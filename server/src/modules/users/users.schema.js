import { z } from 'zod';
import { email, password, text, queryBool } from '../../lib/validation.js';
import { listQuery } from '../../lib/paginate.js';

export const listUsersQuery = listQuery(['name', 'createdAt'], {
  role: z.enum(['ADMIN', 'STAFF', 'CUSTOMER']).optional(),
  isActive: queryBool.optional(),
});

/** Role is never taken from the body: POST /users always creates STAFF. */
export const createStaffSchema = z.object({ name: text(100), email, password });

export const updateUserSchema = z
  .object({ name: text(100).optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, 'Send name or isActive.');
