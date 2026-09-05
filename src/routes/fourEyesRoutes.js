const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { logAction } = require('../services/auditService');
const fe = require('../services/fourEyesService');
const pool = require('../config/db');
const fin = require('../services/financialEngine');

router.use(authRequired, requireRoles('ADMIN'));

const { requireFeature } = require('../services/featureFlagService');
router.use(requireFeature('FOUR_EYES'));

const VALID_ROLES = ['ADMIN', 'MJUMBE', 'OPS', 'COMPLIANCE', 'SUPPORT'];
const PROMOTABLE = ['ADMIN', 'OPS', 'COMPLIANCE', 'SUPPORT'];

async function applyRoleChange(payload, approverId) {
  const userId = Number(payload.userId);
  const role = String(payload.role || '').toUpperCase();
  if (!userId) throw Object.assign(new Error('userId inahitajika.'), { status: 400 });
  if (!VALID_ROLES.includes(role)) throw Object.assign(new Error('Jukumu si sahihi.'), { status: 400 });
  const user = await pool.query('SELECT id, role, full_name FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { status: 404 });
  const current = user.rows[0].role;
  if (current === role) throw Object.assign(new Error('Mtumiaji tayari ana jukumu hili.'), { status: 409 });
  if (Number(userId) === Number(approverId)) throw Object.assign(new Error('Huwezi kubadilisha jukumu lako mwenyewe.'), { status: 403 });
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [userId, role]);
  await logAction(approverId, 'FOUR_EYES_ROLE_CHANGE', 'USER', userId, { from: current, to: role }, null);
  return { userId, from: current, to: role };
}

fe.registerExecutor('ADMIN_PROMOTE_ROLE', async (payload, approverId) => {
  if (!PROMOTABLE.includes(String(payload.role || '').toUpperCase())) {
    throw Object.assign(new Error('Jukumu lililochaguliwa haliruhusiwi kupandisha daraja.'), { status: 400 });
  }
  return applyRoleChange(payload, approverId);
});

fe.registerExecutor('ADMIN_DEMOTE_ROLE', async (payload, approverId) => {
  if (PROMOTABLE.includes(String(payload.role || '').toUpperCase())) {
    throw Object.assign(new Error('Kushusha daraja kunahitaji jukumu lisilo la kiutawala.'), { status: 400 });
  }
  return applyRoleChange(payload, approverId);
});

fe.registerExecutor('ADMIN_LARGE_REFUND', async (payload, approverId) => {
  const userId = Number(payload.userId);
  const amount = Number(payload.amount);
  if (!userId || !amount || amount <= 0) throw Object.assign(new Error('userId na amount sahihi zinahitajika.'), { status: 400 });
  const user = await pool.query('SELECT id, full_name FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { status: 404 });
  const reference = `REF-${approverId}-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({
      client,
      userId,
      amount,
      reference,
      fromAccount: 'SUSPENSE',
      description: `Malipo ya marejesho (four-eyes)`,
      actor: `four-eyes:${approverId}`,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { userId, amount, reference };
});

// ===== Policies =====
router.get('/policies', async (req, res, next) => {
  try {
    res.json({ policies: await fe.listPolicies() });
  } catch (error) { next(error); }
});

router.put('/policies/:code', async (req, res, next) => {
  try {
    const policy = await fe.upsertPolicy({ actionCode: req.params.code, ...req.body });
    await logAction(req.user.id, 'FOUR_EYES_POLICY_UPDATE', 'FOUR_EYES_POLICY', policy.id, { action_code: policy.action_code }, req);
    res.json({ policy });
  } catch (error) { next(error); }
});

// ===== Requests =====
router.get('/requests', async (req, res, next) => {
  try {
    res.json({ requests: await fe.listRequests(req.query.status || null, req.query.limit || 100) });
  } catch (error) { next(error); }
});

router.get('/requests/:id', async (req, res, next) => {
  try {
    res.json(await fe.getRequest(parseInt(req.params.id, 10)));
  } catch (error) { next(error); }
});

router.post('/requests', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: req.body.action_code, requesterId: req.user.id, payload: req.body.payload });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/requests/:id/approve', async (req, res, next) => {
  try {
    const outcome = await fe.approve(parseInt(req.params.id, 10), req.user.id, req.user.role, req.body.note);
    await logAction(req.user.id, 'FOUR_EYES_APPROVED', 'FOUR_EYES_REQUEST', parseInt(req.params.id, 10), {}, req);
    res.json(outcome);
  } catch (error) { next(error); }
});

router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    const request = await fe.reject(parseInt(req.params.id, 10), req.user.id, req.user.role, req.body.note);
    await logAction(req.user.id, 'FOUR_EYES_REJECTED', 'FOUR_EYES_REQUEST', request.id, {}, req);
    res.json({ request });
  } catch (error) { next(error); }
});

router.post('/requests/:id/cancel', async (req, res, next) => {
  try {
    const request = await fe.cancel(parseInt(req.params.id, 10), req.user.id);
    await logAction(req.user.id, 'FOUR_EYES_CANCELLED', 'FOUR_EYES_REQUEST', request.id, {}, req);
    res.json({ request });
  } catch (error) { next(error); }
});

router.post('/requests/:id/retry', async (req, res, next) => {
  try {
    res.json(await fe.retry(parseInt(req.params.id, 10), req.user.id));
  } catch (error) { next(error); }
});

// ===== Convenience action launchers (maker side) =====
router.post('/actions/promote-role', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'ADMIN_PROMOTE_ROLE', requesterId: req.user.id, payload: { userId: req.body.userId, role: req.body.role } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/demote-role', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'ADMIN_DEMOTE_ROLE', requesterId: req.user.id, payload: { userId: req.body.userId, role: req.body.role } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/large-refund', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'ADMIN_LARGE_REFUND', requesterId: req.user.id, payload: { userId: req.body.userId, amount: req.body.amount } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

module.exports = router;