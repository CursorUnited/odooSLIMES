import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN, BACK_OFFICE } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { idParam, money, queryBool, text } from '../../lib/validation.js';
import { listQuery, paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { prisma } from '../../lib/prisma.js';
import { D, rateToApi } from '../../lib/money.js';

export const taxesRouter = Router();

const RATE_FIELD_ERROR = (type) =>
  new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, {
    rate: type === 'PERCENT' ? 'Enter a rate between 0 and 100.' : 'Enter an amount of 0 or more, with up to 2 decimals.',
  });

/** PERCENT: 0..100; FIXED: money per unit ≥ 0 (API.md §4.6). */
function checkRate(type, rate) {
  if (type === 'PERCENT' && D(rate).gt(100)) throw RATE_FIELD_ERROR(type);
}

export const toTaxApi = (t) => ({ id: t.id, name: t.name, type: t.type, rate: rateToApi(t.rate), isActive: t.isActive });

const taxBody = z.object({
  name: text(40),
  type: z.enum(['PERCENT', 'FIXED']),
  rate: money(),
  isActive: z.boolean().optional(),
});

taxesRouter.get(
  '/',
  requireRole(...BACK_OFFICE),
  validate({ query: listQuery(['name', 'createdAt'], { isActive: queryBool.optional() }, 'name') }),
  async (req, res) => {
    const { page, pageSize, sort, q, isActive } = req.valid.query;
    const where = { ...(isActive !== undefined && { isActive }), ...(q && { name: ilike(q) }) };
    res.json(await paginate(prisma.tax, { where, orderBy: orderByFrom(sort), page, pageSize, map: toTaxApi }));
  },
);

taxesRouter.post('/', requireRole(ADMIN), validate({ body: taxBody }), async (req, res) => {
  const { name, type, rate, isActive } = req.valid.body;
  checkRate(type, rate);
  const tax = await prisma.tax.create({ data: { name, type, rate, isActive } });
  res.status(201).json({ data: toTaxApi(tax) });
});

taxesRouter.patch('/:id', requireRole(ADMIN), validate({ params: idParam, body: taxBody.partial() }), async (req, res) => {
  const existing = await prisma.tax.findUnique({ where: { id: req.valid.params.id } });
  if (!existing) throw new AppError('NOT_FOUND', 'Tax not found.', 404);
  const next = { ...existing, ...req.valid.body };
  checkRate(next.type, next.rate);
  const tax = await prisma.tax.update({ where: { id: existing.id }, data: req.valid.body });
  res.json({ data: toTaxApi(tax) });
});
