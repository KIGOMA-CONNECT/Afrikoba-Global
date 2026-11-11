#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R26-C1: segregation of duties on direct admin routes
 *
 *  POST {prefix}/business/admin/loans/:id/disburse   BUSINESS_LOAN_DISBURSE
 *  POST {prefix}/credit/admin/loans/:id/disburse     CREDIT_LOAN_DISBURSE
 *  POST {prefix}/cards/admin/settle                  CARD_ADMIN_SETTLE
 *  POST {prefix}/cards/admin/refund                  CARD_ADMIN_REFUND
 *
 *  Four-eyes active (flag FOUR_EYES on AND policy enabled) → 403 with stable
 *  code FOUR_EYES_REQUIRED, launcher instructions, no financial effect, and an
 *  audit row FOUR_EYES_DIRECT_BLOCKED. Not active → current behaviour.
 *  End to end through the launcher: the maker cannot approve their own request;
 *  a second admin approves and the operation executes once.
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
const fs = require('fs');
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
const card = require(path.join(ROOT, 'src/services/cardService'));
const { signToken } = require(path.join(ROOT, 'src/middleware/auth'));

const app = express();
app.use(express.json());
for (const prefix of ['/api/v1', '/api']) {
  app.use(`${prefix}/business`, require(path.join(ROOT, 'src/routes/businessRoutes')));
  app.use(`${prefix}/credit`, require(path.join(ROOT, 'src/routes/creditRoutes')));
  app.use(`${prefix}/cards`, require(path.join(ROOT, 'src/routes/cardRoutes')));
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
  const phone = `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const u = await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id, phone_number', [`R26C1 ${label} ${seq}`, phone]);
  if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, u.id]);
  const row = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]);
  return { id: row.id, phone: row.phone_number, token: signToken(row) };
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `R26C1-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);

let base;
async function post(pathname, token, body) {
  const r = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  let json = null; try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, body: json };
}
const setFlag = (on) => pool.query("UPDATE feature_flags SET enabled=$1 WHERE flag_key='FOUR_EYES'", [on]);
const setPolicy = (code, on) => pool.query('UPDATE four_eyes_policies SET enabled=$1 WHERE action_code=$2', [on, code]);
const auditCount = (action, code, since) => num('SELECT COUNT(*) FROM audit_logs WHERE action=$1 AND entity_type=$2 AND id > $3', [action, code, since]);
const maxAudit = () => num('SELECT COALESCE(MAX(id),0) FROM audit_logs');

async function mkBusinessLoan(amount = 9000) {
  const owner = await user('biz-owner');
  const biz = await require(path.join(ROOT, 'src/services/businessService')).registerBusiness(owner.id, { business_name: `R26C1 shop ${seq}` });
  const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status)
                         VALUES ($1,$2,$3,10,12,'APPROVED') RETURNING id`, [biz.id, owner.id, amount]);
  return { loanId: loan.id, bizId: biz.id,
    state: async () => ({ status: (await q1('SELECT status FROM business_loans WHERE id=$1', [loan.id])).status, balance: await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id]) }) };
}
async function mkMicroLoan(amount = 7000) {
  const b = await user('borrower');
  const w0 = await wallet(b.id);
  const loan = await q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at) VALUES ($1,$2,10,1,'APPROVED',NOW()) RETURNING id`, [b.id, amount]);
  return { loanId: loan.id,
    state: async () => ({ status: (await q1('SELECT status FROM micro_loans WHERE id=$1', [loan.id])).status, credited: (await wallet(b.id)) - w0 }) };
}
async function mkHold() {
  const o = await user('cardholder'); await fund(o.id, 10000);
  const iss = await card.issueCard(o.id, { daily_limit: 100000, per_txn_limit: 100000 });
  const a = await card.authorizeCard(o.id, iss.card.id, { merchant_name: 'R26C1', amount: 3000, cvv: iss.cvv });
  const ref = a.auth_reference;
  return { ref,
    state: async () => ({ status: (await q1('SELECT status FROM card_transactions WHERE auth_reference=$1', [ref])).status, wallet: await wallet(o.id), locked: await num('SELECT locked_balance FROM users WHERE id=$1', [o.id]) }) };
}

const ACTIONS = [
  { code: 'BUSINESS_LOAN_DISBURSE', mk: mkBusinessLoan, url: (x, p = '/api/v1') => `${p}/business/admin/loans/${x.loanId}/disburse`, body: () => ({}), payload: (x) => ({ loanId: x.loanId }), done: (s) => s.status === 'DISBURSED' && s.balance === 9000, untouched: (s) => s.status === 'APPROVED' && s.balance === 0 },
  { code: 'CREDIT_LOAN_DISBURSE', mk: mkMicroLoan, url: (x, p = '/api/v1') => `${p}/credit/admin/loans/${x.loanId}/disburse`, body: () => ({}), payload: (x) => ({ loanId: x.loanId }), done: (s) => s.status === 'ACTIVE' && s.credited === 7000, untouched: (s) => s.status === 'APPROVED' && s.credited === 0 },
  { code: 'CARD_ADMIN_SETTLE', mk: mkHold, url: (x, p = '/api/v1') => `${p}/cards/admin/settle`, body: (x) => ({ auth_reference: x.ref }), payload: (x) => ({ authReference: x.ref }), done: (s) => s.status === 'SETTLED' && s.wallet === 7000 && s.locked === 0, untouched: (s) => s.status === 'AUTH_HOLD' && s.locked === 3000 },
  { code: 'CARD_ADMIN_REFUND', mk: mkHold, url: (x, p = '/api/v1') => `${p}/cards/admin/refund`, body: (x) => ({ auth_reference: x.ref }), payload: (x) => ({ authReference: x.ref }), done: (s) => s.status === 'REFUNDED' && s.wallet === 10000 && s.locked === 0, untouched: (s) => s.status === 'AUTH_HOLD' && s.locked === 3000 },
];

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_port() port, inet_server_addr() addr');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const admin = await user('maker', 'ADMIN');
  const checker = await user('checker', 'ADMIN');
  await setFlag(true);
  for (const a of ACTIONS) await setPolicy(a.code, true);

  console.log('\n[1] four-eyes active: direct routes refused with 403 FOUR_EYES_REQUIRED, no effect, audited');
  for (const a of ACTIONS) {
    await section(async () => {
      const x = await a.mk();
      const since = await maxAudit();
      const r = await post(a.url(x), admin.token, a.body(x));
      check(`${a.code}: HTTP 403`, r.status === 403, r);
      check(`${a.code}: stable code FOUR_EYES_REQUIRED`, r.body && r.body.code === 'FOUR_EYES_REQUIRED' && r.body.success === false, r.body);
      const l = r.body && r.body.four_eyes && r.body.four_eyes.launcher;
      check(`${a.code}: launcher instructions (POST /api/v1/admin/four-eyes/requests, action_code + payload)`,
        !!l && l.method === 'POST' && l.path === '/api/v1/admin/four-eyes/requests' && l.body.action_code === a.code
        && JSON.stringify(l.body.payload) === JSON.stringify(a.payload(x)), l);
      check(`${a.code}: no financial effect`, a.untouched(await x.state()), await x.state());
      check(`${a.code}: one FOUR_EYES_DIRECT_BLOCKED audit row`, (await auditCount('FOUR_EYES_DIRECT_BLOCKED', a.code, since)) === 1);
    });
  }
  await section(async () => {
    const x = await mkMicroLoan();
    const r = await post(`/api/credit/admin/loans/${x.loanId}/disburse`, admin.token, {});
    check('legacy /api prefix: 403 and launcher path /api/admin/four-eyes/requests',
      r.status === 403 && r.body.four_eyes.launcher.path === '/api/admin/four-eyes/requests', r.body);
    check('legacy /api prefix: no effect', (await x.state()).credited === 0);
  });
  await section(async () => {
    await pool.query("INSERT INTO config_settings (key, value) VALUES ('HIGH_VALUE_TRANSFER_THRESHOLD','5000') ON CONFLICT (key) DO UPDATE SET value='5000'");
    const x = await mkBusinessLoan();
    const flows0 = await num('SELECT COUNT(*) FROM approval_flows');
    const r = await post(`/api/v1/business/admin/loans/${x.loanId}/disburse`, admin.token, {});
    check('high-value amount: gate refuses before the governance branch (403, no approval_flow created)',
      r.status === 403 && (await num('SELECT COUNT(*) FROM approval_flows')) === flows0, { status: r.status });
    await pool.query("DELETE FROM config_settings WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'");
  });
  await section(async () => {
    const outsider = await user('customer');
    const x = await mkMicroLoan();
    const r = await post(`/api/v1/credit/admin/loans/${x.loanId}/disburse`, outsider.token, {});
    check('non-admin still refused by requireRoles (403, not the four-eyes body)', r.status === 403 && (!r.body || r.body.code !== 'FOUR_EYES_REQUIRED'), r.body);
  });

  console.log('\n[2] four-eyes NOT active: current behaviour (direct execution)');
  await setFlag(false);
  for (const a of ACTIONS) {
    await section(async () => {
      const x = await a.mk();
      const since = await maxAudit();
      const r = await post(a.url(x), admin.token, a.body(x));
      check(`flag off · ${a.code}: 200 success with result`, r.status === 200 && r.body.success === true && !!r.body.result, r);
      check(`flag off · ${a.code}: executed`, a.done(await x.state()), await x.state());
      check(`flag off · ${a.code}: no FOUR_EYES_DIRECT_BLOCKED row`, (await auditCount('FOUR_EYES_DIRECT_BLOCKED', a.code, since)) === 0);
    });
  }
  await setFlag(true);
  for (const a of ACTIONS) {
    await section(async () => {
      await setPolicy(a.code, false);
      const x = await a.mk();
      const r = await post(a.url(x), admin.token, a.body(x));
      check(`policy disabled · ${a.code}: direct execution (200)`, r.status === 200 && a.done(await x.state()), { status: r.status, s: await x.state() });
      await setPolicy(a.code, true);
    });
  }

  console.log('\n[3] four-eyes end to end via the launcher: self-approval refused, second admin executes once');
  for (const a of ACTIONS) {
    await section(async () => {
      const x = await a.mk();
      const blocked = await post(a.url(x), admin.token, a.body(x));
      const l = blocked.body.four_eyes.launcher;
      const created = await post(l.path, admin.token, l.body);
      check(`${a.code}: launcher creates a PENDING request (201)`, created.status === 201 && created.body.request.status === 'PENDING', created);
      const reqId = created.body.request.id;
      const self = await post(`/api/v1/admin/four-eyes/requests/${reqId}/approve`, admin.token, {});
      check(`${a.code}: maker self-approval rejected (403)`, self.status === 403, self);
      check(`${a.code}: still no effect after self-approval attempt`, a.untouched(await x.state()), await x.state());
      const ok = await post(`/api/v1/admin/four-eyes/requests/${reqId}/approve`, checker.token, {});
      check(`${a.code}: checker approval executes`, ok.status === 200 && ok.body.request.status === 'EXECUTED', ok.body && ok.body.request);
      check(`${a.code}: effect applied once`, a.done(await x.state()), await x.state());
      const again = await post(`/api/v1/admin/four-eyes/requests/${reqId}/approve`, (await user('c2', 'ADMIN')).token, {});
      check(`${a.code}: later approval refused (409)`, again.status === 409, again.status);
      check(`${a.code}: still applied once`, a.done(await x.state()), await x.state());
    });
  }

  console.log('\n[4] VICOBA routes untouched by C1 (OD-R26-VICOBA)');
  {
    const v = fs.readFileSync(path.join(ROOT, 'src/routes/vicobaRoutes.js'), 'utf8');
    check('vicobaRoutes.js does not use fourEyesGate', !/fourEyesGate/.test(v));
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
