import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, BACK_OFFICE } from '../../middleware/auth.js';
import { date, id, idParam, queryBool } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';
import * as invoices from './invoices.service.js';
import * as actions from './invoiceActions.service.js';

export const invoicesRouter = Router();
invoicesRouter.use(requireAuth);

const STATUSES = ['DRAFT', 'CONFIRMED', 'PAID', 'CANCELLED'];
const statusList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean))
  .pipe(z.array(z.enum(STATUSES)).min(1));

const listInvoicesQuery = listQuery(
  ['number', 'invoiceDate', 'dueDate', 'total', 'createdAt'],
  {
    status: statusList.optional(),
    overdue: queryBool.optional(),
    customerId: id.optional(),
    subscriptionId: id.optional(),
    from: date.optional(),
    to: date.optional(),
    dueFrom: date.optional(),
    dueTo: date.optional(),
  },
  '-invoiceDate',
);

invoicesRouter.get('/', validate({ query: listInvoicesQuery }), async (req, res) => {
  res.json(await invoices.listInvoices(req.user, req.valid.query));
});

invoicesRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json({ data: await invoices.getInvoice(req.user, req.valid.params.id) });
});

invoicesRouter.post(
  '/actions/confirm-bulk',
  requireRole(...BACK_OFFICE),
  validate({ body: z.object({ ids: z.array(id).min(1).max(500) }) }),
  async (req, res) => {
    res.json({ data: await actions.confirmBulk(req.user, [...new Set(req.valid.body.ids)]) });
  },
);

const actionParams = z.object({ id, action: z.enum(['confirm', 'cancel', 'send']) });

invoicesRouter.post('/:id/actions/:action', requireRole(...BACK_OFFICE), validate({ params: actionParams }), async (req, res) => {
  const { id: invoiceId, action } = req.valid.params;
  if (action === 'confirm') {
    const { invoice, warnings } = await actions.confirmInvoice(req.user, invoiceId);
    return res.json({ data: invoice, warnings });
  }
  const run = action === 'cancel' ? actions.cancelInvoice : actions.sendInvoice;
  res.json({ data: await run(req.user, invoiceId) });
});
