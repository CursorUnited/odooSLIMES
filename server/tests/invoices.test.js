import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { formatDate, today } from '../src/lib/dates.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';
import { seedStarter, activeSub } from './helpers/subs.js';

const app = createApp();
const api = '/api/v1';
let staff, customer, accounts, c, starter, tenPercent;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  c = await seedCatalog();
  ({ template: starter, tenPercent } = await seedStarter(c));
  [staff, customer] = await Promise.all([loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

const starterSub = (over = {}) =>
  activeSub(staff, { templateId: starter.id, customerId: accounts.customer.id, startDate: '2026-10-01', ...over });
/** Bills one period now and returns the new DRAFT invoice. */
const billNow = async (subId) => {
  const res = await staff.post(`${api}/subscriptions/${subId}/invoice`).send({});
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data;
};
const invAct = (id, action, agent = staff) => agent.post(`${api}/invoices/${id}/actions/${action}`).send({});

describe('bill now', () => {
  it('creates the invoice for the next period and advances; refuses non-active and past-expiry', async () => {
    const sub = await starterSub();
    const inv = await billNow(sub.id);
    expect(inv).toMatchObject({ status: 'DRAFT', invoiceDate: '2026-10-01', periodStart: '2026-10-01', periodEnd: '2026-10-31', total: '17145.40' });
    const second = await billNow(sub.id);
    expect(second.periodStart).toBe('2026-11-01'); // bill now works for a future period too

    const draft = (await staff.post(`${api}/subscriptions`).send({ templateId: starter.id, customerId: accounts.customer.id, startDate: '2026-10-01' })).body.data;
    expect((await staff.post(`${api}/subscriptions/${draft.id}/invoice`).send({})).body.error.code).toBe('SUB_INVALID_TRANSITION');

    const ending = await starterSub({ expiryDate: '2026-10-20' });
    await billNow(ending.id);
    const past = await staff.post(`${api}/subscriptions/${ending.id}/invoice`).send({});
    expect(past.status).toBe(409);
    expect(past.body.error.code).toBe('SUB_PAST_EXPIRY');
    expect((await customer.post(`${api}/subscriptions/${sub.id}/invoice`).send({})).status).toBe(403);
  });
});

describe('invoice actions', () => {
  it('TC-INV-01 confirm sets the due date from Net 15 and locks the invoice', async () => {
    const inv = await billNow((await starterSub()).id);
    const res = await invAct(inv.id, 'confirm');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CONFIRMED', dueDate: '2026-10-16', allowedActions: ['send', 'cancel'] });
    expect(res.body.data.confirmedAt).toBeTruthy();
    const again = await invAct(inv.id, 'confirm');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INV_INVALID_TRANSITION');
  });

  it('TC-INV-03 send needs a confirmed invoice; writes the INVOICE email and sentAt', async () => {
    const inv = await billNow((await starterSub()).id);
    expect((await invAct(inv.id, 'send')).body.error.code).toBe('INV_INVALID_TRANSITION');
    await invAct(inv.id, 'confirm');
    const sent = await invAct(inv.id, 'send');
    expect(sent.status).toBe(200);
    expect(sent.body.data.sentAt).toBeTruthy();
    const mail = await prisma.emailOutbox.findFirst({ where: { kind: 'INVOICE' } });
    expect(mail).toMatchObject({ toEmail: 'customer@brightloop.test', relatedId: inv.id });
    expect(mail.subject).toContain(inv.number);
    expect(mail.bodyHtml).toContain('17,145.40');
  });

  it('cancel works on DRAFT and CONFIRMED; not twice', async () => {
    const sub = await starterSub();
    const a = await billNow(sub.id);
    const b = await billNow(sub.id);
    expect((await invAct(a.id, 'cancel')).body.data.status).toBe('CANCELLED');
    await invAct(b.id, 'confirm');
    expect((await invAct(b.id, 'cancel')).body.data).toMatchObject({ status: 'CANCELLED', allowedActions: [] });
    expect((await invAct(b.id, 'cancel')).body.error.code).toBe('INV_INVALID_TRANSITION');
  });

  it('TC-DISC-06 usage limit 1: the second confirm is recalculated without the used-up discount', async () => {
    await prisma.discount.update({ where: { id: tenPercent.id }, data: { usageLimit: 1 } });
    const first = await billNow((await starterSub()).id);
    const second = await billNow((await starterSub()).id);
    expect(second.discounts).toHaveLength(1); // both drafts got it: usage is counted at confirm

    expect((await invAct(first.id, 'confirm')).body.data.total).toBe('17145.40');
    const res = await invAct(second.id, 'confirm');
    expect(res.status).toBe(200);
    // without the discount: 15,590 + 499 untaxed; tax 2,806.20 + 89.82 = 2,896.02; total 18,985.02
    expect(res.body.data).toMatchObject({ status: 'CONFIRMED', discountAmount: '0.00', taxAmount: '2896.02', total: '18985.02', discounts: [] });
    expect(res.body.warnings).toEqual(['DISCOUNT_EXHAUSTED: 10% for 10+ seats']);
  });

  it('TC-INV-05 confirm selected: each in its own transaction, failures listed', async () => {
    const sub = await starterSub();
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await billNow(sub.id)).id);
    await invAct(ids[0], 'confirm');
    const res = await staff.post(`${api}/invoices/actions/confirm-bulk`).send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.data.confirmed).toEqual([ids[1], ids[2]]);
    expect(res.body.data.failed).toMatchObject([{ id: ids[0], code: 'INV_INVALID_TRANSITION' }]);
  });
});

describe('lists, overdue and the customer view', () => {
  it('TC-INV-06 a confirmed invoice past its due date is overdue (filter + flag); drafts are not', async () => {
    const sub = await starterSub();
    const due = await billNow(sub.id);
    await billNow(sub.id); // stays DRAFT
    await invAct(due.id, 'confirm'); // due 2026-10-16
    const overdue = await staff.get(`${api}/invoices?overdue=true`);
    const expectOverdue = formatDate(today()) > '2026-10-16';
    expect(overdue.body.total).toBe(expectOverdue ? 1 : 0);
    if (expectOverdue) expect(overdue.body.data[0]).toMatchObject({ id: due.id, isOverdue: true, amountDue: '17145.40' });
    expect((await staff.get(`${api}/invoices?status=draft`)).body.total).toBe(1);
    expect((await staff.get(`${api}/invoices?status=DRAFT,CONFIRMED`)).body.total).toBe(2);
  });

  it('customers see only their own CONFIRMED/PAID invoices, read-only', async () => {
    const sub = await starterSub();
    const confirmed = await billNow(sub.id);
    const draft = await billNow(sub.id);
    await invAct(confirmed.id, 'confirm');

    const list = await customer.get(`${api}/invoices`);
    expect(list.body.data.map((i) => i.id)).toEqual([confirmed.id]);
    expect((await customer.get(`${api}/invoices/${draft.id}`)).status).toBe(404);
    const mine = await customer.get(`${api}/invoices/${confirmed.id}`);
    expect(mine.body.data.allowedActions).toEqual([]);
    expect((await invAct(confirmed.id, 'send', customer)).status).toBe(403);

    const other = await prisma.customer.create({ data: { name: 'Other Co', email: 'other@co.in' } });
    const theirs = await billNow((await starterSub({ customerId: other.id })).id);
    await invAct(theirs.id, 'confirm');
    expect((await customer.get(`${api}/invoices/${theirs.id}`)).status).toBe(404);
  });
});

