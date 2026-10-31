// Pure money maths for one invoice (API.md §7, TECHNICAL_DESIGN §9.3, §11.2).
// No database access: callers pass lines, the base fee, candidate discounts and the date.
import { D, ZERO, round2, sum, min, rateToApi, toApi } from '../../lib/money.js';

/**
 * A discount is eligible when active, inside its dates and not used up.
 * Minimums are checked by the caller per scope.
 */
export function isEligibleOn(discount, date) {
  if (!discount.isActive) return false;
  if (discount.startDate > date) return false;
  if (discount.endDate && discount.endDate < date) return false;
  if (discount.usageLimit != null && discount.usedCount >= discount.usageLimit) return false;
  return true;
}

const discountAmount = (discount, base) =>
  discount.type === 'PERCENT' ? round2(D(base).times(discount.value).div(100)) : min(discount.value, base);

/** Picks the discount giving the largest amount on `base` (ties: lowest id). */
function best(candidates, base) {
  let pick = null;
  for (const discount of candidates) {
    const amount = discountAmount(discount, base);
    if (amount.lte(0)) continue;
    if (!pick || amount.gt(pick.amount) || (amount.eq(pick.amount) && discount.id < pick.discount.id)) {
      pick = { discount, amount };
    }
  }
  return pick;
}

function taxesFor(line, taxable) {
  return line.taxes.map((tax) => {
    const amount =
      tax.type === 'PERCENT' ? round2(D(taxable).times(tax.rate).div(100)) : round2(D(tax.rate).times(line.quantity));
    return { taxId: tax.id, name: tax.name, type: tax.type, rate: rateToApi(tax.rate), amount };
  });
}

/**
 * Computes every invoice line and the totals.
 *
 * @param {object} input
 * @param {Array} input.lines product lines `{ productId, variantId, description, quantity, unitPrice, taxes }`
 * @param {object|null} input.baseFee plan base fee `{ description, unitPrice, taxes }` (only when plan.price > 0)
 * @param {Array} input.discounts candidate discounts with `productIds` and `subscriptionIds`
 * @param {number|null} input.subscriptionId
 * @param {Date} input.date invoice date (business date)
 * @returns {{ lines: Array, appliedDiscounts: Array, totals: { untaxed, discount, tax, total } }} Decimals
 */
export function calculate({ lines, baseFee, discounts = [], subscriptionId = null, date }) {
  const rows = lines.map((l) => ({ ...l, kind: 'PRODUCT', subtotal: round2(D(l.quantity).times(l.unitPrice)) }));
  if (baseFee && D(baseFee.unitPrice).gt(0)) {
    rows.push({ ...baseFee, productId: null, variantId: null, quantity: 1, kind: 'BASE_FEE', subtotal: round2(baseFee.unitPrice) });
  }
  rows.forEach((r) => (r.discountAmount = ZERO));

  const untaxed = sum(rows.map((r) => r.subtotal));
  const eligible = discounts.filter((d) => isEligibleOn(d, date) && untaxed.gte(d.minPurchase ?? 0));
  const applied = new Map(); // discountId → { id, name, amount }
  const note = (discount, amount) => {
    const entry = applied.get(discount.id) ?? { id: discount.id, name: discount.name, amount: ZERO };
    entry.amount = entry.amount.plus(amount);
    applied.set(discount.id, entry);
  };

  // 1. PRODUCT scope: best single discount per product line.
  for (const row of rows) {
    if (row.kind !== 'PRODUCT') continue;
    const candidates = eligible.filter(
      (d) => d.scope === 'PRODUCT' && d.productIds.includes(row.productId) && row.quantity >= (d.minQuantity ?? 0),
    );
    const pick = best(candidates, row.subtotal);
    if (pick) {
      row.discountAmount = pick.amount;
      note(pick.discount, pick.amount);
    }
  }

  // 2. SUBSCRIPTION scope: best single discount on the whole invoice, spread over lines by remaining subtotal.
  const totalQuantity = rows.filter((r) => r.kind === 'PRODUCT').reduce((n, r) => n + r.quantity, 0);
  const base = sum(rows.map((r) => r.subtotal.minus(r.discountAmount)));
  const subCandidates = eligible.filter(
    (d) =>
      d.scope === 'SUBSCRIPTION' &&
      (d.subscriptionIds.length === 0 || d.subscriptionIds.includes(subscriptionId)) &&
      totalQuantity >= (d.minQuantity ?? 0),
  );
  const subPick = base.gt(0) ? best(subCandidates, base) : null;
  if (subPick) {
    const shares = rows.filter((r) => r.subtotal.minus(r.discountAmount).gt(0));
    let left = subPick.amount;
    shares.forEach((row, i) => {
      const remaining = row.subtotal.minus(row.discountAmount);
      const share = i === shares.length - 1 ? min(left, remaining) : round2(subPick.amount.times(remaining).div(base));
      row.discountAmount = row.discountAmount.plus(share);
      left = left.minus(share);
    });
    note(subPick.discount, subPick.amount);
  }

  // 3. Taxes on the discounted amount, rounded per tax per line.
  for (const row of rows) {
    const taxable = row.subtotal.minus(row.discountAmount);
    const taxes = taxesFor(row, taxable);
    row.taxAmount = sum(taxes.map((t) => t.amount));
    row.taxSnapshot = taxes.map((t) => ({ ...t, amount: toApi(t.amount) }));
    row.total = taxable.plus(row.taxAmount);
  }

  const discount = sum(rows.map((r) => r.discountAmount));
  const tax = sum(rows.map((r) => r.taxAmount));
  return {
    lines: rows,
    appliedDiscounts: [...applied.values()],
    totals: { untaxed, discount, tax, total: untaxed.minus(discount).plus(tax) },
  };
}
