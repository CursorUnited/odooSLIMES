import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { addDays, formatDate, parseDate, today } from '../src/lib/dates.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';

const app = createApp();
const api = '/api/v1';
const TODAY = formatDate(today());
const inDays = (n) => formatDate(addDays(today(), n));

let admin, staff, customer, accounts, c, starter;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  c = await seedCatalog();
  starter = await prisma.quotationTemplate.create({
    data: {
      name: 'Starter CRM (monthly)', planId: c.monthly.id, validityDays: 15, paymentTermId: c.net15.id,
      lines: { create: [{ productId: c.crm.id, variantId: c.odoo.id, quantity: 10, description: 'CRM seats' }] },
    },
  });
  [admin, staff, customer] = await Promise.all([loginAs(app, 'ADMIN'), loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

const fromTemplate = (over = {}) =>
  staff
    .post(`${api}/subscriptions`)
    .send({ templateId: starter.id, customerId: accounts.customer.id, startDate: TODAY, ...over })
    .then((r) => r.body.data);
const act = (agent, id, action, note) => agent.post(`${api}/subscriptions/${id}/actions/${action}`).send(note ? { note } : {});

describe('lifecycle actions', () => {
  it('TC-SUB-03 DRAFT → QUOTATION → CONFIRMED → ACTIVE → CLOSED, one event each, quote email in outbox', async () => {
    const { id } = await fromTemplate();

    const quote = await act(staff, id, 'send-quotation');
    expect(quote.status).toBe(200);
    expect(quote.body.data).toMatchObject({ status: 'QUOTATION', quotationValidUntil: inDays(15) });
    const mail = await prisma.emailOutbox.findFirst({ where: { kind: 'QUOTATION' } });
    expect(mail).toMatchObject({ toEmail: 'customer@brightloop.test', relatedId: id });
    expect(mail.subject).toContain('SUB/2026/00001');

    // start date = today, so confirm continues straight to ACTIVE
    const confirmed = await act(staff, id, 'confirm');
    expect(confirmed.body.data).toMatchObject({ status: 'ACTIVE', nextInvoiceDate: TODAY });
    expect(confirmed.body.data.allowedActions).toEqual(expect.arrayContaining(['pause', 'close']));

    const closed = await act(staff, id, 'close', 'Customer moved to another vendor');
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', closedAt: TODAY, nextInvoiceDate: null, allowedActions: [] });

    const events = (await staff.get(`${api}/subscriptions/${id}/events`)).body.data;
    expect(events.map((e) => [e.action, e.fromStatus, e.toStatus])).toEqual([
      ['CLOSE', 'ACTIVE', 'CLOSED'],
      ['ACTIVATE', 'CONFIRMED', 'ACTIVE'],
      ['CONFIRM', 'QUOTATION', 'CONFIRMED'],
      ['SEND_QUOTATION', 'DRAFT', 'QUOTATION'],
      ['CREATE', null, 'DRAFT'],
    ]);
    expect(events[0]).toMatchObject({ note: 'Customer moved to another vendor', user: { name: 'Ravi Staff' } });
  });

  it('a future start date stays CONFIRMED and refuses manual activate', async () => {
    const { id } = await fromTemplate({ startDate: inDays(5) });
    const confirmed = await act(staff, id, 'confirm');
    expect(confirmed.body.data).toMatchObject({ status: 'CONFIRMED', nextInvoiceDate: null });
    expect(confirmed.body.data.allowedActions).not.toContain('activate');
    const early = await act(staff, id, 'activate');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SUB_INVALID_TRANSITION');
  });

  it('TC-SUB-04 invalid transitions: activate a DRAFT, confirm a CLOSED', async () => {
    const { id } = await fromTemplate();
    expect((await act(staff, id, 'activate')).body.error.code).toBe('SUB_INVALID_TRANSITION');
    await act(staff, id, 'close');
    const res = await act(staff, id, 'confirm');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUB_INVALID_TRANSITION');
  });

  it('TC-SUB-05 confirm guards: no lines, below plan minimum, outside plan dates, expired quote', async () => {
    const empty = (
      await staff.post(`${api}/subscriptions`).send({ customerId: accounts.customer.id, planId: c.monthly.id, startDate: TODAY, lines: [] })
    ).body.data;
    expect((await act(staff, empty.id, 'confirm')).body.error.code).toBe('SUB_NO_LINES');
    expect((await act(staff, empty.id, 'send-quotation')).body.error.code).toBe('SUB_NO_LINES');

    const draft = await fromTemplate();
    await prisma.recurringPlan.update({ where: { id: c.monthly.id }, data: { minQuantity: 20 } });
    const min = await act(staff, draft.id, 'confirm');
    expect(min.status).toBe(400);
    expect(min.body.error.code).toBe('SUB_MIN_QUANTITY');
    expect(min.body.error.fields['lines.0.quantity']).toBe('Quantity must be at least 20 for the Monthly plan.');

    await prisma.recurringPlan.update({ where: { id: c.monthly.id }, data: { minQuantity: 1, endDate: parseDate('2026-06-30') } });
    expect((await act(staff, draft.id, 'confirm')).body.error.code).toBe('SUB_PLAN_NOT_AVAILABLE');
    await prisma.recurringPlan.update({ where: { id: c.monthly.id }, data: { endDate: null } });

    await act(staff, draft.id, 'send-quotation');
    await prisma.subscription.update({ where: { id: draft.id }, data: { quotationValidUntil: addDays(today(), -1) } });
    const expired = await act(staff, draft.id, 'confirm');
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('SUB_QUOTE_EXPIRED');
  });

  it('TC-SUB-06 pause on a non-pausable plan is SUB_PLAN_OPTION_DISABLED and not offered', async () => {
    const res = await staff.post(`${api}/subscriptions`).send({
      customerId: accounts.customer.id, planId: c.yearly.id, startDate: TODAY, lines: [{ productId: c.analytics.id, quantity: 5 }],
    });
    const active = (await act(staff, res.body.data.id, 'confirm')).body.data;
    expect(active.status).toBe('ACTIVE');
    expect(active.allowedActions).not.toContain('pause');
    const pause = await act(staff, active.id, 'pause');
    expect(pause.status).toBe(409);
    expect(pause.body.error.code).toBe('SUB_PLAN_OPTION_DISABLED');
  });

  it('resume after a long pause: next bill is the first period start on or after today (paused periods not billed)', async () => {
    const { id } = await fromTemplate({ startDate: '2026-01-31' });
    await act(staff, id, 'confirm');
    expect((await act(staff, id, 'pause')).body.data.status).toBe('PAUSED');
    await prisma.subscription.update({ where: { id }, data: { nextInvoiceDate: parseDate('2026-02-28') } });

    const resumed = (await act(staff, id, 'resume')).body.data;
    // Monthly schedule anchored on 31 Jan (month-end clamped), written out by hand:
    const schedule = ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31',
      '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'];
    expect(resumed).toMatchObject({ status: 'ACTIVE', nextInvoiceDate: schedule.find((s) => s >= TODAY) });
  });

  it('TC-SUB-07 renew adds one original term to the expiry; open-ended gives SUB_NO_EXPIRY', async () => {
    const { id } = await fromTemplate({ startDate: '2026-01-01', expiryDate: '2026-12-31' });
    await act(staff, id, 'confirm');
    const renewed = await act(staff, id, 'renew');
    expect(renewed.body.data.expiryDate).toBe('2027-12-30'); // + (31 Dec − 1 Jan) = 364 days
    const events = (await staff.get(`${api}/subscriptions/${id}/events`)).body.data;
    expect(events[0]).toMatchObject({ action: 'RENEW', fromStatus: 'ACTIVE', toStatus: 'ACTIVE', note: 'Renewed to 2027-12-30' });

    const open = await fromTemplate();
    await act(staff, open.id, 'confirm');
    const res = await act(staff, open.id, 'renew');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUB_NO_EXPIRY');
  });

  it('confirmed subscriptions cannot be edited (SUB_NOT_EDITABLE)', async () => {
    const { id } = await fromTemplate();
    await act(staff, id, 'confirm');
    const res = await staff.patch(`${api}/subscriptions/${id}`).send({ notes: 'late change' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUB_NOT_EDITABLE');
  });

  it('PLAN_IN_USE: the period of a plan with ACTIVE subscriptions cannot change', async () => {
    const { id } = await fromTemplate();
    await act(staff, id, 'confirm');
    const res = await admin.patch(`${api}/plans/${c.monthly.id}`).send({ billingPeriod: 'WEEKLY' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_IN_USE');
  });
});

describe('customer portal (TC-SUB-10, R-29)', () => {
  it('customer sees only own subscriptions; another customer’s id is 404', async () => {
    const own = await fromTemplate();
    const other = await prisma.customer.create({ data: { name: 'Other Co', email: 'other@co.in' } });
    const theirs = await fromTemplate({ customerId: other.id });

    const list = await customer.get(`${api}/subscriptions`);
    expect(list.body.data.map((s) => s.id)).toEqual([own.id]);
    expect((await customer.get(`${api}/subscriptions/${theirs.id}`)).status).toBe(404);
    expect((await customer.get(`${api}/subscriptions/${theirs.id}/events`)).status).toBe(404);
    expect((await act(customer, theirs.id, 'pause')).status).toBe(404);
  });

  it('customer may pause, resume, renew and close own active subscription, but not confirm or cancel a quote', async () => {
    const draft = await fromTemplate({ expiryDate: inDays(365) });
    expect((await act(customer, draft.id, 'confirm')).status).toBe(403);
    expect((await act(customer, draft.id, 'close')).body.error.code).toBe('SUB_INVALID_TRANSITION');

    await act(staff, draft.id, 'confirm');
    const view = (await customer.get(`${api}/subscriptions/${draft.id}`)).body.data;
    expect(view.allowedActions.sort()).toEqual(['close', 'pause', 'renew']);

    expect((await act(customer, draft.id, 'pause')).body.data.status).toBe('PAUSED');
    expect((await act(customer, draft.id, 'resume')).body.data.status).toBe('ACTIVE');
    expect((await act(customer, draft.id, 'close')).body.data.status).toBe('CLOSED');
    const events = (await staff.get(`${api}/subscriptions/${draft.id}/events`)).body.data;
    expect(events[0].user).toMatchObject({ name: 'Kanpur Mart' });
  });

  it('list filters: status (comma list), plan, q by number or customer name', async () => {
    const a = await fromTemplate();
    await fromTemplate();
    await act(staff, a.id, 'confirm');
    const active = await staff.get(`${api}/subscriptions?status=ACTIVE`);
    expect(active.body.data.map((s) => s.id)).toEqual([a.id]);
    expect((await staff.get(`${api}/subscriptions?status=draft,active`)).body.total).toBe(2);
    expect((await staff.get(`${api}/subscriptions?q=00002`)).body.total).toBe(1);
    expect((await staff.get(`${api}/subscriptions?q=kanpur`)).body.total).toBe(2);
    expect((await staff.get(`${api}/subscriptions?planId=${c.yearly.id}`)).body.total).toBe(0);
  });
});
