// Invoice → API shape (API.md §4.11).
import { config } from '../../config/index.js';
import { D, toApi } from '../../lib/money.js';
import { formatDate, toIsoLocal, today } from '../../lib/dates.js';

export const detailInclude = {
  customer: { select: { id: true, name: true, email: true, company: true, address: true } },
  subscription: { select: { id: true, number: true, plan: { select: { name: true } } } },
  paymentTerm: true,
  lines: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  discounts: { include: { discount: { select: { id: true, name: true } } }, orderBy: { discountId: 'asc' } },
  payments: { orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }] },
};

export const amountDue = (inv) => {
  const due = D(inv.total).minus(inv.amountPaid);
  return due.lt(0) ? D(0) : due;
};

/** Derived, never stored: CONFIRMED, due date passed, money still owed. */
export const isOverdue = (inv, now = today()) =>
  inv.status === 'CONFIRMED' && Boolean(inv.dueDate) && inv.dueDate < now && amountDue(inv).gt(0);

/** Buttons the back office may use; customers get none. */
export function allowedInvoiceActions(inv, user) {
  if (user?.role === 'CUSTOMER') return [];
  switch (inv.status) {
    case 'DRAFT':
      return ['confirm', 'cancel'];
    case 'CONFIRMED':
      return D(inv.amountPaid).gt(0) ? ['send'] : ['send', 'cancel'];
    case 'PAID':
      return ['send'];
    default:
      return [];
  }
}

export const toPaymentApi = (p) => ({
  id: p.id,
  number: p.number,
  method: p.method,
  amount: toApi(p.amount),
  paymentDate: formatDate(p.paymentDate),
  note: p.note,
});

export function toInvoiceDetailApi(inv, user) {
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    company: config.company,
    customer: inv.customer,
    subscription: { id: inv.subscription.id, number: inv.subscription.number, plan: inv.subscription.plan.name },
    invoiceDate: formatDate(inv.invoiceDate),
    dueDate: formatDate(inv.dueDate),
    periodStart: formatDate(inv.periodStart),
    periodEnd: formatDate(inv.periodEnd),
    paymentTerm: inv.paymentTerm?.name ?? null,
    lines: inv.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: toApi(l.unitPrice),
      subtotal: toApi(l.subtotal),
      discountAmount: toApi(l.discountAmount),
      taxes: l.taxSnapshot.map((t) => ({ name: t.name, type: t.type, rate: t.rate, amount: t.amount })),
      taxAmount: toApi(l.taxAmount),
      total: toApi(l.total),
    })),
    discounts: inv.discounts.map((d) => ({ id: d.discount.id, name: d.discount.name, amount: toApi(d.amount) })),
    untaxedAmount: toApi(inv.untaxedAmount),
    discountAmount: toApi(inv.discountAmount),
    taxAmount: toApi(inv.taxAmount),
    total: toApi(inv.total),
    amountPaid: toApi(inv.amountPaid),
    amountDue: toApi(amountDue(inv)),
    isOverdue: isOverdue(inv),
    payments: inv.payments.map(toPaymentApi),
    sentAt: toIsoLocal(inv.sentAt),
    confirmedAt: toIsoLocal(inv.confirmedAt),
    paidAt: toIsoLocal(inv.paidAt),
    cancelledAt: toIsoLocal(inv.cancelledAt),
    allowedActions: allowedInvoiceActions(inv, user),
  };
}

export const listSelect = {
  id: true, number: true, status: true, invoiceDate: true, dueDate: true, total: true, amountPaid: true, sentAt: true,
  customer: { select: { id: true, name: true } },
  subscription: { select: { id: true, number: true } },
};

export const toInvoiceListApi = (inv) => ({
  id: inv.id,
  number: inv.number,
  status: inv.status,
  customer: inv.customer,
  subscription: inv.subscription,
  invoiceDate: formatDate(inv.invoiceDate),
  dueDate: formatDate(inv.dueDate),
  total: toApi(inv.total),
  amountPaid: toApi(inv.amountPaid),
  amountDue: toApi(amountDue(inv)),
  isOverdue: isOverdue(inv),
  sentAt: toIsoLocal(inv.sentAt),
});
