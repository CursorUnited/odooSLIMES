import { z } from 'zod';
import { id, money, optionalText, queryBool, text } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';

export const variantBody = z.object({
  attribute: text(50, 1),
  value: text(50, 1),
  extraPrice: money().default('0'),
  isActive: z.boolean().optional(),
});

const productFields = {
  name: text(120),
  type: z.enum(['SERVICE', 'GOODS']),
  salesPrice: money(),
  costPrice: money(),
  notes: optionalText(1000),
  taxIds: z.array(id).max(10).optional(),
  isActive: z.boolean().optional(),
};

export const createProductSchema = z.object({ ...productFields, variants: z.array(variantBody).max(50).optional() });

/** Any product field except variants (those have their own endpoints). */
export const updateProductSchema = z.object(productFields).partial();

export const updateVariantSchema = variantBody.partial();

export const listProductsQuery = listQuery(['name', 'salesPrice', 'createdAt'], {
  type: z.enum(['SERVICE', 'GOODS']).optional(),
  isActive: queryBool.default(true), // zod 4: default is the output value
});
