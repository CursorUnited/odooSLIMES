import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, BACK_OFFICE } from '../../middleware/auth.js';
import { date, id, money, optionalText } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';
import { today } from '../../lib/dates.js';
import * as payments from './payments.service.js';

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'UPI', 'CHEQUE', 'OTHER'];

const createPaymentSchema = z.object({
  invoiceId: id,
  method: z.enum(METHODS),
  amount: money({ positive: true }),
  paymentDate: date.refine((d) => d <= today(), "Payment date can't be in the future."),
  note: optionalText(300),
});

const listPaymentsQuery = listQuery(
  ['paymentDate', 'amount', 'createdAt'],
  {
    invoiceId: id.optional(),
    customerId: id.optional(),
    method: z.enum(METHODS).optional(),
    from: date.optional(),
    to: date.optional(),
  },
  '-paymentDate',
);

paymentsRouter.get('/', validate({ query: listPaymentsQuery }), async (req, res) => {
  res.json(await payments.listPayments(req.user, req.valid.query));
});

paymentsRouter.post('/', requireRole(...BACK_OFFICE), validate({ body: createPaymentSchema }), async (req, res) => {
  res.status(201).json({ data: await payments.createPayment(req.valid.body, req.user) });
});
