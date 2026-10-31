import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { D, toApi } from '../../lib/money.js';
import { toIsoLocal } from '../../lib/dates.js';
import { checkLines } from '../products/lineRules.js';
import { toTermApi } from '../paymentTerms/paymentTerms.routes.js';

const include = {
  plan: { select: { id: true, name: true, minQuantity: true } },
  paymentTerm: true,
  lines: {
    orderBy: { id: 'asc' },
    include: { product: { select: { id: true, name: true, salesPrice: true } }, variant: true },
  },
};

const toTemplateApi = (t) => ({
  id: t.id,
  name: t.name,
  plan: { id: t.plan.id, name: t.plan.name },
  validityDays: t.validityDays,
  paymentTerm: t.paymentTerm ? toTermApi(t.paymentTerm) : null,
  notes: t.notes,
  lines: t.lines.map((l) => ({
    id: l.id,
    product: { id: l.product.id, name: l.product.name },
    variant: l.variant ? { id: l.variant.id, label: `${l.variant.attribute}: ${l.variant.value}` } : null,
    quantity: l.quantity,
    unitPrice: toApi(D(l.product.salesPrice).plus(l.variant?.extraPrice ?? 0)), // current price
    description: l.description,
  })),
  createdAt: toIsoLocal(t.createdAt),
});

async function loadPlan(planId) {
  const plan = await prisma.recurringPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, { planId: 'Choose an active plan.' });
  }
  return plan;
}

async function assertTerm(paymentTermId) {
  if (paymentTermId && !(await prisma.paymentTerm.findUnique({ where: { id: paymentTermId } }))) {
    throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, { paymentTermId: 'Choose a payment term.' });
  }
}

const lineData = (lines) =>
  lines.map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, quantity: l.quantity, description: l.description ?? null }));

export function listTemplates({ page, pageSize, sort, q, planId }) {
  const where = { ...(q && { name: ilike(q) }), ...(planId && { planId }) };
  return paginate(prisma.quotationTemplate, {
    where,
    orderBy: orderByFrom(sort),
    page,
    pageSize,
    include: { plan: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
    map: (t) => ({ id: t.id, name: t.name, plan: t.plan, validityDays: t.validityDays, lineCount: t._count.lines }),
  });
}

export async function getTemplate(id) {
  const t = await prisma.quotationTemplate.findUnique({ where: { id }, include });
  if (!t) throw notFound('Quotation template');
  return toTemplateApi(t);
}

/** Creates a template; every line is checked against the catalog and the plan minimum. */
export async function createTemplate({ lines, ...fields }) {
  const plan = await loadPlan(fields.planId);
  await assertTerm(fields.paymentTermId);
  await checkLines(prisma, lines, plan);
  const t = await prisma.quotationTemplate.create({ data: { ...fields, lines: { create: lineData(lines) } }, include });
  return toTemplateApi(t);
}

/** Updates a template; `lines` replaces all lines. Existing subscriptions are never changed. */
export async function updateTemplate(id, { lines, ...fields }) {
  const existing = await prisma.quotationTemplate.findUnique({ where: { id }, include: { lines: true } });
  if (!existing) throw notFound('Quotation template');
  const plan = await loadPlan(fields.planId ?? existing.planId);
  await assertTerm(fields.paymentTermId);
  await checkLines(prisma, lines ?? existing.lines, plan);
  const t = await prisma.quotationTemplate.update({
    where: { id },
    data: { ...fields, ...(lines && { lines: { deleteMany: {}, create: lineData(lines) } }) },
    include,
  });
  return toTemplateApi(t);
}
