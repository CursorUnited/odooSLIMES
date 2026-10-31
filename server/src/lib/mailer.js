import { config } from '../config/index.js';
import { prisma } from './prisma.js';

/** Escapes text placed inside email HTML. */
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * All mail goes through here (TECHNICAL_DESIGN §16): always stored in
 * `email_outbox` (inside the caller's transaction) and logged; sent by SMTP
 * only when SMTP_URL is set. `logLine` is printed in dev (e.g. the reset link).
 */
export async function sendMail(db, { to, subject, html, kind, relatedId = null, logLine }) {
  const row = await db.emailOutbox.create({ data: { toEmail: to, subject, bodyHtml: html, kind, relatedId } });
  if (config.env !== 'test') {
    console.log(`[mail] ${kind} → ${to}: ${subject}${logLine ? `\n[mail]   ${logLine}` : ''}`);
  }
  if (config.smtpUrl) setTimeout(() => deliver(row.id), 0); // after the caller's commit
  return row;
}

/** Optional SMTP delivery. Needs `npm i nodemailer`; without it mail stays in the outbox. */
async function deliver(id) {
  try {
    const row = await prisma.emailOutbox.findUnique({ where: { id } });
    if (!row || row.sentAt) return;
    const { default: nodemailer } = await import('nodemailer');
    await nodemailer.createTransport(config.smtpUrl).sendMail({
      from: config.company.email,
      to: row.toEmail,
      subject: row.subject,
      html: row.bodyHtml,
    });
    await prisma.emailOutbox.update({ where: { id }, data: { sentAt: new Date() } });
  } catch (e) {
    console.warn(`[mail] SMTP delivery failed for outbox #${id}: ${e.message}`);
  }
}

/** Wraps a short message in the shared email layout. */
export function layout(title, bodyHtml) {
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
    `<h2 style="color:#714B67">${escapeHtml(config.company.name)}</h2>` +
    `<h3>${escapeHtml(title)}</h3>${bodyHtml}` +
    `<p style="color:#4B5563;font-size:12px">${escapeHtml(config.company.address)} · ${escapeHtml(config.company.email)}</p></div>`
  );
}
