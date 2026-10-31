import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';
import * as outbox from './outbox.service.js';

export const outboxRouter = Router();
outboxRouter.use(requireRole(ADMIN));

const listOutboxQuery = listQuery(['createdAt'], {
  kind: z.enum(['WELCOME', 'RESET_PASSWORD', 'QUOTATION', 'INVOICE']).optional(),
  to: z.string().trim().max(254).optional(),
});

outboxRouter.get('/', validate({ query: listOutboxQuery }), async (req, res) => {
  res.json(await outbox.listOutbox(req.valid.query));
});

outboxRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json({ data: await outbox.getOutbox(req.valid.params.id) });
});
