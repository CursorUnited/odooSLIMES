// Bulk demo data for the < 2 s check (TECHNICAL_DESIGN §18): 2,000 customers, 10,000 subscriptions
// across all statuses, 12 months of invoices and payments, some overdue.
// Run after the base seed: npm run db:seed && npm run db:seed:bulk
//
// Invoices are built with the real billing maths (calc.js + period rules), next_invoice_date is set to the
// first unbilled period, and the number sequences are moved past what is inserted, so a billing run after
// this creates only genuinely due invoices. Bulk invoices carry no discounts (usage counts stay honest).
import { prisma } from '../src/lib/prisma.js';
import { calculate } from '../src/modules/billing/calc.js';
import { addDays, diffDays, periodBounds, today } from '../src/lib/dates.js';
import { formatNumber, syncSequence } from '../src/lib/numbering.js';
import { D, round2 } from '../src/lib/money.js';

const CUSTOMERS = 2000;
const SUBSCRIPTIONS = 10000;
const CHUNK = 1000;

// Fixed seed, so numbers are repeatable (mulberry32).
let state = 20261031;
const rand = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (items) => items[Math.floor(rand() * items.length)];
const weighted = (pairs) => {
  let r = rand();
  for (const [value, w] of pairs) if ((r -= w) < 0) return value;
  return pairs[pairs.length - 1][0];
};

const CITIES = ['Lucknow', 'Kanpur', 'Agra', 'Varanasi', 'Prayagraj', 'Noida', 'Meerut', 'Bareilly', 'Aligarh', 'Gorakhpur', 'Jhansi', 'Ayodhya'];
const KINDS = ['Traders', 'Mart', 'Foods', 'Textiles', 'Pharma', 'Logistics', 'Motors', 'Electronics', 'Clinic', 'Studios', 'Labs', 'Retail'];
const METHODS = [['UPI', 0.45], ['BANK_TRANSFER', 0.3], ['CARD', 0.12], ['CASH', 0.06], ['CHEQUE', 0.05], ['OTHER', 0.02]];

async function nextIds() {
  const [r] = await prisma.$queryRaw`SELECT
    (SELECT coalesce(max(id), 0) FROM customers) AS customers,
    (SELECT coalesce(max(id), 0) FROM subscriptions) AS subscriptions,
    (SELECT coalesce(max(id), 0) FROM subscription_lines) AS lines,
    (SELECT coalesce(max(id), 0) FROM invoices) AS invoices,
    (SELECT coalesce(max(id), 0) FROM invoice_lines) AS invoice_lines,
    (SELECT coalesce(max(id), 0) FROM payments) AS payments`;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v) + 1]));
}

async function nextSeq(name) {
  const [r] = await prisma.$queryRawUnsafe(`SELECT nextval('${name}')::int AS n`);
  return r.n;
}

async function insertChunks(label, model, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) await model.createMany({ data: rows.slice(i, i + CHUNK) });
  console.log(`[bulk] ${label}: ${rows.length}`);
}

async function main() {
  const t0 = Date.now();
  if ((await prisma.subscription.count()) >= 1000) {
    console.log('[bulk] bulk data already loaded (>= 1000 subscriptions); run npm run db:reset first');
    return;
  }
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } });
  const plans = Object.fromEntries(
    (await prisma.recurringPlan.findMany({ include: { taxes: true } })).map((p) => [p.name, p]),
  );
  const products = Object.fromEntries((await prisma.product.findMany({ include: { taxes: true, variants: true } })).map((p) => [p.name, p]));
  const terms = await prisma.paymentTerm.findMany({ orderBy: { dueDays: 'asc' } });
  if (!admin || !plans.Monthly || !products['Brightloop CRM'] || terms.length < 3) {
    throw new Error('Base seed missing: run npm run db:seed first');
  }
  const crm = products['Brightloop CRM'];
  const analytics = products['Analytics Add-on'];
  const support = products['Priority Support'];
  const now = today();
  const ids = await nextIds();

  // Customers
  const customers = [];
  for (let i = 0; i < CUSTOMERS; i += 1) {
    const name = `${pick(CITIES)} ${pick(KINDS)} ${String(i + 1).padStart(4, '0')}`;
    customers.push({
      id: ids.customers + i,
      name,
      email: `bulk${String(i + 1).padStart(4, '0')}@customers.test`,
      company: `${name} Pvt Ltd`,
      phone: `+91 9${int(100000000, 999999999)}`,
      address: `${pick(CITIES)}, Uttar Pradesh`,
      createdById: admin.id,
    });
  }
  await insertChunks('customers', prisma.customer, customers);

  const subs = [];
  const subLines = [];
  const lineTaxA = [];
  const lineTaxB = [];
  const events = [];
  const invoices = [];
  const invoiceLines = [];
  const payments = [];
  let subSeq = await nextSeq('seq_subscription');
  let invSeq = await nextSeq('seq_invoice');
  let paySeq = await nextSeq('seq_payment');
  let lineId = ids.lines;
  let invId = ids.invoices;
  let invLineId = ids.invoice_lines;
  let payId = ids.payments;

  for (let i = 0; i < SUBSCRIPTIONS; i += 1) {
    const subId = ids.subscriptions + i;
    const customer = pick(customers);
    const planName = weighted([['Monthly', 0.75], ['Yearly', 0.15], ['Weekly', 0.08], ['Daily', 0.02]]);
    const plan = plans[planName];
    const status = weighted([['ACTIVE', 0.61], ['CLOSED', 0.28], ['PAUSED', 0.04], ['QUOTATION', 0.033], ['DRAFT', 0.021], ['CONFIRMED', 0.016]]);
    const billed = ['ACTIVE', 'PAUSED', 'CLOSED'].includes(status);
    const lookbackDays = { Monthly: 364, Yearly: 364, Weekly: 180, Daily: 45 }[planName];
    const startDate = billed ? addDays(now, -int(0, lookbackDays)) : addDays(now, status === 'CONFIRMED' ? int(1, 30) : int(0, 30));
    const term = weighted([[terms[0], 0.2], [terms[1], 0.4], [terms[2], 0.4]]);

    // Lines (quantities respect the plan minimum)
    const min = plan.minQuantity;
    const lines = [];
    const variant = rand() < 0.6 ? crm.variants.find((v) => v.value === 'Odoo') : crm.variants.find((v) => v.value === 'Generic');
    lines.push({ product: crm, variant, quantity: Math.max(min, int(1, planName === 'Yearly' ? 50 : 30)), description: 'CRM seats' });
    if (rand() < 0.4) lines.push({ product: analytics, variant: null, quantity: Math.max(min, int(1, 10)), description: null });
    if (rand() < 0.1) lines.push({ product: support, variant: null, quantity: Math.max(min, 1), description: null });

    const calcLines = lines.map((l) => ({
      productId: l.product.id,
      variantId: l.variant?.id ?? null,
      description: l.description,
      quantity: l.quantity,
      unitPrice: D(l.product.salesPrice).plus(l.variant?.extraPrice ?? 0),
      taxes: l.product.taxes,
      source: l,
    }));
    const baseFee = D(plan.price).gt(0) ? { description: `${plan.name} plan base fee`, unitPrice: plan.price, taxes: plan.taxes } : null;
    const preview = calculate({ lines: calcLines, baseFee, discounts: [], subscriptionId: subId, date: startDate });

    // Expiry / close / pause dates
    let expiryDate = rand() < 0.5 ? addDays(addDays(startDate, 365), -1) : null;
    let closedAt = null;
    let billUntil = now; // bill periods starting on or before this
    if (status === 'CLOSED') {
      closedAt = addDays(startDate, int(1, Math.max(1, diffDays(startDate, now) - 1)));
      if (closedAt > now) closedAt = now;
      billUntil = addDays(closedAt, -1);
    } else if (status === 'PAUSED') {
      billUntil = addDays(startDate, int(0, Math.max(0, diffDays(startDate, now))));
    }
    if (status === 'ACTIVE' && expiryDate && expiryDate <= now) expiryDate = null;

    // Invoices for every billed period
    let next = billed ? startDate : null;
    const subInvoices = [];
    while (billed && next <= billUntil && (!expiryDate || next < expiryDate)) {
      const { periodEnd, nextStart } = periodBounds(startDate, plan.billingPeriod, plan.intervalCount, next);
      subInvoices.push({ periodStart: next, periodEnd });
      next = nextStart;
    }
    subInvoices.forEach((p, k) => {
      const isLast = k === subInvoices.length - 1;
      const dueDate = addDays(p.periodStart, term.dueDays);
      let invStatus;
      if (status === 'ACTIVE' && isLast && rand() < 0.15) invStatus = 'DRAFT';
      else if (rand() < 0.01) invStatus = 'CANCELLED';
      else if (dueDate >= now) invStatus = rand() < 0.5 ? 'PAID' : 'CONFIRMED';
      else invStatus = rand() < 0.9 ? 'PAID' : 'CONFIRMED';

      const total = round2(preview.totals.total);
      let amountPaid = D(0);
      const confirmedAt = invStatus === 'DRAFT' ? null : addDays(p.periodStart, 0);
      const id = invId++;
      if (invStatus === 'PAID') {
        amountPaid = total;
        const latest = dueDate < now ? addDays(dueDate, 5) : now;
        const payDate = addDays(p.periodStart, int(0, Math.max(0, diffDays(p.periodStart, latest < now ? latest : now))));
        payments.push({
          id: payId++, number: formatNumber('PAY', payDate.getUTCFullYear(), paySeq++), invoiceId: id, customerId: customer.id,
          method: weighted(METHODS), amount: total, paymentDate: payDate, note: null, recordedById: admin.id,
        });
      } else if (invStatus === 'CONFIRMED' && rand() < 0.3) {
        amountPaid = round2(total.times(int(30, 70)).div(100));
        const payDate = addDays(p.periodStart, int(0, Math.max(0, diffDays(p.periodStart, now))));
        payments.push({
          id: payId++, number: formatNumber('PAY', payDate.getUTCFullYear(), paySeq++), invoiceId: id, customerId: customer.id,
          method: weighted(METHODS), amount: amountPaid, paymentDate: payDate, note: 'Part payment', recordedById: admin.id,
        });
      }
      invoices.push({
        id,
        number: formatNumber('INV', p.periodStart.getUTCFullYear(), invSeq++),
        subscriptionId: subId,
        customerId: customer.id,
        paymentTermId: term.id,
        status: invStatus,
        invoiceDate: p.periodStart,
        dueDate: invStatus === 'DRAFT' ? null : dueDate,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        untaxedAmount: preview.totals.untaxed,
        discountAmount: preview.totals.discount,
        taxAmount: preview.totals.tax,
        total,
        amountPaid,
        confirmedAt,
        paidAt: invStatus === 'PAID' ? new Date() : null,
        cancelledAt: invStatus === 'CANCELLED' ? new Date() : null,
        sentAt: invStatus !== 'DRAFT' && rand() < 0.6 ? new Date() : null,
      });
      preview.lines.forEach((row, sortOrder) => {
        invoiceLines.push({
          id: invLineId++,
          invoiceId: id,
          productId: row.productId,
          variantId: row.variantId,
          description:
            row.kind === 'BASE_FEE'
              ? row.description
              : `${row.source.product.name}${row.source.variant ? ` (${row.source.variant.attribute}: ${row.source.variant.value})` : ''}${row.source.description ? ` — ${row.source.description}` : ''}`,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          subtotal: row.subtotal,
          discountAmount: row.discountAmount,
          taxAmount: row.taxAmount,
          total: row.total,
          taxSnapshot: row.taxSnapshot,
          sortOrder,
        });
      });
    });

    subs.push({
      id: subId,
      number: formatNumber('SUB', startDate.getUTCFullYear(), subSeq++),
      customerId: customer.id,
      planId: plan.id,
      status,
      startDate,
      expiryDate,
      nextInvoiceDate: status === 'ACTIVE' || status === 'PAUSED' ? next : null,
      quotationValidUntil: status === 'QUOTATION' ? addDays(now, int(-3, 15)) : null,
      closedAt,
      paymentTermId: term.id,
      recurringTotal: preview.totals.total,
      recurringUntaxed: preview.totals.untaxed.minus(preview.totals.discount),
      createdById: admin.id,
      createdAt: addDays(startDate, -int(1, 10)),
    });
    for (const l of lines) {
      const id = lineId++;
      subLines.push({
        id,
        subscriptionId: subId,
        productId: l.product.id,
        variantId: l.variant?.id ?? null,
        description: l.description,
        quantity: l.quantity,
        unitPrice: D(l.product.salesPrice).plus(l.variant?.extraPrice ?? 0),
        amount: round2(D(l.quantity).times(D(l.product.salesPrice).plus(l.variant?.extraPrice ?? 0))),
      });
      for (const tax of l.product.taxes) {
        lineTaxA.push(id);
        lineTaxB.push(tax.id);
      }
    }
    events.push({ subscriptionId: subId, action: 'CREATE', fromStatus: null, toStatus: 'DRAFT', userId: admin.id, note: 'Bulk seed' });
    if (status !== 'DRAFT') {
      events.push({ subscriptionId: subId, action: status === 'CLOSED' ? 'CLOSE' : 'CONFIRM', fromStatus: 'DRAFT', toStatus: status, userId: admin.id, note: 'Bulk seed' });
    }
  }

  await insertChunks('subscriptions', prisma.subscription, subs);
  await insertChunks('subscription lines', prisma.subscriptionLine, subLines);
  for (let i = 0; i < lineTaxA.length; i += 5000) {
    await prisma.$executeRaw`INSERT INTO "_SubscriptionLineTaxes" ("A", "B")
      SELECT * FROM unnest(${lineTaxA.slice(i, i + 5000)}::int[], ${lineTaxB.slice(i, i + 5000)}::int[])`;
  }
  await insertChunks('subscription events', prisma.subscriptionEvent, events);
  await insertChunks('invoices', prisma.invoice, invoices);
  await insertChunks('invoice lines', prisma.invoiceLine, invoiceLines);
  await insertChunks('payments', prisma.payment, payments);

  // Keep autoincrement ids and document numbers ahead of what was inserted.
  for (const table of ['customers', 'subscriptions', 'subscription_lines', 'invoices', 'invoice_lines', 'payments']) {
    await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT coalesce(max(id), 1) FROM "${table}"))`);
  }
  await syncSequence(prisma, 'SUB', subSeq - 1);
  await syncSequence(prisma, 'INV', invSeq - 1);
  await syncSequence(prisma, 'PAY', paySeq - 1);
  await prisma.$executeRawUnsafe('ANALYZE');

  const overdue = invoices.filter((x) => x.status === 'CONFIRMED' && x.dueDate < now).length;
  console.log(`[bulk] done in ${((Date.now() - t0) / 1000).toFixed(1)} s · overdue invoices: ${overdue}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
