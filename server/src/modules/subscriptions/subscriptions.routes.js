import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, BACK_OFFICE } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import {
  createSubscriptionSchema,
  updateSubscriptionSchema,
  listSubscriptionsQuery,
  actionParams,
  actionBody,
} from './subscriptions.schema.js';
import * as subs from './subscriptions.service.js';
import { performAction } from './actions.service.js';
import { billNow } from '../billing/billing.service.js';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

subscriptionsRouter.get('/', validate({ query: listSubscriptionsQuery }), async (req, res) => {
  res.json(await subs.listSubscriptions(req.user, req.valid.query));
});

subscriptionsRouter.post('/', requireRole(...BACK_OFFICE), validate({ body: createSubscriptionSchema }), async (req, res) => {
  res.status(201).json({ data: await subs.createSubscription(req.valid.body, req.user) });
});

subscriptionsRouter.post('/preview', requireRole(...BACK_OFFICE), validate({ body: createSubscriptionSchema }), async (req, res) => {
  res.json({ data: await subs.previewSubscription(req.valid.body) });
});

subscriptionsRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json({ data: await subs.getSubscription(req.user, req.valid.params.id) });
});

subscriptionsRouter.patch('/:id', requireRole(...BACK_OFFICE), validate({ params: idParam, body: updateSubscriptionSchema }), async (req, res) => {
  res.json({ data: await subs.updateSubscription(req.user, req.valid.params.id, req.valid.body) });
});

subscriptionsRouter.get('/:id/events', validate({ params: idParam }), async (req, res) => {
  res.json({ data: await subs.listEvents(req.user, req.valid.params.id) });
});

subscriptionsRouter.post('/:id/actions/:action', validate({ params: actionParams, body: actionBody }), async (req, res) => {
  const { id, action } = req.valid.params;
  res.json({ data: await performAction(req.user, id, action, req.valid.body.note) });
});

subscriptionsRouter.post('/:id/invoice', requireRole(...BACK_OFFICE), validate({ params: idParam }), async (req, res) => {
  res.status(201).json({ data: await billNow(req.user, req.valid.params.id) });
});
