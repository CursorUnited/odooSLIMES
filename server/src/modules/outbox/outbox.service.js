import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { toIsoLocal } from '../../lib/dates.js';

const toApi = (m) => ({ ...m, createdAt: toIsoLocal(m.createdAt), sentAt: toIsoLocal(m.sentAt) });

/** Admin list of stored emails, newest first; filters kind, to (contains), q (subject). */
export function listOutbox({ page, pageSize, sort, q, kind, to }) {
  const where = {
    ...(kind && { kind }),
    ...(to && { toEmail: ilike(to) }),
    ...(q && { subject: ilike(q) }),
  };
  return paginate(prisma.emailOutbox, {
    where,
    orderBy: orderByFrom(sort),
    page,
    pageSize,
    select: { id: true, toEmail: true, subject: true, kind: true, relatedId: true, createdAt: true, sentAt: true },
    map: toApi,
  });
}

/** One stored email with its HTML body (the reset link is clickable from here offline). */
export async function getOutbox(id) {
  const row = await prisma.emailOutbox.findUnique({ where: { id } });
  if (!row) throw notFound('Email');
  return toApi(row);
}
