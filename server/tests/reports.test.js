import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { addDays, diffDays, formatDate, parseDate, today } from '../src/lib/dates.js';

const formatToday = () => formatDate(today());
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';

const app = createApp();
const api = '/api/v1';
let staff, customer, accounts, c;
let n = 0;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  c = await seedCatalog();
  [staff, customer] = await Promise.all([loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

// Arrange rows directly; assertions go through the HTTP API only.
const sub = (data) =>
  prisma.subscription.create({
    data: {
      number: `SUB/T/${(n += 1)}`, customerId: accounts.customer.id, planId: c.monthly.id, paymentTermId: c.net15.id,
      startDate: parseDate('2026-01-01'), status: 'ACTIVE', ...data,
    },
  });
const invoice = (s, data) =>
  prisma.invoice.create({
    data: {
      number: `INV/T/${(n += 1)}`, subscriptionId: s.id, customerId: s.customerId, status: 'CONFIRMED',
      untaxedAmount: data.total, taxAmount: '0', ...data,
      invoiceDate: parseDate(data.invoiceDate), periodStart: parseDate(data.invoiceDate), periodEnd: parseDate(data.invoiceDate),
      dueDate: data.dueDate ? parseDate(data.dueDate) : null,
    },
  });
const payment = (inv, amount, paymentDate) =>
  prisma.payment.create({
    data: { number: `PAY/T/${(n += 1)}`, invoiceId: inv.id, customerId: inv.customerId, method: 'UPI', amount, paymentDate: parseDate(paymentDate) },
  });

describe('GET /reports/summary', () => {
  it('TC-REP-01 a known set gives the hand-computed numbers', async () => {
    const a = await sub({ recurringUntaxed: '1000' });
    await sub({ recurringUntaxed: '500' });
    await sub({ status: 'PAUSED', recurringUntaxed: '300' });
    const owed = await invoice(a, { invoiceDate: '2026-10-05', dueDate: '2026-10-10', total: '1180', amountPaid: '180' });
    const paid = await invoice(a, { invoiceDate: '2026-10-06', dueDate: '2026-10-20', total: '590', amountPaid: '590', status: 'PAID' });
    await invoice(a, { invoiceDate: '2026-10-07', total: '999', status: 'DRAFT' });
    await payment(owed, '180', '2026-10-08');
    await payment(paid, '590', '2026-10-09');
    await payment(paid, '0.01', '2026-09-30'); // outside the range (amount is arbitrary)

    const res = await staff.get(`${api}/reports/summary?from=2026-10-01&to=2026-10-31`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      from: '2026-10-01', to: '2026-10-31',
      activeSubscriptions: 2,
      mrr: '1500.00',
      revenueCollected: '770.00',
      invoicedAmount: '1770.00',
      amountOutstanding: '1000.00',
      overdueCount: 1,
      overdueAmount: '1000.00',
      subscriptionsByStatus: { DRAFT: 0, QUOTATION: 0, CONFIRMED: 0, ACTIVE: 2, PAUSED: 1, CLOSED: 0 },
      invoicesByStatus: { DRAFT: 1, CONFIRMED: 1, PAID: 1, CANCELLED: 0 },
    });
  });

  it('date edges: a payment on the `from` day counts; an invoice due today is not overdue yet', async () => {
    const s = await sub({});
    const inv = await invoice(s, { invoiceDate: '2026-10-01', dueDate: formatToday(), total: '100' });
    await payment(inv, '40', '2026-10-01');
    const res = (await staff.get(`${api}/reports/summary?from=2026-10-01&to=2026-10-01`)).body.data;
    expect(res).toMatchObject({ revenueCollected: '40.00', invoicedAmount: '100.00', overdueCount: 0 });
    expect((await staff.get(`${api}/reports/overdue-invoices`)).body.total).toBe(0);
  });

  it('TC-REP-04 MRR normalises every period to a month', async () => {
    const plan = (name, billingPeriod) =>
      prisma.recurringPlan.create({ data: { name, billingPeriod, price: '0', startDate: parseDate('2026-01-01') } });
    const [daily, weekly, yearly] = await Promise.all([plan('D', 'DAILY'), plan('W', 'WEEKLY'), plan('Y', 'YEARLY')]);
    await sub({ planId: daily.id, recurringUntaxed: '10' });
    await sub({ planId: weekly.id, recurringUntaxed: '70' });
    await sub({ planId: c.monthly.id, recurringUntaxed: '300' });
    await sub({ planId: yearly.id, recurringUntaxed: '3600' });
    const res = await staff.get(`${api}/reports/summary`);
    // 10 × 30 + 70 × 52 / 12 + 300 + 3600 / 12 = 300 + 303.33 + 300 + 300
    expect(res.body.data.mrr).toBe('1203.33');
  });

  it('plan and customer filters narrow every number; customers cannot read reports', async () => {
    const other = await prisma.customer.create({ data: { name: 'Other', email: 'o@o.in' } });
    await sub({ recurringUntaxed: '100' });
    const theirs = await sub({ customerId: other.id, planId: c.yearly.id, recurringUntaxed: '1200' });
    await invoice(theirs, { invoiceDate: '2026-10-05', dueDate: '2026-10-06', total: '50' });

    const byPlan = (await staff.get(`${api}/reports/summary?planId=${c.yearly.id}`)).body.data;
    expect(byPlan).toMatchObject({ activeSubscriptions: 1, mrr: '100.00', overdueCount: 1 });
    const byCustomer = (await staff.get(`${api}/reports/summary?customerId=${accounts.customer.id}`)).body.data;
    expect(byCustomer).toMatchObject({ activeSubscriptions: 1, mrr: '100.00', overdueCount: 0, amountOutstanding: '0.00' });
    expect((await customer.get(`${api}/reports/summary`)).status).toBe(403);
  });
});

describe('GET /reports/revenue-by-month', () => {
  it('12 months ending at `to`, empty months included; new = started that month, closed = closed that month', async () => {
    const s = await sub({ startDate: parseDate('2026-10-03') });
    await sub({ status: 'DRAFT', startDate: parseDate('2026-10-04') }); // a draft is not "new" yet
    await sub({ status: 'CLOSED', startDate: parseDate('2026-02-01'), closedAt: parseDate('2026-09-20') });
    const inv = await invoice(s, { invoiceDate: '2026-10-05', total: '1000', status: 'PAID', amountPaid: '1000' });
    await payment(inv, '400', '2026-09-15');
    await payment(inv, '600', '2026-10-15');
    const res = await staff.get(`${api}/reports/revenue-by-month?to=2026-10-31`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(12);
    expect(res.body.data[0].month).toBe('2025-11');
    expect(res.body.data.slice(-2)).toEqual([
      { month: '2026-09', invoiced: '0.00', collected: '400.00', newSubscriptions: 0, closedSubscriptions: 1 },
      { month: '2026-10', invoiced: '1000.00', collected: '600.00', newSubscriptions: 1, closedSubscriptions: 0 },
    ]);
  });
});

describe('GET /reports/overdue-invoices', () => {
  it('TC-REP-03 only overdue invoices, most days overdue first', async () => {
    const s = await sub({});
    const due = (d) => addDays(today(), -d).toISOString().slice(0, 10);
    await invoice(s, { invoiceDate: '2026-01-01', dueDate: due(5), total: '100' });
    await invoice(s, { invoiceDate: '2026-01-02', dueDate: due(40), total: '200', amountPaid: '50' });
    await invoice(s, { invoiceDate: '2026-01-03', dueDate: due(-3), total: '300' }); // not due yet
    await invoice(s, { invoiceDate: '2026-01-04', dueDate: due(60), total: '400', amountPaid: '400', status: 'PAID' });

    const res = await staff.get(`${api}/reports/overdue-invoices`);
    expect(res.body.total).toBe(2);
    expect(res.body.data.map((r) => [r.daysOverdue, r.amountDue])).toEqual([
      [40, '150.00'],
      [5, '100.00'],
    ]);
    expect(res.body.data[0]).toMatchObject({ customer: { name: 'Kanpur Mart' }, total: '200.00' });
    expect(diffDays(parseDate(res.body.data[0].dueDate), today())).toBe(40);
  });
});
