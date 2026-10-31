import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { toApi } from '../../lib/money.js';
import { formatDate, today } from '../../lib/dates.js';
import { ruleErrors } from './discounts.schema.js';

const include = {
  products: { select: { id: true, name: true }, orderBy: { id: 'asc' } },
  subscriptions: { select: { id: true, number: true }, orderBy: { id: 'asc' } },
};

const isExhausted = (d) => d.usageLimit != null && d.usedCount >= d.usageLimit;

/** Derived, never stored (UI_UX_SPEC §5.12 chips). */
export function stateOf(d, now = today()) {
  if (!d.isActive) return 'INACTIVE';
  if (isExhausted(d)) return 'EXHAUSTED';
  if (d.endDate && d.endDate < now) return 'EXPIRED';
  if (d.startDate > now) return 'SCHEDULED';
  return 'ACTIVE';
}

const toDiscountApi = (d) => ({
  id: d.id,
  name: d.name,
  type: d.type,
  value: toApi(d.value),
  scope: d.scope,
  minPurchase: toApi(d.minPurchase),
  minQuantity: d.minQuantity,
  startDate: formatDate(d.startDate),
  endDate: formatDate(d.endDate),
  usageLimit: d.usageLimit,
  usedCount: d.usedCount,
  isActive: d.isActive,
  state: stateOf(d),
  ...(d.products && { products: d.products }),
  ...(d.subscriptions && { subscriptions: d.subscriptions }),
});

const notUsedUp = () => ({ OR: [{ usageLimit: null }, { usedCount: { lt: prisma.discount.fields.usageLimit } }] });

/** SQL version of stateOf for the `status` filter. */
function statusWhere(status, now) {
  switch (status) {
    case 'inactive':
      return { isActive: false };
    case 'exhausted':
      return { isActive: true, usageLimit: { not: null }, usedCount: { gte: prisma.discount.fields.usageLimit } };
    case 'expired':
      return { isActive: true, endDate: { lt: now }, ...notUsedUp() };
    case 'scheduled':
      return { isActive: true, startDate: { gt: now }, ...notUsedUp() };
    case 'active':
      return { isActive: true, startDate: { lte: now }, AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }, notUsedUp()] };
    default:
      return {};
  }
}

export function listDiscounts({ page, pageSize, sort, q, scope, status }) {
  const where = { ...(q && { name: ilike(q) }), ...(scope && { scope }), ...statusWhere(status, today()) };
  return paginate(prisma.discount, { where, orderBy: orderByFrom(sort), page, pageSize, map: toDiscountApi });
}

export async function getDiscount(id) {
  const d = await prisma.discount.findUnique({ where: { id }, include });
  if (!d) throw notFound('Discount');
  return toDiscountApi(d);
}

async function assertLinks({ productIds, subscriptionIds }) {
  const fields = {};
  if (productIds?.length && (await prisma.product.count({ where: { id: { in: productIds } } })) !== new Set(productIds).size) {
    fields.productIds = 'Choose existing products.';
  }
  if (subscriptionIds?.length && (await prisma.subscription.count({ where: { id: { in: subscriptionIds } } })) !== new Set(subscriptionIds).size) {
    fields.subscriptionIds = 'Choose existing subscriptions.';
  }
  if (Object.keys(fields).length) throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, fields);
}

async function assertNameFree(name, exceptId) {
  const clash = await prisma.discount.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) } });
  if (clash) throw new AppError('DUPLICATE', 'A discount with this name already exists.', 409, { name: 'A discount with this name already exists.' });
}

/** Admin creates a rule; it is picked up by the next invoice that meets it. */
export async function createDiscount({ productIds, subscriptionIds, ...fields }) {
  await assertNameFree(fields.name);
  await assertLinks({ productIds, subscriptionIds });
  const d = await prisma.discount.create({
    data: {
      ...fields,
      products: { connect: productIds.map((id) => ({ id })) },
      subscriptions: { connect: subscriptionIds.map((id) => ({ id })) },
    },
    include,
  });
  return toDiscountApi(d);
}

/** Any field; productIds / subscriptionIds replace the links. usageLimit never below usedCount. */
export async function updateDiscount(id, { productIds, subscriptionIds, ...fields }) {
  const existing = await prisma.discount.findUnique({ where: { id }, include });
  if (!existing) throw notFound('Discount');
  const merged = {
    ...existing,
    ...fields,
    productIds: productIds ?? existing.products.map((p) => p.id),
  };
  const errors = ruleErrors(merged);
  if (fields.usageLimit != null && fields.usageLimit < existing.usedCount) {
    errors.usageLimit = `Already used ${existing.usedCount} times; the limit can't be lower.`;
  }
  if (Object.keys(errors).length) throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, errors);
  if (fields.name) await assertNameFree(fields.name, id);
  await assertLinks({ productIds, subscriptionIds });

  const d = await prisma.discount.update({
    where: { id },
    data: {
      ...fields,
      ...(productIds && { products: { set: productIds.map((p) => ({ id: p })) } }),
      ...(subscriptionIds && { subscriptions: { set: subscriptionIds.map((s) => ({ id: s })) } }),
    },
    include,
  });
  return toDiscountApi(d);
}
