import { z } from 'zod';
import { config } from '../config/index.js';

/**
 * Query schema for a list endpoint: page, pageSize (max PAGE_SIZE_MAX), sort
 * (one of `sortFields`, '-' = descending), q, plus endpoint filters in `shape`.
 */
export function listQuery(sortFields, shape = {}, defaultSort = '-createdAt') {
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(config.pageSizeMax).default(25),
    sort: z
      .string()
      .default(defaultSort)
      .refine((s) => sortFields.includes(s.replace(/^-/, '')), `Sort by one of: ${sortFields.join(', ')}.`),
    q: z
      .string()
      .trim()
      .max(100)
      .transform((v) => v || undefined)
      .optional(),
    ...shape,
  });
}

/** '-createdAt' → [{ createdAt: 'desc' }, { id: 'desc' }]. `custom` maps a field to its own orderBy. */
export function orderByFrom(sort, custom = {}) {
  const dir = sort.startsWith('-') ? 'desc' : 'asc';
  const field = sort.replace(/^-/, '');
  const primary = custom[field] ? custom[field](dir) : { [field]: dir };
  return field === 'id' ? [primary] : [primary, { id: dir }];
}

/** Runs findMany + count with the same `where`. Returns the API list shape. */
export async function paginate(model, { where, orderBy, page, pageSize, select, include, map }) {
  const [rows, total] = await Promise.all([
    model.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, select, include }),
    model.count({ where }),
  ]);
  return { data: map ? rows.map(map) : rows, page, pageSize, total };
}

/** Case-insensitive `contains` filter. */
export const ilike = (q) => ({ contains: q, mode: 'insensitive' });
