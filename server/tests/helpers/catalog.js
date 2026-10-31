import { prisma } from '../../src/lib/prisma.js';
import { parseDate } from '../../src/lib/dates.js';

/**
 * Arranges the base catalog from API.md §9 (same values as prisma/seed.js):
 * GST 18%, Net 15/30, CRM 999 (Odoo +560), Analytics 299, Monthly 499 (min 1), Yearly 4999 (min 5, not pausable).
 */
export async function seedCatalog() {
  const gst18 = await prisma.tax.create({ data: { name: 'GST 18%', type: 'PERCENT', rate: '18' } });
  const tax = { connect: [{ id: gst18.id }] };
  const immediate = await prisma.paymentTerm.create({ data: { name: 'Immediate', dueDays: 0 } });
  const net15 = await prisma.paymentTerm.create({ data: { name: 'Net 15', dueDays: 15 } });
  const net30 = await prisma.paymentTerm.create({ data: { name: 'Net 30', dueDays: 30 } });
  const crm = await prisma.product.create({
    data: {
      name: 'Brightloop CRM', type: 'SERVICE', salesPrice: '999', costPrice: '300', taxes: tax,
      variants: { create: [{ attribute: 'Brand', value: 'Odoo', extraPrice: '560' }, { attribute: 'Brand', value: 'Generic', extraPrice: '0' }] },
    },
    include: { variants: { orderBy: { id: 'asc' } } },
  });
  const analytics = await prisma.product.create({ data: { name: 'Analytics Add-on', type: 'SERVICE', salesPrice: '299', costPrice: '80', taxes: tax } });
  const start = parseDate('2026-01-01');
  const monthly = await prisma.recurringPlan.create({
    data: { name: 'Monthly', price: '499', billingPeriod: 'MONTHLY', minQuantity: 1, startDate: start, autoClose: true, closable: true, pausable: true, renewable: true, taxes: tax },
  });
  const yearly = await prisma.recurringPlan.create({
    data: { name: 'Yearly', price: '4999', billingPeriod: 'YEARLY', minQuantity: 5, startDate: start, autoClose: true, closable: true, pausable: false, renewable: true, taxes: tax },
  });
  return {
    gst18, immediate, net15, net30, crm, analytics, monthly, yearly,
    odoo: crm.variants[0],
    generic: crm.variants[1],
  };
}
