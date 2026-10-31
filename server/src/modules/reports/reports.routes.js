import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireRole, BACK_OFFICE } from '../../middleware/auth.js';
import { date, id } from '../../lib/validation.js';
import { config } from '../../config/index.js';
import * as reports from './reports.service.js';

export const reportsRouter = Router();
reportsRouter.use(requireRole(...BACK_OFFICE));

const filters = { from: date.optional(), to: date.optional(), planId: id.optional(), customerId: id.optional() };
const END_BEFORE_START = { message: 'End date must be on or after the start date.', path: ['to'] };
const ordered = (v) => !(v.from && v.to && v.to < v.from);

reportsRouter.get('/summary', validate({ query: z.object(filters).refine(ordered, END_BEFORE_START) }), async (req, res) => {
  res.json({ data: await reports.summary(req.valid.query) });
});

reportsRouter.get(
  '/revenue-by-month',
  validate({ query: z.object({ ...filters, months: z.coerce.number().int().min(1).max(24).default(12) }) }),
  async (req, res) => {
    res.json({ data: await reports.revenueByMonth(req.valid.query) });
  },
);

reportsRouter.get(
  '/overdue-invoices',
  validate({
    query: z.object({
      planId: filters.planId,
      customerId: filters.customerId,
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(config.pageSizeMax).default(25),
      sort: z.enum(['-daysOverdue', 'daysOverdue']).default('-daysOverdue'),
    }),
  }),
  async (req, res) => {
    res.json(await reports.overdueInvoices(req.valid.query));
  },
);
