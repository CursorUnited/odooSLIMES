import { prisma } from '../../lib/prisma.js';
import { AppError, notFound } from '../../lib/errors.js';
import { paginate, orderByFrom, ilike } from '../../lib/paginate.js';
import { D, toApi } from '../../lib/money.js';
import { toTaxApi } from '../taxes/taxes.routes.js';

const DUPLICATE_NAME = () =>
  new AppError('DUPLICATE', 'A product with this name already exists.', 409, { name: 'A product with this name already exists.' });

const fullInclude = { taxes: { orderBy: { id: 'asc' } }, variants: { orderBy: { id: 'asc' } } };

/** Variant with its unit price: product.salesPrice + variant.extraPrice. */
export const toVariantApi = (v, salesPrice) => ({
  id: v.id,
  attribute: v.attribute,
  value: v.value,
  label: `${v.attribute}: ${v.value}`,
  extraPrice: toApi(v.extraPrice),
  price: toApi(D(salesPrice).plus(v.extraPrice)),
  isActive: v.isActive,
});

const toProductApi = (p) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  salesPrice: toApi(p.salesPrice),
  costPrice: toApi(p.costPrice),
  notes: p.notes,
  isActive: p.isActive,
  taxes: p.taxes.map(toTaxApi),
  variants: p.variants.map((v) => toVariantApi(v, p.salesPrice)),
});

/** Every id must be an active tax; otherwise a field error on `taxIds`. */
export async function assertActiveTaxes(db, taxIds, field = 'taxIds') {
  if (!taxIds?.length) return;
  const found = await db.tax.count({ where: { id: { in: taxIds }, isActive: true } });
  if (found !== new Set(taxIds).size) {
    throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, { [field]: 'Choose active taxes only.' });
  }
}

async function assertNameFree(name, exceptId) {
  const clash = await prisma.product.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, isActive: true, ...(exceptId && { id: { not: exceptId } }) },
    select: { id: true },
  });
  if (clash) throw DUPLICATE_NAME();
}

function assertUniqueVariants(variants = []) {
  const keys = variants.map((v) => `${v.attribute.toLowerCase()}=${v.value.toLowerCase()}`);
  if (new Set(keys).size !== keys.length) {
    throw new AppError('DUPLICATE', 'This variant already exists.', 409, { variants: 'This variant already exists.' });
  }
}

/** Product list; archived products hidden unless isActive=false. */
export function listProducts({ page, pageSize, sort, q, type, isActive }) {
  const where = { isActive, ...(type && { type }), ...(q && { name: ilike(q) }) };
  return paginate(prisma.product, {
    where,
    orderBy: orderByFrom(sort),
    page,
    pageSize,
    include: { _count: { select: { variants: { where: { isActive: true } } } } },
    map: (p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      salesPrice: toApi(p.salesPrice),
      costPrice: toApi(p.costPrice),
      isActive: p.isActive,
      variantCount: p._count.variants,
    }),
  });
}

export async function getProduct(id) {
  const product = await prisma.product.findUnique({ where: { id }, include: fullInclude });
  if (!product) throw notFound('Product');
  return toProductApi(product);
}

/** Creates a product with optional default taxes and variants. */
export async function createProduct({ taxIds, variants, ...fields }) {
  await assertNameFree(fields.name);
  await assertActiveTaxes(prisma, taxIds);
  assertUniqueVariants(variants);
  const product = await prisma.product.create({
    data: {
      ...fields,
      taxes: { connect: (taxIds ?? []).map((id) => ({ id })) },
      variants: { create: variants ?? [] },
    },
    include: fullInclude,
  });
  return toProductApi(product);
}

/** Updates product fields; `taxIds`, if sent, replaces the default taxes. Archive = isActive false. */
export async function updateProduct(id, { taxIds, ...fields }) {
  const existing = await prisma.product.findUnique({ where: { id }, select: { id: true, name: true, isActive: true } });
  if (!existing) throw notFound('Product');
  const name = fields.name ?? existing.name;
  if ((fields.isActive ?? existing.isActive) && (fields.name || fields.isActive)) await assertNameFree(name, id);
  await assertActiveTaxes(prisma, taxIds);
  const product = await prisma.product.update({
    where: { id },
    data: { ...fields, ...(taxIds && { taxes: { set: taxIds.map((t) => ({ id: t })) } }) },
    include: fullInclude,
  });
  return toProductApi(product);
}

export async function addVariant(productId, body) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { salesPrice: true } });
  if (!product) throw notFound('Product');
  const variant = await prisma.productVariant.create({ data: { ...body, productId } });
  return toVariantApi(variant, product.salesPrice);
}

/** Price changes never touch existing subscription lines or invoices (they copy the price). */
export async function updateVariant(id, body) {
  const existing = await prisma.productVariant.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw notFound('Variant');
  const variant = await prisma.productVariant.update({ where: { id }, data: body, include: { product: { select: { salesPrice: true } } } });
  return toVariantApi(variant, variant.product.salesPrice);
}
