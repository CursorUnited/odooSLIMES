import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { D, round2, toApi } from '../../lib/money.js';
import { formatDate, today } from '../../lib/dates.js';
import { nextNumber } from '../../lib/numbering.js';
import { scopeToCustomer } from '../../lib/scope.js';
import { checkLines } from '../products/lineRules.js';
import { detailInclude, previewOf, moneyBlock, toDetailApi, toListApi, toEventApi } from './subscriptions.view.js';

const fieldError = (fields, code = 'VALIDATION_FAILED', message = 'Some fields need attention.', status = 400) =>
  new AppError(code, message, status, fields);

/** Active discounts in the shape calc.js expects. */
export async function loadDiscounts(db = prisma) {
  const rows = await db.discount.findMany({
    where: { isActive: true },
    include: { products: { select: { id: true } }, subscriptions: { select: { id: true } } },
  });
  return rows.map(({ products, subscriptions, ...d }) => ({
    ...d,
    productIds: products.map((p) => p.id),
    subscriptionIds: subscriptions.map((s) => s.id),
  }));
}

/** Plan must be active and contain the start date (SUB_PLAN_NOT_AVAILABLE). */
export function assertPlanAvailable(plan, startDate) {
  if (!plan.isActive) {
    throw fieldError({ planId: 'This plan is no longer available.' }, 'SUB_PLAN_NOT_AVAILABLE', 'This plan is no longer available.');
  }
  if (startDate < plan.startDate || (plan.endDate && startDate > plan.endDate)) {
    const window = plan.endDate ? `from ${formatDate(plan.startDate)} to ${formatDate(plan.endDate)}` : `from ${formatDate(plan.startDate)}`;
    const message = `This plan is available ${window}.`;
    throw fieldError({ startDate: message }, 'SUB_PLAN_NOT_AVAILABLE', message);
  }
}

async function defaultPaymentTerm(db) {
  return (
    (await db.paymentTerm.findFirst({ where: { name: 'Immediate' } })) ??
    (await db.paymentTerm.findFirst({ orderBy: [{ dueDays: 'asc' }, { id: 'asc' }] }))
  );
}

/**
 * Turns a create/patch body (plus template defaults) into checked values and
 * fully priced lines. Throws field errors the form can show.
 */
async function resolveDraft(body, db = prisma) {
  const template = body.templateId
    ? await db.quotationTemplate.findUnique({ where: { id: body.templateId }, include: { lines: { orderBy: { id: 'asc' } } } })
    : null;
  if (body.templateId && !template) throw fieldError({ templateId: 'Choose a quotation template.' });

  const customer = await db.customer.findUnique({ where: { id: body.customerId }, select: { id: true } });
  if (!customer) throw fieldError({ customerId: 'Choose a customer.' });

  const planId = body.planId ?? template?.planId;
  const plan = await db.recurringPlan.findUnique({ where: { id: planId }, include: detailInclude.plan.include });
  if (!plan) throw fieldError({ planId: 'Choose a plan.' });
  assertPlanAvailable(plan, body.startDate);

  const paymentTermId = body.paymentTermId ?? template?.paymentTermId ?? (await defaultPaymentTerm(db))?.id;
  const paymentTerm = paymentTermId ? await db.paymentTerm.findUnique({ where: { id: paymentTermId } }) : null;
  if (!paymentTerm) throw fieldError({ paymentTermId: 'Choose a payment term.' });

  const inputLines =
    body.lines ??
    template?.lines.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity, description: l.description })) ??
    [];
  const products = await checkLines(db, inputLines, plan, { minQuantityCode: 'SUB_MIN_QUANTITY' });

  const explicitTaxIds = [...new Set(inputLines.flatMap((l) => l.taxIds ?? []))];
  const taxes = explicitTaxIds.length ? await db.tax.findMany({ where: { id: { in: explicitTaxIds }, isActive: true } }) : [];
  const taxById = new Map(taxes.map((t) => [t.id, t]));

  const lines = inputLines.map((l, i) => {
    const product = products.get(l.productId);
    const variant = l.variantId ? product.variants.find((v) => v.id === l.variantId) : null;
    if (l.taxIds?.some((t) => !taxById.has(t))) throw fieldError({ [`lines.${i}.taxIds`]: 'Choose active taxes only.' });
    return {
      productId: product.id,
      variantId: variant?.id ?? null,
      description: l.description ?? null,
      quantity: l.quantity,
      unitPrice: toApi(l.unitPrice ?? D(product.salesPrice).plus(variant?.extraPrice ?? 0)),
      taxes: l.taxIds ? l.taxIds.map((t) => taxById.get(t)) : product.taxes,
      product: { id: product.id, name: product.name },
      variant,
    };
  });

  return {
    customerId: customer.id,
    plan,
    template,
    paymentTermId: paymentTerm.id,
    startDate: body.startDate,
    expiryDate: body.expiryDate ?? null,
    notes: body.notes !== undefined ? body.notes : (template?.notes ?? null),
    lines,
  };
}

const lineCreate = (l) => ({
  productId: l.productId,
  variantId: l.variantId,
  description: l.description,
  quantity: l.quantity,
  unitPrice: l.unitPrice,
  amount: round2(D(l.quantity).times(l.unitPrice)),
  taxes: { connect: l.taxes.map((t) => ({ id: t.id })) },
});

/** Recomputes the next-invoice preview and caches recurringTotal / recurringUntaxed for lists and MRR. */
export async function refreshRecurring(tx, id) {
  const sub = await tx.subscription.findUnique({ where: { id }, include: detailInclude });
  const preview = previewOf(sub, await loadDiscounts(tx));
  await tx.subscription.update({
    where: { id },
    data: { recurringTotal: preview.totals.total, recurringUntaxed: preview.totals.untaxed.minus(preview.totals.discount) },
  });
  return { sub, preview };
}

/** Loads one subscription the user may see (customers: own only, else 404). */
export async function findVisible(user, id, db = prisma) {
  const sub = await db.subscription.findFirst({ where: scopeToCustomer(user, { id }), include: detailInclude });
  if (!sub) throw notFound('Subscription');
  return sub;
}

export async function getSubscription(user, id) {
  const sub = await findVisible(user, id);
  return toDetailApi(sub, previewOf(sub, await loadDiscounts()), user);
}

/** Creates a DRAFT, from a template (plan, terms, notes, lines copied) or from scratch. */
export async function createSubscription(body, user) {
  const draft = await resolveDraft(body);
  return prisma.$transaction(async (tx) => {
    const created = await tx.subscription.create({
      data: {
        number: await nextNumber(tx, 'SUB'),
        customerId: draft.customerId,
        planId: draft.plan.id,
        templateId: draft.template?.id ?? null,
        paymentTermId: draft.paymentTermId,
        startDate: draft.startDate,
        expiryDate: draft.expiryDate,
        notes: draft.notes,
        createdById: user.id,
        lines: { create: draft.lines.map(lineCreate) },
        events: {
          create: {
            action: 'CREATE',
            toStatus: 'DRAFT',
            userId: user.id,
            note: draft.template ? `Created from template "${draft.template.name}"` : null,
          },
        },
      },
    });
    const { sub, preview } = await refreshRecurring(tx, created.id);
    return toDetailApi(sub, preview, user);
  });
}

/** Totals for an unsaved form (same body as create); nothing is stored. */
export async function previewSubscription(body) {
  const draft = await resolveDraft(body);
  const pseudo = { id: null, plan: draft.plan, lines: draft.lines };
  return moneyBlock(previewOf(pseudo, await loadDiscounts()));
}

/** Edits a DRAFT or QUOTATION; `lines` replaces all lines (SUB_NOT_EDITABLE after confirm). */
export async function updateSubscription(user, id, body) {
  const existing = await findVisible(user, id);
  if (!['DRAFT', 'QUOTATION'].includes(existing.status)) {
    throw new AppError('SUB_NOT_EDITABLE', 'Confirmed subscriptions cannot be edited.', 409);
  }
  const merged = {
    customerId: body.customerId ?? existing.customerId,
    planId: body.planId ?? existing.planId,
    paymentTermId: body.paymentTermId ?? existing.paymentTermId,
    startDate: body.startDate ?? existing.startDate,
    expiryDate: body.expiryDate !== undefined ? body.expiryDate : existing.expiryDate,
    notes: body.notes !== undefined ? body.notes : existing.notes,
    lines:
      body.lines ??
      existing.lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        taxIds: l.taxes.map((t) => t.id),
        description: l.description,
      })),
  };
  if (merged.expiryDate && merged.expiryDate <= merged.startDate) {
    throw fieldError({ expiryDate: 'Expiry date must be after the start date.' });
  }
  const draft = await resolveDraft(merged);
  return prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id },
      data: {
        customerId: draft.customerId,
        planId: draft.plan.id,
        paymentTermId: draft.paymentTermId,
        startDate: draft.startDate,
        expiryDate: draft.expiryDate,
        notes: draft.notes,
        ...(body.lines && { lines: { deleteMany: {}, create: draft.lines.map(lineCreate) } }),
      },
    });
    const { sub, preview } = await refreshRecurring(tx, id);
    return toDetailApi(sub, preview, user);
  });
}

/** List with filters; customers see only their own. */
export function listSubscriptions(user, { page, pageSize, sort, q, status, customerId, planId, startFrom, startTo, expiringBefore }) {
  const where = scopeToCustomer(user, {
    ...(status && { status: { in: status } }),
    ...(customerId && { customerId }),
    ...(planId && { planId }),
    ...((startFrom || startTo) && { startDate: { ...(startFrom && { gte: startFrom }), ...(startTo && { lte: startTo }) } }),
    ...(expiringBefore && { expiryDate: { lt: expiringBefore } }),
    ...(q && { OR: [{ number: ilike(q) }, { customer: { name: ilike(q) } }] }),
  });
  return paginate(prisma.subscription, {
    where,
    orderBy: orderByFrom(sort),
    page,
    pageSize,
    select: {
      id: true, number: true, status: true, startDate: true, expiryDate: true, nextInvoiceDate: true, recurringTotal: true,
      customer: { select: { id: true, name: true } },
      plan: { select: { id: true, name: true, billingPeriod: true } },
    },
    map: toListApi,
  });
}

/** History, newest first. */
export async function listEvents(user, id) {
  await findVisible(user, id);
  const events = await prisma.subscriptionEvent.findMany({
    where: { subscriptionId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { user: { select: { id: true, name: true } } },
  });
  return events.map(toEventApi);
}

