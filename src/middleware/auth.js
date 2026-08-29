const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config');
const { hardenedVerify } = require('./jwtHardening');

const JWT_SECRET = config.security.jwtSecret || config.DEFAULT_JWT;
const TOKEN_TTL = config.security.jwtTtl;

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
    { expiresIn: expiresIn || TOKEN_TTL }
  );
}

async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Unahitaji kuingia kwanza.' });
  }
  try {
    // Hardened verify: HS256 lock, issuer/expiry/structure checks.
    const decoded = hardenedVerify(token, JWT_SECRET);
    const result = await pool.query(
      `SELECT id, full_name, phone_number, email, role, kyc_level, wallet_balance,
              locked_balance, trust_score, nida_number, is_active, currency_code, auth_version
       FROM users WHERE id = $1`,
      [decoded.id]
    );
    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ success: false, message: 'Akaunti imefungwa.' });
    }
    // Revocation: auth_version inabadilika kila password change →
    // tokens zote za zamani zinakataliwa papo hapo.
    if (decoded.av !== (result.rows[0].auth_version || 0)) {
      return res.status(401).json({ success: false, message: 'Kipindi chako kimeisha. Ingia tena.', code: 'TOKEN_REVOKED' });
    }
    // Blacklist check (logout revoke) — access tokens sasa hubeba jti.
    if (decoded.jti) {
      const revoked = await pool.query('SELECT 1 FROM revoked_tokens WHERE token_jti = $1', [decoded.jti]);
      if (revoked.rows.length > 0) {
        return res.status(401).json({ success: false, message: 'Token imebatilishwa. Ingia tena.', code: 'TOKEN_REVOKED' });
      }
    }
    req.user = result.rows[0];
    next();
  } catch (error) {
    if (error.statusCode && error.code) {
      return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
    }
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
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Una hitaji kuingia.' });
    if ((req.user.kyc_level || 1) < level) {
      return res.status(403).json({
        success: false,
        message: `Unahitaji KYC Level ${level} ili kufanya muamala huu.`,
      });
    }
    next();
  };
}

module.exports = { signToken, authRequired, requireRoles, requireKycLevel, JWT_SECRET };
