import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';

const app = createApp();
const api = '/api/v1';
let admin;
let staff;
let customer;

beforeEach(async () => {
  await resetDb();
  await seedAccounts();
  [admin, staff, customer] = await Promise.all([loginAs(app, 'ADMIN'), loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

describe('taxes', () => {
  it('admin creates a percent tax; staff can list it but not create', async () => {
    const res = await admin.post(`${api}/taxes`).send({ name: 'GST 18%', type: 'PERCENT', rate: '18' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'GST 18%', type: 'PERCENT', rate: '18.00', isActive: true });

    const list = await staff.get(`${api}/taxes`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].rate).toBe('18.00');

    expect((await staff.post(`${api}/taxes`).send({ name: 'GST 5%', type: 'PERCENT', rate: '5' })).status).toBe(403);
    expect((await customer.get(`${api}/taxes`)).status).toBe(403);
  });

  it('rejects a percent rate above 100 and a duplicate name', async () => {
    const bad = await admin.post(`${api}/taxes`).send({ name: 'Too much', type: 'PERCENT', rate: '120' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.rate).toBeTruthy();

    await admin.post(`${api}/taxes`).send({ name: 'GST 18%', type: 'PERCENT', rate: '18' });
    const dup = await admin.post(`${api}/taxes`).send({ name: 'GST 18%', type: 'PERCENT', rate: '18' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
  });

  it('admin deactivates a tax with PATCH', async () => {
    const { body } = await admin.post(`${api}/taxes`).send({ name: 'Cess', type: 'FIXED', rate: '2.50' });
    const res = await admin.patch(`${api}/taxes/${body.data.id}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isActive: false, rate: '2.50', type: 'FIXED' });
  });
});

describe('payment terms', () => {
  it('admin creates Net 30; staff lists it; due days must be 0..365', async () => {
    const res = await admin.post(`${api}/payment-terms`).send({ name: 'Net 30', dueDays: 30 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Net 30', dueDays: 30 });

    const list = await staff.get(`${api}/payment-terms`);
    expect(list.body.data.map((t) => t.name)).toEqual(['Net 30']);

    const bad = await admin.post(`${api}/payment-terms`).send({ name: 'Forever', dueDays: 400 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.dueDays).toBeTruthy();
    expect((await staff.post(`${api}/payment-terms`).send({ name: 'Net 7', dueDays: 7 })).status).toBe(403);
  });
});

describe('products and variants', () => {
  const gst18 = () => admin.post(`${api}/taxes`).send({ name: 'GST 18%', type: 'PERCENT', rate: '18' }).then((r) => r.body.data);

  it('TC-CAT-01 product with Brand = Odoo variant shows price base + 560', async () => {
    const tax = await gst18();
    const res = await admin.post(`${api}/products`).send({
      name: 'Brightloop CRM', type: 'SERVICE', salesPrice: '1000', costPrice: '400', notes: 'Per-seat CRM licence',
      taxIds: [tax.id], variants: [{ attribute: 'Brand', value: 'Odoo', extraPrice: '560' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Brightloop CRM', type: 'SERVICE', salesPrice: '1000.00', costPrice: '400.00', notes: 'Per-seat CRM licence', isActive: true,
      taxes: [{ id: tax.id, name: 'GST 18%', type: 'PERCENT', rate: '18.00' }],
      variants: [{ attribute: 'Brand', value: 'Odoo', extraPrice: '560.00', price: '1560.00', isActive: true }],
    });

    const one = await staff.get(`${api}/products/${res.body.data.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.variants[0].price).toBe('1560.00');

    const list = await staff.get(`${api}/products`);
    expect(list.body.data[0]).toMatchObject({ name: 'Brightloop CRM', salesPrice: '1000.00', variantCount: 1 });
  });

  it('TC-CAT-02 negative price and empty name give field errors', async () => {
    const res = await admin.post(`${api}/products`).send({ name: ' ', type: 'SERVICE', salesPrice: '-5', costPrice: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['name', 'salesPrice']));
  });

  it('TC-CAT-03 the same variant twice gives DUPLICATE', async () => {
    const { body } = await admin.post(`${api}/products`).send({
      name: 'Brightloop CRM', type: 'SERVICE', salesPrice: '999', costPrice: '300',
      variants: [{ attribute: 'Brand', value: 'Odoo', extraPrice: '560' }],
    });
    const dup = await admin.post(`${api}/products/${body.data.id}/variants`).send({ attribute: 'Brand', value: 'Odoo', extraPrice: '10' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');

    const added = await admin.post(`${api}/products/${body.data.id}/variants`).send({ attribute: 'Brand', value: 'Zoho', extraPrice: '120' });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ value: 'Zoho', extraPrice: '120.00', price: '1119.00' });

    const patched = await admin.patch(`${api}/variants/${added.body.data.id}`).send({ extraPrice: '200', isActive: false });
    expect(patched.body.data).toMatchObject({ extraPrice: '200.00', price: '1199.00', isActive: false });
  });

  it('duplicate active product name is refused; archive hides it from the default list', async () => {
    const body = { name: 'Analytics Add-on', type: 'SERVICE', salesPrice: '299', costPrice: '80' };
    const { body: created } = await admin.post(`${api}/products`).send(body);
    expect((await admin.post(`${api}/products`).send(body)).body.error.code).toBe('DUPLICATE');

    const archived = await admin.patch(`${api}/products/${created.data.id}`).send({ isActive: false });
    expect(archived.body.data.isActive).toBe(false);
    expect((await admin.get(`${api}/products`)).body.total).toBe(0);
    expect((await admin.get(`${api}/products?isActive=false`)).body.total).toBe(1);
  });

  it('staff and customers cannot write products; customers cannot read them', async () => {
    const body = { name: 'Priority Support', type: 'SERVICE', salesPrice: '1499', costPrice: '500' };
    expect((await staff.post(`${api}/products`).send(body)).status).toBe(403);
    expect((await customer.get(`${api}/products`)).status).toBe(403);
  });

  it('an unknown tax id is a field error', async () => {
    const res = await admin.post(`${api}/products`).send({ name: 'Thing', type: 'GOODS', salesPrice: '1', costPrice: '1', taxIds: [999] });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.taxIds).toBeTruthy();
  });
});

describe('recurring plans', () => {
  const monthly = {
    name: 'Monthly', price: '499', billingPeriod: 'MONTHLY', intervalCount: 1, minQuantity: 1,
    startDate: '2026-10-01', endDate: null, autoClose: true, closable: true, pausable: true, renewable: false,
  };

  it('TC-CAT-05 admin creates a monthly plan with options; staff reads it', async () => {
    const tax = (await admin.post(`${api}/taxes`).send({ name: 'GST 18%', type: 'PERCENT', rate: '18' })).body.data;
    const res = await admin.post(`${api}/plans`).send({ ...monthly, taxIds: [tax.id] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Monthly', price: '499.00', billingPeriod: 'MONTHLY', intervalCount: 1, minQuantity: 1,
      startDate: '2026-10-01', endDate: null, autoClose: true, closable: true, pausable: true, renewable: false, isActive: true,
      taxes: [{ id: tax.id, rate: '18.00' }],
    });

    const one = await staff.get(`${api}/plans/${res.body.data.id}`);
    expect(one.body.data).toMatchObject({ name: 'Monthly', activeSubscriptions: 0 });
    expect((await staff.post(`${api}/plans`).send({ ...monthly, name: 'Other' })).status).toBe(403);
  });

  it('TC-CAT-04 end date before start date and min quantity 0 are field errors', async () => {
    const res = await admin.post(`${api}/plans`).send({ ...monthly, startDate: '2026-10-01', endDate: '2026-09-30', minQuantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.fields).toHaveProperty('endDate');
    expect(res.body.error.fields).toHaveProperty('minQuantity');
  });

  it('duplicate plan name gives DUPLICATE; PATCH changes options', async () => {
    const { body } = await admin.post(`${api}/plans`).send(monthly);
    expect((await admin.post(`${api}/plans`).send(monthly)).body.error.code).toBe('DUPLICATE');
    const patched = await admin.patch(`${api}/plans/${body.data.id}`).send({ renewable: true, price: '599.5' });
    expect(patched.body.data).toMatchObject({ renewable: true, price: '599.50' });
    const badPatch = await admin.patch(`${api}/plans/${body.data.id}`).send({ endDate: '2026-01-01' });
    expect(badPatch.body.error.fields).toHaveProperty('endDate');
  });

  it('availableOn lists only plans whose window contains the date', async () => {
    await admin.post(`${api}/plans`).send(monthly);
    await admin.post(`${api}/plans`).send({ ...monthly, name: 'Diwali', startDate: '2026-10-15', endDate: '2026-11-15' });
    const names = async (d) => (await staff.get(`${api}/plans?availableOn=${d}&sort=name`)).body.data.map((p) => p.name);
    expect(await names('2026-10-05')).toEqual(['Monthly']);
    expect(await names('2026-11-01')).toEqual(['Diwali', 'Monthly']);
  });
});

describe('quotation templates', () => {
  let c;
  beforeEach(async () => {
    c = await seedCatalog();
  });

  it('TC-CAT-06 admin creates a template with plan, 2 lines and 15-day validity', async () => {
    const res = await admin.post(`${api}/quotation-templates`).send({
      name: 'CRM 10 seats', planId: c.monthly.id, validityDays: 15, paymentTermId: c.net15.id, notes: 'Starter pack',
      lines: [
        { productId: c.crm.id, variantId: c.odoo.id, quantity: 10, description: 'CRM seats' },
        { productId: c.analytics.id, variantId: null, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'CRM 10 seats', validityDays: 15, notes: 'Starter pack',
      plan: { id: c.monthly.id, name: 'Monthly' }, paymentTerm: { id: c.net15.id, name: 'Net 15', dueDays: 15 },
      lines: [
        { product: { id: c.crm.id, name: 'Brightloop CRM' }, variant: { id: c.odoo.id, label: 'Brand: Odoo' }, quantity: 10, unitPrice: '1559.00', description: 'CRM seats' },
        { product: { id: c.analytics.id, name: 'Analytics Add-on' }, variant: null, quantity: 1, unitPrice: '299.00' },
      ],
    });

    const list = await staff.get(`${api}/quotation-templates`);
    expect(list.body.data[0]).toMatchObject({ name: 'CRM 10 seats', plan: { id: c.monthly.id, name: 'Monthly' }, validityDays: 15, lineCount: 2 });
    const one = await staff.get(`${api}/quotation-templates/${res.body.data.id}`);
    expect(one.body.data.lines).toHaveLength(2);
  });

  it('defaults validity to 30 days; rejects 0 and 400', async () => {
    const base = { name: 'Tmpl', planId: c.monthly.id, lines: [{ productId: c.analytics.id, quantity: 1 }] };
    expect((await admin.post(`${api}/quotation-templates`).send(base)).body.data.validityDays).toBe(30);
    for (const validityDays of [0, 400]) {
      const res = await admin.post(`${api}/quotation-templates`).send({ ...base, name: `Tmpl ${validityDays}`, validityDays });
      expect(res.body.error.fields).toHaveProperty('validityDays');
    }
  });

  it('variant of another product and quantity below the plan minimum are line field errors', async () => {
    const res = await admin.post(`${api}/quotation-templates`).send({
      name: 'Bad', planId: c.yearly.id,
      lines: [
        { productId: c.analytics.id, variantId: c.odoo.id, quantity: 5 },
        { productId: c.crm.id, variantId: c.odoo.id, quantity: 2 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.fields).toHaveProperty('lines.0.variantId');
    expect(res.body.error.fields['lines.1.quantity']).toMatch(/at least 5/);
  });

  it('PATCH replaces lines; staff cannot write', async () => {
    const { body } = await admin.post(`${api}/quotation-templates`).send({
      name: 'Swap', planId: c.monthly.id, lines: [{ productId: c.analytics.id, quantity: 1 }],
    });
    const patched = await admin.patch(`${api}/quotation-templates/${body.data.id}`).send({
      lines: [{ productId: c.crm.id, variantId: c.generic.id, quantity: 3 }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.lines).toMatchObject([{ product: { id: c.crm.id }, quantity: 3, unitPrice: '999.00' }]);
    expect((await staff.patch(`${api}/quotation-templates/${body.data.id}`).send({ name: 'X' })).status).toBe(403);
  });
});
