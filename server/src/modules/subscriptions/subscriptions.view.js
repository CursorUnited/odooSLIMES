// Subscription → API shape (API.md §4.8.1, §4.8.4). The money comes from calc.js.
import { D, toApi } from '../../lib/money.js';
import { formatDate, toIsoLocal, today } from '../../lib/dates.js';
import { calculate } from '../billing/calc.js';
import { toTaxApi } from '../taxes/taxes.routes.js';
import { toTermApi } from '../paymentTerms/paymentTerms.routes.js';
import { allowedActions } from './lifecycle.js';

/** Prisma include for one subscription with everything the detail view and billing need. */
export const detailInclude = {
  customer: { select: { id: true, name: true, email: true } },
  plan: { include: { taxes: { where: { isActive: true }, orderBy: { id: 'asc' } } } },
  template: { select: { id: true, name: true, validityDays: true } },
  paymentTerm: true,
  createdBy: { select: { id: true, name: true } },
  lines: {
    orderBy: { id: 'asc' },
    include: { product: { select: { id: true, name: true } }, variant: true, taxes: { orderBy: { id: 'asc' } } },
  },
};

export const variantLabel = (v) => (v ? `${v.attribute}: ${v.value}` : null);

/** Calc input for a subscription's lines + plan base fee. */
export function calcInput(sub, discounts, date) {
  return {
    lines: sub.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxes: l.taxes,
      source: l,
    })),
    baseFee: D(sub.plan.price).gt(0)
      ? { description: `${sub.plan.name} plan base fee`, unitPrice: sub.plan.price, taxes: sub.plan.taxes }
      : null,
    discounts,
    subscriptionId: sub.id ?? null,
    date,
  };
}

export const previewOf = (sub, discounts, date = today()) => calculate(calcInput(sub, discounts, date));

export const totalsToApi = (t) => ({
  untaxed: toApi(t.untaxed),
  discount: toApi(t.discount),
  tax: toApi(t.tax),
  total: toApi(t.total),
});

/** Lines, base fee, applied discounts and totals in API form. */
export function moneyBlock(preview) {
  const productRows = preview.lines.filter((r) => r.kind === 'PRODUCT');
  const fee = preview.lines.find((r) => r.kind === 'BASE_FEE');
  return {
    lines: productRows.map((r) => {
      const l = r.source;
      return {
        id: l.id ?? null,
        product: { id: l.product.id, name: l.product.name },
        variant: l.variant ? { id: l.variant.id, label: variantLabel(l.variant) } : null,
        description: l.description,
        quantity: l.quantity,
        unitPrice: toApi(l.unitPrice),
        taxes: l.taxes.map(toTaxApi),
        amount: toApi(r.subtotal),
        discountAmount: toApi(r.discountAmount),
        taxAmount: toApi(r.taxAmount),
        total: toApi(r.total),
      };
    }),
    baseFee: fee ? { amount: toApi(fee.subtotal), discountAmount: toApi(fee.discountAmount), taxAmount: toApi(fee.taxAmount), total: toApi(fee.total) } : null,
    appliedDiscounts: preview.appliedDiscounts.map((a) => ({ id: a.id, name: a.name, amount: toApi(a.amount) })),
    totals: totalsToApi(preview.totals),
  };
}

const isExpired = (sub, now = today()) => Boolean(sub.expiryDate && sub.expiryDate < now && sub.status !== 'CLOSED');

const planApi = (p) => ({
  id: p.id,
  name: p.name,
  price: toApi(p.price),
  billingPeriod: p.billingPeriod,
  intervalCount: p.intervalCount,
  minQuantity: p.minQuantity,
  autoClose: p.autoClose,
  closable: p.closable,
  pausable: p.pausable,
  renewable: p.renewable,
});

/** Full detail view for `user` (allowedActions depend on the role). */
export function toDetailApi(sub, preview, user) {
  return {
    id: sub.id,
    number: sub.number,
    status: sub.status,
    customer: sub.customer,
    plan: planApi(sub.plan),
    template: sub.template ? { id: sub.template.id, name: sub.template.name } : null,
    paymentTerm: toTermApi(sub.paymentTerm),
    startDate: formatDate(sub.startDate),
    expiryDate: formatDate(sub.expiryDate),
    nextInvoiceDate: formatDate(sub.nextInvoiceDate),
    quotationValidUntil: formatDate(sub.quotationValidUntil),
    closedAt: formatDate(sub.closedAt),
    isExpired: isExpired(sub),
    notes: sub.notes,
    ...moneyBlock(preview),
    allowedActions: allowedActions(sub, user),
    createdBy: sub.createdBy,
    createdAt: toIsoLocal(sub.createdAt),
  };
}

/** List row (no lines; uses the cached recurringTotal). */
export const toListApi = (s) => ({
  id: s.id,
  number: s.number,
  status: s.status,
  customer: s.customer,
  plan: s.plan,
  startDate: formatDate(s.startDate),
  expiryDate: formatDate(s.expiryDate),
  nextInvoiceDate: formatDate(s.nextInvoiceDate),
  recurringTotal: toApi(s.recurringTotal),
  isExpired: isExpired(s),
});

export const toEventApi = (e) => ({
  id: e.id,
  action: e.action,
  fromStatus: e.fromStatus,
  toStatus: e.toStatus,
  note: e.note,
  user: e.user,
  createdAt: toIsoLocal(e.createdAt),
});
