import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { email, password, text, optionalText, phone } from '../../lib/validation.js';

export const signupSchema = z.object({
  name: text(100),
  email,
  password,
  company: optionalText(120),
  phone,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const forgotSchema = z.object({ email });

export const resetSchema = z.object({
  token: z.string().trim().min(1).max(200),
  password,
});

/** Turns a failed password rule into AUTH_WEAK_PASSWORD (API.md §5); other failures stay VALIDATION_FAILED. */
export function weakPasswordAware(zodError) {
  const fields = {};
  for (const issue of zodError.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  if (fields.password) {
    return new AppError('AUTH_WEAK_PASSWORD', fields.password, 400, fields);
  }
  return zodError;
}
