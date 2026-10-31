import { z } from 'zod';
import { id, optionalText, quantity, text } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';

const lineSchema = z.object({
  productId: id,
  variantId: id.nullish(),
  quantity,
  description: optionalText(200),
});

const templateFields = {
  name: text(80),
  planId: id,
  validityDays: z.coerce.number().int().min(1, 'Validity must be between 1 and 365 days.').max(365, 'Validity must be between 1 and 365 days.'),
  paymentTermId: id.nullish(),
  notes: optionalText(1000),
  lines: z.array(lineSchema).min(1, 'Add at least one line.').max(50),
};

export const createTemplateSchema = z.object({ ...templateFields, validityDays: templateFields.validityDays.default(30) });

/** `lines`, if sent, replaces all lines. */
export const updateTemplateSchema = z.object(templateFields).partial();

export const listTemplatesQuery = listQuery(['name', 'createdAt'], { planId: id.optional() }, 'name');
