const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const logger = require('../utils/logger');
const { hardenedVerify } = require('./jwtHardening');

const JWT_SECRET = config.security.jwtSecret || config.DEFAULT_JWT;

function signToken(user, expiresIn) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      phone: user.phone_number,
      av: user.auth_version || 0,
      jti: crypto.randomUUID(),
    },
    JWT_SECRET,
    { expiresIn: expiresIn || '1h' }
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    logger.warn('AUTH_401_DIAG', `path=${req.path} reason=no-token`);
    return res.status(401).json({ success: false, message: 'Unahitaji kuingia kwanza.' });
  }
  try {
    // Hardened verify: HS256 lock, issuer/expiry/structure checks.
    const decoded = hardenedVerify(token, JWT_SECRET);
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await pool.query(
          `SELECT id, full_name, phone_number, email, role, kyc_level, wallet_balance,
                  locked_balance, trust_score, nida_number, is_active, currency_code, auth_version,
                  device_policy
           FROM users WHERE id = $1`,
          [decoded.id]
        );
        if (result.rows.length === 0 || !result.rows[0].is_active) {
          logger.warn('AUTH_401_DIAG', `path=${req.path} reason=account-closed id=${decoded.id}`);
          return res.status(401).json({ success: false, message: 'Akaunti imefungwa.' });
        }
        // Revocation: auth_version inabadilika kila password change →
        // tokens zote za zamani zinakataliwa papo hapo.
        if (decoded.av !== (result.rows[0].auth_version || 0)) {
          logger.warn('AUTH_401_DIAG', `path=${req.path} reason=auth-version id=${decoded.id} tokenAV=${decoded.av} dbAV=${result.rows[0].auth_version || 0}`);
          return res.status(401).json({ success: false, message: 'Kipindi chako kimeisha. Ingia tena.', code: 'TOKEN_REVOKED' });
        }
        // Blacklist check (logout revoke) — access tokens sasa hubeba jti.
        if (decoded.jti) {
          const revoked = await pool.query('SELECT 1 FROM revoked_tokens WHERE token_jti = $1', [decoded.jti]);
          if (revoked.rows.length > 0) {
            logger.warn('AUTH_401_DIAG', `path=${req.path} reason=jti-blacklisted`);
            return res.status(401).json({ success: false, message: 'Token imebatilishwa. Ingia tena.', code: 'TOKEN_REVOKED' });
          }
        }
        req.user = result.rows[0];
        return next();
      } catch (err) {
        // Stale pool socket (connection terminated / ECONNRESET / EPIPE) →
        // retry once before surfacing a bogus 401 that aborts fine requests.
        lastErr = err;
        const isConnTerm = err && /connection terminated|read ECONN|ECONNRESET|EPIPE|timeout expired/i.test(err.message || '');
        if (isConnTerm && attempt === 0) {
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  } catch (error) {
    if (error.statusCode && error.code) {
      return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
    }
    logger.warn('AUTH_401_DIAG', `path=${req.path} reason=${error && error.message} name=${error && error.name} code=${error && error.code}`);
    return res.status(401).json({ success: false, message: 'Kipindi chako kimeisha. Ingia tena.', code: 'TOKEN_REVOKED' });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Una hitaji kuingia.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Huna mamlaka ya kufanya hili.' });
    }
    next();
  };
}

function requireKycLevel(level) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ success: false, message: 'Una hitaji kuingia.' });
      const { enforceKycLevel } = require('../services/kycDocumentService');
      const { ok, level: effective } = await enforceKycLevel(req.user.id, level);
      if (!ok) {
        return res.status(403).json({
          success: false,
          message: `Unahitaji KYC Level ${level} ili kufanya muamala huu.`,
          kycLevel: effective,
        });
      }
      if (effective !== undefined && req.user.kyc_level !== effective) req.user.kyc_level = effective;
      next();
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { signToken, authRequired, requireRoles, requireKycLevel, JWT_SECRET };
