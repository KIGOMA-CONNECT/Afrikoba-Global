const { ZodError } = require('zod');

/**
 * Generic validation middleware using Zod schemas.
 * Usage: validate(schema, ['body' | 'query' | 'params'])
 * The schema validates against the specified request properties.
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const errors = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Tafta si sahihi.',
        errors,
      });
    }
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
