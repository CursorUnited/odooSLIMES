// Invoice lifecycle: DRAFT → CONFIRMED → PAID, or CANCELLED (TECHNICAL_DESIGN §10.1, API.md §4.11.3).
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { D } from '../../lib/money.js';
import { addDays, formatDate } from '../../lib/dates.js';
import { config } from '../../config/index.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';
import { calculate, isEligibleOn } from '../billing/calc.js';
import { findInvoice } from './invoices.service.js';
import { amountDue, toInvoiceDetailApi } from './invoices.view.js';

const invalid = (message) => new AppError('INV_INVALID_TRANSITION', message, 409);
const inr = (v) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));

const lockInvoice = (tx, id) => tx.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;

const fresh = async (tx, user, id) => toInvoiceDetailApi(await findInvoice(user, id, tx), user);

/** Rebuilds line discounts, taxes and totals of a DRAFT invoice with only `discounts` as candidates. */
async function recompute(tx, inv, discounts) {
  const fromSnapshot = (l) => l.taxSnapshot.map((t) => ({ id: t.taxId, name: t.name, type: t.type, rate: t.rate }));
  const productLines = inv.lines.filter((l) => l.productId !== null);
  const feeLine = inv.lines.find((l) => l.productId === null);
  const result = calculate({
    lines: productLines.map((l) => ({ productId: l.productId, variantId: l.variantId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxes: fromSnapshot(l), line: l })),
    baseFee: feeLine ? { description: feeLine.description, unitPrice: feeLine.unitPrice, taxes: fromSnapshot(feeLine), line: feeLine } : null,
    discounts,
    subscriptionId: inv.subscriptionId,
    date: inv.invoiceDate,
  });
  for (const row of result.lines) {
    await tx.invoiceLine.update({
      where: { id: row.line.id },
      data: { discountAmount: row.discountAmount, taxAmount: row.taxAmount, total: row.total, taxSnapshot: row.taxSnapshot },
    });
  }
  await tx.invoiceDiscount.deleteMany({ where: { invoiceId: inv.id } });
  if (result.appliedDiscounts.length) {
    await tx.invoiceDiscount.createMany({ data: result.appliedDiscounts.map((a) => ({ invoiceId: inv.id, discountId: a.id, amount: a.amount })) });
  }
  await tx.invoice.update({
    where: { id: inv.id },
    data: { untaxedAmount: result.totals.untaxed, discountAmount: result.totals.discount, taxAmount: result.totals.tax, total: result.totals.total },
  });
  return result.appliedDiscounts.map((a) => a.id);
}

/**
 * DRAFT → CONFIRMED. Re-checks every applied discount under a row lock; one that
 * ran out or expired since the draft is dropped and the invoice recomputed
 * (warning returned). Then counts one use per remaining discount and sets the due date.
 */
export async function confirmInvoice(user, id) {
  return prisma.$transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await findInvoice(user, id, tx);
    if (inv.status !== 'DRAFT') throw invalid('Invoice is already confirmed.');

    const warnings = [];
    let keptIds = inv.discounts.map((d) => d.discountId);
    if (keptIds.length) {
      await tx.$queryRaw`SELECT id FROM discounts WHERE id = ANY(${keptIds}) FOR UPDATE`;
      const rows = await tx.discount.findMany({
        where: { id: { in: keptIds } },
        include: { products: { select: { id: true } }, subscriptions: { select: { id: true } } },
      });
      const valid = [];
      for (const { products, subscriptions, ...d } of rows) {
        const candidate = { ...d, productIds: products.map((p) => p.id), subscriptionIds: subscriptions.map((s) => s.id) };
        if (isEligibleOn(candidate, inv.invoiceDate)) valid.push(candidate);
        else {
          const exhausted = d.usageLimit != null && d.usedCount >= d.usageLimit;
          warnings.push(`${exhausted ? 'DISCOUNT_EXHAUSTED' : 'DISCOUNT_EXPIRED'}: ${d.name}`);
        }
      }
      if (valid.length < rows.length) keptIds = await recompute(tx, inv, valid);
      if (keptIds.length) await tx.discount.updateMany({ where: { id: { in: keptIds } }, data: { usedCount: { increment: 1 } } });
    }

    await tx.invoice.update({
      where: { id },
      data: { status: 'CONFIRMED', confirmedAt: new Date(), dueDate: addDays(inv.invoiceDate, inv.paymentTerm?.dueDays ?? 0) },
    });
    return { invoice: await fresh(tx, user, id), warnings };
  });
}

/** DRAFT/CONFIRMED → CANCELLED when nothing was paid. A confirmed invoice gives its discount uses back. */
export async function cancelInvoice(user, id) {
  return prisma.$transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await findInvoice(user, id, tx);
    if (!['DRAFT', 'CONFIRMED'].includes(inv.status)) {
      throw invalid(inv.status === 'PAID' ? "Paid invoices can't be cancelled." : 'This invoice is already cancelled.');
    }
    if (D(inv.amountPaid).gt(0)) throw new AppError('INV_HAS_PAYMENTS', "This invoice has payments and can't be cancelled.", 409);
    if (inv.status === 'CONFIRMED' && inv.discounts.length) {
      await tx.discount.updateMany({
        where: { id: { in: inv.discounts.map((d) => d.discountId) }, usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
    }
    await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    return fresh(tx, user, id);
  });
}

/** Emails the invoice (Outbox, SMTP if set) and stamps sentAt. CONFIRMED or PAID only. */
export async function sendInvoice(user, id) {
  return prisma.$transaction(async (tx) => {
    const inv = await findInvoice(user, id, tx);
    if (!['CONFIRMED', 'PAID'].includes(inv.status)) throw invalid('Confirm the invoice before sending it.');
    const link = `${config.appUrl}/portal/invoices/${inv.id}`;
    await sendMail(tx, {
      to: inv.customer.email,
      subject: `Invoice ${inv.number} from ${config.company.name}`,
      kind: 'INVOICE',
      relatedId: inv.id,
      html: layout(
        `Invoice ${inv.number}`,
        `<p>Hi ${escapeHtml(inv.customer.name)},</p>
         <p>Period ${formatDate(inv.periodStart)} to ${formatDate(inv.periodEnd)}.<br>
         Total ₹${inr(inv.total)} · Amount due ₹${inr(amountDue(inv))} · Due ${formatDate(inv.dueDate)}.</p>
         <p><a href="${link}">View or download the invoice</a></p>`,
      ),
    });
    await tx.invoice.update({ where: { id }, data: { sentAt: new Date() } });
    return fresh(tx, user, id);
  });
}

/** Confirms each id in its own transaction; returns which worked and why the others failed. */
export async function confirmBulk(user, ids) {
  const out = { confirmed: [], failed: [] };
  for (const id of ids) {
    try {
      await confirmInvoice(user, id);
      out.confirmed.push(id);
    } catch (err) {
      out.failed.push({ id, code: err.code ?? 'INTERNAL', message: err.message });
    }
  }
  return out;
}
