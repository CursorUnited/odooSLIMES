import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN, BACK_OFFICE } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import { createProductSchema, updateProductSchema, variantBody, updateVariantSchema, listProductsQuery } from './products.schema.js';
import * as products from './products.service.js';

export const productsRouter = Router();
export const variantsRouter = Router();

productsRouter.get('/', requireRole(...BACK_OFFICE), validate({ query: listProductsQuery }), async (req, res) => {
  res.json(await products.listProducts(req.valid.query));
});

productsRouter.get('/:id', requireRole(...BACK_OFFICE), validate({ params: idParam }), async (req, res) => {
  res.json({ data: await products.getProduct(req.valid.params.id) });
});

productsRouter.post('/', requireRole(ADMIN), validate({ body: createProductSchema }), async (req, res) => {
  res.status(201).json({ data: await products.createProduct(req.valid.body) });
});

productsRouter.patch('/:id', requireRole(ADMIN), validate({ params: idParam, body: updateProductSchema }), async (req, res) => {
  res.json({ data: await products.updateProduct(req.valid.params.id, req.valid.body) });
});

productsRouter.post('/:id/variants', requireRole(ADMIN), validate({ params: idParam, body: variantBody }), async (req, res) => {
  res.status(201).json({ data: await products.addVariant(req.valid.params.id, req.valid.body) });
});

variantsRouter.patch('/:id', requireRole(ADMIN), validate({ params: idParam, body: updateVariantSchema }), async (req, res) => {
  res.json({ data: await products.updateVariant(req.valid.params.id, req.valid.body) });
});
