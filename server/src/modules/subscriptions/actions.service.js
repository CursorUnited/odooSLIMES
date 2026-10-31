// POST /subscriptions/:id/actions/:action (TECHNICAL_DESIGN §8.2, API.md §4.8.3).
import { prisma } from '../../lib/prisma.js';
import { AppError, forbidden } from '../../lib/errors.js';
import { addDays, diffDays, formatDate, periodStartOnOrAfter, today } from '../../lib/dates.js';
import { sendMail, layout, escapeHtml } from '../../lib/mailer.js';
import { config } from '../../config/index.js';
import { checkLines } from '../products/lineRules.js';
import { TRANSITIONS, optionFor } from './lifecycle.js';
import { detailInclude, previewOf, totalsToApi, toDetailApi } from './subscriptions.view.js';
import { findVisible, loadDiscounts, assertPlanAvailable } from './subscriptions.service.js';

const DEFAULT_VALIDITY_DAYS = 30;

const invalid = (sub) =>
  new AppError('SUB_INVALID_TRANSITION', `This action isn't available for a ${sub.status.toLowerCase()} subscription.`, 409);
const noLines = () => new AppError('SUB_NO_LINES', 'Add at least one product line before confirming.', 400);

function logEvent(tx, sub, action, toStatus, user, note = null) {
  return tx.subscriptionEvent.create({
    data: { subscriptionId: sub.id, action, fromStatus: sub.status, toStatus, userId: user?.id ?? null, note },
  });
}

async function sendQuotationMail(tx, sub, validUntil) {
  const preview = previewOf(sub, await loadDiscounts(tx));
  const t = totalsToApi(preview.totals);
  const rows = preview.lines
    .map((l) => `<tr><td>${escapeHtml(l.source?.product?.name ?? l.description)}</td><td>${l.quantity}</td><td>₹${l.total.toFixed(2)}</td></tr>`)
    .join('');
  await sendMail(tx, {
    to: sub.customer.email,
    subject: `Quotation ${sub.number} from ${config.company.name}`,
    kind: 'QUOTATION',
    relatedId: sub.id,
    html: layout(
      `Quotation ${sub.number}`,
      `<p>Hi ${escapeHtml(sub.customer.name)}, here is your ${escapeHtml(sub.plan.name)} quotation.</p>
       <table>${rows}</table>
       <p><b>Total per period: ₹${t.total}</b> (incl. tax). Valid until ${formatDate(validUntil)}.</p>`,
    ),
  });
}

/** The confirm guards: lines, plan minimum, plan window, quote still valid, expiry after start. */
async function assertConfirmable(tx, sub, now) {
  if (!sub.lines.length) throw noLines();
  await checkLines(tx, sub.lines, sub.plan, { minQuantityCode: 'SUB_MIN_QUANTITY' });
  assertPlanAvailable(sub.plan, sub.startDate);
  if (sub.status === 'QUOTATION' && sub.quotationValidUntil && sub.quotationValidUntil < now) {
    throw new AppError(
      'SUB_QUOTE_EXPIRED',
      `This quotation expired on ${formatDate(sub.quotationValidUntil)}. Send a new quotation first.`,
      409,
    );
  }
  if (sub.expiryDate && sub.expiryDate <= sub.startDate) {
    throw new AppError('VALIDATION_FAILED', 'Some fields need attention.', 400, { expiryDate: 'Expiry date must be after the start date.' });
  }
}

/**
 * Runs one lifecycle action in a transaction with the subscription row locked,
 * writes the history event(s) and returns the updated detail view.
 */
export async function performAction(user, id, action, note = null) {
  const transition = TRANSITIONS[action];
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM subscriptions WHERE id = ${id} FOR UPDATE`;
    const sub = await findVisible(user, id, tx);

    if (!transition.roles.includes(user.role)) throw forbidden();
    const from = user.role === 'CUSTOMER' && transition.customerFrom ? transition.customerFrom : transition.from;
    if (!from.includes(sub.status)) throw invalid(sub);
    const option = optionFor(action, sub.status);
    if (option && !sub.plan[option]) {
      throw new AppError('SUB_PLAN_OPTION_DISABLED', `The ${sub.plan.name} plan doesn't allow this.`, 409);
    }

    const now = today();
    const update = (data) => tx.subscription.update({ where: { id }, data });

    switch (action) {
      case 'send-quotation': {
        if (!sub.lines.length) throw noLines();
        const validUntil = addDays(now, sub.template?.validityDays ?? DEFAULT_VALIDITY_DAYS);
        await update({ status: 'QUOTATION', quotationValidUntil: validUntil });
        await logEvent(tx, sub, 'SEND_QUOTATION', 'QUOTATION', user, note ?? `Sent to ${sub.customer.email}`);
        await sendQuotationMail(tx, sub, validUntil);
        break;
      }
      case 'confirm': {
        await assertConfirmable(tx, sub, now);
        await update({ status: 'CONFIRMED' });
        await logEvent(tx, sub, 'CONFIRM', 'CONFIRMED', user, note);
        if (sub.startDate <= now) {
          await update({ status: 'ACTIVE', nextInvoiceDate: sub.startDate });
          await logEvent(tx, { ...sub, status: 'CONFIRMED' }, 'ACTIVATE', 'ACTIVE', user, 'Start date reached');
        }
        break;
      }
      case 'activate': {
        if (sub.startDate > now) {
          throw new AppError('SUB_INVALID_TRANSITION', `This subscription starts on ${formatDate(sub.startDate)}.`, 409);
        }
        await update({ status: 'ACTIVE', nextInvoiceDate: sub.startDate });
        await logEvent(tx, sub, 'ACTIVATE', 'ACTIVE', user, note);
        break;
      }
      case 'pause': {
        await update({ status: 'PAUSED' });
        await logEvent(tx, sub, 'PAUSE', 'PAUSED', user, note);
        break;
      }
      case 'resume': {
        // Paused periods are not billed later: the next bill is the first period start on or after today.
        const aligned = periodStartOnOrAfter(sub.startDate, sub.plan.billingPeriod, sub.plan.intervalCount, now);
        const next = sub.nextInvoiceDate && sub.nextInvoiceDate >= now ? sub.nextInvoiceDate : aligned;
        await update({ status: 'ACTIVE', nextInvoiceDate: next });
        await logEvent(tx, sub, 'RESUME', 'ACTIVE', user, note);
        break;
      }
      case 'close': {
        const cancel = ['DRAFT', 'QUOTATION'].includes(sub.status);
        await update({ status: 'CLOSED', closedAt: now, nextInvoiceDate: null });
        await logEvent(tx, sub, 'CLOSE', 'CLOSED', user, note ?? (cancel ? 'Quotation cancelled' : null));
        break;
      }
      case 'renew': {
        if (!sub.expiryDate) throw new AppError('SUB_NO_EXPIRY', "Open-ended subscriptions don't need renewing.", 409);
        const expiryDate = addDays(sub.expiryDate, diffDays(sub.startDate, sub.expiryDate));
        await update({ expiryDate });
        const renewed = `Renewed to ${formatDate(expiryDate)}`;
        await logEvent(tx, sub, 'RENEW', sub.status, user, note ? `${renewed}. ${note}` : renewed);
        break;
      }
      default:
        throw invalid(sub);
    }

    const fresh = await tx.subscription.findUnique({ where: { id }, include: detailInclude });
    return toDetailApi(fresh, previewOf(fresh, await loadDiscounts(tx)), user);
  });
}
