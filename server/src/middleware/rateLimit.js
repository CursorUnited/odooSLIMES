import { AppError } from '../lib/errors.js';

/**
 * Small in-memory limiter: `max` calls per `windowMs` per key. Off in tests.
 * Key defaults to IP + route. Behind the Vite proxy every browser shares one
 * IP, so login/forgot also key by the email to avoid locking out the whole demo.
 */
export function rateLimit({ max = 10, windowMs = 60_000, key = (req) => `${req.ip}:${req.path}` } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const now = Date.now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    const k = key(req);
    const entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      hits.set(k, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new AppError('RATE_LIMITED', 'Too many attempts. Please wait a minute and try again.', 429));
    }
    next();
  };
}

/** Key by IP + route + submitted email (lower-cased). */
export const byEmail = (req) => `${req.ip}:${req.path}:${String(req.body?.email ?? '').trim().toLowerCase()}`;
