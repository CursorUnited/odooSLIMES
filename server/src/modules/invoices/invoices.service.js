import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { today } from '../../lib/dates.js';
import { isCustomer, scopeToCustomer } from '../../lib/scope.js';
import { detailInclude, listSelect, toInvoiceDetailApi, toInvoiceListApi } from './invoices.view.js';

/** Customers never see DRAFT or CANCELLED invoices, and only their own. */
export function visibleWhere(user, where = {}) {
  const scoped = scopeToCustomer(user, where);
  return isCustomer(user) ? { AND: [scoped, { status: { in: ['CONFIRMED', 'PAID'] } }] } : scoped;
}

export async function findInvoice(user, id, db = prisma) {
  const inv = await db.invoice.findFirst({ where: visibleWhere(user, { id }), include: detailInclude });
  if (!inv) throw notFound('Invoice');
  return inv;
}

export async function getInvoice(user, id) {
  return toInvoiceDetailApi(await findInvoice(user, id), user);
}

/**
 * Invoice list. `overdue=true` = CONFIRMED with due date before today (a CONFIRMED
 * invoice always has money due; fully paid ones are PAID). Uses the (status, due_date) index.
 */
export function listInvoices(user, { page, pageSize, sort, q, status, overdue, customerId, subscriptionId, from, to, dueFrom, dueTo }) {
  const now = today();
  const where = visibleWhere(user, {
    ...(status && { status: { in: status } }),
    ...(overdue === true && { status: 'CONFIRMED', dueDate: { lt: now } }),
    ...(customerId && { customerId }),
    ...(subscriptionId && { subscriptionId }),
    ...((from || to) && { invoiceDate: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
    ...((dueFrom || dueTo) && { dueDate: { ...(dueFrom && { gte: dueFrom }), ...(dueTo && { lte: dueTo }) } }),
    ...(q && { OR: [{ number: ilike(q) }, { customer: { name: ilike(q) } }] }),
  });
  return paginate(prisma.invoice, { where, orderBy: orderByFrom(sort), page, pageSize, select: listSelect, map: toInvoiceListApi });
}
