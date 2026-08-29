/**
 * Partner Banking (BaaS) Routes (K1-K6)
 * Mounted at /api/v1/bap and /api/bap
 * Partner-signed endpoints use text/plain raw payload + HMAC signature.
 */

const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const { authRequired, requireRoles } = require('../middleware/auth');
const { bapSignedLimiter, bapApplyLimiter } = require('../middleware/rateLimiter');
const bap = require('../services/bapService');

const router = express.Router();

async function bapAuth(req, res, next) {
  try {
    const key = req.headers['x-api-key'];
    const ts = req.headers['x-timestamp'];
    const sig = req.headers['x-signature'];
    if (!key || !ts || !sig) {
      return res.status(401).json({ success: false, message: 'Partner credentials zinahitajika (API key, timestamp, signature).' });
    }
    const r = await pool.query('SELECT * FROM partners WHERE api_key = $1', [key]);
    if (!r.rows.length) return res.status(401).json({ success: false, message: 'API key haitambuliki.' });
    const partner = r.rows[0];
    if (partner.status !== 'ACTIVE') return res.status(403).json({ success: false, message: `Partner hali: ${partner.status}.` });
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - Number(ts)) > 300) return res.status(401).json({ success: false, message: 'Timestamp imepitwa na wakati.' });
    const body = typeof req.body === 'string' ? req.body : '';
    const expected = bap.computeSignature(partner.api_secret, ts, body);
    const provided = Buffer.from(String(sig).trim());
    if (provided.length !== Buffer.from(expected).length || !crypto.timingSafeEqual(provided, Buffer.from(expected))) {
      return res.status(403).json({ success: false, message: 'Signature si sahihi.' });
    }
    req.partner = partner;
    next();
  } catch (e) { next(e); }
}

// ===== K1: PUBLIC APPLICATION =====
router.post('/apply', bapApplyLimiter, async (req, res, next) => {
  try { res.json({ success: true, partner: await bap.applyPartner(req.body) }); }
  catch (e) { next(e); }
});

// ===== K2/K1: ADMIN =====
router.post('/admin/approve', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await bap.approvePartner(req.user.id, req.body.partner_id) }); }
  catch (e) { next(e); }
});

router.get('/admin/partners', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, partners: await bap.listPartners(req.user.id) }); }
  catch (e) { next(e); }
});

router.post('/admin/partners/:id/suspend', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await bap.setPartnerSuspended(req.user.id, req.params.id, req.body.suspended) }); }
  catch (e) { next(e); }
});

router.post('/admin/partners/:id/fund', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, result: await bap.fundPartner(req.user.id, req.params.id, req.body.amount) }); }
  catch (e) { next(e); }
});

router.get('/admin/partners/:id/webhooks', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try { res.json({ success: true, webhooks: await bap.partnerWebhooks(req.user.id, req.params.id) }); }
  catch (e) { next(e); }
});

// ===== K3-K6: PARTNER-SIGNED =====
router.post('/payout', bapSignedLimiter, express.text({ type: '*/*' }), bapAuth, async (req, res, next) => {
  try {
    let payload = {};
    try { payload = JSON.parse(req.body || '{}'); } catch (e) { throw Object.assign(new Error('Body lazima iwe JSON string.'), { statusCode: 400 }); }
    res.json({ success: true, result: await bap.processPayout(req.partner, payload) });
  } catch (e) { next(e); }
});

router.get('/statement', bapSignedLimiter, express.text({ type: '*/*' }), bapAuth, async (req, res, next) => {
  try { res.json({ success: true, statement: await bap.partnerStatement(req.partner.id) }); }
  catch (e) { next(e); }
});

router.get('/summary', bapSignedLimiter, express.text({ type: '*/*' }), bapAuth, async (req, res, next) => {
  try { res.json({ success: true, summary: await bap.partnerSummary(req.partner.id) }); }
  catch (e) { next(e); }
});

module.exports = router;