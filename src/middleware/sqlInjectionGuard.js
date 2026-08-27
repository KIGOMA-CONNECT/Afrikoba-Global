/**
 * SQL Injection Prevention
 * Validates and sanitizes database inputs.
 */

const logger = require('../utils/logger');

// Common SQL injection patterns
const SQL_INJECTION_PATTERNS = [
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|DECLARE|CAST|CONVERT|TRUNCATE|GRANT|REVOKE)\b)/i,
  /(UNION\s+(ALL\s+)?SELECT)/i,
  /(--|#|\/\*|\*\/)/,
  /(';\s*(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE)\s)/i,
  /(;\s*(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE))/i,
  /(0x[0-9a-fA-F]+)/,
  /(CHAR\s*\(\s*\d+)/i,
  /(\bCONVERT\s*\()/i,
  /(\bCAST\s*\()/i,
  /(BENCHMARK\s*\()/i,
  /(SLEEP\s*\(\s*\d+)/i,
  /(LOAD_FILE\s*\()/i,
  /(INTO\s+(OUTFILE|DUMPFILE))/i,
  /(\bEXEC\s*\()/i,
  /(xp_cmdshell)/i,
  /(sp_executesql)/i,
];

/**
 * H13: Validate input against SQL injection patterns.
 */
function detectSqlInjection(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return SQL_INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * H13: SQL injection detection middleware.
 * Scans request body, query, and params for injection patterns.
 */
function sqlInjectionGuard(req, res, next) {
  const sources = [
    { name: 'body', data: req.body },
    { name: 'query', data: req.query },
    { name: 'params', data: req.params },
  ];

  for (const { name, data } of sources) {
    if (!data || typeof data !== 'object') continue;

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && detectSqlInjection(value)) {
        logger.warn('SECURITY', `SQL injection attempt detected in ${name}.${key}: ${value.substring(0, 50)} from ${req.ip}`);
        return res.status(400).json({
          success: false,
          message: 'Maombi yana data batili.',
          code: 'INVALID_INPUT',
        });
      }
      // Check arrays
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && detectSqlInjection(item)) {
            logger.warn('SECURITY', `SQL injection attempt detected in ${name}.${key}[]: ${item.substring(0, 50)} from ${req.ip}`);
            return res.status(400).json({
              success: false,
              message: 'Maombi yana data batili.',
              code: 'INVALID_INPUT',
            });
          }
        }
      }
    }
  }

  next();
}

module.exports = {
  detectSqlInjection,
  sqlInjectionGuard,
};
