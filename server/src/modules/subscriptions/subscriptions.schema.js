import { z } from 'zod';
import { date, id, money, optionalText, quantity } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';

export const STATUSES = ['DRAFT', 'QUOTATION', 'CONFIRMED', 'ACTIVE', 'PAUSED', 'CLOSED'];
export const ACTIONS = ['send-quotation', 'confirm', 'activate', 'pause', 'resume', 'close', 'renew'];

const lineSchema = z.object({
  productId: id,
  variantId: id.nullish(),
  quantity,
  unitPrice: money().optional(), // default: product sales price + variant extra price
  taxIds: z.array(id).max(10).optional(), // default: the product's default taxes
  description: optionalText(200),
});

export const EXPIRY_NOT_AFTER_START = 'Expiry date must be after the start date.';
const expiryAfterStart = (v) => !(v.startDate instanceof Date && v.expiryDate instanceof Date && v.expiryDate <= v.startDate);

const fields = {
  customerId: id,
  planId: id,
  templateId: id,
  startDate: date,
  expiryDate: date.nullable(),
  paymentTermId: id,
  notes: optionalText(1000),
  lines: z.array(lineSchema).max(50),
};

/** Create (and preview): either a template or a plan; body fields override the template. */
export const createSubscriptionSchema = z
  .object({
    customerId: fields.customerId,
    startDate: fields.startDate,
    planId: fields.planId.optional(),
    templateId: fields.templateId.optional(),
    expiryDate: fields.expiryDate.optional(),
    paymentTermId: fields.paymentTermId.optional(),
    notes: fields.notes,
    lines: fields.lines.optional(),
  })
  .refine((v) => v.planId || v.templateId, { message: 'Choose a plan.', path: ['planId'] })
  .refine(expiryAfterStart, { message: EXPIRY_NOT_AFTER_START, path: ['expiryDate'] });

/** Same fields as create except templateId; `lines` replaces all lines. */
export const updateSubscriptionSchema = z
  .object({
    customerId: fields.customerId,
    planId: fields.planId,
    startDate: fields.startDate,
    expiryDate: fields.expiryDate,
    paymentTermId: fields.paymentTermId,
    notes: fields.notes,
    lines: fields.lines,
  })
  .partial()
  .refine(expiryAfterStart, { message: EXPIRY_NOT_AFTER_START, path: ['expiryDate'] });

export const actionParams = z.object({ id, action: z.enum(ACTIONS) });
export const actionBody = z.object({ note: optionalText(300) });

const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
  .pipe(z.array(z.enum(STATUSES)).min(1));

export const listSubscriptionsQuery = listQuery(['number', 'startDate', 'nextInvoiceDate', 'createdAt'], {
  status: statusList.optional(),
  customerId: id.optional(),
  planId: id.optional(),
  startFrom: date.optional(),
  startTo: date.optional(),
  expiringBefore: date.optional(),
});
