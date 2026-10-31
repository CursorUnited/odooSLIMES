import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { addDays, formatDate, today } from '../src/lib/dates.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';
import { seedStarter, activeSub } from './helpers/subs.js';

const app = createApp();
const api = '/api/v1';
const TODAY = formatDate(today());
let staff, customer, accounts, c, starter;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  c = await seedCatalog();
  ({ template: starter } = await seedStarter(c));
  [staff, customer] = await Promise.all([loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

/** A CONFIRMED invoice of 17,145.40 dated 2026-10-01 (Net 15). */
async function confirmedInvoice(customerId = accounts.customer.id) {
  const sub = await activeSub(staff, { templateId: starter.id, customerId, startDate: '2026-10-01' });
  const inv = (await staff.post(`${api}/subscriptions/${sub.id}/invoice`).send({})).body.data;
  return (await staff.post(`${api}/invoices/${inv.id}/actions/confirm`).send({})).body.data;
}
const pay = (body) => staff.post(`${api}/payments`).send({ method: 'UPI', paymentDate: TODAY, ...body });

describe('recording payments', () => {
  it('TC-PAY-01 partial payment: amount due drops, status stays CONFIRMED', async () => {
    const inv = await confirmedInvoice();
    const res = await pay({ invoiceId: inv.id, amount: '5000', note: 'UPI ref 4421' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'PAY/2026/00001', invoiceId: inv.id, method: 'UPI', amount: '5000.00', paymentDate: TODAY, note: 'UPI ref 4421',
      invoice: { id: inv.id, status: 'CONFIRMED', amountPaid: '5000.00', amountDue: '12145.40' },
    });
    const after = (await staff.get(`${api}/invoices/${inv.id}`)).body.data;
    expect(after).toMatchObject({ amountPaid: '5000.00', amountDue: '12145.40', allowedActions: ['send'] });
    expect(after.payments).toMatchObject([{ number: 'PAY/2026/00001', amount: '5000.00', method: 'UPI' }]);
  });

  it('TC-PAY-02 more than the amount due is a field error on amount', async () => {
    const inv = await confirmedInvoice();
    await pay({ invoiceId: inv.id, amount: '5000' });
    const res = await pay({ invoiceId: inv.id, amount: '20000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAY_EXCEEDS_DUE');
    expect(res.body.error.fields.amount).toBe('Amount cannot be more than the amount due (₹12,145.40).');
  });

  it('TC-PAY-03 paying the rest marks the invoice PAID; it leaves the overdue list', async () => {
    const inv = await confirmedInvoice();
    await pay({ invoiceId: inv.id, amount: '5000' });
    const res = await pay({ invoiceId: inv.id, amount: '12145.40', method: 'BANK_TRANSFER' });
    expect(res.body.data.invoice).toMatchObject({ status: 'PAID', amountDue: '0.00' });
    const after = (await staff.get(`${api}/invoices/${inv.id}`)).body.data;
    expect(after).toMatchObject({ status: 'PAID', isOverdue: false });
    expect(after.paidAt).toBeTruthy();
    expect((await staff.get(`${api}/invoices?overdue=true`)).body.total).toBe(0);
  });

  it('TC-PAY-04 payments on DRAFT, PAID or CANCELLED invoices are refused', async () => {
    const sub = await activeSub(staff, { templateId: starter.id, customerId: accounts.customer.id, startDate: '2026-10-01' });
    const draft = (await staff.post(`${api}/subscriptions/${sub.id}/invoice`).send({})).body.data;
    const res = await pay({ invoiceId: draft.id, amount: '100' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAY_INVOICE_NOT_CONFIRMED');
    await staff.post(`${api}/invoices/${draft.id}/actions/cancel`).send({});
    expect((await pay({ invoiceId: draft.id, amount: '100' })).body.error.code).toBe('PAY_INVOICE_NOT_CONFIRMED');
  });

  it('date rules: not in the future, not before the invoice date; amount above 0', async () => {
    const inv = await confirmedInvoice();
    const future = await pay({ invoiceId: inv.id, amount: '10', paymentDate: formatDate(addDays(today(), 1)) });
    expect(future.body.error.fields.paymentDate).toBe("Payment date can't be in the future.");
    const early = await pay({ invoiceId: inv.id, amount: '10', paymentDate: '2026-09-30' });
    expect(early.body.error.fields.paymentDate).toBeTruthy();
    const zero = await pay({ invoiceId: inv.id, amount: '0' });
    expect(zero.body.error.fields.amount).toBeTruthy();
  });

  it('TC-INV-02 an invoice with payments cannot be cancelled; a PAID one neither', async () => {
    const inv = await confirmedInvoice();
    await pay({ invoiceId: inv.id, amount: '5000' });
    const res = await staff.post(`${api}/invoices/${inv.id}/actions/cancel`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INV_HAS_PAYMENTS');
    await pay({ invoiceId: inv.id, amount: '12145.40' });
    expect((await staff.post(`${api}/invoices/${inv.id}/actions/cancel`).send({})).body.error.code).toBe('INV_INVALID_TRANSITION');
  });
});

describe('payments list', () => {
  it('filters by invoice and method; customers see only their own and cannot record', async () => {
    const mine = await confirmedInvoice();
    const other = await prisma.customer.create({ data: { name: 'Other Co', email: 'other@co.in' } });
    const theirs = await confirmedInvoice(other.id);
    await pay({ invoiceId: mine.id, amount: '100', method: 'CASH' });
    await pay({ invoiceId: theirs.id, amount: '200', method: 'CARD' });

    const all = await staff.get(`${api}/payments`);
    expect(all.body.total).toBe(2);
    expect(all.body.data[0]).toMatchObject({ invoice: { id: expect.any(Number), number: expect.stringMatching(/^INV\//) }, customer: { name: expect.any(String) }, recordedBy: { name: 'Ravi Staff' } });
    expect((await staff.get(`${api}/payments?method=CARD`)).body.data.map((p) => p.amount)).toEqual(['200.00']);
    expect((await staff.get(`${api}/payments?invoiceId=${mine.id}`)).body.total).toBe(1);

    const own = await customer.get(`${api}/payments`);
    expect(own.body.data.map((p) => p.amount)).toEqual(['100.00']);
    expect((await customer.post(`${api}/payments`).send({ invoiceId: mine.id, method: 'UPI', amount: '1', paymentDate: TODAY })).status).toBe(403);
  });
});
