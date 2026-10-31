import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, BACK_OFFICE } from '../../middleware/auth.js';
import { email, idParam, optionalText, phone, text } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';
import * as customers from './customers.service.js';

export const customersRouter = Router();

const customerFields = {
  name: text(120),
  email,
  phone,
  company: optionalText(120),
  address: optionalText(300),
};
const createCustomerSchema = z.object(customerFields);
const updateCustomerSchema = z.object(customerFields).partial();

customersRouter.get('/', requireRole(...BACK_OFFICE), validate({ query: listQuery(['name', 'createdAt']) }), async (req, res) => {
  res.json(await customers.listCustomers(req.valid.query));
});

customersRouter.post('/', requireRole(...BACK_OFFICE), validate({ body: createCustomerSchema }), async (req, res) => {
  res.status(201).json({ data: await customers.createCustomer(req.valid.body, req.user) });
});

customersRouter.get('/:id', requireAuth, validate({ params: idParam }), async (req, res) => {
  res.json({ data: await customers.getCustomer(req.user, req.valid.params.id) });
});

customersRouter.patch('/:id', requireAuth, validate({ params: idParam, body: updateCustomerSchema }), async (req, res) => {
  res.json({ data: await customers.updateCustomer(req.user, req.valid.params.id, req.valid.body) });
});
