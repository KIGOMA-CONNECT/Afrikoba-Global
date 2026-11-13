const express = require('express');
const router = express.Router();
const { authRequired, requireRoles } = require('../middleware/auth');
const { logAction, writeAudit } = require('../services/auditService'); // R26: logAction import lost in b993f1c (17 call sites)
const fe = require('../services/fourEyesService');
const pool = require('../config/db');
const fin = require('../services/financialEngine');
const card = require('../services/cardService');
const credit = require('../services/savingsCreditService');
const business = require('../services/businessService');
const circle = require('../services/lendingCircleService');
const kilimo = require('../services/kilimoAgriService');
const network = require('../services/networkService');

router.use(authRequired, requireRoles('ADMIN'));

const { requireFeature } = require('../services/featureFlagService');
// R36B OD-3: in the pilot the four-eyes routes do not depend on the FOUR_EYES flag (environment lock).
const fourEyesFlagGate = requireFeature('FOUR_EYES');
router.use((req, res, next) => (require('../config/pilot').isFourEyesLocked() ? next() : fourEyesFlagGate(req, res, next)));

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

// Stable, request-scoped operation reference. A dispatch that committed the wallet
// credit but could not record EXECUTED is recovered by re-dispatch under this same
// reference, so the credit is never repeated.
function fourEyesRefundReference(requestId) {
  return `FOUR_EYES_REFUND:${requestId}`;
}

function unresolvedRefund(message) {
  return Object.assign(new Error(message), { status: 409, code: 'FOUR_EYES_OPERATION_UNRESOLVED' });
}

// Runs inside the executor's transaction. Success is reported only for a committed
// CREDIT operation with the expected shape and a balanced two-line journal.
async function verifyCommittedRefund(client, { reference, userId, amount }) {
  const op = await client.query(
    'SELECT operation_type, user_id, amount, status FROM financial_operations WHERE reference_id = $1',
    [reference]
  );
  const row = op.rows[0];
  if (!row) throw unresolvedRefund('Operesheni ya marejesho haijapatikana; haijathibitishwa.');
  if (row.status !== 'SUCCESS') {
    throw unresolvedRefund(`Operesheni ya marejesho iko katika hali ${row.status}, si SUCCESS.`);
  }
  if (row.operation_type !== 'CREDIT' || Number(row.user_id) !== Number(userId) ||
      Math.abs(Number(row.amount) - Number(amount)) >= 0.005) {
    throw Object.assign(new Error('Operesheni iliyopo ya marejesho hailingani na ombi.'), { status: 409, code: 'FOUR_EYES_OPERATION_MISMATCH' });
  }
  const journal = await client.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END), 0)::numeric AS dr,
            COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END), 0)::numeric AS cr
       FROM journal_entries WHERE reference_id = $1`,
    [reference]
  );
  const j = journal.rows[0];
  if (j.n !== 2 || Math.abs(Number(j.dr) - Number(amount)) >= 0.005 || Math.abs(Number(j.cr) - Number(amount)) >= 0.005) {
    throw unresolvedRefund('Jarida ya marejesho haijakamilika kwa operesheni iliyopo.');
  }
}

fe.registerExecutor('ADMIN_LARGE_REFUND', async (payload, approverId, request) => {
  const requestId = Number(request && request.id);
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    throw Object.assign(new Error('Kitambulisho cha ombi si sahihi.'), { status: 400 });
  }
  const userId = Number(payload.userId);
  const amount = Number(payload.amount);
  if (!userId || !amount || amount <= 0) throw Object.assign(new Error('userId na amount sahihi zinahitajika.'), { status: 400 });
  const user = await pool.query('SELECT id, full_name FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { status: 404 });
  const reference = fourEyesRefundReference(requestId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const credit = await fin.creditWallet({
      client,
      userId,
      amount,
      reference,
      fromAccount: 'SUSPENSE',
      description: `Malipo ya marejesho (four-eyes)`,
      actor: `four-eyes:${approverId}`,
    });
    if (credit.dedup) {
      await verifyCommittedRefund(client, { reference, userId, amount });
    }
    await client.query('COMMIT');
    return { userId, amount, reference, replayed: Boolean(credit.dedup) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
});

const num = (v) => Number(v);
const requireValue = (v, msg) => {
  if (v == null || v === '' || (typeof v === 'number' && Number.isNaN(v))) {
    throw Object.assign(new Error(msg), { status: 400 });
  }
};

// R29 D5: VICOBA group operations are authorised only by group officers (MWEKAHAZINA, KATIBU,
// MWENYEKITI) acting as themselves on the VICOBA routes, never through the system-admin
// four-eyes queue and never with an actor taken from a body or payload. Launchers, POST /requests
// and these executors (requests already queued) all refuse, whatever the policy says.
const VICOBA_ACTION_CODES = new Set(['VICOBA_LOAN_DISBURSE', 'VICOBA_SOCIAL_FUND_DISBURSE']);
const vicobaGroupAuthorityRequired = () => Object.assign(
  new Error('VICOBA_GROUP_AUTHORITY_REQUIRED: Operesheni za kikundi zinaidhinishwa na viongozi wa kikundi kupitia VICOBA, si na admin wa mfumo.'),
  { status: 403, statusCode: 403, code: 'VICOBA_GROUP_AUTHORITY_REQUIRED' }
);
fe.registerExecutor('VICOBA_LOAN_DISBURSE', async () => { throw vicobaGroupAuthorityRequired(); });
fe.registerExecutor('VICOBA_SOCIAL_FUND_DISBURSE', async () => { throw vicobaGroupAuthorityRequired(); });

fe.registerExecutor('CARD_ADMIN_SETTLE', async (payload, approverId) => {
  requireValue(payload.authReference, 'authReference inahitajika.');
  return card.settleCardAuth(approverId, String(payload.authReference));
});

fe.registerExecutor('CARD_ADMIN_REFUND', async (payload, approverId) => {
  requireValue(payload.authReference, 'authReference inahitajika.');
  return card.refundCardAuth(approverId, String(payload.authReference));
});

fe.registerExecutor('CREDIT_LOAN_DISBURSE', async (payload, approverId) => {
  const loanId = num(payload.loanId);
  requireValue(loanId, 'loanId inahitajika.');
  return credit.adminDisburseMicroLoan(loanId, approverId);
});

fe.registerExecutor('BUSINESS_LOAN_DISBURSE', async (payload, approverId) => {
  const loanId = num(payload.loanId);
  requireValue(loanId, 'loanId inahitajika.');
  return business.adminDisburseLoan(loanId, approverId);
});

fe.registerExecutor('LENDING_CIRCLE_DISBURSE', async (payload, approverId) => {
  const campaignId = num(payload.campaignId);
  requireValue(campaignId, 'campaignId inahitajika.');
  return circle.disburseCampaign(approverId, campaignId);
});

fe.registerExecutor('KILIMO_AGRI_LOAN_DISBURSE', async (payload, approverId) => {
  const loanId = num(payload.loanId);
  requireValue(loanId, 'loanId inahitajika.');
  return kilimo.disburseAgriLoan(approverId, loanId);
});

fe.registerExecutor('AGENT_SETTLEMENT', async (payload, approverId) => {
  return network.executeAgentSettlement(payload, approverId);
});

// ===== Policies =====
router.get('/policies', async (req, res, next) => {
  try {
    res.json({ policies: await fe.listPolicies() });
  } catch (error) { next(error); }
});

router.put('/policies/:code', async (req, res, next) => {
  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const result = await fe.upsertPolicy({
      actionCode: req.params.code,
      ...req.body,
      client,
    });
    await writeAudit({
      userId: req.user.id,
      action: 'FOUR_EYES_POLICY_UPDATE',
      entityType: 'FOUR_EYES_POLICY',
      entityId: result.policy.id,
      meta: {
        action_code: result.policy.action_code,
        before: result.before,
        after: result.after,
      },
      req,
      client,
    });
    await client.query('COMMIT');
    res.json({ policy: result.policy });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
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
    if (VICOBA_ACTION_CODES.has(String(req.body.action_code || '').trim().toUpperCase())) throw vicobaGroupAuthorityRequired();
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

router.post('/actions/vicoba-loan-disburse', (req, res, next) => next(vicobaGroupAuthorityRequired()));

router.post('/actions/vicoba-social-disburse', (req, res, next) => next(vicobaGroupAuthorityRequired()));

router.post('/actions/card-settle', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'CARD_ADMIN_SETTLE', requesterId: req.user.id, payload: { authReference: req.body.authReference } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/card-refund', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'CARD_ADMIN_REFUND', requesterId: req.user.id, payload: { authReference: req.body.authReference } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/credit-loan-disburse', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'CREDIT_LOAN_DISBURSE', requesterId: req.user.id, payload: { loanId: req.body.loanId } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/business-loan-disburse', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'BUSINESS_LOAN_DISBURSE', requesterId: req.user.id, payload: { loanId: req.body.loanId } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/lending-circle-disburse', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'LENDING_CIRCLE_DISBURSE', requesterId: req.user.id, payload: { campaignId: req.body.campaignId } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

router.post('/actions/kilimo-loan-disburse', async (req, res, next) => {
  try {
    const { request, policy } = await fe.initiateRequest({ actionCode: 'KILIMO_AGRI_LOAN_DISBURSE', requesterId: req.user.id, payload: { loanId: req.body.loanId } });
    await logAction(req.user.id, 'FOUR_EYES_REQUESTED', 'FOUR_EYES_REQUEST', request.id, { action_code: request.action_code }, req);
    res.status(201).json({ request, policy });
  } catch (error) { next(error); }
});

module.exports = router;