import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { resetDb, seedAccounts, loginAs } from './helpers/db.js';

const app = createApp();
const api = '/api/v1';

beforeEach(async () => {
  await resetDb();
  await seedAccounts();
});
afterAll(() => prisma.$disconnect());

const signup = (body) => request(app).post(`${api}/auth/signup`).send(body);

/** Pulls the raw reset token out of the newest RESET_PASSWORD outbox email. */
async function latestResetToken(email) {
  const mail = await prisma.emailOutbox.findFirst({ where: { toEmail: email, kind: 'RESET_PASSWORD' }, orderBy: { id: 'desc' } });
  return mail?.bodyHtml.match(/token=([0-9a-f]{64})/)?.[1];
}

describe('sign-up and password rule', () => {
  it('TC-AUTH-01 sign-up creates a CUSTOMER user + customer record and sets the cookie', async () => {
    const res = await signup({ name: 'Asha Traders', email: ' Owner@AshaTraders.in ', password: 'Brightloop#1', company: 'Asha Traders' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: 'owner@ashatraders.in', role: 'CUSTOMER', name: 'Asha Traders' });
    expect(res.body.data.customerId).toBeTypeOf('number');
    expect(res.headers['set-cookie'].join(';')).toMatch(/sl_token=.*HttpOnly/i);

    const customer = await prisma.customer.findUnique({ where: { id: res.body.data.customerId } });
    expect(customer).toMatchObject({ email: 'owner@ashatraders.in', company: 'Asha Traders' });
    expect(await prisma.emailOutbox.count({ where: { kind: 'WELCOME' } })).toBe(1);
  });

  it.each([
    ['TC-AUTH-02 8 characters', 'Abcdef#1'],
    ['TC-AUTH-03 no uppercase', 'brightloop#1'],
    ['TC-AUTH-04 no lowercase', 'BRIGHTLOOP#1'],
    ['TC-AUTH-05 no special character', 'Brightloop1'],
  ])('%s is rejected with AUTH_WEAK_PASSWORD', async (_label, password) => {
    const res = await signup({ name: 'Weak Pass', email: 'weak@shop.in', password });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTH_WEAK_PASSWORD');
    expect(res.body.error.fields.password).toBeTruthy();
  });

  it('accepts exactly 9 characters with upper, lower and special (Bright#26)', async () => {
    const res = await signup({ name: 'Nine Chars', email: 'nine@shop.in', password: 'Bright#26' });
    expect(res.status).toBe(201);
  });

  it('TC-AUTH-06 same email in another case gives AUTH_EMAIL_TAKEN', async () => {
    expect((await signup({ name: 'Shop One', email: 'new@shop.in', password: 'Brightloop#1' })).status).toBe(201);
    const res = await signup({ name: 'Shop Two', email: 'New@Shop.in', password: 'Brightloop#1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('AUTH_EMAIL_TAKEN');
    expect(res.body.error.fields.email).toBeTruthy();
  });

  it('parallel sign-ups with one email: one wins, the rest get AUTH_EMAIL_TAKEN', async () => {
    const body = { name: 'Race Shop', email: 'race@shop.in', password: 'Brightloop#1' };
    const results = await Promise.all([1, 2, 3].map(() => signup(body)));
    const codes = results.map((r) => r.body.error?.code ?? r.status).sort();
    expect(codes).toEqual([201, 'AUTH_EMAIL_TAKEN', 'AUTH_EMAIL_TAKEN']);
  });

  it('links sign-up to a customer record staff created earlier', async () => {
    const existing = await prisma.customer.create({ data: { name: 'Northwind', email: 'billing@northwind.in' } });
    const res = await signup({ name: 'Northwind', email: 'billing@northwind.in', password: 'Brightloop#1' });
    expect(res.status).toBe(201);
    expect(res.body.data.customerId).toBe(existing.id);
  });

  it('cannot set its own role', async () => {
    const res = await signup({ name: 'Sneaky', email: 'sneaky@shop.in', password: 'Brightloop#1', role: 'ADMIN' });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('CUSTOMER');
  });
});

describe('login, me, logout', () => {
  it('TC-AUTH-07 wrong password and unknown email give the same error', async () => {
    const a = await request(app).post(`${api}/auth/login`).send({ email: 'admin@brightloop.test', password: 'Wrong#12345' });
    const b = await request(app).post(`${api}/auth/login`).send({ email: 'nobody@brightloop.test', password: 'Wrong#12345' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('login → me → logout', async () => {
    const agent = await loginAs(app, 'CUSTOMER');
    const me = await agent.get(`${api}/auth/me`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ role: 'CUSTOMER', email: 'customer@brightloop.test' });
    expect(me.body.data.customer).toMatchObject({ name: 'Kanpur Mart' });

    expect((await agent.post(`${api}/auth/logout`)).status).toBe(204);
    const after = await agent.get(`${api}/auth/me`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('no cookie gives AUTH_REQUIRED', async () => {
    const res = await request(app).get(`${api}/auth/me`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('a deactivated user cannot log in and an open session stops working', async () => {
    const staffAgent = await loginAs(app, 'STAFF');
    const admin = await loginAs(app, 'ADMIN');
    const staff = await prisma.user.findUnique({ where: { email: 'staff@brightloop.test' } });
    expect((await admin.patch(`${api}/users/${staff.id}`).send({ isActive: false })).status).toBe(200);

    expect((await staffAgent.get(`${api}/auth/me`)).status).toBe(401);
    const login = await request(app).post(`${api}/auth/login`).send({ email: 'staff@brightloop.test', password: 'Staff@1234' });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
  });
});

describe('TC-AUTH-08 forgot and reset password', () => {
  it('forgot always answers 200; mail only for known emails', async () => {
    const known = await request(app).post(`${api}/auth/forgot-password`).send({ email: 'customer@brightloop.test' });
    const unknown = await request(app).post(`${api}/auth/forgot-password`).send({ email: 'ghost@brightloop.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(await prisma.emailOutbox.count({ where: { kind: 'RESET_PASSWORD' } })).toBe(1);
  });

  it('reset works once; reuse and expired tokens are rejected', async () => {
    await request(app).post(`${api}/auth/forgot-password`).send({ email: 'customer@brightloop.test' });
    const token = await latestResetToken('customer@brightloop.test');
    expect(token).toHaveLength(64);

    const weak = await request(app).post(`${api}/auth/reset-password`).send({ token, password: 'short' });
    expect(weak.body.error.code).toBe('AUTH_WEAK_PASSWORD');

    const ok = await request(app).post(`${api}/auth/reset-password`).send({ token, password: 'NewBright#2026' });
    expect(ok.status).toBe(200);
    const login = await request(app).post(`${api}/auth/login`).send({ email: 'customer@brightloop.test', password: 'NewBright#2026' });
    expect(login.status).toBe(200);

    const reuse = await request(app).post(`${api}/auth/reset-password`).send({ token, password: 'Another#2026' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('AUTH_RESET_TOKEN_INVALID');

    await request(app).post(`${api}/auth/forgot-password`).send({ email: 'customer@brightloop.test' });
    const token2 = await latestResetToken('customer@brightloop.test');
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post(`${api}/auth/reset-password`).send({ token: token2, password: 'Another#2026' });
    expect(expired.body.error.code).toBe('AUTH_RESET_TOKEN_INVALID');
  });

  it('a new forgot request invalidates the older link', async () => {
    await request(app).post(`${api}/auth/forgot-password`).send({ email: 'customer@brightloop.test' });
    const first = await latestResetToken('customer@brightloop.test');
    await request(app).post(`${api}/auth/forgot-password`).send({ email: 'customer@brightloop.test' });
    const res = await request(app).post(`${api}/auth/reset-password`).send({ token: first, password: 'NewBright#2026' });
    expect(res.body.error.code).toBe('AUTH_RESET_TOKEN_INVALID');
  });
});

describe('roles', () => {
  it('TC-AUTH-09 customer is blocked from admin endpoints', async () => {
    const customer = await loginAs(app, 'CUSTOMER');
    const res = await customer.get(`${api}/users`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await customer.get(`${api}/outbox`)).status).toBe(403);
  });

  it('TC-AUTH-10 staff cannot create staff; admin can, and the new user logs in as STAFF', async () => {
    const staff = await loginAs(app, 'STAFF');
    const body = { name: 'Meera Sales', email: 'meera@brightloop.test', password: 'Meera#2026x', role: 'ADMIN' };
    expect((await staff.post(`${api}/users`).send(body)).status).toBe(403);

    const admin = await loginAs(app, 'ADMIN');
    const created = await admin.post(`${api}/users`).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ role: 'STAFF', email: 'meera@brightloop.test', isActive: true });

    const login = await request(app).post(`${api}/auth/login`).send({ email: 'meera@brightloop.test', password: 'Meera#2026x' });
    expect(login.status).toBe(200);
    expect(login.body.data.role).toBe('STAFF');

    const dup = await admin.post(`${api}/users`).send(body);
    expect(dup.body.error.code).toBe('AUTH_EMAIL_TAKEN');
  });

  it('admin lists users with filters and cannot deactivate themself', async () => {
    const admin = await loginAs(app, 'ADMIN');
    const list = await admin.get(`${api}/users?role=STAFF`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 25, total: 1 });
    expect(list.body.data[0]).toMatchObject({ name: 'Ravi Staff', role: 'STAFF' });

    const me = await admin.get(`${api}/auth/me`);
    const self = await admin.patch(`${api}/users/${me.body.data.id}`).send({ isActive: false });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('FORBIDDEN_SELF_ACTION');
  });

  it('admin reads the outbox; reset link is in the body', async () => {
    await request(app).post(`${api}/auth/forgot-password`).send({ email: 'customer@brightloop.test' });
    const admin = await loginAs(app, 'ADMIN');
    const list = await admin.get(`${api}/outbox?kind=RESET_PASSWORD`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ toEmail: 'customer@brightloop.test', kind: 'RESET_PASSWORD', sentAt: null });
    expect(list.body.data[0].bodyHtml).toBeUndefined();

    const one = await admin.get(`${api}/outbox/${list.body.data[0].id}`);
    expect(one.body.data.bodyHtml).toMatch(/\/reset-password\?token=[0-9a-f]{64}/);
  });
});
