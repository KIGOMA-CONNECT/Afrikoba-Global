/* ============================================================
 * AFRIKOBA GLOBAL - PHASE 69 FOUR-EYES LARGE REFUND SUITE
 * ADMIN_LARGE_REFUND only. Covers first success, replay after commit,
 * mismatched user/amount, NEW/FAILED existing operations, approved-request
 * recovery after dispatch interruption, concurrent dispatch attempts held
 * at the request-row lock, and single credit / single journal invariants.
 * Isolated disposable database phase69_four_eyes_test only.
 * ============================================================ */
const BASE = process.env.FOUREYES_TEST_BASE || 'http://127.0.0.1:3098';
const pool = require('../src/config/db');
const crypto = require('crypto');

const EXPECTED_DB = process.env.PHASE69_TEST_DB;
if (!EXPECTED_DB || !process.env.DB_NAME || process.env.DB_NAME !== EXPECTED_DB ||
    !/^phase69_four_eyes_[a-z0-9_]+$/i.test(EXPECTED_DB)) {
  console.error('REFUSING to run: DB_NAME and PHASE69_TEST_DB must match an explicit phase69_four_eyes_<suffix> disposable database.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];
function expect(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : ''}`); }
}
function section(label) { console.log('\n--- ' + label + ' ---'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd8 = () => String(crypto.randomInt(0, 1e8)).padStart(8, '0');

async function api(method, path, token, body) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function newUser(name, role) {
  const phone = '2557' + rnd8();
  const otp = (await api('POST', '/api/auth/send-otp', null, { phoneNumber: phone })).data.devOtp;
  const reg = await api('POST', '/api/auth/register', null, { fullName: name, phoneNumber: phone, otp });
  if (!reg.data.token) throw new Error('register failed ' + JSON.stringify(reg.data).slice(0, 200));
  const uid = reg.data.user.id;
  if (role) {
    await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [uid, role]);
    let tok = null;
    for (let i = 0; i < 8 && !tok; i++) {
      const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
      const candidate = refresh.data.token;
      if (candidate && (await api('GET', '/api/admin/four-eyes/policies', candidate)).status !== 401) tok = candidate;
      else await sleep(250);
    }
    return { tok, uid, phone };
  }
  return { tok: reg.data.token, uid, phone };
}

async function wallet(uid) {
  return Number((await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [uid])).rows[0].wallet_balance);
}
async function ops(reference) {
  return (await pool.query('SELECT operation_type, user_id, amount, status FROM financial_operations WHERE reference_id = $1', [reference])).rows;
}
async function journal(reference) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(CASE WHEN direction='DR' THEN amount ELSE 0 END),0)::numeric AS dr,
            COALESCE(SUM(CASE WHEN direction='CR' THEN amount ELSE 0 END),0)::numeric AS cr
       FROM journal_entries WHERE reference_id = $1`, [reference]);
  return { n: r.rows[0].n, dr: Number(r.rows[0].dr), cr: Number(r.rows[0].cr) };
}
async function req(id) {
  return (await pool.query('SELECT status, error, execution_result FROM four_eyes_requests WHERE id = $1', [id])).rows[0];
}
const refOf = (id) => `FOUR_EYES_REFUND:${id}`;

async function initiate(maker, userId, amount) {
  const r = await api('POST', '/api/admin/four-eyes/actions/large-refund', maker.tok, { userId, amount });
  if (r.status !== 201) throw new Error('initiate failed ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
  return r.data.request.id;
}

async function setFault(on) {
  await pool.query('UPDATE p69_fault SET on_flag = $1 WHERE id = 1', [on]);
}

// Holds the request row lock in its own transaction; returns pid and release().
async function holdRequestRow(id) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT id FROM four_eyes_requests WHERE id = $1 FOR UPDATE', [id]);
  const pid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return { pid, release: async () => { await c.query('COMMIT'); c.release(); } };
}
// Counts sessions queued on the request-row lock (FOR UPDATE OF r) and how many are
// directly blocked by the holder. Queued waiters behind the first waiter are counted too.
async function waitBlockedOn(pid, count) {
  const deadline = Date.now() + 2500;
  let rows = [];
  while (Date.now() < deadline) {
    rows = (await pool.query(
      `SELECT pid, left(query, 100) AS q, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()
          AND query ILIKE '%FOR UPDATE OF r%' AND pid <> $1`, [pid])).rows;
    if (rows.length >= count) break;
    await sleep(40);
  }
  rows.direct = rows.filter((r) => r.blockers.includes(pid)).length;
  const snapshot = (await pool.query(
    `SELECT pid, state, wait_event_type, wait_event, left(query, 80) AS q, pg_blocking_pids(pid) AS blockers
       FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND query ILIKE '%four_eyes_requests%'`)).rows;
  console.log(`  [evidence] holder pid=${pid}; sessions on four_eyes_requests: ${JSON.stringify(snapshot)}`);
  return rows;
}

async function main() {
  const identity = await pool.query('SELECT current_database() AS db');
  if (identity.rows[0].db !== EXPECTED_DB) {
    console.error(`REFUSING: connected database '${identity.rows[0].db}' is not '${EXPECTED_DB}'.`);
    process.exit(2);
  }
  console.log(`[guard] connected database verified: ${identity.rows[0].db}`);

  await pool.query('CREATE TABLE IF NOT EXISTS p69_fault (id INT PRIMARY KEY, on_flag BOOLEAN NOT NULL)');
  await pool.query('INSERT INTO p69_fault (id, on_flag) VALUES (1, false) ON CONFLICT (id) DO UPDATE SET on_flag = false');
  await pool.query(`CREATE OR REPLACE FUNCTION p69_fault_dispatch() RETURNS trigger AS $$ BEGIN
      IF NEW.status = 'EXECUTED' AND NEW.action_code = 'ADMIN_LARGE_REFUND'
         AND (SELECT on_flag FROM p69_fault WHERE id = 1) THEN
        RAISE EXCEPTION 'injected dispatch interruption';
      END IF;
      RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query('DROP TRIGGER IF EXISTS p69_fault_dispatch ON four_eyes_requests');
  await pool.query('CREATE TRIGGER p69_fault_dispatch BEFORE UPDATE ON four_eyes_requests FOR EACH ROW EXECUTE FUNCTION p69_fault_dispatch()');

  const legacyRefsBefore = Number((await pool.query("SELECT COUNT(*)::int AS n FROM financial_operations WHERE reference_id LIKE 'REF-%'")).rows[0].n);

  try {
    const maker = await newUser('P69 Maker', 'ADMIN');
    const checker = await newUser('P69 Checker', 'ADMIN');
    expect(maker.tok && checker.tok, 'two distinct ADMIN actors available (maker, checker)');
    const pol = await api('GET', '/api/admin/four-eyes/policies', maker.tok);
    expect(pol.status === 200, 'admin can read four-eyes policies', pol.status);

    // ---------------- 1. First successful refund ----------------
    section('1. First successful refund');
    const u1 = await newUser('P69 Recipient 1');
    const id1 = await initiate(maker, u1.uid, 1000);
    const ap1 = await api('POST', `/api/admin/four-eyes/requests/${id1}/approve`, checker.tok, {});
    const r1 = await req(id1);
    const o1 = await ops(refOf(id1));
    const j1 = await journal(refOf(id1));
    expect(ap1.status === 200 && ap1.data.executed && ap1.data.executed.reference === refOf(id1), 'checker approval executes the refund (executor result returned)', { status: ap1.status, executed: ap1.data.executed });
    expect(r1.status === 'EXECUTED' && r1.execution_result.reference === refOf(id1) && r1.execution_result.replayed === false, 'request EXECUTED with stable reference, replayed=false', r1);
    expect(await wallet(u1.uid) === 1000, 'recipient wallet credited exactly 1000', await wallet(u1.uid));
    expect(o1.length === 1 && o1[0].status === 'SUCCESS' && o1[0].operation_type === 'CREDIT' && Number(o1[0].user_id) === u1.uid, 'one CREDIT operation, SUCCESS, expected user', o1);
    expect(j1.n === 2 && j1.dr === 1000 && j1.cr === 1000, 'journal: two lines, DR = CR = 1000', j1);

    // ---------------- 2. Replay after wallet commit ----------------
    section('2. Replay after wallet commit');
    const rp = await api('POST', `/api/admin/four-eyes/requests/${id1}/approve`, checker.tok, {});
    const rt = await api('POST', `/api/admin/four-eyes/requests/${id1}/retry`, checker.tok, {});
    expect(rp.status === 409, 'second approval of an EXECUTED request is rejected (no re-dispatch)', rp.status);
    expect(rt.status === 409, 'retry of an EXECUTED request is rejected (not FAILED)', rt.status);
    expect(await wallet(u1.uid) === 1000, 'replays leave wallet at 1000', await wallet(u1.uid));
    expect((await ops(refOf(id1))).length === 1 && (await journal(refOf(id1))).n === 2, 'replays leave one operation and two journal lines', { ops: (await ops(refOf(id1))).length });

    // ---------------- 3. Same request, mismatched user or amount ----------------
    section('3. Mismatched user or amount for the same request reference');
    const u3 = await newUser('P69 Recipient 3');
    const u4 = await newUser('P69 Other User');
    const id3 = await initiate(maker, u3.uid, 1000);
    await pool.query(
      `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts)
       VALUES ('CREDIT', $1, NULL, $2, 1000, 'SUCCESS', 1)`, [refOf(id3), u4.uid]);
    const ap3 = await api('POST', `/api/admin/four-eyes/requests/${id3}/approve`, checker.tok, {});
    const r3 = await req(id3);
    expect(ap3.status === 200 && !ap3.data.executed && r3.status === 'FAILED', 'mismatched user: request FAILED, not EXECUTED', { s: ap3.status, st: r3.status });
    expect(/OPERATION_SHAPE_MISMATCH/.test(r3.error || ''), 'mismatched user: error names the shape mismatch', r3.error);
    expect(await wallet(u3.uid) === 0 && await wallet(u4.uid) === 0, 'mismatched user: neither wallet credited', { u3: await wallet(u3.uid), u4: await wallet(u4.uid) });

    const u3b = await newUser('P69 Recipient 3b');
    const id3b = await initiate(maker, u3b.uid, 1000);
    await pool.query(
      `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts)
       VALUES ('CREDIT', $1, NULL, $2, 999, 'SUCCESS', 1)`, [refOf(id3b), u3b.uid]);
    const ap3b = await api('POST', `/api/admin/four-eyes/requests/${id3b}/approve`, checker.tok, {});
    const r3b = await req(id3b);
    expect(r3b.status === 'FAILED' && /OPERATION_SHAPE_MISMATCH/.test(r3b.error || ''), 'mismatched amount: request FAILED with shape mismatch', { s: ap3b.status, r: r3b });
    expect(await wallet(u3b.uid) === 0, 'mismatched amount: wallet not credited', await wallet(u3b.uid));

    // ---------------- 4. Existing operation in NEW or FAILED ----------------
    section('4. Existing operation in NEW or FAILED state');
    for (const st of ['NEW', 'FAILED']) {
      const u = await newUser('P69 Recipient ' + st);
      const id = await initiate(maker, u.uid, 800);
      await pool.query(
        `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts)
         VALUES ('CREDIT', $1, NULL, $2, 800, $3, 1)`, [refOf(id), u.uid, st]);
      const ap = await api('POST', `/api/admin/four-eyes/requests/${id}/approve`, checker.tok, {});
      const r = await req(id);
      const o = await ops(refOf(id));
      expect(ap.status === 200 && !ap.data.executed && r.status === 'FAILED', `operation ${st}: request FAILED, not reported as success`, { s: ap.status, st: r.status });
      expect(r.status !== 'EXECUTED' && String(r.error || '').includes(st), `operation ${st}: error is visible and names the state`, r.error);
      expect(o.length === 1 && o[0].status === st, `operation ${st}: operation row left unchanged and visible`, o);
      expect(await wallet(u.uid) === 0 && (await journal(refOf(id))).n === 0, `operation ${st}: no wallet credit and no journal posted`, { w: await wallet(u.uid) });
    }

    // ---------------- 5. Approved-request recovery after dispatch interruption ----------------
    section('5. Recovery of an APPROVED request after dispatch interruption');
    const u5 = await newUser('P69 Recipient 5');
    const id5 = await initiate(maker, u5.uid, 2500);
    await setFault(true);
    const ap5 = await api('POST', `/api/admin/four-eyes/requests/${id5}/approve`, checker.tok, {});
    await setFault(false);
    const r5a = await req(id5);
    const o5a = await ops(refOf(id5));
    const j5a = await journal(refOf(id5));
    expect(ap5.status >= 500, 'interrupted dispatch surfaces as a server error to the caller', ap5.status);
    expect(r5a.status === 'APPROVED', 'after interruption the request remains APPROVED (not falsely EXECUTED)', r5a.status);
    expect(await wallet(u5.uid) === 2500 && o5a.length === 1 && o5a[0].status === 'SUCCESS' && j5a.n === 2, 'wallet credit already committed exactly once before recovery', { w: await wallet(u5.uid), ops: o5a.length, j: j5a });
    const rec5 = await api('POST', `/api/admin/four-eyes/requests/${id5}/retry`, checker.tok, {});
    const r5b = await req(id5);
    expect(rec5.status === 200 && rec5.data.executed && rec5.data.executed.replayed === true && rec5.data.recoveredApprovedRefund === true, 'recovery executes the APPROVED request via verified replay', { s: rec5.status, d: rec5.data });
    expect(r5b.status === 'EXECUTED' && r5b.execution_result.replayed === true && r5b.execution_result.reference === refOf(id5), 'recovered request EXECUTED under the same stable reference, replayed=true', r5b);
    expect(await wallet(u5.uid) === 2500, 'recovery does not repeat the wallet credit (still 2500)', await wallet(u5.uid));
    expect((await ops(refOf(id5))).length === 1 && (await journal(refOf(id5))).n === 2, 'recovery leaves one operation and two journal lines', { ops: (await ops(refOf(id5))).length });

    // ---------------- 6. Concurrent dispatch attempts ----------------
    section('6. Concurrent dispatch attempts (controlled overlap at the request-row lock)');
    const u6 = await newUser('P69 Recipient 6');
    const id6 = await initiate(maker, u6.uid, 700);
    await setFault(true);
    const ap6 = await api('POST', `/api/admin/four-eyes/requests/${id6}/approve`, checker.tok, {});
    await setFault(false);
    expect(ap6.status >= 500 && (await req(id6)).status === 'APPROVED' && await wallet(u6.uid) === 700, 'setup: APPROVED request with committed single credit 700', { s: ap6.status });
    const lock6 = await holdRequestRow(id6);
    const pending6 = Array.from({ length: 4 }, () => api('POST', `/api/admin/four-eyes/requests/${id6}/retry`, checker.tok, {}));
    const blocked6 = await waitBlockedOn(lock6.pid, 4);
    expect(blocked6.length >= 4 && blocked6.direct >= 1, 'four concurrent dispatch attempts queued on the request-row lock, at least one directly blocked by the holder', { queued: blocked6.length, direct: blocked6.direct });
    await lock6.release();
    const res6 = await Promise.all(pending6);
    const executed6 = res6.filter((x) => x.status === 200 && x.data.executed && x.data.executed.replayed === true).length;
    const r6 = await req(id6);
    expect(executed6 === 1, 'exactly one concurrent dispatch executes the request', res6.map((x) => ({ s: x.status, e: x.data.executed })));
    expect(res6.every((x) => x.status === 200 || x.status === 409), 'every concurrent attempt returns a defined outcome (200 or 409), no 5xx', res6.map((x) => x.status));
    expect(r6.status === 'EXECUTED' && await wallet(u6.uid) === 700, 'final: EXECUTED, wallet credited once (700)', { st: r6.status, w: await wallet(u6.uid) });
    expect((await ops(refOf(id6))).length === 1 && (await journal(refOf(id6))).n === 2, 'final: one operation and two journal lines for the reference', { ops: (await ops(refOf(id6))).length });

    // ---------------- 7. Global invariants ----------------
    section('7. Global invariants across all refund requests in this run');
    const dup = await pool.query(
      "SELECT reference_id, COUNT(*)::int AS n FROM financial_operations WHERE reference_id LIKE 'FOUR_EYES_REFUND:%' GROUP BY reference_id HAVING COUNT(*) > 1");
    expect(dup.rows.length === 0, 'no FOUR_EYES_REFUND reference has more than one operation', dup.rows);
    const badJ = await pool.query(
      `SELECT j.reference_id FROM journal_entries j
        WHERE j.reference_id LIKE 'FOUR_EYES_REFUND:%'
        GROUP BY j.reference_id
       HAVING COUNT(*) <> 2 OR SUM(CASE WHEN direction='DR' THEN amount ELSE -amount END) <> 0`);
    expect(badJ.rows.length === 0, 'every FOUR_EYES_REFUND journal posting is a balanced two-line entry', badJ.rows);
    const legacyRefsAfter = Number((await pool.query("SELECT COUNT(*)::int AS n FROM financial_operations WHERE reference_id LIKE 'REF-%'")).rows[0].n);
    expect(legacyRefsAfter === legacyRefsBefore, 'no legacy REF- references created by the refund executor in this run', { before: legacyRefsBefore, after: legacyRefsAfter });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS p69_fault_dispatch ON four_eyes_requests').catch(() => {});
    await pool.query('DROP FUNCTION IF EXISTS p69_fault_dispatch()').catch(() => {});
  }

  console.log(`\nPHASE 69 FOUR-EYES LARGE REFUND: ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
