import { AppError } from '../../lib/errors.js';

/** Message used for SUB_MIN_QUANTITY and template lines (UI_UX_SPEC §7). */
export const minQuantityMessage = (plan) => `Quantity must be at least ${plan.minQuantity} for the ${plan.name} plan.`;

/**
 * Checks product lines against the catalog and the plan: product exists and is
 * active, variant belongs to the product, quantity ≥ plan minimum.
 * Returns the loaded products (with variants and default taxes) keyed by id.
 * Errors use field paths like `lines.1.quantity`; `minQuantityCode` lets
 * subscriptions raise SUB_MIN_QUANTITY instead of VALIDATION_FAILED.
 */
export async function checkLines(db, lines, plan, { minQuantityCode = 'VALIDATION_FAILED' } = {}) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    include: { variants: true, taxes: { where: { isActive: true }, orderBy: { id: 'asc' } } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const fields = {};
  let minQuantityOnly = true;
  lines.forEach((line, i) => {
    const product = byId.get(line.productId);
    if (!product || !product.isActive) {
      fields[`lines.${i}.productId`] = 'Choose an active product.';
      minQuantityOnly = false;
      return;
    }
    if (line.variantId) {
      const variant = product.variants.find((v) => v.id === line.variantId);
      if (!variant || !variant.isActive) {
        fields[`lines.${i}.variantId`] = 'Choose a variant of this product.';
        minQuantityOnly = false;
      }
    }
    if (line.quantity < plan.minQuantity) fields[`lines.${i}.quantity`] = minQuantityMessage(plan);
  });

  if (Object.keys(fields).length) {
    const code = minQuantityOnly ? minQuantityCode : 'VALIDATION_FAILED';
    const message = code === 'VALIDATION_FAILED' ? 'Some fields need attention.' : minQuantityMessage(plan);
    throw new AppError(code, message, 400, fields);
  }
  return byId;
}
