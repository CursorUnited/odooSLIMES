import { prisma } from '../../src/lib/prisma.js';
import { parseDate } from '../../src/lib/dates.js';

const api = '/api/v1';

/** "Starter CRM (monthly)": 10 × CRM (Odoo) on Monthly, Net 15, 15 days; plus the "10% for 10+ seats" discount. */
export async function seedStarter(c, { discount = true } = {}) {
  const template = await prisma.quotationTemplate.create({
    data: {
      name: 'Starter CRM (monthly)', planId: c.monthly.id, validityDays: 15, paymentTermId: c.net15.id,
      lines: { create: [{ productId: c.crm.id, variantId: c.odoo.id, quantity: 10, description: 'CRM seats' }] },
    },
  });
  const tenPercent = discount
    ? await prisma.discount.create({
        data: {
          name: '10% for 10+ seats', type: 'PERCENT', value: '10', scope: 'PRODUCT', minQuantity: 10,
          startDate: parseDate('2026-01-01'), usageLimit: 100, products: { connect: [{ id: c.crm.id }] },
        },
      })
    : null;
  return { template, tenPercent };
}

/** Creates a subscription through the API and confirms it (start ≤ today → ACTIVE). */
export async function activeSub(agent, body) {
  const created = await agent.post(`${api}/subscriptions`).send(body);
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const confirmed = await agent.post(`${api}/subscriptions/${created.body.data.id}/actions/confirm`).send({});
  if (confirmed.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirmed.body)}`);
  return confirmed.body.data;
}
