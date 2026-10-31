import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

export const AUTH_COOKIE = 'sl_token';

/**
 * If a valid session cookie is present, sets `req.user = { id, role, customerId, name, email }`.
 * Re-reads the user each request so deactivated users are locked out at once. Never rejects.
 */
export async function authenticate(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE];
  if (!token) return next();
  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return next();
  }
  const user = await prisma.user.findUnique({
    where: { id: Number(claims.sub) },
    select: { id: true, role: true, customerId: true, name: true, email: true, isActive: true },
  });
  if (user?.isActive) req.user = user;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new AppError('AUTH_REQUIRED', 'Please log in to continue.', 401));
  next();
}

/** 401 without a session, 403 FORBIDDEN when the role is not in `roles`. */
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user) return next(new AppError('AUTH_REQUIRED', 'Please log in to continue.', 401));
    if (!roles.includes(req.user.role)) return next(new AppError('FORBIDDEN', "You don't have access to this.", 403));
    next();
  };

export const ADMIN = 'ADMIN';
export const STAFF = 'STAFF';
export const CUSTOMER = 'CUSTOMER';
export const BACK_OFFICE = [ADMIN, STAFF];
