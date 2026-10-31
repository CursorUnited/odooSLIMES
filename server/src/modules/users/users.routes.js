import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import { weakPasswordAware } from '../auth/auth.schema.js';
import { listUsersQuery, createStaffSchema, updateUserSchema } from './users.schema.js';
import * as users from './users.service.js';

export const usersRouter = Router();
usersRouter.use(requireRole(ADMIN));

usersRouter.get('/', validate({ query: listUsersQuery }), async (req, res) => {
  res.json(await users.listUsers(req.valid.query));
});

usersRouter.post('/', validate({ body: createStaffSchema }, { onError: weakPasswordAware }), async (req, res) => {
  res.status(201).json({ data: await users.createStaff(req.valid.body) });
});

usersRouter.patch('/:id', validate({ params: idParam, body: updateUserSchema }), async (req, res) => {
  res.json({ data: await users.updateUser(req.valid.params.id, req.valid.body, req.user) });
});
