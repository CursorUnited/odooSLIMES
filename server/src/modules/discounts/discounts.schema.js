import { z } from 'zod';
import { date, id, money, text } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';

export const MESSAGES = {
  percent: 'Enter a percentage between 0 and 100.',
  endBeforeStart: 'End date must be on or after the start date.',
  products: 'Choose at least one product.',
  usageLimit: 'Usage limit must be at least 1, or leave it empty.',
};

const fields = {
  name: text(80),
  type: z.enum(['PERCENT', 'FIXED']),
  value: money({ positive: true }),
  scope: z.enum(['PRODUCT', 'SUBSCRIPTION']),
  productIds: z.array(id).max(100),
  subscriptionIds: z.array(id).max(500),
  minPurchase: money(),
  minQuantity: z.coerce.number().int('Use a whole number.').min(0, 'Use 0 or more.').max(100000),
  startDate: date,
  endDate: date.nullable(),
  usageLimit: z.coerce.number().int('Use a whole number.').min(1, MESSAGES.usageLimit).nullable(),
  isActive: z.boolean(),
};

/** Cross-field rules shared by create and (merged) patch. Returns { field: message }. */
export function ruleErrors(d) {
  const errors = {};
  if (d.type === 'PERCENT' && d.value != null && Number(d.value) > 100) errors.value = MESSAGES.percent;
  if (d.startDate instanceof Date && d.endDate instanceof Date && d.endDate < d.startDate) errors.endDate = MESSAGES.endBeforeStart;
  if (d.scope === 'PRODUCT' && !(d.productIds?.length > 0)) errors.productIds = MESSAGES.products;
  return errors;
}

export const createDiscountSchema = z
  .object({
    ...fields,
    productIds: fields.productIds.default([]),
    subscriptionIds: fields.subscriptionIds.default([]),
    minPurchase: fields.minPurchase.default('0'),
    minQuantity: fields.minQuantity.default(0),
    endDate: fields.endDate.optional(),
    usageLimit: fields.usageLimit.optional(),
    isActive: fields.isActive.optional(),
  })
  .superRefine((d, ctx) => {
    for (const [path, message] of Object.entries(ruleErrors(d))) ctx.addIssue({ code: 'custom', path: [path], message });
  });

export const updateDiscountSchema = z.object(fields).partial();

export const listDiscountsQuery = listQuery(
  ['name', 'startDate', 'createdAt'],
  {
    scope: z.enum(['PRODUCT', 'SUBSCRIPTION']).optional(),
    status: z.enum(['active', 'scheduled', 'expired', 'exhausted', 'inactive']).optional(),
  },
  'name',
);
