#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R26-C2: maker and checker recorded for every financial
 * execution, without changing any API response.
 *
 *  governanceService.decideApprovalFlow → audit APPROVAL_FLOW_EXECUTED
 *      {maker_id = requester, checker_id = approver}
 *  fourEyesService (dispatch after quorum) → audit FOUR_EYES_EXECUTED
 *      {maker_id = requester, checker_ids = approvers, executed_by}
 *  direct admin routes while four-eyes is NOT active → FINANCIAL_DIRECT_EXECUTED
 *      {maker_id = acting admin, checker_id = null}
 *  No row when the execution fails. Return values / HTTP bodies keep exactly
 *  the same keys as before.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> on
 * 127.0.0.1:55471. axios is stubbed: no real network.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') {
  console.error('REFUSING: DB_HOST/DB_PORT must be the disposable p71-ci-db (127.0.0.1:55471).');
  process.exit(2);
}
process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex'); // per-run, never printed

const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = {
  post: async () => { throw new Error('network disabled in test'); },
  get: async () => { throw new Error('network disabled in test'); },
  create() { return this; },
  defaults: { headers: { common: {} } },
  interceptors: { request: { use() {} }, response: { use() {} } },
};
const express = require(path.join(ROOT, 'node_modules/express'));
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const gov = require(path.join(ROOT, 'src/services/governanceService'));
const fe = require(path.join(ROOT, 'src/services/fourEyesService'));
const business = require(path.join(ROOT, 'src/services/businessService'));
const card = require(path.join(ROOT, 'src/services/cardService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
app.use('/api/v1/business', require(path.join(ROOT, 'src/routes/businessRoutes')));
app.use('/api/v1/credit', require(path.join(ROOT, 'src/routes/creditRoutes')));
app.use('/api/v1/cards', require(path.join(ROOT, 'src/routes/cardRoutes')));
require(path.join(ROOT, 'src/routes/walletRoutes'));
require(path.join(ROOT, 'src/routes/eventRoutes'));
require(path.join(ROOT, 'src/routes/fourEyesRoutes'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, message: err.message, code: err.code }));

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
async function section(fn) {
  try { await fn(); } catch (e) { failed++; console.log(`  ✗ section aborted — ${e.message}`); }
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const num = async (sql, p) => Number(Object.values(await q1(sql, p))[0]);
let seq = 0;
async function user(label, role) {
  seq++;
  const phone = `2558${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R26C2 ${label} ${seq}`, phone]);
  if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, u.id]);
  const row = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  return { id: row.id, phone: row.phone_number, token: signToken(row) };
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `R26C2-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function expectReject(fn) { try { await fn(); return null; } catch (e) { return e; } }
const auditRows = (action, entityType, entityId) => pool.query(
  'SELECT user_id, entity_id, meta FROM audit_logs WHERE action=$1 AND entity_type=$2 AND ($3::int IS NULL OR entity_id=$3) ORDER BY id', [action, entityType, entityId]).then((r) => r.rows);
const keys = (o) => Object.keys(o || {}).sort().join(',');

async function bizLoan(amount = 9000) {
  const owner = await user('biz-owner');
  const biz = await business.registerBusiness(owner.id, { business_name: `R26C2 shop ${seq}` });
  return (await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status) VALUES ($1,$2,$3,10,12,'APPROVED') RETURNING id`, [biz.id, owner.id, amount])).id;
}
async function microLoan(amount = 7000) {
  const b = await user('borrower');
  return (await q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at) VALUES ($1,$2,10,1,'APPROVED',NOW()) RETURNING id`, [b.id, amount])).id;
}
async function hold() {
  const o = await user('cardholder'); await fund(o.id, 10000);
  const iss = await card.issueCard(o.id, { daily_limit: 100000, per_txn_limit: 100000 });
  return (await card.authorizeCard(o.id, iss.card.id, { merchant_name: 'R26C2', amount: 3000, cvv: iss.cvv })).auth_reference;
}

let base;
async function post(pathname, token, body) {
  const r = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body || {}) });
  let json = null; try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, body: json };
}

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_port() port, inet_server_addr() addr');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n[1] governance decideApprovalFlow: APPROVAL_FLOW_EXECUTED names maker and checker; return shape unchanged');
  const govCases = [
    { t: 'BUSINESS_LOAN_DISBURSE', data: async (m) => ({ loanId: await bizLoan(), requesterId: m.id, amount: 9000 }) },
    { t: 'CREDIT_LOAN_DISBURSE', data: async (m) => ({ loanId: await microLoan(), requesterId: m.id, amount: 7000 }) },
    { t: 'WALLET_TRANSFER', makerIsSender: true, data: async (m) => { await fund(m.id, 20000); const to = await user('to'); return { fromUserId: m.id, toPhoneNumber: to.phone, amount: 5000, note: 'r26c2' }; } },
    { t: 'EVENT_WITHDRAWAL', makerIsSender: true, data: async (m) => {
      const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R26C2 ev',$1,100000,40000) RETURNING id`, [m.id]);
      const ref = `R26C2-EVW-${Date.now()}-${seq}`;
      const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status, requires_approval) VALUES ($1,$2,'FUNDRAISING',15000,$3,'PENDING',TRUE) RETURNING id`, [ev.id, m.id, ref]);
      return { eventId: ev.id, withdrawalId: w.id, mode: 'FUNDRAISING', amount: 15000, userId: m.id, reference: ref }; } },
  ];
  for (const c of govCases) {
    await section(async () => {
      const maker = await user('maker', c.makerIsSender ? null : 'ADMIN');
      const checker = await user('checker', 'ADMIN');
      const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: c.t, refType: c.t, data: await c.data(maker) });
      const out = await gov.decideApprovalFlow(flow.id, checker.id, 'APPROVE', 'r26c2');
      check(`${c.t}: return keys unchanged (execution,flow)`, keys(out) === 'execution,flow' && out.flow.status === 'APPROVED' && out.execution && out.execution.success !== false, keys(out));
      const rows = await auditRows('APPROVAL_FLOW_EXECUTED', 'APPROVAL_FLOW', flow.id);
      const m = rows[0] && rows[0].meta;
      check(`${c.t}: exactly one APPROVAL_FLOW_EXECUTED row`, rows.length === 1, rows.length);
      check(`${c.t}: maker_id = requester, checker_id = approver, actor = approver`,
        !!m && Number(m.maker_id) === maker.id && Number(m.checker_id) === checker.id && Number(rows[0].user_id) === checker.id && m.action_type === c.t, m);
    });
  }
  await section(async () => {
    const maker = await user('sender');
    const to = await user('to');
    const checker = await user('checker', 'ADMIN');
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'WALLET_TRANSFER', refType: 'WALLET_TRANSFER', data: { fromUserId: maker.id, toPhoneNumber: to.phone, amount: 5000, note: 'no funds' } });
    const e = await expectReject(() => gov.decideApprovalFlow(flow.id, checker.id, 'APPROVE'));
    check('executor failure: error surfaced (400) and flow back to PENDING', !!e && e.statusCode === 400 && (await q1('SELECT status FROM approval_flows WHERE id=$1', [flow.id])).status === 'PENDING');
    check('executor failure: no APPROVAL_FLOW_EXECUTED row', (await auditRows('APPROVAL_FLOW_EXECUTED', 'APPROVAL_FLOW', flow.id)).length === 0);
  });

  console.log('\n[2] four-eyes dispatch: FOUR_EYES_EXECUTED names maker, checkers and executor; return shape unchanged');
  const feCases = [
    { code: 'BUSINESS_LOAN_DISBURSE', payload: async () => ({ loanId: await bizLoan() }) },
    { code: 'CREDIT_LOAN_DISBURSE', payload: async () => ({ loanId: await microLoan() }) },
    { code: 'CARD_ADMIN_SETTLE', payload: async () => ({ authReference: await hold() }) },
    { code: 'CARD_ADMIN_REFUND', payload: async () => ({ authReference: await hold() }) },
  ];
  for (const c of feCases) {
    await section(async () => {
      const maker = await user('fe-maker', 'ADMIN');
      const checker = await user('fe-checker', 'ADMIN');
      const { request } = await fe.initiateRequest({ actionCode: c.code, requesterId: maker.id, payload: await c.payload() });
      const out = await fe.approve(request.id, checker.id, 'ADMIN', 'r26c2');
      check(`${c.code}: return keys unchanged (approvalCounts,executed,request) and EXECUTED`, keys(out) === 'approvalCounts,executed,request' && out.request.status === 'EXECUTED', { k: keys(out), s: out.request && out.request.status });
      const rows = await auditRows('FOUR_EYES_EXECUTED', 'FOUR_EYES_REQUEST', request.id);
      const m = rows[0] && rows[0].meta;
      check(`${c.code}: exactly one FOUR_EYES_EXECUTED row`, rows.length === 1, rows.length);
      check(`${c.code}: maker_id = requester, checker_ids = [approver], executed_by = approver`,
        !!m && Number(m.maker_id) === maker.id && Array.isArray(m.checker_ids) && m.checker_ids.map(Number).join() === String(checker.id)
        && Number(m.executed_by) === checker.id && m.action_code === c.code, m);
    });
  }
  await section(async () => {
    const maker = await user('fe-maker', 'ADMIN');
    const checker = await user('fe-checker', 'ADMIN');
    const { request } = await fe.initiateRequest({ actionCode: 'CARD_ADMIN_SETTLE', requesterId: maker.id, payload: { authReference: 'R26C2-NO-SUCH-AUTH' } });
    const out = await fe.approve(request.id, checker.id, 'ADMIN', 'r26c2').catch((e) => e);
    const st = (await q1('SELECT status FROM four_eyes_requests WHERE id=$1', [request.id])).status;
    check('four-eyes executor failure: request FAILED', st === 'FAILED', { st, out: out && out.message });
    check('four-eyes executor failure: no FOUR_EYES_EXECUTED row', (await auditRows('FOUR_EYES_EXECUTED', 'FOUR_EYES_REQUEST', request.id)).length === 0);
  });

  console.log('\n[3] direct admin routes while four-eyes is NOT active: FINANCIAL_DIRECT_EXECUTED; HTTP body unchanged');
  await pool.query("UPDATE feature_flags SET enabled=false WHERE flag_key='FOUR_EYES'");
  const admin = await user('admin', 'ADMIN');
  const direct = [
    { code: 'BUSINESS_LOAN_DISBURSE', mk: bizLoan, url: (x) => `/api/v1/business/admin/loans/${x}/disburse`, body: () => ({}), entity: (x) => x },
    { code: 'CREDIT_LOAN_DISBURSE', mk: microLoan, url: (x) => `/api/v1/credit/admin/loans/${x}/disburse`, body: () => ({}), entity: (x) => x },
    { code: 'CARD_ADMIN_SETTLE', mk: hold, url: () => '/api/v1/cards/admin/settle', body: (x) => ({ auth_reference: x }), entity: () => null },
    { code: 'CARD_ADMIN_REFUND', mk: hold, url: () => '/api/v1/cards/admin/refund', body: (x) => ({ auth_reference: x }), entity: () => null },
  ];
  for (const d of direct) {
    await section(async () => {
      const x = await d.mk();
      const before = await num('SELECT COALESCE(MAX(id),0) FROM audit_logs');
      const r = await post(d.url(x), admin.token, d.body(x));
      check(`${d.code}: 200 with body keys unchanged (result,success)`, r.status === 200 && keys(r.body) === 'result,success' && r.body.success === true, { s: r.status, k: keys(r.body) });
      const rows = (await pool.query("SELECT user_id, entity_id, meta FROM audit_logs WHERE action='FINANCIAL_DIRECT_EXECUTED' AND entity_type=$1 AND id > $2", [d.code, before])).rows;
      const m = rows[0] && rows[0].meta;
      check(`${d.code}: one FINANCIAL_DIRECT_EXECUTED row, maker = admin, checker = null`,
        rows.length === 1 && Number(m.maker_id) === admin.id && m.checker_id === null && Number(rows[0].user_id) === admin.id
        && (d.entity(x) == null ? (m.auth_reference === x) : Number(rows[0].entity_id) === d.entity(x)), rows);
      const before2 = await num('SELECT COALESCE(MAX(id),0) FROM audit_logs');
      const again = await post(d.url(x), admin.token, d.body(x));
      check(`${d.code}: repeat fails (already executed) and writes no FINANCIAL_DIRECT_EXECUTED row`,
        again.status >= 400 && (await num("SELECT COUNT(*) FROM audit_logs WHERE action='FINANCIAL_DIRECT_EXECUTED' AND id > $1", [before2])) === 0, again.status);
    });
  }
  await pool.query("UPDATE feature_flags SET enabled=true WHERE flag_key='FOUR_EYES'");

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
