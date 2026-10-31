/**
 * zod-validates `params`, `query` and `body`; parsed values land in `req.valid`.
 * Unknown body fields are stripped (zod's default). `onError` may turn the
 * ZodError into a domain error (e.g. AUTH_WEAK_PASSWORD).
 */
export const validate =
  (schemas, { onError } = {}) =>
  (req, res, next) => {
    req.valid = req.valid ?? {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (!result.success) return next(onError ? onError(result.error) : result.error);
      req.valid[part] = result.data;
    }
    next();
  };
