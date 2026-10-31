import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN, BACK_OFFICE } from '../../middleware/auth.js';
import { text } from '../../lib/validation.js';
import { listQuery, paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { prisma } from '../../lib/prisma.js';

export const paymentTermsRouter = Router();

export const toTermApi = (t) => ({ id: t.id, name: t.name, dueDays: t.dueDays });

const termBody = z.object({
  name: text(40),
  dueDays: z.coerce.number().int('Use a whole number.').min(0, 'Use 0 to 365 days.').max(365, 'Use 0 to 365 days.'),
});

paymentTermsRouter.get(
  '/',
  requireRole(...BACK_OFFICE),
  validate({ query: listQuery(['name', 'dueDays', 'createdAt'], {}, 'dueDays') }),
  async (req, res) => {
    const { page, pageSize, sort, q } = req.valid.query;
    const where = q ? { name: ilike(q) } : {};
    res.json(await paginate(prisma.paymentTerm, { where, orderBy: orderByFrom(sort), page, pageSize, map: toTermApi }));
  },
);

paymentTermsRouter.post('/', requireRole(ADMIN), validate({ body: termBody }), async (req, res) => {
  const term = await prisma.paymentTerm.create({ data: req.valid.body });
  res.status(201).json({ data: toTermApi(term) });
});
