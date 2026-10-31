import { prisma } from '../../lib/prisma.js';
import { AppError, notFound, forbidden } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { toApi } from '../../lib/money.js';
import { toIsoLocal } from '../../lib/dates.js';
import { isCustomer } from '../../lib/scope.js';

const fields = { id: true, name: true, email: true, phone: true, company: true, address: true, createdAt: true };
const toCustomerApi = (c) => ({ ...c, createdAt: toIsoLocal(c.createdAt) });

const EMAIL_TAKEN = () =>
  new AppError('DUPLICATE', 'A customer with this email already exists.', 409, { email: 'A customer with this email already exists.' });

async function assertEmailFree(email, exceptId) {
  const clash = await prisma.customer.findFirst({ where: { email, ...(exceptId && { id: { not: exceptId } }) }, select: { id: true } });
  if (clash) throw EMAIL_TAKEN();
}

/** A customer may only touch their own record; others get 404 (no existence leak). */
function assertVisible(user, id) {
  if (isCustomer(user) && user.customerId !== id) throw notFound('Customer');
}

/** Back-office list; q searches name, email and company. */
export function listCustomers({ page, pageSize, sort, q }) {
  const where = q ? { OR: [{ name: ilike(q) }, { email: ilike(q) }, { company: ilike(q) }] } : {};
  return paginate(prisma.customer, {
    where,
    orderBy: orderByFrom(sort),
    page,
    pageSize,
    select: {
      ...fields,
      user: { select: { id: true } },
      _count: { select: { subscriptions: { where: { status: 'ACTIVE' } } } },
    },
    map: ({ user, _count, ...c }) => ({ ...toCustomerApi(c), hasPortalUser: Boolean(user), activeSubscriptions: _count.subscriptions }),
  });
}

/** One customer with subscription counts by status and what they owe now (CONFIRMED invoices). */
export async function getCustomer(user, id) {
  assertVisible(user, id);
  const customer = await prisma.customer.findUnique({ where: { id }, select: { ...fields, user: { select: { id: true } } } });
  if (!customer) throw notFound('Customer');

  const [byStatus, owed] = await Promise.all([
    prisma.subscription.groupBy({ by: ['status'], where: { customerId: id }, _count: { _all: true } }),
    prisma.$queryRaw`SELECT coalesce(sum(total - amount_paid), 0) AS owed FROM invoices WHERE customer_id = ${id} AND status = 'CONFIRMED'`,
  ]);
  const { user: portalUser, ...rest } = customer;
  return {
    ...toCustomerApi(rest),
    hasPortalUser: Boolean(portalUser),
    subscriptionCounts: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    outstandingAmount: toApi(owed[0].owed),
  };
}

export async function createCustomer(data, actor) {
  await assertEmailFree(data.email);
  const customer = await prisma.customer.create({ data: { ...data, createdById: actor.id }, select: fields });
  return toCustomerApi(customer);
}

/** Staff/Admin may change everything incl. email; a customer edits only their own contact fields. */
export async function updateCustomer(user, id, data) {
  assertVisible(user, id);
  if (isCustomer(user) && data.email !== undefined) throw forbidden();
  if (!(await prisma.customer.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Customer');
  if (data.email) await assertEmailFree(data.email, id);
  const customer = await prisma.customer.update({ where: { id }, data, select: fields });
  return toCustomerApi(customer);
}
