// Base demo data (API.md §9). Run on an empty database: npm run db:reset && npm run db:seed
import { config } from '../src/config/index.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';
import { parseDate } from '../src/lib/dates.js';

const env = (key, fallback) => process.env[key] || fallback;
const envEmail = (key, fallback) => env(key, fallback).trim().toLowerCase();

async function main() {
  if (await prisma.user.count()) {
    console.log('[seed] database already has users, skipping (run npm run db:reset first)');
    return;
  }

  await prisma.$transaction(async (tx) => {
    // Accounts
    const admin = await tx.user.create({
      data: {
        email: envEmail('SEED_ADMIN_EMAIL', 'admin@brightloop.test'),
        passwordHash: await hashPassword(env('SEED_ADMIN_PASSWORD', 'Admin@1234')),
        name: 'Brightloop Admin',
        role: 'ADMIN',
      },
    });
    await tx.user.create({
      data: {
        email: envEmail('SEED_STAFF_EMAIL', 'staff@brightloop.test'),
        passwordHash: await hashPassword(env('SEED_STAFF_PASSWORD', 'Staff@1234')),
        name: 'Ravi Staff',
        role: 'STAFF',
      },
    });
    const customerEmail = envEmail('SEED_CUSTOMER_EMAIL', 'customer@brightloop.test');
    const customer = await tx.customer.create({
      data: {
        name: 'Kanpur Mart',
        email: customerEmail,
        company: 'Kanpur Mart Pvt Ltd',
        phone: '+91 98390 12345',
        address: 'Civil Lines, Kanpur',
        createdById: admin.id,
      },
    });
    await tx.user.create({
      data: {
        email: customerEmail,
        passwordHash: await hashPassword(env('SEED_CUSTOMER_PASSWORD', 'Customer@1234')),
        name: 'Kanpur Mart',
        role: 'CUSTOMER',
        customerId: customer.id,
      },
    });

    // Taxes (GST 18% is id 3, default on all products)
    await tx.tax.create({ data: { name: 'GST 5%', type: 'PERCENT', rate: '5' } });
    await tx.tax.create({ data: { name: 'GST 12%', type: 'PERCENT', rate: '12' } });
    const gst18 = await tx.tax.create({ data: { name: 'GST 18%', type: 'PERCENT', rate: '18' } });
    const gst = { connect: [{ id: gst18.id }] };

    // Payment terms
    await tx.paymentTerm.create({ data: { name: 'Immediate', dueDays: 0 } });
    const net15 = await tx.paymentTerm.create({ data: { name: 'Net 15', dueDays: 15 } });
    const net30 = await tx.paymentTerm.create({ data: { name: 'Net 30', dueDays: 30 } });

    // Products
    const crm = await tx.product.create({
      data: {
        name: 'Brightloop CRM',
        type: 'SERVICE',
        salesPrice: '999.00',
        costPrice: '300.00',
        notes: 'Per-seat CRM licence',
        taxes: gst,
        variants: {
          create: [
            { attribute: 'Brand', value: 'Odoo', extraPrice: '560.00' },
            { attribute: 'Brand', value: 'Generic', extraPrice: '0.00' },
          ],
        },
      },
      include: { variants: true },
    });
    const odoo = crm.variants.find((v) => v.value === 'Odoo');
    const analytics = await tx.product.create({
      data: { name: 'Analytics Add-on', type: 'SERVICE', salesPrice: '299.00', costPrice: '80.00', notes: 'Dashboards and exports', taxes: gst },
    });
    await tx.product.create({
      data: { name: 'Priority Support', type: 'SERVICE', salesPrice: '1499.00', costPrice: '500.00', notes: '4-hour response SLA', taxes: gst },
    });

    // Plans (price = base fee per period, taxed with GST 18%)
    const planStart = parseDate('2026-01-01');
    const monthly = await tx.recurringPlan.create({
      data: {
        name: 'Monthly', price: '499.00', billingPeriod: 'MONTHLY', minQuantity: 1, startDate: planStart,
        autoClose: true, closable: true, pausable: true, renewable: true, taxes: gst,
      },
    });
    const yearly = await tx.recurringPlan.create({
      data: {
        name: 'Yearly', price: '4999.00', billingPeriod: 'YEARLY', minQuantity: 5, startDate: planStart,
        autoClose: true, closable: true, pausable: false, renewable: true, taxes: gst,
      },
    });
    await tx.recurringPlan.create({
      data: {
        name: 'Weekly', price: '149.00', billingPeriod: 'WEEKLY', minQuantity: 1, startDate: planStart,
        autoClose: false, closable: true, pausable: true, renewable: true, taxes: gst,
      },
    });
    await tx.recurringPlan.create({
      data: {
        name: 'Daily', price: '29.00', billingPeriod: 'DAILY', minQuantity: 1, startDate: planStart,
        autoClose: true, closable: true, pausable: false, renewable: false, taxes: gst,
      },
    });

    // Quotation templates
    await tx.quotationTemplate.create({
      data: {
        name: 'Starter CRM (monthly)', planId: monthly.id, validityDays: 15, paymentTermId: net15.id,
        notes: '10 CRM seats on the Odoo brand.',
        lines: { create: [{ productId: crm.id, variantId: odoo.id, quantity: 10, description: 'CRM seats, Odoo brand' }] },
      },
    });
    await tx.quotationTemplate.create({
      data: {
        name: 'Enterprise CRM (yearly)', planId: yearly.id, validityDays: 30, paymentTermId: net30.id,
        notes: 'Includes onboarding call.',
        lines: {
          create: [
            { productId: crm.id, variantId: odoo.id, quantity: 25, description: 'CRM seats, Odoo brand' },
            { productId: analytics.id, quantity: 5, description: 'Analytics for each team' },
          ],
        },
      },
    });

    // Discount
    await tx.discount.create({
      data: {
        name: '10% for 10+ seats', type: 'PERCENT', value: '10.00', scope: 'PRODUCT',
        minQuantity: 10, startDate: parseDate('2026-10-01'), endDate: parseDate('2026-12-31'), usageLimit: 100,
        products: { connect: [{ id: crm.id }] },
      },
    });
  });

  console.log(`[seed] done (${config.databaseUrl.replace(/:[^:@/]+@/, ':****@')})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
