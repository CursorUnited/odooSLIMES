import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { D, toApi, formatInr } from '../../lib/money.js';
import { formatDate, toIsoLocal } from '../../lib/dates.js';
import { nextNumber } from '../../lib/numbering.js';
import { scopeToCustomer } from '../../lib/scope.js';
import { amountDue } from '../invoices/invoices.view.js';

const toPaymentApi = (p) => ({
  id: p.id,
  number: p.number,
  invoiceId: p.invoiceId,
  invoice: p.invoice ? { id: p.invoice.id, number: p.invoice.number } : undefined,
  customer: p.customer,
  method: p.method,
  amount: toApi(p.amount),
  paymentDate: formatDate(p.paymentDate),
  note: p.note,
  recordedBy: p.recordedBy ?? null,
  createdAt: toIsoLocal(p.createdAt),
});

/**
 * Records a payment against a CONFIRMED invoice, in one transaction with the
 * invoice row locked: insert payment → amount_paid += amount → PAID when fully paid.
 */
export async function createPayment({ invoiceId, method, amount, paymentDate, note }, user) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, { invoiceId: 'Choose an invoice.' });
    if (inv.status !== 'CONFIRMED') {
      const message = inv.status === 'PAID' ? 'This invoice is already paid.' : 'Confirm the invoice before recording a payment.';
      throw new AppError('PAY_INVOICE_NOT_CONFIRMED', message, 409);
    }
    if (paymentDate < inv.invoiceDate) {
      throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, {
        paymentDate: `Payment date can't be before the invoice date (${formatDate(inv.invoiceDate)}).`,
      });
    }
    const due = amountDue(inv);
    if (D(amount).gt(due)) {
      const message = `Amount cannot be more than the amount due (₹${formatInr(due)}).`;
      throw new AppError('PAY_EXCEEDS_DUE', message, 400, { amount: message });
    }

    const payment = await tx.payment.create({
      data: {
        number: await nextNumber(tx, 'PAY', paymentDate),
        invoiceId,
        customerId: inv.customerId,
        method,
        amount,
        paymentDate,
        note: note ?? null,
        recordedById: user.id,
      },
    });
    const amountPaid = D(inv.amountPaid).plus(amount);
    const paid = amountPaid.gte(inv.total);
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: { amountPaid, ...(paid && { status: 'PAID', paidAt: new Date() }) },
    });
    return {
      ...toPaymentApi(payment),
      invoice: { id: updated.id, number: updated.number, status: updated.status, amountPaid: toApi(updated.amountPaid), amountDue: toApi(amountDue(updated)) },
    };
  });
}

/** Payments list; customers see only their own. q matches payment or invoice number. */
export function listPayments(user, { page, pageSize, sort, q, invoiceId, customerId, method, from, to }) {
  const where = scopeToCustomer(user, {
    ...(invoiceId && { invoiceId }),
    ...(customerId && { customerId }),
    ...(method && { method }),
    ...((from || to) && { paymentDate: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
    ...(q && { OR: [{ number: ilike(q) }, { invoice: { number: ilike(q) } }] }),
  });
  return paginate(prisma.payment, {
    where,
    orderBy: orderByFrom(sort),
    page,
    pageSize,
    include: {
      invoice: { select: { id: true, number: true } },
      customer: { select: { id: true, name: true } },
      recordedBy: { select: { id: true, name: true } },
    },
    map: toPaymentApi,
  });
}
