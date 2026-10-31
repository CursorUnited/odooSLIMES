// Subscription state machine (TECHNICAL_DESIGN §8, API.md §4.8.3).
import { today } from '../../lib/dates.js';

const BACK_OFFICE = ['ADMIN', 'STAFF'];
const EVERYONE = ['ADMIN', 'STAFF', 'CUSTOMER'];

/**
 * action → allowed source statuses, roles, and the plan option it needs.
 * `customerFrom` narrows the statuses a customer may act from.
 */
export const TRANSITIONS = {
  'send-quotation': { from: ['DRAFT', 'QUOTATION'], roles: BACK_OFFICE },
  confirm: { from: ['DRAFT', 'QUOTATION'], roles: BACK_OFFICE },
  activate: { from: ['CONFIRMED'], roles: BACK_OFFICE },
  pause: { from: ['ACTIVE'], roles: EVERYONE, option: 'pausable' },
  resume: { from: ['PAUSED'], roles: EVERYONE, option: 'pausable' },
  close: { from: ['DRAFT', 'QUOTATION', 'CONFIRMED', 'ACTIVE', 'PAUSED'], roles: EVERYONE, customerFrom: ['CONFIRMED', 'ACTIVE', 'PAUSED'] },
  renew: { from: ['ACTIVE', 'PAUSED'], roles: EVERYONE, option: 'renewable' },
};

/** Closing a draft or quotation is "cancel quotation" and never needs plan.closable. */
export const optionFor = (action, status) =>
  action === 'close' ? (['DRAFT', 'QUOTATION'].includes(status) ? null : 'closable') : TRANSITIONS[action].option;

/** Actions this user may take now, so the UI shows only valid buttons. */
export function allowedActions(sub, user, now = today()) {
  const role = user?.role;
  return Object.entries(TRANSITIONS)
    .filter(([action, t]) => {
      if (!t.roles.includes(role)) return false;
      const from = role === 'CUSTOMER' && t.customerFrom ? t.customerFrom : t.from;
      if (!from.includes(sub.status)) return false;
      const option = optionFor(action, sub.status);
      if (option && !sub.plan[option]) return false;
      if (action === 'activate' && sub.startDate > now) return false;
      if (action === 'renew' && !sub.expiryDate) return false;
      return true;
    })
    .map(([action]) => action);
}
