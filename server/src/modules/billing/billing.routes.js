import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireRole, BACK_OFFICE } from '../../middleware/auth.js';
import { date } from '../../lib/validation.js';
import { addDays, today } from '../../lib/dates.js';
import { listQuery, paginate, orderByFrom } from '../../lib/paginate.js';
import { prisma } from '../../lib/prisma.js';
import { runBilling, toRunApi } from './billing.service.js';

export const billingRouter = Router();
billingRouter.use(requireRole(...BACK_OFFICE));

const runBody = z.object({
  asOf: date.refine((d) => d <= addDays(today(), 1), 'Bill up to tomorrow at most.').optional(),
});

billingRouter.post('/run', validate({ body: runBody }), async (req, res) => {
  const run = await runBilling({ asOf: req.valid.body.asOf ?? today(), userId: req.user.id });
  res.status(201).json({ data: run });
});

billingRouter.get('/runs', validate({ query: listQuery(['startedAt'], {}, '-startedAt') }), async (req, res) => {
  const { page, pageSize, sort } = req.valid.query;
  res.json(
    await paginate(prisma.billingRun, {
      orderBy: orderByFrom(sort),
      page,
      pageSize,
      include: { triggeredBy: { select: { id: true, name: true } } },
      map: toRunApi,
    }),
  );
});
