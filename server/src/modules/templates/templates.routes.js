import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireRole, ADMIN, BACK_OFFICE } from '../../middleware/auth.js';
import { idParam } from '../../lib/validation.js';
import { createTemplateSchema, updateTemplateSchema, listTemplatesQuery } from './templates.schema.js';
import * as templates from './templates.service.js';

export const templatesRouter = Router();

templatesRouter.get('/', requireRole(...BACK_OFFICE), validate({ query: listTemplatesQuery }), async (req, res) => {
  res.json(await templates.listTemplates(req.valid.query));
});

templatesRouter.get('/:id', requireRole(...BACK_OFFICE), validate({ params: idParam }), async (req, res) => {
  res.json({ data: await templates.getTemplate(req.valid.params.id) });
});

templatesRouter.post('/', requireRole(ADMIN), validate({ body: createTemplateSchema }), async (req, res) => {
  res.status(201).json({ data: await templates.createTemplate(req.valid.body) });
});

templatesRouter.patch('/:id', requireRole(ADMIN), validate({ params: idParam, body: updateTemplateSchema }), async (req, res) => {
  res.json({ data: await templates.updateTemplate(req.valid.params.id, req.valid.body) });
});
