// Shared zod building blocks (API.md §6). Client mirrors these in client/src/lib/validation/.
import { z } from 'zod';
import { parseDate } from './dates.js';

/** "More than eight characters" = at least 9; plus lowercase, uppercase and a special character. */
export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{9,}$/;
export const PASSWORD_MESSAGE =
  'Use at least 9 characters with an uppercase letter, a lowercase letter and a special character.';

export const password = z.string().max(72, 'Use at most 72 characters.').regex(PASSWORD_REGEX, PASSWORD_MESSAGE);

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Keep it under 254 characters.')
  .pipe(z.email('Enter a valid email address.'));

/** Trimmed text, `min` to `max` characters, not only whitespace. */
export const text = (max, min = 2) =>
  z
    .string()
    .trim()
    .min(min, min > 1 ? `Use at least ${min} characters.` : 'This field is required.')
    .max(max, `Keep it under ${max} characters.`);

/** Optional text: empty string becomes null. */
export const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters.`)
    .transform((v) => (v === '' ? null : v))
    .nullish();

export const phone = z
  .string()
  .trim()
  .max(20, 'Keep it under 20 characters.')
  .regex(/^[0-9 +()-]*$/, 'Use digits, spaces and + ( ) - only.')
  .transform((v) => (v === '' ? null : v))
  .nullish();

const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;

/** Money as string or number, ≥ 0 (or > 0 with `positive`), max 2 decimals. Output: string. */
export const money = ({ positive = false } = {}) =>
  z
    .union([z.string().trim(), z.number()])
    .transform((v) => String(v))
    .refine((v) => MONEY_RE.test(v), 'Enter an amount of 0 or more, with up to 2 decimals.')
    .refine((v) => !positive || Number(v) > 0, 'Enter an amount greater than 0.');

/** Business date 'YYYY-MM-DD' → Date (UTC midnight). */
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((v) => {
    const d = parseDate(v);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Enter a real calendar date.')
  .transform(parseDate);

export const id = z.coerce.number().int().positive();

export const idParam = z.object({ id });

/** Query-string boolean: 'true' / 'false'. */
export const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const quantity = z.coerce.number().int('Use a whole number.').min(1, 'Quantity must be at least 1.').max(100000);
