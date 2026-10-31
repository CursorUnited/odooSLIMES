import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';

const app = createApp();
const api = '/api/v1';
let admin, staff, customer, accounts;

beforeEach(async () => {
  await resetDb();
  accounts = await seedAccounts();
  [admin, staff, customer] = await Promise.all([loginAs(app, 'ADMIN'), loginAs(app, 'STAFF'), loginAs(app, 'CUSTOMER')]);
});
afterAll(() => prisma.$disconnect());

const northwind = { name: 'Northwind Pvt Ltd', email: 'Billing@Northwind.in', company: 'Northwind Pvt Ltd', phone: '0522 400 1234', address: 'Gomti Nagar, Lucknow' };

describe('customers (back office)', () => {
  it('staff creates a customer; email stored lower-case and unique', async () => {
    const res = await staff.post(`${api}/customers`).send(northwind);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Northwind Pvt Ltd', email: 'billing@northwind.in', phone: '0522 400 1234', address: 'Gomti Nagar, Lucknow' });

    const dup = await admin.post(`${api}/customers`).send({ ...northwind, name: 'Other' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    expect(dup.body.error.fields.email).toBeTruthy();
  });

  it('list shows portal flag and active subscription count; q searches name, email, company', async () => {
    await staff.post(`${api}/customers`).send(northwind);
    const all = await staff.get(`${api}/customers?sort=name`);
    expect(all.body.total).toBe(2);
    expect(all.body.data).toMatchObject([
      { name: 'Kanpur Mart', hasPortalUser: true, activeSubscriptions: 0 },
      { name: 'Northwind Pvt Ltd', hasPortalUser: false, activeSubscriptions: 0 },
    ]);
    const hit = await staff.get(`${api}/customers?q=northwind.in`);
    expect(hit.body.data.map((c) => c.name)).toEqual(['Northwind Pvt Ltd']);
  });

  it('detail has subscription counts and outstanding amount; staff can change email', async () => {
    const { body } = await staff.post(`${api}/customers`).send(northwind);
    const one = await staff.get(`${api}/customers/${body.data.id}`);
    expect(one.body.data).toMatchObject({ name: 'Northwind Pvt Ltd', outstandingAmount: '0.00', subscriptionCounts: {} });

    const patched = await staff.patch(`${api}/customers/${body.data.id}`).send({ email: 'accounts@northwind.in', phone: '' });
    expect(patched.body.data).toMatchObject({ email: 'accounts@northwind.in', phone: null });
  });
});

describe('customers (portal)', () => {
  it('a customer reads and edits only their own record and cannot change email', async () => {
    const own = await customer.get(`${api}/customers/${accounts.customer.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data.email).toBe('customer@brightloop.test');

    const other = (await staff.post(`${api}/customers`).send(northwind)).body.data;
    expect((await customer.get(`${api}/customers/${other.id}`)).status).toBe(404);
    expect((await customer.patch(`${api}/customers/${other.id}`).send({ phone: '1' })).status).toBe(404);

    const edit = await customer.patch(`${api}/customers/${accounts.customer.id}`).send({ phone: '+91 90000 00000', address: 'Civil Lines' });
    expect(edit.body.data).toMatchObject({ phone: '+91 90000 00000', address: 'Civil Lines' });

    const email = await customer.patch(`${api}/customers/${accounts.customer.id}`).send({ email: 'new@x.in' });
    expect(email.status).toBe(403);
    expect(email.body.error.code).toBe('FORBIDDEN');
  });

  it('a customer cannot list or create customers', async () => {
    expect((await customer.get(`${api}/customers`)).status).toBe(403);
    expect((await customer.post(`${api}/customers`).send(northwind)).status).toBe(403);
  });
});
