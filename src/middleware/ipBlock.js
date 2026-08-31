/**
 * IP Temporary Block Middleware
 * Blocks IPs after repeated security violations.
 */

const logger = require('../utils/logger');

const violations = new Map();
const blocked = new Map();

const MAX_VIOLATIONS = 10;
const VIOLATION_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_DURATION_MS = 30 * 60 * 1000;

function recordViolation(ip, type) {
  const now = Date.now();
  const entry = violations.get(ip);

  if (!entry || now - entry.windowStart > VIOLATION_WINDOW_MS) {
    violations.set(ip, { count: 1, firstSeen: now, types: [type] });
    return;
  }

  entry.count++;
  entry.types.push(type);

  if (entry.count >= MAX_VIOLATIONS) {
    blocked.set(ip, { blockedAt: now, expiresAt: now + BLOCK_DURATION_MS, violations: entry.types });
    violations.delete(ip);
    logger.error('SECURITY', `IP BLOCKED for ${BLOCK_DURATION_MS / 60000}min: ${ip} (${entry.count} violations)`);
  }
}

function isIpBlocked(ip) {
  const entry = blocked.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    blocked.delete(ip);
    return false;
  }
  return true;
}

function ipBlockGuard(req, res, next) {
  if (process.env.RATE_LIMIT_DISABLED === 'true') return next();

  const ip = req.ip;
  if (isIpBlocked(ip)) {
    logger.warn('SECURITY', `Blocked IP request: ${ip} ${req.method} ${req.path}`);
    return res.status(429).json({
      success: false,
      message: 'Access imezuiwa kwa muda. Jaribu tena baadaye.',
      code: 'IP_BLOCKED',
    });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of violations) {
    if (now - entry.firstSeen > VIOLATION_WINDOW_MS) violations.delete(ip);
  }
  for (const [ip, entry] of blocked) {
    if (now > entry.expiresAt) blocked.delete(ip);
  }
}, 5 * 60 * 1000);

module.exports = { recordViolation, isIpBlocked, ipBlockGuard };