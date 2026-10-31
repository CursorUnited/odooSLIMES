import request from 'supertest';
import { prisma } from '../../src/lib/prisma.js';
import { config } from '../../src/config/index.js';
import { hashPassword } from '../../src/lib/password.js';

export const PASSWORDS = {
  ADMIN: 'Admin@1234',
  STAFF: 'Staff@1234',
  CUSTOMER: 'Customer@1234',
};

/** Wipes every table and sequence. Refuses to touch anything but the test database. */
export async function resetDb() {
  if (!/slimes_test/.test(config.databaseUrl)) {
    throw new Error(`Refusing to reset a non-test database: ${config.databaseUrl.replace(/:[^:@/]+@/, ':****@')}`);
  }
  const rows = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  if (tables) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  for (const seq of ['seq_subscription', 'seq_invoice', 'seq_payment']) {
    await prisma.$executeRawUnsafe(`ALTER SEQUENCE "${seq}" RESTART WITH 1`);
  }
}

/** Admin, Staff and one Customer (with its customer record). */
export async function seedAccounts() {
  const admin = await prisma.user.create({
    data: { email: 'admin@brightloop.test', name: 'Brightloop Admin', role: 'ADMIN', passwordHash: await hashPassword(PASSWORDS.ADMIN) },
  });
  const staff = await prisma.user.create({
    data: { email: 'staff@brightloop.test', name: 'Ravi Staff', role: 'STAFF', passwordHash: await hashPassword(PASSWORDS.STAFF) },
  });
  const customer = await prisma.customer.create({ data: { name: 'Kanpur Mart', email: 'customer@brightloop.test' } });
  const customerUser = await prisma.user.create({
    data: {
      email: 'customer@brightloop.test',
      name: 'Kanpur Mart',
      role: 'CUSTOMER',
      customerId: customer.id,
      passwordHash: await hashPassword(PASSWORDS.CUSTOMER),
    },
  });
  return { admin, staff, customer, customerUser };
}

/** Supertest agent logged in as the seeded user of that role (keeps the cookie). */
export async function loginAs(app, role) {
  const agent = request.agent(app);
  const email = `${role.toLowerCase()}@brightloop.test`;
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORDS[role] });
  if (res.status !== 200) throw new Error(`login as ${role} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
