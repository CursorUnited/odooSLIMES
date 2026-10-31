import { z } from 'zod';
import { date, id, money, queryBool, text } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';

const PERIODS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

const planFields = {
  name: text(80),
  price: money(),
  billingPeriod: z.enum(PERIODS),
  intervalCount: z.coerce.number().int().min(1, 'Use 1 to 12.').max(12, 'Use 1 to 12.'),
  minQuantity: z.coerce.number().int('Use a whole number.').min(1, 'Minimum quantity must be at least 1.').max(100000),
  startDate: date,
  endDate: date.nullable(),
  autoClose: z.boolean(),
  closable: z.boolean(),
  pausable: z.boolean(),
  renewable: z.boolean(),
  taxIds: z.array(id).max(10),
  isActive: z.boolean(),
};

export const END_BEFORE_START = 'End date must be on or after the start date.';

/** True when both dates are valid and end < start. */
export const endsBeforeStart = (start, end) => start instanceof Date && end instanceof Date && end < start;

export const createPlanSchema = z
  .object({
    ...planFields,
    intervalCount: planFields.intervalCount.default(1),
    minQuantity: planFields.minQuantity.default(1),
    endDate: planFields.endDate.optional(),
    autoClose: planFields.autoClose.default(false),
    closable: planFields.closable.default(true),
    pausable: planFields.pausable.default(false),
    renewable: planFields.renewable.default(true),
    taxIds: planFields.taxIds.optional(),
    isActive: planFields.isActive.optional(),
  })
  .refine((v) => !endsBeforeStart(v.startDate, v.endDate), { message: END_BEFORE_START, path: ['endDate'] });

export const updatePlanSchema = z.object(planFields).partial();

export const listPlansQuery = listQuery(
  ['name', 'price', 'createdAt'],
  {
    billingPeriod: z.enum(PERIODS).optional(),
    isActive: queryBool.optional(),
    availableOn: date.optional(),
  },
  'name',
);
