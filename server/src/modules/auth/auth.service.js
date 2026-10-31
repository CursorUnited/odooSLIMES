import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../../config/index.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Compared against when the email is unknown, so both paths take the same time.
const dummyHash = hashPassword(randomBytes(16).toString('hex'));

const INVALID_CREDENTIALS = () => new AppError('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
const EMAIL_TAKEN = () =>
  new AppError('AUTH_EMAIL_TAKEN', 'An account with this email already exists.', 409, {
    email: 'An account with this email already exists.',
  });

/** Public user shape returned by signup, login and /auth/me. */
export const toAuthUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, customerId: u.customerId ?? null });

/** Signs the 8 h session token. */
export function issueToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role, customerId: user.customerId ?? null }, config.jwtSecret, {
    expiresIn: `${config.jwtTtlHours}h`,
  });
}

export const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.isProd,
  path: '/',
  maxAge: config.jwtTtlHours * 60 * 60 * 1000,
});

/**
 * Creates a CUSTOMER user and its customer record in one transaction (TECHNICAL_DESIGN §6.1).
 * If staff already created a customer with this email and it has no login, the user is linked to it.
 */
export async function signup({ name, email, password, company, phone }) {
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) throw EMAIL_TAKEN();
  const passwordHash = await hashPassword(password);

  // Two sign-ups racing on one email: the loser hits a unique key (user or customer email).
  return prisma.$transaction(async (tx) => {
    let customer = await tx.customer.findUnique({ where: { email }, include: { user: { select: { id: true } } } });
    if (customer?.user) throw EMAIL_TAKEN();
    if (!customer) {
      customer = await tx.customer.create({ data: { name, email, company: company ?? null, phone: phone ?? null } });
    }
    const user = await tx.user.create({ data: { email, name, passwordHash, role: 'CUSTOMER', customerId: customer.id } });
    await sendMail(tx, {
      to: email,
      subject: `Welcome to ${config.company.name}`,
      kind: 'WELCOME',
      relatedId: user.id,
      html: layout(
        `Welcome, ${name}`,
        `<p>Your account is ready. See your subscriptions and invoices any time in the
         <a href="${config.appUrl}/portal/subscriptions">customer portal</a>.</p>`,
      ),
    });
    return user;
  }).catch((err) => {
    if (err?.code === 'P2002') throw EMAIL_TAKEN();
    throw err;
  });
}

/** Checks credentials. Same error for unknown email and wrong password; inactive users get AUTH_ACCOUNT_DISABLED. */
export async function login({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok) throw INVALID_CREDENTIALS();
  if (!user.isActive) {
    throw new AppError('AUTH_ACCOUNT_DISABLED', 'This account is inactive. Contact your administrator.', 403);
  }
  return user;
}

/** Current user with the customer record for portal users. */
export async function me(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { customer: { select: { id: true, name: true, email: true, phone: true, company: true, address: true } } },
  });
  return { ...toAuthUser(user), customer: user.customer ?? null };
}

/**
 * Always resolves (no account enumeration). For an active user: invalidates older
 * links, stores the SHA-256 of a fresh 32-byte token and mails the link.
 */
export async function forgotPassword({ email }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.isActive) return;

  const token = randomBytes(32).toString('hex');
  const link = `${config.appUrl}/reset-password?token=${token}`;
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + config.resetTokenTtlMin * 60_000) },
    });
    await sendMail(tx, {
      to: user.email,
      subject: `Reset your ${config.company.name.split(' ')[0]} password`,
      kind: 'RESET_PASSWORD',
      relatedId: user.id,
      logLine: `reset link: ${link}`,
      html: layout(
        'Reset your password',
        `<p>Hi ${escapeHtml(user.name)},</p>
         <p><a href="${link}">Reset password</a> (valid ${config.resetTokenTtlMin} minutes).</p>
         <p>If you did not ask for this, you can ignore this email.</p>`,
      ),
    });
  });
}

/** Sets a new password from a valid, unused, unexpired token; marks the token used. */
export async function resetPassword({ token, password }) {
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!row || row.usedAt || row.expiresAt <= new Date()) {
    throw new AppError('AUTH_RESET_TOKEN_INVALID', 'This link has expired or was already used.', 400);
  }
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    // Claim the token atomically so two parallel resets cannot both use it.
    const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new AppError('AUTH_RESET_TOKEN_INVALID', 'This link has expired or was already used.', 400);
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
    await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } });
  });
}
