/**
 * XSS Protection Middleware
 * Sanitizes user input to prevent cross-site scripting.
 */

const logger = require('../utils/logger');

const XSS_PATTERNS = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi,
  /javascript\s*:/gi,
  /on\w+\s*=\s*["'][^"']*["']/gi,
  /on\w+\s*=\s*\S+/gi,
  /<object\b[^>]*>[\s\S]*?<\/object>/gi,
  /<embed\b[^>]*>/gi,
  /<applet\b[^>]*>[\s\S]*?<\/applet>/gi,
  /data\s*:\s*text\/html/gi,
  /vbscript\s*:/gi,
  /expression\s*\(/gi,
  /<svg\b[^>]*onload/gi,
  /<img\b[^>]*onerror/gi,
];

function detectXss(value) {
  if (typeof value !== 'string') return false;
  return XSS_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function xssProtection(req, res, next) {
  const sources = ['body', 'query', 'params'];

  for (const source of sources) {
    const data = req[source];
    if (!data || typeof data !== 'object') continue;

    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && detectXss(value)) {
        logger.warn('SECURITY', `XSS attempt detected in ${source}.${key}: ${value.substring(0, 80)} from ${req.ip}`);
        return res.status(400).json({
          success: false,
          message: 'Maombi yana data batili.',
          code: 'INVALID_INPUT',
        });
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && detectXss(item)) {
            logger.warn('SECURITY', `XSS attempt detected in ${source}.${key}[]: ${item.substring(0, 80)} from ${req.ip}`);
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

module.exports = { xssProtection, detectXss, sanitizeString };