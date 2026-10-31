import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { toApi } from '../../lib/money.js';
import { formatDate } from '../../lib/dates.js';
import { toTaxApi } from '../taxes/taxes.routes.js';
import { assertActiveTaxes } from '../products/products.service.js';
import { END_BEFORE_START, endsBeforeStart } from './plans.schema.js';

const include = { taxes: { orderBy: { id: 'asc' } } };

export const toPlanApi = (p) => ({
  id: p.id,
  name: p.name,
  price: toApi(p.price),
  billingPeriod: p.billingPeriod,
  intervalCount: p.intervalCount,
  minQuantity: p.minQuantity,
  startDate: formatDate(p.startDate),
  endDate: formatDate(p.endDate),
  autoClose: p.autoClose,
  closable: p.closable,
  pausable: p.pausable,
  renewable: p.renewable,
  isActive: p.isActive,
  ...(p.taxes && { taxes: p.taxes.map(toTaxApi) }),
});

/** Plans; `availableOn` keeps plans whose window [startDate, endDate] contains that date. */
export function listPlans({ page, pageSize, sort, q, billingPeriod, isActive, availableOn }) {
  const where = {
    ...(q && { name: ilike(q) }),
    ...(billingPeriod && { billingPeriod }),
    ...(isActive !== undefined && { isActive }),
    ...(availableOn && {
      startDate: { lte: availableOn },
      OR: [{ endDate: null }, { endDate: { gte: availableOn } }],
    }),
  };
  return paginate(prisma.recurringPlan, { where, orderBy: orderByFrom(sort), page, pageSize, include, map: toPlanApi });
}

export async function getPlan(id) {
  const plan = await prisma.recurringPlan.findUnique({ where: { id }, include });
  if (!plan) throw notFound('Plan');
  const activeSubscriptions = await prisma.subscription.count({ where: { planId: id, status: 'ACTIVE' } });
  return { ...toPlanApi(plan), activeSubscriptions };
}

/** Creates a plan; `taxIds` are the taxes on its base-fee line. */
export async function createPlan({ taxIds, ...fields }) {
  await assertActiveTaxes(prisma, taxIds);
  const plan = await prisma.recurringPlan.create({
    data: { ...fields, taxes: { connect: (taxIds ?? []).map((id) => ({ id })) } },
    include,
  });
  return toPlanApi(plan);
}

/**
 * Updates a plan. Price changes affect only future invoices. Changing the period
 * while ACTIVE subscriptions use the plan is refused (PLAN_IN_USE).
 */
export async function updatePlan(id, { taxIds, ...fields }) {
  const existing = await prisma.recurringPlan.findUnique({ where: { id } });
  if (!existing) throw notFound('Plan');
  const startDate = fields.startDate ?? existing.startDate;
  const endDate = fields.endDate !== undefined ? fields.endDate : existing.endDate;
  if (endsBeforeStart(startDate, endDate)) {
    throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, { endDate: END_BEFORE_START });
  }
  const periodChanged =
    (fields.billingPeriod && fields.billingPeriod !== existing.billingPeriod) ||
    (fields.intervalCount && fields.intervalCount !== existing.intervalCount);
  if (periodChanged && (await prisma.subscription.count({ where: { planId: id, status: 'ACTIVE' } }))) {
    throw new AppError('PLAN_IN_USE', 'This plan has active subscriptions, so its billing period cannot change.', 409);
  }
  await assertActiveTaxes(prisma, taxIds);
  const plan = await prisma.recurringPlan.update({
    where: { id },
    data: { ...fields, ...(taxIds && { taxes: { set: taxIds.map((t) => ({ id: t })) } }) },
    include,
  });
  return toPlanApi(plan);
}
