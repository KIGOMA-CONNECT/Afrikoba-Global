/* ============================================================
 * AFRIKOBA GLOBAL - P1.4 DEDICATED LOAN-LOSS CONCURRENCY SUITE
 * Concurrent release vs release, release vs write-off, repeated
 * release, write-off vs write-off, journal / state-transition fault
 * injection with full rollback, and deadlock observation over repeated
 * concurrent iterations. Isolated disposable DB only.
 * Loan fixtures are inserted directly (ACTIVE loan rows) because the
 * full application/guarantor/approval flow is outside P1.4 scope.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const crypto = require('crypto');

const EXPECTED_DB = process.env.PHASE68_TEST_DB;
const DENYLIST = ['afrikoba_regression', 'afrikoba_global', 'afrikoba', 'afrikoba_staging', 'postgres', 'phase68_guard', 'phase68_remed_dryrun'];
if (!EXPECTED_DB || !process.env.DB_NAME || process.env.DB_NAME !== EXPECTED_DB ||
    !/^phase68_amount_guard_[a-z0-9_]+$/i.test(EXPECTED_DB) || DENYLIST.includes(EXPECTED_DB)) {
  console.error('REFUSING to run: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<suffix> disposable database.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];
function expect(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
function section(label) { console.log('\n--- ' + label + ' ---'); }
const rnd = (n = 4) => crypto.randomBytes(n).toString('hex');

async function api(method, path, token, body) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function newUser(name) {
  const phone = '2557' + String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  const otp = (await api('POST', '/api/auth/send-otp', null, { phoneNumber: phone })).data.devOtp;
  const reg = await api('POST', '/api/auth/register', null, { fullName: name, phoneNumber: phone, otp });
  if (!reg.data.token) throw new Error('register failed');
  return { tok: reg.data.token, uid: reg.data.user.id };
}

// Financial state for one org/loan. Read-only.
async function state(orgId, loanId) {
  const llr = await pool.query('SELECT id, status FROM saccos_loan_loss_reserves WHERE loan_id = $1', [loanId]);
  const loan = await pool.query('SELECT status, amount_outstanding FROM saccos_loans WHERE id = $1', [loanId]);
  const ops = await pool.query(
    `SELECT operation_type, COUNT(*)::int AS c FROM financial_operations
      WHERE operation_type IN ('SACCOS_LOAN_LOSS_PROVISION','SACCOS_LOAN_LOSS_RELEASE','SACCOS_LOAN_WRITE_OFF')
      GROUP BY operation_type`);
  const opMap = Object.fromEntries(ops.rows.map((r) => [r.operation_type, r.c]));
  const wo = await pool.query('SELECT COUNT(*)::int AS c FROM saccos_loan_write_offs WHERE loan_id = $1', [loanId]);
  const bal = await pool.query(
    `SELECT l.account_code, COALESCE(SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE -j.amount END), 0)::numeric AS net
       FROM ledger_accounts l LEFT JOIN journal_entries j ON j.account_id = l.id
      WHERE l.account_code LIKE $1 GROUP BY l.account_code`, [`SACCOS${orgId}_%`]);
  const balances = Object.fromEntries(bal.rows.map((r) => [r.account_code, Number(r.net)]));
  const jn = await pool.query('SELECT COUNT(*)::int AS c FROM journal_entries');
  return {
    llrStatus: llr.rows.length ? llr.rows[0].status : null,
    llrId: llr.rows.length ? llr.rows[0].id : null,
    loanStatus: loan.rows[0].status,
    outstanding: Number(loan.rows[0].amount_outstanding),
    releaseOps: opMap.SACCOS_LOAN_LOSS_RELEASE || 0,
    writeOffOps: opMap.SACCOS_LOAN_WRITE_OFF || 0,
    writeOffRows: wo.rows[0].c,
    balances,
    journalRows: jn.rows[0].c,
  };
}

// Balanced-journal invariant across the whole isolated DB.
async function journalBalanced() {
  const r = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'DR' THEN amount ELSE 0 END), 0)::numeric AS dr,
            COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE 0 END), 0)::numeric AS cr FROM journal_entries`);
  return Number(r.rows[0].dr) === Number(r.rows[0].cr);
}

async function main() {
  const identity = await pool.query('SELECT current_database() AS db');
  if (identity.rows[0].db !== EXPECTED_DB || DENYLIST.includes(identity.rows[0].db)) {
    console.error(`REFUSING: connected database '${identity.rows[0].db}' is not '${EXPECTED_DB}'.`);
    process.exit(2);
  }
  console.log(`[guard] connected database verified: ${identity.rows[0].db}`);

  const owner = await newUser('P14 Owner');
  const created = await api('POST', '/api/v1/saccos', owner.tok, { name: 'P14 ' + rnd(), config: { shareStructure: { autoApprove: true } } });
  if (created.status !== 201) throw new Error('org create failed ' + created.status);
  const orgId = created.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, owner.tok);
  const mem = await pool.query('SELECT id FROM saccos_members WHERE saccos_id = $1 AND user_id = $2', [orgId, owner.uid]);
  const memberId = mem.rows[0].id;

  // Fixture: ACTIVE loan with outstanding principal (direct insert; see header).
  async function makeLoan(principal) {
    const app = await pool.query(
      `INSERT INTO saccos_loan_applications (saccos_id, member_id, reference_id, requested_amount, term_months, status, requires_approval)
       VALUES ($1, $2, $3, $4, 12, 'ACTIVE', false) RETURNING id`, [orgId, memberId, 'APP-' + rnd(3).toUpperCase(), principal]);
    const loan = await pool.query(
      `INSERT INTO saccos_loans (saccos_id, member_id, application_id, reference_id, principal, interest_rate, total_repayable, amount_outstanding, term_months, status)
       VALUES ($1, $2, $3, $4, $5, 0, $5, $5, 12, 'ACTIVE') RETURNING id`, [orgId, memberId, app.rows[0].id, 'LN-' + rnd(3).toUpperCase(), principal]);
    return loan.rows[0].id;
  }
  async function provision(loanId, amount) {
    const r = await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, owner.tok, { loanId, amount, ratePercent: 0 });
    if (r.status !== 201) throw new Error('provision failed ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
    return r.data.result.id;
  }
  const release = (llrId) => api('POST', `/api/saccos/${orgId}/loan-loss/${llrId}/release`, owner.tok);
  const writeOff = (loanId) => api('POST', `/api/saccos/${orgId}/loans/${loanId}/write-off`, owner.tok, { reason: 'p14 concurrency' });

  section('1. Single release: exactly one operation, one journal pair, reserve reversed');
  const L1 = await makeLoan(10000);
  const llr1 = await provision(L1, 4000);
  const s1a = await state(orgId, L1);
  const r1 = await release(llr1);
  const s1b = await state(orgId, L1);
  expect(r1.status === 200 && r1.data.result.status === 'RELEASED', 'single release -> 200 RELEASED', r1.data);
  expect(s1b.llrStatus === 'RELEASED' && s1b.releaseOps === s1a.releaseOps + 1, 'release: LLR RELEASED, +1 release operation', { before: s1a, after: s1b });
  const resKey = `SACCOS${orgId}_LOAN_LOSS_RESERVES`;
  expect((s1b.balances[resKey] || 0) === 0, 'reserve net balance returns to 0 after release', { before: s1a.balances, after: s1b.balances });
  expect(await journalBalanced(), 'global journal DR = CR after release');

  section('2. Repeated release: alreadyReleased, no new operation or journal');
  const s2a = await state(orgId, L1);
  const r2 = await release(llr1);
  const s2b = await state(orgId, L1);
  expect(r2.status === 200 && r2.data.result.alreadyReleased === true, 'repeated release -> 200 alreadyReleased', r2.data);
  expect(same(s2a, s2b), 'repeated release creates no operation, journal row, or balance change', { before: s2a, after: s2b });

  section('3. Two concurrent releases of the same reserve (Promise.all; overlap not instrumented)');
  const L3 = await makeLoan(10000);
  const llr3 = await provision(L3, 2500);
  const s3a = await state(orgId, L3);
  const res3 = await Promise.all([release(llr3), release(llr3)]);
  const s3b = await state(orgId, L3);
  const okFirst = res3.filter((x) => x.status === 200 && x.data.result.alreadyReleased !== true).length;
  const okDedup = res3.filter((x) => x.status === 200 && x.data.result.alreadyReleased === true).length;
  const bad3 = res3.filter((x) => !(x.status === 200)).map((x) => x.data.code || x.status);
  expect(okFirst === 1 && okDedup === 1 && bad3.length === 0, 'concurrent releases: one RELEASED + one alreadyReleased, no errors', res3.map((x) => ({ s: x.status, a: x.data.result && x.data.result.alreadyReleased })));
  expect(s3b.releaseOps === s3a.releaseOps + 1, 'concurrent releases produce exactly one release operation', { before: s3a.releaseOps, after: s3b.releaseOps });
  expect((s3b.balances[resKey] || 0) === 0, 'concurrent releases leave reserve net 0 (single reversal)', s3b.balances);

  section('4. Concurrent release vs write-off, repeated 8 times');
  const outcomes4 = [];
  for (let i = 0; i < 8; i++) {
    const L = await makeLoan(6000);
    const llr = await provision(L, 1500);
    const before = await state(orgId, L);
    const [rel, wo] = await Promise.all([release(llr), writeOff(L)]);
    const after = await state(orgId, L);
    const relOk = rel.status === 200 && rel.data.result.alreadyReleased !== true;
    const woOk = wo.status === 200;
    outcomes4.push({ rel: rel.status + (rel.data.code ? ':' + rel.data.code : ''), wo: wo.status + (wo.data.code ? ':' + wo.data.code : ''), llr: after.llrStatus, loan: after.loanStatus });
    const terminalOk = (after.llrStatus === 'RELEASED' || after.llrStatus === 'UTILIZED') && after.loanStatus === 'WRITTEN_OFF';
    expect(terminalOk, `iteration ${i + 1}: terminal reserve ${after.llrStatus} + loan WRITTEN_OFF`, outcomes4[i]);
    expect(woOk && after.writeOffRows === before.writeOffRows + 1, `iteration ${i + 1}: exactly one write-off recorded`, outcomes4[i]);
    // Accounting invariants, identical for both orders. Balances are CR-DR (net).
    // Receivable (asset): principal 6000 credited once -> net +6000.
    // Loss expense (DR-normal): 1500 provision reversed/consumed + 6000 written off -> net expense Δ = -4500 (CR-DR).
    // Reserve (CR-normal): 1500 consumed exactly once -> net Δ = -1500.
    const exp = `SACCOS${orgId}_LOAN_LOSS_EXPENSE`;
    const rec = `SACCOS${orgId}_LOANS_RECEIVABLE`;
    const dNet = (code) => (after.balances[code] || 0) - (before.balances[code] || 0);
    expect(dNet(rec) === 6000, `iteration ${i + 1}: receivable credited exactly 6000 (principal written off once)`, { delta: dNet(rec) });
    expect(dNet(exp) === -4500, `iteration ${i + 1}: loss expense recognised exactly once (net Δ -4500 CR-DR)`, { delta: dNet(exp) });
    expect(dNet(resKey) === -1500, `iteration ${i + 1}: reserve consumed exactly once (net Δ -1500)`, { delta: dNet(resKey) });
    expect(after.releaseOps - before.releaseOps === (relOk ? 1 : 0), `iteration ${i + 1}: release operations match outcome`, { relOk, delta: after.releaseOps - before.releaseOps });
    if (relOk) expect(rel.data.result.status === 'RELEASED', `iteration ${i + 1}: release-first -> RELEASED`, rel.data);
    if (!relOk) expect(rel.data.code === 'SACCOS_LLR_STATE', `iteration ${i + 1}: write-off-first -> release rejected SACCOS_LLR_STATE`, rel.data);
  }
  expect(await journalBalanced(), 'global journal DR = CR after 8 release-vs-write-off races');

  section('5. Concurrent write-offs of the same loan (no reserve): exactly one effect');
  for (let i = 0; i < 10; i++) {
    const L5 = await makeLoan(5000);
    const s5a = await state(orgId, L5);
    const res5 = await Promise.all([writeOff(L5), writeOff(L5)]);
    const s5b = await state(orgId, L5);
    const ok5 = res5.filter((x) => x.status === 200).length;
    const tag = `iteration ${i + 1}`;
    expect(s5b.writeOffRows === s5a.writeOffRows + 1 && s5b.writeOffOps === s5a.writeOffOps + 1, `${tag}: exactly one write-off row and one write-off operation`, { before: s5a, after: s5b, codes: res5.map((x) => x.status + ':' + (x.data.code || 'ok')) });
    expect(s5b.loanStatus === 'WRITTEN_OFF' && s5b.outstanding === 0, `${tag}: loan WRITTEN_OFF with outstanding 0`, { loanStatus: s5b.loanStatus, outstanding: s5b.outstanding });
    expect((s5b.balances[`SACCOS${orgId}_LOAN_LOSS_EXPENSE`] || 0) - (s5a.balances[`SACCOS${orgId}_LOAN_LOSS_EXPENSE`] || 0) === -5000, `${tag}: loss expense recognised exactly once (net Δ -5000 CR-DR)`, { before: s5a.balances, after: s5b.balances });
    expect(ok5 === 1, `${tag}: two concurrent write-offs -> exactly one 200 (other rejected, not a 5xx)`, res5.map((x) => ({ s: x.status, c: x.data.code })));
  }

  section('6. Journal failure during release: full rollback');
  await pool.query('CREATE TABLE IF NOT EXISTS p14_fault (id int PRIMARY KEY, on_flag boolean NOT NULL)');
  await pool.query('INSERT INTO p14_fault (id, on_flag) VALUES (1, false) ON CONFLICT (id) DO UPDATE SET on_flag = false');
  await pool.query(`CREATE OR REPLACE FUNCTION p14_fault_journal() RETURNS trigger AS $$ BEGIN
      IF (SELECT on_flag FROM p14_fault WHERE id = 1) THEN RAISE EXCEPTION 'injected journal fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query('DROP TRIGGER IF EXISTS p14_fault_journal ON journal_entries');
  await pool.query('CREATE TRIGGER p14_fault_journal BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION p14_fault_journal()');
  await pool.query(`CREATE OR REPLACE FUNCTION p14_fault_state() RETURNS trigger AS $$ BEGIN
      IF NEW.status = 'RELEASED' AND (SELECT on_flag FROM p14_fault WHERE id = 1) THEN RAISE EXCEPTION 'injected state fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query('DROP TRIGGER IF EXISTS p14_fault_state ON saccos_loan_loss_reserves');
  await pool.query('CREATE TRIGGER p14_fault_state BEFORE UPDATE ON saccos_loan_loss_reserves FOR EACH ROW EXECUTE FUNCTION p14_fault_state()');
  try {
    const L6 = await makeLoan(3000);
    const llr6 = await provision(L6, 1000);
    const b6 = await state(orgId, L6);
    await pool.query('UPDATE p14_fault SET on_flag = true WHERE id = 1');
    const r6 = await release(llr6);
    await pool.query('UPDATE p14_fault SET on_flag = false WHERE id = 1');
    const a6 = await state(orgId, L6);
    expect(r6.status >= 500, 'journal fault during release -> server error response', r6.status);
    expect(same(b6, a6), 'journal fault during release: LLR still PROVISIONED, no operation, no journal, reserve unchanged', { before: b6, after: a6 });
    const r6b = await release(llr6);
    expect(r6b.status === 200 && r6b.data.result.status === 'RELEASED', 'release retry after fault removed succeeds once', r6b.data);

    section('7. State-transition fault during release: full rollback');
    const L7 = await makeLoan(3000);
    const llr7 = await provision(L7, 900);
    const b7 = await state(orgId, L7);
    await pool.query('UPDATE p14_fault SET on_flag = true WHERE id = 1');
    const r7 = await release(llr7);
    await pool.query('UPDATE p14_fault SET on_flag = false WHERE id = 1');
    const a7 = await state(orgId, L7);
    expect(r7.status >= 500, 'state-transition fault during release -> server error response', r7.status);
    expect(same(b7, a7), 'state-transition fault: no journal, no operation, LLR still PROVISIONED', { before: b7, after: a7 });

    section('8. Journal fault during write-off: full rollback');
    const L8 = await makeLoan(2000);
    const llr8 = await provision(L8, 500);
    const b8 = await state(orgId, L8);
    await pool.query('UPDATE p14_fault SET on_flag = true WHERE id = 1');
    const r8 = await writeOff(L8);
    await pool.query('UPDATE p14_fault SET on_flag = false WHERE id = 1');
    const a8 = await state(orgId, L8);
    expect(r8.status >= 500, 'journal fault during write-off -> server error response', r8.status);
    expect(same(b8, a8) && a8.loanStatus === 'ACTIVE' && a8.llrStatus === 'PROVISIONED', 'write-off journal fault: loan ACTIVE, reserve PROVISIONED, no write-off row or journal', { before: b8, after: a8 });
    expect(llr8 > 0, 'fixture reserve present for write-off fault test');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS p14_fault_journal ON journal_entries').catch(() => {});
    await pool.query('DROP TRIGGER IF EXISTS p14_fault_state ON saccos_loan_loss_reserves').catch(() => {});
    await pool.query('UPDATE p14_fault SET on_flag = false WHERE id = 1').catch(() => {});
  }

  section('9. Deadlock observation: 12 concurrent mixed operations on one org, repeated');
  let deadlocks = 0;
  let serverErrors = 0;
  for (let round = 0; round < 3; round++) {
    const loans = [];
    for (let i = 0; i < 4; i++) {
      const L = await makeLoan(1000 + i);
      const llr = await provision(L, 100 + i);
      loans.push({ L, llr });
    }
    const ops = [];
    for (const { L, llr } of loans) {
      ops.push(release(llr), writeOff(L), release(llr));
    }
    const out = await Promise.all(ops);
    for (const x of out) {
      if (x.status >= 500) serverErrors++;
      if (x.data.code === '40P01') deadlocks++;
    }
  }
  expect(deadlocks === 0, 'no deadlocks (40P01) across 36 concurrent mixed operations', { deadlocks });
  expect(serverErrors === 0, 'no 5xx responses across concurrent mixed operations', { serverErrors });
  expect(await journalBalanced(), 'global journal DR = CR after all concurrency rounds');

  console.log(`\nP1.4 LOAN-LOSS CONCURRENCY: ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

main().catch(async (e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
