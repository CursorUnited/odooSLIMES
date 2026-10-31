// Business dates are Postgres DATE columns. Prisma hands them over as JS Dates
// at UTC midnight, so all date maths here works on UTC parts only.
// "Today" is the server's local date (TZ=Asia/Kolkata).

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' → Date at UTC midnight (what Prisma expects for @db.Date). */
export function parseDate(str) {
  return new Date(`${str}T00:00:00.000Z`);
}

/** Date (UTC midnight) → 'YYYY-MM-DD'. Null stays null. */
export function formatDate(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Today in IST as a business date (UTC midnight). */
export function today() {
  const now = new Date();
  return parseDate(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whole days from a to b (b − a). */
export function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Adds months, clamping to the month end: 31 Jan + 1 month = 28/29 Feb. */
export function addMonthsClamped(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(ty, tm));
  return new Date(Date.UTC(ty, tm, day));
}

/** Start of the period `count` periods after `date` (TECHNICAL_DESIGN §7.2). */
export function addPeriod(date, period, count = 1) {
  switch (period) {
    case 'DAILY':
      return addDays(date, count);
    case 'WEEKLY':
      return addDays(date, 7 * count);
    case 'MONTHLY':
      return addMonthsClamped(date, count);
    case 'YEARLY':
      return addMonthsClamped(date, 12 * count);
    default:
      throw new Error(`Unknown billing period ${period}`);
  }
}

/**
 * Start of period n, always computed from the anchor (subscription start date)
 * so month-end starts never drift (31 Jan → 28 Feb → 31 Mar).
 */
export function periodStartAt(anchor, period, intervalCount, n) {
  return addPeriod(anchor, period, n * intervalCount);
}

/** Smallest period start strictly after `date`, for a schedule anchored at `anchor`. */
export function nextPeriodStartAfter(anchor, period, intervalCount, date) {
  // Rough guess of the index, then step to the exact one.
  const approxDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 30.44, YEARLY: 365.25 }[period] * intervalCount;
  let n = Math.max(0, Math.floor(diffDays(anchor, date) / approxDays) - 1);
  while (periodStartAt(anchor, period, intervalCount, n) > date) n -= 1;
  while (periodStartAt(anchor, period, intervalCount, n + 1) <= date) n += 1;
  return periodStartAt(anchor, period, intervalCount, n + 1);
}

/** Period [start, end] that begins at `periodStart` (end = next start − 1 day). */
export function periodBounds(anchor, period, intervalCount, periodStart) {
  const next = nextPeriodStartAfter(anchor, period, intervalCount, periodStart);
  return { periodStart, periodEnd: addDays(next, -1), nextStart: next };
}

/** ISO 8601 timestamp with the local (IST) offset, e.g. 2026-10-31T11:15:00.000+05:30. */
export function toIsoLocal(date = new Date()) {
  if (!date) return null;
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
