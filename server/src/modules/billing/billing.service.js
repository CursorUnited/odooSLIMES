// Billing run (TECHNICAL_DESIGN §9, ADR 0002): nothing billed twice, nothing skipped.
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { config } from '../../config/index.js';
import { formatDate, periodBounds, toIsoLocal } from '../../lib/dates.js';
import { nextNumber } from '../../lib/numbering.js';
import { calculate } from './calc.js';
import { detailInclude as subInclude, calcInput, variantLabel } from '../subscriptions/subscriptions.view.js';
import { loadDiscounts } from '../subscriptions/subscriptions.service.js';

const BATCH = 500;
const STALE_RUN_MINUTES = 15;
const RUN_LOCK_KEY = 731_001; // pg advisory lock id for "starting a billing run"
const MAX_FAILURES_LISTED = 50;

const lineDescription = (row) => {
  if (row.kind === 'BASE_FEE') return row.description;
  const { product, variant, description } = row.source;
  return `${product.name}${variant ? ` (${variantLabel(variant)})` : ''}${description ? ` — ${description}` : ''}`;
};

/**
 * Creates the DRAFT invoice for the period starting at `periodStart`, inside `tx`.
 * Uses calc.js with the discounts eligible on the invoice date (= period start, billing in advance).
 */
export async function createInvoiceForPeriod(tx, sub, periodStart, discounts) {
  const { periodEnd, nextStart } = periodBounds(sub.startDate, sub.plan.billingPeriod, sub.plan.intervalCount, periodStart);
  const result = calculate(calcInput(sub, discounts, periodStart));
  const invoice = await tx.invoice.create({
    data: {
      number: await nextNumber(tx, 'INV', periodStart),
      subscriptionId: sub.id,
      customerId: sub.customerId,
      paymentTermId: sub.paymentTermId,
      invoiceDate: periodStart,
      periodStart,
      periodEnd,
      untaxedAmount: result.totals.untaxed,
      discountAmount: result.totals.discount,
      taxAmount: result.totals.tax,
      total: result.totals.total,
      lines: {
        create: result.lines.map((row, i) => ({
          productId: row.productId,
          variantId: row.variantId,
          description: lineDescription(row),
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          subtotal: row.subtotal,
          discountAmount: row.discountAmount,
          taxAmount: row.taxAmount,
          total: row.total,
          taxSnapshot: row.taxSnapshot,
          sortOrder: i,
        })),
      },
      discounts: { create: result.appliedDiscounts.map((a) => ({ discountId: a.id, amount: a.amount })) },
    },
  });
  return { invoice, nextStart };
}

const isDue = (sub, asOf) =>
  sub.status === 'ACTIVE' &&
  sub.nextInvoiceDate &&
  sub.nextInvoiceDate <= asOf &&
  (!sub.expiryDate || sub.nextInvoiceDate < sub.expiryDate);

/**
 * Bills every due period of one subscription in ONE transaction with the row
 * locked: insert invoice, advance next_invoice_date, repeat (catch-up).
 * A period that already has an invoice is skipped and still advanced.
 */
export async function billSubscription(subId, asOf, discounts) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${subId} FOR UPDATE`;
      const sub = await tx.subscription.findUnique({ where: { id: subId }, include: subInclude });
      const out = { created: 0, skipped: 0, invoiceIds: [] };
      let next = sub.nextInvoiceDate;
      while (isDue({ ...sub, nextInvoiceDate: next }, asOf)) {
        const existing = await tx.invoice.findUnique({
          where: { subscriptionId_periodStart: { subscriptionId: sub.id, periodStart: next } },
          select: { id: true },
        });
        if (existing) {
          out.skipped += 1;
          next = periodBounds(sub.startDate, sub.plan.billingPeriod, sub.plan.intervalCount, next).nextStart;
          continue;
        }
        const { invoice, nextStart } = await createInvoiceForPeriod(tx, sub, next, discounts);
        out.created += 1;
        out.invoiceIds.push(invoice.id);
        next = nextStart;
      }
      if (next !== sub.nextInvoiceDate) await tx.subscription.update({ where: { id: sub.id }, data: { nextInvoiceDate: next } });
      return out;
    });
  } catch (err) {
    // A parallel run won the unique key (subscription_id, period_start): already billed, not a failure.
    if (err?.code === 'P2002') return { created: 0, skipped: 1, invoiceIds: [] };
    throw err;
  }
}

/** Claims the run slot: one unfinished run at a time (serialised by an advisory xact lock). */
async function startRun(asOf, userId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_KEY})`;
    const running = await tx.billingRun.findFirst({
      where: { finishedAt: null, startedAt: { gt: new Date(Date.now() - STALE_RUN_MINUTES * 60_000) } },
      select: { id: true },
    });
    if (running) throw new AppError('BILLING_RUN_IN_PROGRESS', 'A billing run is already in progress. Try again in a moment.', 409);
    return tx.billingRun.create({ data: { asOf, triggeredById: userId ?? null } });
  });
}

const runNote = (run) => `Billing run #${run.id}`;

/** CONFIRMED subscriptions whose start date has come → ACTIVE. */
async function autoActivate(asOf, run) {
  const due = await prisma.subscription.findMany({ where: { status: 'CONFIRMED', startDate: { lte: asOf } }, select: { id: true, startDate: true } });
  for (const s of due) {
    await prisma.$transaction([
      prisma.subscription.update({ where: { id: s.id, status: 'CONFIRMED' }, data: { status: 'ACTIVE', nextInvoiceDate: s.startDate } }),
      prisma.subscriptionEvent.create({ data: { subscriptionId: s.id, action: 'AUTO_ACTIVATE', fromStatus: 'CONFIRMED', toStatus: 'ACTIVE', note: runNote(run) } }),
    ]);
  }
  return due.length;
}

/** ACTIVE/PAUSED past their expiry date on auto-close plans → CLOSED (after billing, so the last period is billed). */
async function autoClose(asOf, run) {
  const due = await prisma.subscription.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, expiryDate: { lt: asOf }, plan: { autoClose: true } },
    select: { id: true, status: true },
  });
  for (const s of due) {
    await prisma.$transaction([
      prisma.subscription.update({ where: { id: s.id }, data: { status: 'CLOSED', closedAt: asOf, nextInvoiceDate: null } }),
      prisma.subscriptionEvent.create({ data: { subscriptionId: s.id, action: 'AUTO_CLOSE', fromStatus: s.status, toStatus: 'CLOSED', note: runNote(run) } }),
    ]);
  }
  return due.length;
}

/**
 * The billing run: activate → bill (keyset batches of 500, one transaction per
 * subscription) → auto-close → optional auto-confirm. Shared by POST /billing/run and the daily job.
 */
export async function runBilling({ asOf, userId = null }) {
  const run = await startRun(asOf, userId);
  const counts = { activatedCount: 0, createdCount: 0, skippedCount: 0, failedCount: 0, closedCount: 0 };
  const failures = [];
  const newInvoiceIds = [];
  try {
    counts.activatedCount = await autoActivate(asOf, run);
    const discounts = await loadDiscounts();

    let lastId = 0;
    for (;;) {
      const batch = await prisma.subscription.findMany({
        where: {
          id: { gt: lastId },
          status: 'ACTIVE',
          nextInvoiceDate: { lte: asOf },
          OR: [{ expiryDate: null }, { expiryDate: { gt: prisma.subscription.fields.nextInvoiceDate } }],
        },
        orderBy: { id: 'asc' },
        take: BATCH,
        select: { id: true, number: true },
      });
      if (!batch.length) break;
      for (const s of batch) {
        try {
          const r = await billSubscription(s.id, asOf, discounts);
          counts.createdCount += r.created;
          counts.skippedCount += r.skipped;
          newInvoiceIds.push(...r.invoiceIds);
        } catch (err) {
          counts.failedCount += 1;
          if (failures.length < MAX_FAILURES_LISTED) {
            failures.push({ subscriptionId: s.id, number: s.number, code: err.code ?? 'INTERNAL', message: err.message });
          }
          console.error(JSON.stringify({ level: 'error', billingRun: run.id, subscriptionId: s.id, stack: err.stack }));
        }
      }
      lastId = batch[batch.length - 1].id;
    }

    counts.closedCount = await autoClose(asOf, run);
    if (config.billingAutoConfirm && newInvoiceIds.length) {
      const { confirmInvoice } = await import('../invoices/invoiceActions.service.js');
      for (const id of newInvoiceIds) await confirmInvoice(null, id).catch(() => {});
    }
  } finally {
    await prisma.billingRun.update({ where: { id: run.id }, data: { ...counts, failures, finishedAt: new Date() } });
  }
  return getRun(run.id);
}

export const toRunApi = (r) => ({
  id: r.id,
  asOf: formatDate(r.asOf),
  activatedCount: r.activatedCount,
  createdCount: r.createdCount,
  skippedCount: r.skippedCount,
  failedCount: r.failedCount,
  closedCount: r.closedCount,
  startedAt: toIsoLocal(r.startedAt),
  finishedAt: toIsoLocal(r.finishedAt),
  durationMs: r.finishedAt ? r.finishedAt - r.startedAt : null,
  triggeredBy: r.triggeredBy,
  failures: r.failures,
});

export async function getRun(id) {
  const r = await prisma.billingRun.findUnique({ where: { id }, include: { triggeredBy: { select: { id: true, name: true } } } });
  return toRunApi(r);
}

/**
 * "Bill now" for one ACTIVE subscription: invoices the period starting at
 * nextInvoiceDate right away (even if it is in the future) and advances it.
 * Same code path as the run, so the unique period key still applies.
 */
export async function billNow(user, subId) {
  const discounts = await loadDiscounts();
  const invoiceId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${subId} FOR UPDATE`;
    const sub = await tx.subscription.findUnique({ where: { id: subId }, include: subInclude });
    if (!sub) throw new AppError('NOT_FOUND', 'Subscription not found.', 404);
    if (sub.status !== 'ACTIVE') {
      throw new AppError('SUB_INVALID_TRANSITION', 'Only active subscriptions can be billed.', 409);
    }
    if (sub.expiryDate && sub.nextInvoiceDate >= sub.expiryDate) {
      throw new AppError('SUB_PAST_EXPIRY', 'The next period starts on or after the expiry date.', 409);
    }
    const { invoice, nextStart } = await createInvoiceForPeriod(tx, sub, sub.nextInvoiceDate, discounts);
    await tx.subscription.update({ where: { id: sub.id }, data: { nextInvoiceDate: nextStart } });
    return invoice.id;
  });
  const { confirmInvoice } = await import('../invoices/invoiceActions.service.js');
  if (config.billingAutoConfirm) await confirmInvoice(user, invoiceId);
  const { getInvoice } = await import('../invoices/invoices.service.js');
  return getInvoice(user, invoiceId);
}
