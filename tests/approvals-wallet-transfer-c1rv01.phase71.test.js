#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R26 C1RV-01: requester identity on /admin/approvals and
 * the owner's absolute prohibition of admin-initiated customer WALLET_TRANSFER.
 *
 *  A. POST {prefix}/admin/approvals: the authenticated admin is always the
 *     requester (maker). A body `requesterId` must not name someone else (it
 *     let one admin approve their own request).
 *  B. Owner decision: an admin may not move money out of a customer's wallet
 *     with WALLET_TRANSFER, by any route, executor or approval. A second
 *     checker does not make it allowed; flags/policies/rollout do not matter.
 *     The only WALLET_TRANSFER that may execute is the wallet owner's own
 *     high-value transfer (requester = sender), approved by another admin.
 *  Every refusal happens before any financial mutation (fingerprint check).
 *
 * Real routers, real authRequired/requireRoles (signed JWT), real services, on
 * an ephemeral 127.0.0.1 HTTP listener. Requires a DISPOSABLE database named
 * phase71_financial_audit_<suffix> on 127.0.0.1:55471. axios is stubbed.
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
const business = require(path.join(ROOT, 'src/services/businessService'));
const gov = require(path.join(ROOT, 'src/services/governanceService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

// Same mount order as src/server.js (admin before admin/four-eyes), both prefixes.
const app = express();
app.use(express.json());
for (const prefix of ['/api/v1', '/api']) {
  app.use(`${prefix}/admin`, require(path.join(ROOT, 'src/routes/adminRoutes')));
  app.use(`${prefix}/wallet`, require(path.join(ROOT, 'src/routes/walletRoutes')));
  app.use(`${prefix}/business`, require(path.join(ROOT, 'src/routes/businessRoutes')));
  app.use(`${prefix}/admin/four-eyes`, require(path.join(ROOT, 'src/routes/fourEyesRoutes')));
}
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
  const phone = `2557${String(Date.now()).slice(-5)}${String(seq).padStart(3, '0')}`;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`C1RV01 ${label} ${seq}`, phone]);
  if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, u.id]);
  const row = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  return { id: row.id, phone: row.phone_number, role: row.role, token: signToken(row) };
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `C1RV01-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);

let base;
async function http(method, pathname, token, body, headers = {}) {
  const r = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  let json = null; try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, body: json };
}
const post = (p, t, b, h) => http('POST', p, t, b, h);
const put = (p, t, b) => http('PUT', p, t, b);

// Financial fingerprint: anything that moves money changes at least one of these.
async function fingerprint() {
  return q1(`SELECT
      (SELECT COUNT(*) FROM journal_entries)::text AS journal,
      (SELECT COUNT(*) FROM transactions)::text AS txns,
      (SELECT COUNT(*) FROM financial_operations)::text AS ops,
      (SELECT COUNT(*) FROM wallet_ledger)::text AS wallet_ledger,
      (SELECT COALESCE(SUM(wallet_balance),0)::text FROM users) AS wallets,
      (SELECT COALESCE(SUM(locked_balance),0)::text FROM users) AS locked,
      (SELECT COALESCE(SUM(balance),0)::text FROM treasury_wallets) AS treasury,
      (SELECT COALESCE(SUM(balance),0)::text FROM business_accounts) AS biz,
      (SELECT string_agg(id||':'||status, ',' ORDER BY id) FROM business_loans) AS bloans`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} -> ${b[k]}`);
const wtFlows = () => num(`SELECT COUNT(*) FROM approval_flows WHERE upper(trim(action_type)) = 'WALLET_TRANSFER'`);
const audits = (action, userId) => pool.query('SELECT user_id, entity_type, meta FROM audit_logs WHERE action=$1 AND user_id=$2 ORDER BY id', [action, userId]).then((r) => r.rows);
const meta = (row) => (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) || {};
// A WALLET_TRANSFER flow written straight to the table: stands for a flow that
// already exists (created before this fix, or by any other path).
const seedFlow = (requesterId, data) => gov.createApprovalFlow({ requesterId, actionType: 'WALLET_TRANSFER', refType: 'WALLET_TRANSFER', data });
function state(label, before, after, extra = {}) {
  console.log(`    STATE ${label}: ${JSON.stringify({ ...extra, changed: diff(before, after) })}`);
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const A = await user('admin-a', 'ADMIN');
    const B = await user('admin-b', 'ADMIN');
    const C = await user('admin-c', 'ADMIN');

    console.log('\n[1] Requester identity: body requesterId cannot replace the authenticated admin');
    await section(async () => {
      for (const prefix of ['/api/v1', '/api']) {
        const r = await post(`${prefix}/admin/approvals`, A.token, { actionType: 'C1RV01_NOOP', refType: 'TEST', requesterId: B.id, data: {} });
        check(`${prefix}: flow created (200)`, r.status === 200, r);
        const flow = r.body && r.body.flow;
        check(`${prefix}: requester_id is the authenticated admin, not the body value`, flow && flow.requester_id === A.id, flow && { requester_id: flow.requester_id, actor: A.id, body: B.id });
        if (flow) {
          const self = await post(`${prefix}/admin/approvals/${flow.id}/decide`, A.token, { action: 'APPROVE' });
          check(`${prefix}: the same admin cannot approve it`, self.status !== 200, self);
        }
      }
      // The C1 case: a spoofed BUSINESS_LOAN_DISBURSE must not be self-approvable.
      const owner = await user('biz-owner');
      const biz = await business.registerBusiness(owner.id, { business_name: `C1RV01 shop ${seq}` });
      const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status) VALUES ($1,$2,9000,10,12,'APPROVED') RETURNING id`, [biz.id, owner.id]);
      const before = await fingerprint();
      const r = await post('/api/v1/admin/approvals', A.token, { actionType: 'BUSINESS_LOAN_DISBURSE', refType: 'BUSINESS_LOAN', refId: loan.id, requesterId: B.id, data: { loanId: loan.id, requesterId: B.id, amount: 9000 } });
      const id = r.body && r.body.flow && r.body.flow.id;
      const d = id ? await post(`/api/v1/admin/approvals/${id}/decide`, A.token, { action: 'APPROVE' }) : { status: 'no-flow' };
      const after = await fingerprint();
      state('spoofed BUSINESS_LOAN_DISBURSE + self-approve', before, after, { decide: d.status });
      check('spoofed disburse is not executed by the same admin (403/400, loan stays APPROVED)', d.status !== 200 && same(before, after), diff(before, after));
    });

    console.log('\n[2] /admin/approvals cannot create a WALLET_TRANSFER (prohibited, before any mutation)');
    await section(async () => {
      const victim = await user('customer'); await fund(victim.id, 50000);
      const other = await user('other-customer');
      const cases = [
        ['to the initiating admin, spoofed requester = victim', A, { requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 } }],
        ['to the initiating admin, no spoof', A, { data: { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 } }],
        ['to another admin', A, { requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: B.phone, amount: 40000 } }],
        ['to another customer', A, { requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: other.phone, amount: 40000 } }],
        ['action type in lower case', A, { actionType: 'wallet_transfer', requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 } }],
        ['action type with spaces', A, { actionType: ' WALLET_TRANSFER ', requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 } }],
      ];
      for (const prefix of ['/api/v1', '/api']) {
        for (const [label, actor, extra] of cases) {
          const before = await fingerprint(); const flowsBefore = await wtFlows(); const vBefore = await wallet(victim.id);
          const r = await post(`${prefix}/admin/approvals`, actor.token, { actionType: 'WALLET_TRANSFER', refType: 'WALLET_TRANSFER', ...extra });
          // If a flow was created anyway, a second, independent admin tries to approve it.
          let d = null;
          if (r.body && r.body.flow) d = await post(`${prefix}/admin/approvals/${r.body.flow.id}/decide`, (r.body.flow.requester_id === B.id ? C : B).token, { action: 'APPROVE' });
          const after = await fingerprint(); const flowsAfter = await wtFlows(); const vAfter = await wallet(victim.id);
          if (d) state(`${prefix} ${label}`, before, after, { create: r.status, decide: d.status, victim: `${vBefore} -> ${vAfter}` });
          check(`${prefix} ${label}: 403 WALLET_TRANSFER_PROHIBITED`, r.status === 403 && r.body && r.body.code === 'WALLET_TRANSFER_PROHIBITED', { status: r.status, code: r.body && r.body.code });
          check(`${prefix} ${label}: no flow, no financial change, victim ${vBefore}`, flowsAfter === flowsBefore && same(before, after) && vAfter === vBefore, { flows: `${flowsBefore}->${flowsAfter}`, changed: diff(before, after) });
        }
      }
      // Audit: the refusal names the authenticated actor and the ignored body requester.
      const rows = await audits('WALLET_TRANSFER_PROHIBITED', A.id);
      const spoofRow = rows.find((x) => meta(x).route === 'POST /admin/approvals' && Number(meta(x).body_requester_id) === victim.id);
      check('audit WALLET_TRANSFER_PROHIBITED: user_id = authenticated admin, from_user_id = victim, body requester recorded', rows.length >= 12 && spoofRow && Number(meta(spoofRow).from_user_id) === victim.id, { rows: rows.length, sample: spoofRow && meta(spoofRow) });
    });

    console.log('\n[3] An existing admin-made WALLET_TRANSFER flow cannot execute, even with an independent checker');
    await section(async () => {
      const victim = await user('customer'); await fund(victim.id, 50000);
      const scenarios = [
        ['requester admin A, to A, checker B', A, B, A.phone],
        ['requester admin A, to admin C, checker B', A, B, C.phone],
        ['requester admin A, to A, checker C', A, C, A.phone],
      ];
      for (const [label, maker, checker, to] of scenarios) {
        const flow = await seedFlow(maker.id, { fromUserId: victim.id, toPhoneNumber: to, amount: 40000, note: 'c1rv01' });
        const before = await fingerprint(); const vBefore = await wallet(victim.id);
        const d = await post(`/api/v1/admin/approvals/${flow.id}/decide`, checker.token, { action: 'APPROVE' });
        const after = await fingerprint(); const vAfter = await wallet(victim.id);
        state(label, before, after, { decide: d.status, code: d.body && d.body.code, victim: `${vBefore} -> ${vAfter}` });
        check(`${label}: approval refused 403 WALLET_TRANSFER_PROHIBITED`, d.status === 403 && d.body && d.body.code === 'WALLET_TRANSFER_PROHIBITED', { status: d.status, code: d.body && d.body.code });
        check(`${label}: no financial change (victim ${vBefore})`, same(before, after) && vAfter === vBefore, diff(before, after));
        const st = (await q1('SELECT status FROM approval_flows WHERE id=$1', [flow.id])).status;
        check(`${label}: flow not left APPROVED (${st})`, st !== 'APPROVED');
        const ex = await audits('APPROVAL_FLOW_EXECUTED', checker.id);
        check(`${label}: no APPROVAL_FLOW_EXECUTED audit`, !ex.some((x) => Number(meta(x).flow_id) === flow.id));
        const rows = await audits('WALLET_TRANSFER_PROHIBITED', checker.id);
        const row = rows.find((x) => Number(meta(x).flow_id) === flow.id);
        check(`${label}: audit names checker (user_id), maker and source wallet`, row && Number(meta(row).maker_id) === maker.id && Number(meta(row).from_user_id) === victim.id, row && meta(row));
      }
      // Executor path without HTTP (service call), and a flow whose requester is the customer
      // but whose sender is another customer.
      const v2 = await user('customer-2'); await fund(v2.id, 30000);
      for (const [label, makerId, fromId, to] of [
        ['service decideApprovalFlow, requester admin A', A.id, victim.id, A.phone],
        ['service decideApprovalFlow, requester customer-2, sender victim', v2.id, victim.id, v2.phone],
      ]) {
        const flow = await seedFlow(makerId, { fromUserId: fromId, toPhoneNumber: to, amount: 10000 });
        const before = await fingerprint();
        let err = null; try { await gov.decideApprovalFlow(flow.id, B.id, 'APPROVE'); } catch (e) { err = e; }
        const after = await fingerprint();
        state(label, before, after, { error: err && err.code });
        check(`${label}: rejected (WALLET_TRANSFER_PROHIBITED), no financial change`, err && err.code === 'WALLET_TRANSFER_PROHIBITED' && same(before, after), { err: err && err.message, changed: diff(before, after) });
      }
    });

    console.log('\n[4] Configuration cannot enable it (four-eyes flag/policy/rollout, four-eyes requests)');
    await section(async () => {
      const victim = await user('customer'); await fund(victim.id, 50000);
      const flagRow = await q1(`SELECT enabled, rollout_percent, audience FROM feature_flags WHERE flag_key='FOUR_EYES'`);
      for (const [label, sql] of [
        ['FOUR_EYES flag off', `UPDATE feature_flags SET enabled=false WHERE flag_key='FOUR_EYES'`],
        ['FOUR_EYES rollout 0', `UPDATE feature_flags SET enabled=true, rollout_percent=0 WHERE flag_key='FOUR_EYES'`],
      ]) {
        await pool.query(sql);
        const before = await fingerprint();
        const r = await post('/api/v1/admin/approvals', A.token, { actionType: 'WALLET_TRANSFER', requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 } });
        const flow = await seedFlow(A.id, { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 });
        const d = await post(`/api/v1/admin/approvals/${flow.id}/decide`, B.token, { action: 'APPROVE' });
        const after = await fingerprint();
        check(`${label}: create 403 and approve 403, no financial change`, r.status === 403 && d.status === 403 && same(before, after), { create: r.status, decide: d.status, changed: diff(before, after) });
      }
      await pool.query(`UPDATE feature_flags SET enabled=$1, rollout_percent=$2, audience=$3::jsonb WHERE flag_key='FOUR_EYES'`, [flagRow.enabled, flagRow.rollout_percent, JSON.stringify(flagRow.audience || [])]);
      // Four-eyes subsystem: there is no WALLET_TRANSFER executor; a policy + request + approval moves nothing.
      const before = await fingerprint();
      const p = await put('/api/v1/admin/four-eyes/policies/WALLET_TRANSFER', A.token, { enabled: true, requiredApprovers: 1, approverRoles: ['ADMIN'], allowSelfApprove: true, description: 'c1rv01 attempt' });
      const rq = await post('/api/v1/admin/four-eyes/requests', A.token, { action_code: 'WALLET_TRANSFER', payload: { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 } });
      const rid = rq.body && (rq.body.request ? rq.body.request.id : rq.body.id);
      const ap1 = rid ? await post(`/api/v1/admin/four-eyes/requests/${rid}/approve`, A.token, {}) : { status: 'no-request' };
      const ap2 = rid ? await post(`/api/v1/admin/four-eyes/requests/${rid}/approve`, B.token, {}) : { status: 'no-request' };
      const after = await fingerprint();
      state('four-eyes WALLET_TRANSFER policy+request+approve', before, after, { policy: p.status, request: rq.status, approveSelf: ap1.status, approveB: ap2.status });
      check('four-eyes path: no financial change from a WALLET_TRANSFER request', same(before, after), diff(before, after));
    });

    console.log('\n[5] No direct admin route moves a customer wallet');
    await section(async () => {
      const victim = await user('customer'); await fund(victim.id, 50000);
      const vBefore = await wallet(victim.id);
      for (const prefix of ['/api/v1', '/api']) {
        await post(`${prefix}/wallet/transfer`, A.token, { fromUserId: victim.id, userId: victim.id, toPhoneNumber: B.phone, amount: 40000, note: 'c1rv01' });
      }
      check('admin POST /wallet/transfer with body fromUserId=victim: victim wallet unchanged', (await wallet(victim.id)) === vBefore, { before: vBefore, after: await wallet(victim.id) });
    });

    console.log('\n[6] Legitimate flow still works: a customer\'s own high-value transfer, approved by an admin');
    await section(async () => {
      const cust = await user('high-value-customer'); await fund(cust.id, 60000);
      const rcpt = await user('recipient');
      const prev = await q1(`SELECT value FROM config_settings WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'`);
      await pool.query(`INSERT INTO config_settings (key, value) VALUES ('HIGH_VALUE_TRANSFER_THRESHOLD','1000') ON CONFLICT (key) DO UPDATE SET value='1000'`);
      try {
        const r = await post('/api/v1/wallet/transfer', cust.token, { toPhoneNumber: rcpt.phone, amount: 20000, note: 'legit' });
        check('customer transfer above threshold → PENDING_APPROVAL flow', r.status === 200 && r.body && r.body.requiresApproval === true, r);
        const id = r.body && r.body.approvalFlowId;
        const self = id ? await post(`/api/v1/admin/approvals/${id}/decide`, cust.token, { action: 'APPROVE' }) : { status: 'no-flow' };
        check('customer cannot reach /admin/approvals (403)', self.status === 403, self.status);
        const d = id ? await post(`/api/v1/admin/approvals/${id}/decide`, B.token, { action: 'APPROVE' }) : { status: 'no-flow' };
        check('admin approval executes the customer\'s own transfer (200)', d.status === 200, d);
        check('customer 60000 → 40000, recipient 0 → 20000', (await wallet(cust.id)) === 40000 && (await wallet(rcpt.id)) === 20000, { cust: await wallet(cust.id), rcpt: await wallet(rcpt.id) });
      } finally {
        await pool.query(`UPDATE config_settings SET value=$1 WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'`, [prev ? prev.value : '5000000']);
      }
    });

    console.log('\n[7] Concurrency: parallel attempts produce no financial mutation');
    await section(async () => {
      const victim = await user('customer'); await fund(victim.id, 50000);
      const before = await fingerprint(); const flowsBefore = await wtFlows();
      const rs = await Promise.all([A, B, C, A, B, C, A, B].map((adm, i) => post(i % 2 ? '/api/admin/approvals' : '/api/v1/admin/approvals', adm.token, { actionType: 'WALLET_TRANSFER', requesterId: victim.id, data: { fromUserId: victim.id, toPhoneNumber: adm.phone, amount: 40000 } })));
      const after = await fingerprint();
      check('8 concurrent /admin/approvals WALLET_TRANSFER: all 403, no flows, no change', rs.every((r) => r.status === 403) && (await wtFlows()) === flowsBefore && same(before, after), { statuses: rs.map((r) => r.status), changed: diff(before, after) });
      const flow = await seedFlow(A.id, { fromUserId: victim.id, toPhoneNumber: A.phone, amount: 40000 });
      const extra = [await user('admin-d', 'ADMIN'), await user('admin-e', 'ADMIN')];
      const b2 = await fingerprint();
      const ds = await Promise.all([B, C, ...extra, B].map((adm) => post(`/api/v1/admin/approvals/${flow.id}/decide`, adm.token, { action: 'APPROVE' })));
      const a2 = await fingerprint();
      state('5 concurrent approvals of an admin-made flow', b2, a2, { statuses: ds.map((r) => r.status) });
      check('5 concurrent approvals of an admin-made flow: none succeeds, no change', ds.every((r) => r.status !== 200) && same(b2, a2) && (await wallet(victim.id)) === 50000, { statuses: ds.map((r) => r.status), changed: diff(b2, a2) });
    });
  } finally {
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
