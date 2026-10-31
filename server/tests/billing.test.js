import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';
import { seedStarter, activeSub } from './helpers/subs.js';

const app = createApp();
const api = '/api/v1';
let admin, staff, customer, accounts, c, starter;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  c = await seedCatalog();
  ({ template: starter } = await seedStarter(c));
  [admin, staff, customer] = await Promise.all([loginAs(app, 'ADMIN'), loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

const run = (asOf, agent = staff) => agent.post(`${api}/billing/run`).send(asOf ? { asOf } : {});
const starterSub = (over = {}) =>
  activeSub(staff, { templateId: starter.id, customerId: accounts.customer.id, startDate: '2026-01-31', ...over });
const invoicesOf = async (subscriptionId) =>
  (await staff.get(`${api}/invoices?subscriptionId=${subscriptionId}&sort=invoiceDate&pageSize=100`)).body.data;

describe('billing run creates invoices', () => {
  it('TC-BILL-01/02 one DRAFT invoice on the start date with lines, tax, discount; next invoice date advances', async () => {
    const sub = await starterSub();
    expect(sub.nextInvoiceDate).toBe('2026-01-31');

    const res = await run('2026-01-31');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ asOf: '2026-01-31', createdCount: 1, skippedCount: 0, failedCount: 0, triggeredBy: { name: 'Ravi Staff' } });

    const [row] = await invoicesOf(sub.id);
    expect(row).toMatchObject({
      number: 'INV/2026/00001', status: 'DRAFT', customer: { name: 'Kanpur Mart' }, subscription: { number: sub.number },
      invoiceDate: '2026-01-31', dueDate: null, total: '17145.40', amountPaid: '0.00', amountDue: '17145.40', isOverdue: false,
    });

    const inv = (await staff.get(`${api}/invoices/${row.id}`)).body.data;
    expect(inv).toMatchObject({
      periodStart: '2026-01-31', periodEnd: '2026-02-27', paymentTerm: 'Net 15',
      company: { name: 'Brightloop Software' },
      customer: { id: accounts.customer.id, name: 'Kanpur Mart', email: 'customer@brightloop.test' },
      subscription: { id: sub.id, number: sub.number, plan: 'Monthly' },
      lines: [
        { description: 'Brightloop CRM (Brand: Odoo) — CRM seats', quantity: 10, unitPrice: '1559.00', subtotal: '15590.00',
          discountAmount: '1559.00', taxes: [{ name: 'GST 18%', rate: '18.00', amount: '2525.58' }], taxAmount: '2525.58', total: '16556.58' },
        { description: 'Monthly plan base fee', quantity: 1, unitPrice: '499.00', subtotal: '499.00',
          discountAmount: '0.00', taxAmount: '89.82', total: '588.82' },
      ],
      discounts: [{ name: '10% for 10+ seats', amount: '1559.00' }],
      untaxedAmount: '16089.00', discountAmount: '1559.00', taxAmount: '2615.40', total: '17145.40',
      amountPaid: '0.00', amountDue: '17145.40', payments: [], allowedActions: ['confirm', 'cancel'],
    });

    const after = (await staff.get(`${api}/subscriptions/${sub.id}`)).body.data;
    expect(after.nextInvoiceDate).toBe('2026-02-28');
  });

  it('customers cannot run billing', async () => {
    expect((await run(undefined, customer)).status).toBe(403);
  });
});

describe('nothing billed twice or skipped (ADR 0002)', () => {
  it('TC-BILL-03 running twice for the same date creates nothing the second time', async () => {
    const sub = await starterSub();
    expect((await run('2026-01-31')).body.data.createdCount).toBe(1);
    const second = await run('2026-01-31');
    expect(second.body.data).toMatchObject({ createdCount: 0, failedCount: 0 });
    expect(await invoicesOf(sub.id)).toHaveLength(1);
  });

  it('TC-BILL-04 three periods behind → three consecutive invoices in one run, no gaps or overlaps', async () => {
    const sub = await starterSub();
    expect((await run('2026-03-31')).body.data.createdCount).toBe(3);
    const ids = (await invoicesOf(sub.id)).map((i) => i.id);
    const periods = [];
    for (const id of ids) {
      const inv = (await staff.get(`${api}/invoices/${id}`)).body.data;
      periods.push([inv.periodStart, inv.periodEnd]);
    }
    expect(periods).toEqual([
      ['2026-01-31', '2026-02-27'],
      ['2026-02-28', '2026-03-30'],
      ['2026-03-31', '2026-04-29'],
    ]);
    expect((await staff.get(`${api}/subscriptions/${sub.id}`)).body.data.nextInvoiceDate).toBe('2026-04-30');
  });

  it('TC-BILL-05 two runs in parallel: still one invoice per period, no 500', async () => {
    const sub = await starterSub();
    const results = await Promise.all([run('2026-03-31'), run('2026-03-31')]);
    for (const r of results) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe('BILLING_RUN_IN_PROGRESS');
    }
    expect(results.reduce((n, r) => n + (r.body.data?.createdCount ?? 0), 0)).toBe(3);
    expect(await invoicesOf(sub.id)).toHaveLength(3);
  });

  it('TC-BILL-06 paused and past-expiry subscriptions are not billed', async () => {
    const paused = await starterSub();
    await staff.post(`${api}/subscriptions/${paused.id}/actions/pause`).send({});
    // Weekly-style expiry inside the first month: one period only, then nothing.
    const ending = await starterSub({ expiryDate: '2026-02-15' });
    await prisma.recurringPlan.update({ where: { id: c.monthly.id }, data: { autoClose: false } });
    const res = await run('2026-03-31');
    expect(res.body.data.createdCount).toBe(1);
    expect(await invoicesOf(paused.id)).toHaveLength(0);
    expect(await invoicesOf(ending.id)).toHaveLength(1);
  });

  it('confirmed subscriptions whose start date has come are activated and billed in the same run', async () => {
    const created = (await staff.post(`${api}/subscriptions`).send({ templateId: starter.id, customerId: accounts.customer.id, startDate: '2026-01-31' })).body.data;
    await prisma.subscription.update({ where: { id: created.id }, data: { status: 'CONFIRMED' } });
    const res = await run('2026-01-31');
    expect(res.body.data).toMatchObject({ activatedCount: 1, createdCount: 1 });
    const events = (await staff.get(`${api}/subscriptions/${created.id}/events`)).body.data;
    expect(events[0]).toMatchObject({ action: 'AUTO_ACTIVATE', toStatus: 'ACTIVE', user: null });
  });

  it('TC-SUB-08 auto-close: after expiry on an auto-close plan the run bills the last period, then closes it', async () => {
    const sub = await starterSub({ startDate: '2026-01-01', expiryDate: '2026-03-31' });
    const res = await run('2026-04-05');
    expect(res.body.data).toMatchObject({ createdCount: 3, closedCount: 1 });
    const after = (await staff.get(`${api}/subscriptions/${sub.id}`)).body.data;
    expect(after).toMatchObject({ status: 'CLOSED', closedAt: '2026-04-05', nextInvoiceDate: null });
    const events = (await staff.get(`${api}/subscriptions/${sub.id}/events`)).body.data;
    expect(events[0]).toMatchObject({ action: 'AUTO_CLOSE', fromStatus: 'ACTIVE', toStatus: 'CLOSED', user: null });
  });

  it('asOf more than one day ahead is refused; runs are listed newest first', async () => {
    const far = await run('2099-01-01');
    expect(far.status).toBe(400);
    expect(far.body.error.fields.asOf).toBeTruthy();
    await run('2026-01-31');
    await run('2026-02-28');
    const runs = (await staff.get(`${api}/billing/runs`)).body;
    expect(runs.total).toBe(2);
    expect(runs.data.map((r) => r.asOf)).toEqual(['2026-02-28', '2026-01-31']);
  });
});
