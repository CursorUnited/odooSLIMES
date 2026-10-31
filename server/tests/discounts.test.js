import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { addDays, formatDate, today } from '../src/lib/dates.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';
import { seedCatalog } from './helpers/catalog.js';
import { seedStarter, activeSub } from './helpers/subs.js';

const app = createApp();
const api = '/api/v1';
const inDays = (n) => formatDate(addDays(today(), n));
let admin, staff, customer, accounts, c, starter;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  c = await seedCatalog();
  ({ template: starter } = await seedStarter(c, { discount: false }));
  [admin, staff, customer] = await Promise.all([loginAs(app, 'ADMIN'), loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

const tenPercent = (over = {}) => ({
  name: '10% for 10+ seats', type: 'PERCENT', value: '10', scope: 'PRODUCT', productIds: [c.crm.id],
  minQuantity: 10, startDate: '2026-01-01', endDate: '2026-12-31', usageLimit: 100, ...over,
});

describe('discount rules (admin only)', () => {
  it('TC-DISC-07 staff cannot create; admin can; staff can read; customers cannot', async () => {
    expect((await staff.post(`${api}/discounts`).send(tenPercent())).status).toBe(403);
    const res = await admin.post(`${api}/discounts`).send(tenPercent());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: '10% for 10+ seats', type: 'PERCENT', value: '10.00', scope: 'PRODUCT', minPurchase: '0.00', minQuantity: 10,
      startDate: '2026-01-01', endDate: '2026-12-31', usageLimit: 100, usedCount: 0, isActive: true,
      products: [{ id: c.crm.id, name: 'Brightloop CRM' }], subscriptions: [],
    });
    const list = await staff.get(`${api}/discounts`);
    expect(list.body.data[0]).toMatchObject({ name: '10% for 10+ seats', usedCount: 0 });
    expect((await staff.get(`${api}/discounts/${res.body.data.id}`)).status).toBe(200);
    expect((await customer.get(`${api}/discounts`)).status).toBe(403);
  });

  it('validation: percent over 100, fixed 0, end before start, usage limit 0, product scope without products', async () => {
    const res = await admin.post(`${api}/discounts`).send(tenPercent({ value: '120', endDate: '2025-12-01', usageLimit: 0, productIds: [] }));
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(['value', 'endDate', 'usageLimit', 'productIds']));
    const fixed0 = await admin.post(`${api}/discounts`).send(tenPercent({ type: 'FIXED', value: '0' }));
    expect(fixed0.body.error.fields.value).toBeTruthy();
    await admin.post(`${api}/discounts`).send(tenPercent());
    expect((await admin.post(`${api}/discounts`).send(tenPercent())).body.error.code).toBe('DUPLICATE');
  });

  it('derived state: scheduled, active, expired, inactive; status filter', async () => {
    await admin.post(`${api}/discounts`).send(tenPercent({ name: 'Later', startDate: inDays(10), endDate: null }));
    await admin.post(`${api}/discounts`).send(tenPercent({ name: 'Now', startDate: inDays(-10), endDate: null }));
    await admin.post(`${api}/discounts`).send(tenPercent({ name: 'Gone', startDate: '2026-01-01', endDate: inDays(-1) }));
    const off = (await admin.post(`${api}/discounts`).send(tenPercent({ name: 'Off', startDate: inDays(-10), endDate: null }))).body.data;
    await admin.patch(`${api}/discounts/${off.id}`).send({ isActive: false });

    const states = Object.fromEntries((await staff.get(`${api}/discounts?pageSize=10`)).body.data.map((d) => [d.name, d.state]));
    expect(states).toEqual({ Later: 'SCHEDULED', Now: 'ACTIVE', Gone: 'EXPIRED', Off: 'INACTIVE' });
    const active = await staff.get(`${api}/discounts?status=active`);
    expect(active.body.data.map((d) => d.name)).toEqual(['Now']);
  });

  it('PATCH cannot lower the usage limit below the uses already counted', async () => {
    const d = (await admin.post(`${api}/discounts`).send(tenPercent())).body.data;
    await prisma.discount.update({ where: { id: d.id }, data: { usedCount: 3 } });
    const res = await admin.patch(`${api}/discounts/${d.id}`).send({ usageLimit: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.usageLimit).toBeTruthy();
    expect((await admin.patch(`${api}/discounts/${d.id}`).send({ usageLimit: 3 })).body.data.state).toBe('EXHAUSTED');
  });
});

describe('a rule applies on the next invoice by itself (R-24)', () => {
  const sub = (quantity) =>
    activeSub(staff, {
      customerId: accounts.customer.id, planId: c.monthly.id, startDate: '2026-10-01',
      lines: [{ productId: c.crm.id, variantId: c.odoo.id, quantity }],
    });
  const billNow = async (id) => (await staff.post(`${api}/subscriptions/${id}/invoice`).send({})).body.data;

  it('applies to a 10-seat subscription, not a 5-seat one; usage limit 1 stops it after one confirmed invoice', async () => {
    const ten = await sub(10);
    const five = await sub(5);
    const rule = (await admin.post(`${api}/discounts`).send(tenPercent({ usageLimit: 1 }))).body.data; // created after the subscriptions

    const invTen = await billNow(ten.id);
    expect(invTen.discounts).toMatchObject([{ id: rule.id, amount: '1559.00' }]);
    expect((await billNow(five.id)).discounts).toEqual([]);

    await staff.post(`${api}/invoices/${invTen.id}/actions/confirm`).send({});
    const after = (await staff.get(`${api}/discounts/${rule.id}`)).body.data;
    expect(after).toMatchObject({ usedCount: 1, state: 'EXHAUSTED' });
    expect((await billNow(ten.id)).discounts).toEqual([]); // next period: used up, so it stops on its own
  });

  it('SUBSCRIPTION scope linked to one subscription only discounts that one', async () => {
    const a = await sub(1);
    const b = await sub(1);
    await admin.post(`${api}/discounts`).send({
      name: '₹100 off for A', type: 'FIXED', value: '100', scope: 'SUBSCRIPTION', subscriptionIds: [a.id], startDate: '2026-01-01',
    });
    expect((await billNow(a.id)).discountAmount).toBe('100.00');
    expect((await billNow(b.id)).discountAmount).toBe('0.00');
  });
});
