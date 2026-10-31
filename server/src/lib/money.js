import { Prisma } from '@prisma/client';

const { Decimal } = Prisma;

/** Any money-like input (string, number, Decimal, null) → Decimal. */
export const D = (v) => new Decimal(v ?? 0);

export const ZERO = D(0);

/** Round half-up to 2 decimals (TECHNICAL_DESIGN §9.4). */
export const round2 = (v) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Sum of money values. */
export const sum = (values) => values.reduce((acc, v) => acc.plus(D(v)), D(0));

/** Larger of two Decimals. */
export const max = (a, b) => (D(a).gte(D(b)) ? D(a) : D(b));

/** Smaller of two Decimals. */
export const min = (a, b) => (D(a).lte(D(b)) ? D(a) : D(b));

/** Decimal → API string with exactly 2 decimals ("1559.00"). */
export const toApi = (v) => round2(v).toFixed(2);

/** Rate → API string ("18.00"). */
export const rateToApi = (v) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
