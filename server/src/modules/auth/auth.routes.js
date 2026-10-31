import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth, AUTH_COOKIE } from '../../middleware/auth.js';
import { rateLimit, byEmail } from '../../middleware/rateLimit.js';
import { signupSchema, loginSchema, forgotSchema, resetSchema, weakPasswordAware } from './auth.schema.js';
import * as auth from './auth.service.js';

export const authRouter = Router();
const limiter = rateLimit({ max: 10, windowMs: 60_000, key: byEmail });

authRouter.post('/signup', validate({ body: signupSchema }, { onError: weakPasswordAware }), async (req, res) => {
  const user = await auth.signup(req.valid.body);
  res.cookie(AUTH_COOKIE, auth.issueToken(user), auth.cookieOptions());
  res.status(201).json({ data: auth.toAuthUser(user) });
});

authRouter.post('/login', limiter, validate({ body: loginSchema }), async (req, res) => {
  const user = await auth.login(req.valid.body);
  res.cookie(AUTH_COOKIE, auth.issueToken(user), auth.cookieOptions());
  res.json({ data: auth.toAuthUser(user) });
});

authRouter.post('/logout', (req, res) => {
  const { maxAge, ...opts } = auth.cookieOptions();
  res.clearCookie(AUTH_COOKIE, opts);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ data: await auth.me(req.user.id) });
});

authRouter.post('/forgot-password', limiter, validate({ body: forgotSchema }), async (req, res) => {
  await auth.forgotPassword(req.valid.body);
  res.json({ data: { ok: true } });
});

authRouter.post('/reset-password', validate({ body: resetSchema }, { onError: weakPasswordAware }), async (req, res) => {
  await auth.resetPassword(req.valid.body);
  res.json({ data: { ok: true } });
});
