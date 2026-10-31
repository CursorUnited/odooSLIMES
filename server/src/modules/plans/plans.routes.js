import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN, BACK_OFFICE } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import { createPlanSchema, updatePlanSchema, listPlansQuery } from './plans.schema.js';
import * as plans from './plans.service.js';

export const plansRouter = Router();

plansRouter.get('/', requireRole(...BACK_OFFICE), validate({ query: listPlansQuery }), async (req, res) => {
  res.json(await plans.listPlans(req.valid.query));
});

plansRouter.get('/:id', requireRole(...BACK_OFFICE), validate({ params: idParam }), async (req, res) => {
  res.json({ data: await plans.getPlan(req.valid.params.id) });
});

plansRouter.post('/', requireRole(ADMIN), validate({ body: createPlanSchema }), async (req, res) => {
  res.status(201).json({ data: await plans.createPlan(req.valid.body) });
});

plansRouter.patch('/:id', requireRole(ADMIN), validate({ params: idParam, body: updatePlanSchema }), async (req, res) => {
  res.json({ data: await plans.updatePlan(req.valid.params.id, req.valid.body) });
});
