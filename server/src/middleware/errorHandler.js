import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';

/** Zod issues → `{ "lines.0.quantity": "message" }` (first message per path). */
function zodFields(error) {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

function fromPrisma(err) {
  const target = [err.meta?.target ?? []].flat().join(',');
  switch (err.code) {
    case 'P2002':
      if (err.meta?.modelName === 'User' && target.includes('email')) {
        return new AppError('AUTH_EMAIL_TAKEN', 'An account with this email already exists.', 409, {
          email: 'An account with this email already exists.',
        });
      }
      return new AppError('DUPLICATE', 'This record already exists.', 409);
    case 'P2025':
      return new AppError('NOT_FOUND', 'Record not found.', 404);
    case 'P2003': {
      const field = String(err.meta?.field_name ?? '').replace(/_fkey.*$/, '');
      return new AppError('VALIDATION_FAILED', 'A linked record does not exist.', 400, field ? { [field]: 'Not found.' } : undefined);
    }
    default:
      return null;
  }
}

/** 404 for unknown API routes. */
export function notFoundRoute(req, res, next) {
  next(new AppError('NOT_FOUND', 'Route not found.', 404));
}

/** Maps every error to `{ error: { code, message, fields?, requestId } }`. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let appErr = null;

  if (err instanceof AppError) appErr = err;
  else if (err instanceof ZodError) {
    appErr = new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, zodFields(err));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) appErr = fromPrisma(err);
  else if (err?.type === 'entity.parse.failed') {
    appErr = new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.', 400);
  } else if (err?.type === 'entity.too.large') {
    appErr = new AppError('VALIDATION_FAILED', 'Request body is too large.', 413);
  }

  if (!appErr) {
    console.error(JSON.stringify({ level: 'error', requestId: req.id, path: req.originalUrl, stack: err?.stack ?? String(err) }));
    appErr = new AppError('INTERNAL', `Something went wrong (ref ${req.id}).`, 500);
  }

  const body = { code: appErr.code, message: appErr.message, requestId: req.id };
  if (appErr.fields) body.fields = appErr.fields;
  res.status(appErr.status).json({ error: body });
}
