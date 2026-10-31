import { today } from './dates.js';

const SEQUENCES = {
  SUB: 'seq_subscription',
  INV: 'seq_invoice',
  PAY: 'seq_payment',
};

/** Formats a document number: SUB/2026/00001. */
export function formatNumber(prefix, year, n) {
  return `${prefix}/${year}/${String(n).padStart(5, '0')}`;
}

/**
 * Next document number from the Postgres sequence, inside the caller's
 * transaction. `date` is a business date (UTC midnight) giving the year;
 * defaults to today in IST, so 00:30 IST on 1 Jan is already the new year.
 */
export async function nextNumber(tx, prefix, date = today()) {
  const seq = SEQUENCES[prefix];
  if (!seq) throw new Error(`Unknown number prefix ${prefix}`);
  const [row] = await tx.$queryRawUnsafe(`SELECT nextval('${seq}')::int AS n`);
  return formatNumber(prefix, date.getUTCFullYear(), row.n);
}

/** Moves a sequence past numbers inserted directly (bulk seed). */
export async function syncSequence(tx, prefix, lastValue) {
  await tx.$queryRawUnsafe(`SELECT setval('${SEQUENCES[prefix]}', ${Math.max(1, Number(lastValue))}, ${lastValue > 0})`);
}
