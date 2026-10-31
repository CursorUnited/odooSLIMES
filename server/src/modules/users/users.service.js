import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { toIsoLocal } from '../../lib/dates.js';

const select = { id: true, name: true, email: true, role: true, isActive: true, createdAt: true };
const toApi = (u) => ({ ...u, createdAt: toIsoLocal(u.createdAt) });

/** Admin list of users; filters role, isActive, q (name or email). */
export function listUsers({ page, pageSize, sort, q, role, isActive }) {
  const where = {
    ...(role && { role }),
    ...(isActive !== undefined && { isActive }),
    ...(q && { OR: [{ name: ilike(q) }, { email: ilike(q) }] }),
  };
  return paginate(prisma.user, { where, orderBy: orderByFrom(sort), page, pageSize, select, map: toApi });
}

/** Creates a STAFF user (only Admin calls this; the role is fixed). */
export async function createStaff({ name, email, password }) {
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new AppError('AUTH_EMAIL_TAKEN', 'An account with this email already exists.', 409, {
      email: 'An account with this email already exists.',
    });
  }
  const user = await prisma.user.create({
    data: { name, email, role: 'STAFF', passwordHash: await hashPassword(password) },
    select,
  });
  return toApi(user);
}

/** Renames or (de)activates a user. An Admin cannot deactivate themself. */
export async function updateUser(id, { name, isActive }, actor) {
  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('User');
  if (id === actor.id && isActive === false) {
    throw new AppError('FORBIDDEN_SELF_ACTION', "You can't deactivate your own account.", 409);
  }
  const user = await prisma.user.update({
    where: { id },
    data: { ...(name !== undefined && { name }), ...(isActive !== undefined && { isActive }) },
    select,
  });
  return toApi(user);
}
