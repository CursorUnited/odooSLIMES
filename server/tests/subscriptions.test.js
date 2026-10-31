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
  await prisma.discount.create({
    data: {
      name: '10% for 10+ seats', type: 'PERCENT', value: '10', scope: 'PRODUCT', minQuantity: 10,
      startDate: parseDate('2026-01-01'), usageLimit: 100, products: { connect: [{ id: c.crm.id }] },
    },
  });
  starter = await prisma.quotationTemplate.create({
    data: {
      name: 'Starter CRM (monthly)', planId: c.monthly.id, validityDays: 15, paymentTermId: c.net15.id, notes: '10 seats',
      lines: { create: [{ productId: c.crm.id, variantId: c.odoo.id, quantity: 10, description: 'CRM seats' }] },
    },
  });
  [admin, staff, customer] = await Promise.all([loginAs(app, 'ADMIN'), loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

const fromTemplate = (over = {}) =>
  staff.post(`${api}/subscriptions`).send({ templateId: starter.id, customerId: accounts.customer.id, startDate: TODAY, ...over });

describe('create and read', () => {
  it('TC-SUB-01 from a template: DRAFT with plan, lines, terms copied and the next-invoice preview', async () => {
    const res = await fromTemplate({ expiryDate: inDays(365) });
    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s).toMatchObject({
      number: 'SUB/2026/00001', status: 'DRAFT', startDate: TODAY, expiryDate: inDays(365),
      nextInvoiceDate: null, quotationValidUntil: null, notes: '10 seats',
      customer: { id: accounts.customer.id, name: 'Kanpur Mart' },
      plan: { id: c.monthly.id, name: 'Monthly', price: '499.00', minQuantity: 1, pausable: true },
      template: { id: starter.id, name: 'Starter CRM (monthly)' },
      paymentTerm: { id: c.net15.id, name: 'Net 15', dueDays: 15 },
      lines: [{
        product: { id: c.crm.id, name: 'Brightloop CRM' }, variant: { id: c.odoo.id, label: 'Brand: Odoo' },
        description: 'CRM seats', quantity: 10, unitPrice: '1559.00', taxes: [{ name: 'GST 18%', rate: '18.00' }],
        amount: '15590.00', discountAmount: '1559.00', taxAmount: '2525.58', total: '16556.58',
      }],
      baseFee: { amount: '499.00', taxAmount: '89.82', total: '588.82' },
      appliedDiscounts: [{ name: '10% for 10+ seats', amount: '1559.00' }],
      totals: { untaxed: '16089.00', discount: '1559.00', tax: '2615.40', total: '17145.40' },
      createdBy: { name: 'Ravi Staff' },
    });
    expect(s.allowedActions).toEqual(expect.arrayContaining(['send-quotation', 'confirm', 'close']));

    const got = await staff.get(`${api}/subscriptions/${s.id}`);
    expect(got.body.data.totals.total).toBe('17145.40');
  });

  it('TC-SUB-02 numbers are unique and increasing', async () => {
    const numbers = [];
    for (let i = 0; i < 3; i += 1) numbers.push((await fromTemplate()).body.data.number);
    expect(numbers).toEqual(['SUB/2026/00001', 'SUB/2026/00002', 'SUB/2026/00003']);
  });

  it('list row has recurringTotal; history starts with CREATE', async () => {
    const { body } = await fromTemplate();
    const list = await staff.get(`${api}/subscriptions`);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({
      number: 'SUB/2026/00001', status: 'DRAFT', customer: { name: 'Kanpur Mart' },
      plan: { name: 'Monthly', billingPeriod: 'MONTHLY' }, recurringTotal: '17145.40',
    });
    const events = await staff.get(`${api}/subscriptions/${body.data.id}/events`);
    expect(events.body.data).toMatchObject([{ action: 'CREATE', fromStatus: null, toStatus: 'DRAFT', user: { name: 'Ravi Staff' } }]);
  });
});

describe('create from scratch, validation, preview, edit', () => {
  const scratch = (over = {}) => ({
    customerId: accounts.customer.id, planId: c.monthly.id, startDate: TODAY, paymentTermId: c.net30.id,
    lines: [{ productId: c.analytics.id, quantity: 2 }], ...over,
  });

  it('defaults unit price and taxes from the product; a negotiated price is kept', async () => {
    const res = await staff.post(`${api}/subscriptions`).send(scratch({
      lines: [{ productId: c.analytics.id, quantity: 2 }, { productId: c.crm.id, variantId: c.generic.id, quantity: 1, unitPrice: '900', taxIds: [] }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.data.lines).toMatchObject([
      { quantity: 2, unitPrice: '299.00', taxes: [{ name: 'GST 18%' }], amount: '598.00' },
      { quantity: 1, unitPrice: '900.00', taxes: [], amount: '900.00', taxAmount: '0.00' },
    ]);
    expect(res.body.data.paymentTerm.name).toBe('Net 30');
  });

  it('without a payment term it defaults to Immediate', async () => {
    const res = await staff.post(`${api}/subscriptions`).send(scratch({ paymentTermId: undefined }));
    expect(res.body.data.paymentTerm.name).toBe('Immediate');
  });

  it('SUB_MIN_QUANTITY under the line; SUB_PLAN_NOT_AVAILABLE under start date; expiry after start; plan required', async () => {
    const minQty = await staff.post(`${api}/subscriptions`).send(scratch({ planId: c.yearly.id }));
    expect(minQty.status).toBe(400);
    expect(minQty.body.error.code).toBe('SUB_MIN_QUANTITY');
    expect(minQty.body.error.fields['lines.0.quantity']).toBe('Quantity must be at least 5 for the Yearly plan.');

    const window = await staff.post(`${api}/subscriptions`).send(scratch({ startDate: '2025-12-31' }));
    expect(window.body.error.code).toBe('SUB_PLAN_NOT_AVAILABLE');
    expect(window.body.error.fields.startDate).toMatch(/available from 2026-01-01/);

    const expiry = await staff.post(`${api}/subscriptions`).send(scratch({ expiryDate: TODAY }));
    expect(expiry.body.error.fields.expiryDate).toBe('Expiry date must be after the start date.');

    const noPlan = await staff.post(`${api}/subscriptions`).send(scratch({ planId: undefined }));
    expect(noPlan.body.error.fields.planId).toBeTruthy();
  });

  it('preview returns totals and saves nothing', async () => {
    const res = await staff.post(`${api}/subscriptions/preview`).send({ templateId: starter.id, customerId: accounts.customer.id, startDate: TODAY });
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({ untaxed: '16089.00', discount: '1559.00', tax: '2615.40', total: '17145.40' });
    expect(res.body.data.lines[0]).toMatchObject({ quantity: 10, unitPrice: '1559.00', discountAmount: '1559.00' });
    expect((await staff.get(`${api}/subscriptions`)).body.total).toBe(0);
  });

  it('PATCH in DRAFT replaces lines and recomputes totals; customers cannot create', async () => {
    const { body } = await fromTemplate();
    const res = await staff.patch(`${api}/subscriptions/${body.data.id}`).send({ lines: [{ productId: c.crm.id, variantId: c.odoo.id, quantity: 9 }] });
    expect(res.status).toBe(200);
    // 9 seats: no discount. 9 × 1559 = 14031 + 499 = 14530; tax 2615.40; total 17145.40
    expect(res.body.data.totals).toEqual({ untaxed: '14530.00', discount: '0.00', tax: '2615.40', total: '17145.40' });
    expect(res.body.data.appliedDiscounts).toEqual([]);
    expect((await customer.post(`${api}/subscriptions`).send(scratch())).status).toBe(403);
  });
});
