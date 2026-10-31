import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN, BACK_OFFICE } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import { createDiscountSchema, updateDiscountSchema, listDiscountsQuery } from './discounts.schema.js';
import * as discounts from './discounts.service.js';

export const discountsRouter = Router();

discountsRouter.get('/', requireRole(...BACK_OFFICE), validate({ query: listDiscountsQuery }), async (req, res) => {
  res.json(await discounts.listDiscounts(req.valid.query));
});

discountsRouter.get('/:id', requireRole(...BACK_OFFICE), validate({ params: idParam }), async (req, res) => {
  res.json({ data: await discounts.getDiscount(req.valid.params.id) });
});

discountsRouter.post('/', requireRole(ADMIN), validate({ body: createDiscountSchema }), async (req, res) => {
  res.status(201).json({ data: await discounts.createDiscount(req.valid.body) });
});

discountsRouter.patch('/:id', requireRole(ADMIN), validate({ params: idParam, body: updateDiscountSchema }), async (req, res) => {
  res.json({ data: await discounts.updateDiscount(req.valid.params.id, req.valid.body) });
});
