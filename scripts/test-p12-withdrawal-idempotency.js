/* ============================================================
 * AFRIKOBA GLOBAL - P1.2 DEDICATED WITHDRAWAL IDEMPOTENCY SUITE
 * Verifies Idempotency-Key handling, exact/conflicting replay,
 * concurrent same-key requests, concurrent withdrawal vs approval,
 * injected journal / movement / state-transition faults with full
 * rollback, retry after rollback, and retry after commit.
 * Runs only against an explicit disposable phase68_amount_guard_* DB.
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
const key = (p) => (p + '-' + rnd(4)).slice(0, 24);

async function api(method, path, token, body, headers) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (headers) Object.assign(h, headers);
  const res = await fetch(BASE + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function newUser(name) {
  const phone = '2557' + String(crypto.randomInt(0, 1e8)).padStart(8, '0');
  const otp = (await api('POST', '/api/auth/send-otp', null, { phoneNumber: phone })).data.devOtp;
  const reg = await api('POST', '/api/auth/register', null, { fullName: name, phoneNumber: phone, otp });
  if (!reg.data.token) throw new Error('register failed ' + JSON.stringify(reg.data).slice(0, 200));
  return { phone, tok: reg.data.token, uid: reg.data.user.id };
}

async function newOrg(owner, savings) {
  const r = await api('POST', '/api/v1/saccos', owner.tok, {
    name: 'P12 ' + rnd(), config: { shareStructure: { autoApprove: true }, savings },
  });
  if (r.status !== 201) throw new Error('create org failed ' + r.status);
  const id = r.data.result.saccos.id;
  await api('POST', `/api/saccos/${id}/activate`, owner.tok);
  return id;
}

async function addMember(owner, orgId, u) {
  const inv = await api('POST', `/api/saccos/${orgId}/members`, owner.tok, { phoneNumber: u.phone });
  await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, u.tok);
  u.mid = inv.data.result.id;
}

async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + rnd().toUpperCase();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'DEPOSIT', $4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'p12-funding' })]);
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [tx.rows[0].id, ref, userId, amount, 'p12 funding']);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Actual financial state for one reference and one member. Read-only.
async function snap(u, ref) {
  const w = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [u.uid]);
  const a = await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [u.mid]);
  const r = ref
    ? await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM saccos_savings_withdrawals WHERE reference_id = $1) AS wd,
           (SELECT COUNT(*)::int FROM saccos_savings_movements WHERE reference_id = $1) AS mv,
           (SELECT COUNT(*)::int FROM transactions WHERE reference_id = $1) AS tx,
           (SELECT COUNT(*)::int FROM journal_entries WHERE reference_id = $1) AS jn,
           (SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DR'), 0)::numeric FROM journal_entries WHERE reference_id = $1) AS dr,
           (SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CR'), 0)::numeric FROM journal_entries WHERE reference_id = $1) AS cr,
           (SELECT status FROM saccos_savings_withdrawals WHERE reference_id = $1) AS wd_status`,
        [ref])
    : { rows: [{ wd: 0, mv: 0, tx: 0, jn: 0, dr: 0, cr: 0, wd_status: null }] };
  const memberWd = await pool.query('SELECT COUNT(*)::int AS c FROM saccos_savings_withdrawals WHERE member_id = $1', [u.mid]);
  const memberMv = await pool.query('SELECT COUNT(*)::int AS c FROM saccos_savings_movements WHERE member_id = $1', [u.mid]);
  return {
    wallet: Number(w.rows[0].wallet_balance),
    balance: Number(a.rows[0].balance),
    memberWithdrawals: memberWd.rows[0].c,
    memberMovements: memberMv.rows[0].c,
    ...r.rows[0],
    dr: Number(r.rows[0].dr),
    cr: Number(r.rows[0].cr),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const identity = await pool.query('SELECT current_database() AS db');
  const dbName = identity.rows[0].db;
  if (dbName !== EXPECTED_DB || DENYLIST.includes(dbName)) {
    console.error(`REFUSING: connected database '${dbName}' is not the expected '${EXPECTED_DB}'.`);
    process.exit(2);
  }
  console.log(`[guard] connected database verified: ${dbName}`);

  const owner = await newUser('P12 Owner');
  const auto = await newOrg(owner, { savingsType: 'VOLUNTARY', minDeposit: 0, minBalanceToRetain: 0, autoApproveWithdrawals: true });
  const m1 = await newUser('P12 Member One');
  await addMember(owner, auto, m1);
  await fundWallet(m1.uid, 100000);
  const dep = await api('POST', `/api/saccos/${auto}/savings/deposit`, m1.tok, { amount: 10000 });
  expect(dep.status === 201, 'setup: member deposits 10000', dep.status);

  const m2 = await newUser('P12 Member Two');
  await addMember(owner, auto, m2);
  await fundWallet(m2.uid, 100000);
  await api('POST', `/api/saccos/${auto}/savings/deposit`, m2.tok, { amount: 5000 });

  section('1. Missing, empty and oversized Idempotency-Key');
  const before1 = await snap(m1, null);
  const r1 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 1000 });
  expect(r1.status === 400, 'missing Idempotency-Key -> 400', r1.status);
  const r2 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 1000 }, { 'Idempotency-Key': '   ' });
  expect(r2.status === 400, 'whitespace-only Idempotency-Key -> 400', r2.status);
  const r3 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 1000 }, { 'Idempotency-Key': 'X'.repeat(25) });
  expect(r3.status === 400, 'Idempotency-Key of 25 chars -> 400', r3.status);
  const after1 = await snap(m1, null);
  expect(same(before1, after1), 'rejected keys leave wallet, balance, withdrawals and movements unchanged', { before1, after1 });

  section('2. First valid withdrawal');
  const K1 = key('K1');
  const b2 = await snap(m1, K1);
  const r4 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 2000 }, { 'Idempotency-Key': K1 });
  const a2 = await snap(m1, K1);
  expect(r4.status === 201 && r4.data.result.status === 'APPROVED' && r4.data.result.newBalance === 8000, 'first withdrawal 2000 -> 201 APPROVED, newBalance 8000', r4.data);
  expect(a2.wd === 1 && a2.wd_status === 'APPROVED' && a2.mv === 1 && a2.tx === 1, 'exactly 1 withdrawal(APPROVED), 1 movement, 1 transaction', a2);
  expect(a2.jn === 2 && a2.dr === 2000 && a2.cr === 2000, 'journal balanced: 2 lines, DR 2000 = CR 2000', a2);
  expect(a2.wallet === b2.wallet + 2000 && a2.balance === b2.balance - 2000, 'wallet +2000 and savings balance -2000', { before: b2, after: a2 });

  section('3. Exact replay (same key, same payload)');
  const r5 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 2000 }, { 'Idempotency-Key': K1 });
  const a3 = await snap(m1, K1);
  expect(r5.status === 201 && r5.data.result.dedup === true && r5.data.result.status === 'APPROVED', 'exact replay -> 201 dedup, status APPROVED', r5.data);
  expect(same(a2, a3), 'exact replay leaves withdrawal, movement, transaction, journal, wallet and balance unchanged', { before: a2, after: a3 });

  section('4. Conflicting replay (same key, different payload)');
  const b4 = await snap(m1, K1);
  const r6 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 3000 }, { 'Idempotency-Key': K1 });
  expect(r6.status === 409 && r6.data.code === 'SACCOS_SAVINGS_REFERENCE_CONFLICT', 'same key, different amount -> 409 REFERENCE_CONFLICT', r6.status);
  const a4 = await snap(m1, K1);
  expect(same(b4, a4), 'conflicting amount produces no financial entries', { before: b4, after: a4 });
  const b4b = await snap(m2, K1);
  const r7 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m2.tok, { amount: 2000 }, { 'Idempotency-Key': K1 });
  expect(r7.status === 409 && r7.data.code === 'SACCOS_SAVINGS_REFERENCE_CONFLICT', 'same key used by another member -> 409 REFERENCE_CONFLICT', r7.status);
  const a4b = await snap(m2, K1);
  expect(same(b4b, a4b) && a4b.balance === b4b.balance && a4b.wallet === b4b.wallet, 'cross-member key reuse leaves second member unchanged', { before: b4b, after: a4b });

  section('5. Concurrent same-key requests (6 parallel)');
  const K5 = key('K5');
  const b5 = await snap(m1, K5);
  const results5 = await Promise.all(Array.from({ length: 6 }, () =>
    api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 1500 }, { 'Idempotency-Key': K5 })));
  const a5 = await snap(m1, K5);
  const codes5 = results5.map((x) => x.status);
  expect(codes5.every((c) => c === 201), 'all 6 concurrent same-key responses are 201 (dedup or first)', codes5);
  expect(a5.wd === 1 && a5.mv === 1 && a5.tx === 1 && a5.jn === 2, 'exactly one claim, one movement, one transaction, one journal pair', a5);
  expect(a5.balance === b5.balance - 1500 && a5.wallet === b5.wallet + 1500, 'balance and wallet moved exactly once (1500)', { before: b5, after: a5 });
  expect(a5.dr === 1500 && a5.cr === 1500, 'journal DR = CR = 1500', a5);

  section('6. Insufficient balance: rollback leaves no claim, retry succeeds');
  const K6 = key('K6');
  const b6 = await snap(m2, K6);
  const r8 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m2.tok, { amount: 999999 }, { 'Idempotency-Key': K6 });
  const a6 = await snap(m2, K6);
  expect(r8.status === 400 && r8.data.code === 'SACCOS_SAVINGS_INSUFFICIENT', 'overdraw attempt -> 400 INSUFFICIENT', r8.data);
  expect(same(b6, a6), 'insufficient failure rolled back: no claim row, no movement, no journal, balances unchanged', { before: b6, after: a6 });
  const r9 = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m2.tok, { amount: 1000 }, { 'Idempotency-Key': K6 });
  const a6b = await snap(m2, K6);
  expect(r9.status === 201 && r9.data.result.status === 'APPROVED', 'retry with same key after rollback succeeds (no stranded claim)', r9.data);
  expect(a6b.wd === 1 && a6b.jn === 2 && a6b.balance === b6.balance - 1000, 'retry posts exactly one withdrawal and one journal pair', a6b);

  section('7. Injected faults: journal, movement and state transition (full rollback)');
  await pool.query(`CREATE OR REPLACE FUNCTION p12_fault_journal() RETURNS trigger AS $$ BEGIN
      IF NEW.reference_id LIKE 'FAULT-JN%' THEN RAISE EXCEPTION 'injected journal fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE OR REPLACE FUNCTION p12_fault_movement() RETURNS trigger AS $$ BEGIN
      IF NEW.reference_id LIKE 'FAULT-MV%' THEN RAISE EXCEPTION 'injected movement fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE OR REPLACE FUNCTION p12_fault_state() RETURNS trigger AS $$ BEGIN
      IF NEW.status = 'APPROVED' AND NEW.reference_id LIKE 'FAULT-ST%' THEN RAISE EXCEPTION 'injected state fault'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  try {
    await pool.query('CREATE TRIGGER p12_fault_journal BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION p12_fault_journal()');
    await pool.query('CREATE TRIGGER p12_fault_movement BEFORE INSERT ON saccos_savings_movements FOR EACH ROW EXECUTE FUNCTION p12_fault_movement()');
    await pool.query('CREATE TRIGGER p12_fault_state BEFORE UPDATE ON saccos_savings_withdrawals FOR EACH ROW EXECUTE FUNCTION p12_fault_state()');

    const scenarios = [
      { name: 'journal posting', ref: 'FAULT-JN-' + rnd(3) },
      { name: 'movement insert', ref: 'FAULT-MV-' + rnd(3) },
      { name: 'final state transition', ref: 'FAULT-ST-' + rnd(3) },
    ];
    for (const sc of scenarios) {
      const bf = await snap(m1, sc.ref);
      const rf = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 500 }, { 'Idempotency-Key': sc.ref });
      const af = await snap(m1, sc.ref);
      expect(rf.status >= 400 && rf.status < 600 && rf.status !== 201, `fault during ${sc.name} -> failure response (${rf.status})`, rf.status);
      expect(same(bf, af), `fault during ${sc.name}: full rollback, no claim/movement/transaction/journal, balances unchanged`, { before: bf, after: af });
    }

    await pool.query('DROP TRIGGER p12_fault_journal ON journal_entries');
    await pool.query('DROP TRIGGER p12_fault_movement ON saccos_savings_movements');
    await pool.query('DROP TRIGGER p12_fault_state ON saccos_savings_withdrawals');
    const retryRef = scenarios[0].ref;
    const rr = await api('POST', `/api/saccos/${auto}/savings/withdraw`, m1.tok, { amount: 500 }, { 'Idempotency-Key': retryRef });
    const ar = await snap(m1, retryRef);
    expect(rr.status === 201 && rr.data.result.status === 'APPROVED' && ar.wd === 1 && ar.jn === 2, 'retry of journal-faulted key succeeds once after faults removed', { status: rr.status, ar });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS p12_fault_journal ON journal_entries').catch(() => {});
    await pool.query('DROP TRIGGER IF EXISTS p12_fault_movement ON saccos_savings_movements').catch(() => {});
    await pool.query('DROP TRIGGER IF EXISTS p12_fault_state ON saccos_savings_withdrawals').catch(() => {});
  }

  section('8. Gated org: concurrent withdrawal vs approval, and double approval');
  const gated = await newOrg(owner, { savingsType: 'VOLUNTARY', minDeposit: 0, minBalanceToRetain: 0, autoApproveWithdrawals: false });
  const g1 = await newUser('P12 Gated Member');
  await addMember(owner, gated, g1);
  await fundWallet(g1.uid, 50000);
  await api('POST', `/api/saccos/${gated}/savings/deposit`, g1.tok, { amount: 10000 });
  const KA = key('KA');
  const pendA = await api('POST', `/api/saccos/${gated}/savings/withdraw`, g1.tok, { amount: 4000 }, { 'Idempotency-Key': KA });
  expect(pendA.status === 201 && pendA.data.result.status === 'PENDING', 'gated withdrawal 4000 -> PENDING (reserved)', pendA.data);
  const KB = key('KB');
  const [approveR, wdR] = await Promise.all([
    api('POST', `/api/saccos/${gated}/savings/withdrawals/${(await pool.query('SELECT id FROM saccos_savings_withdrawals WHERE reference_id = $1', [KA])).rows[0].id}/approve`, owner.tok),
    api('POST', `/api/saccos/${gated}/savings/withdraw`, g1.tok, { amount: 8000 }, { 'Idempotency-Key': KB }),
  ]);
  const balG = await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [g1.mid]);
  const endBal = Number(balG.rows[0].balance);
  const sumApproved = await pool.query("SELECT COALESCE(SUM(amount),0)::numeric AS s FROM saccos_savings_withdrawals WHERE member_id = $1 AND status = 'APPROVED'", [g1.mid]);
  expect(approveR.status === 200 && approveR.data.result.status === 'APPROVED', 'concurrent approval of 4000 -> APPROVED', approveR.data);
  expect(wdR.status === 400 && wdR.data.code === 'SACCOS_SAVINGS_INSUFFICIENT', 'concurrent 8000 request rejected INSUFFICIENT (no overdraw)', { status: wdR.status, code: wdR.data.code });
  expect(endBal === 6000 && endBal >= 0, 'final savings balance 6000 (10000 - 4000), never negative', endBal);
  expect(Number(sumApproved.rows[0].s) === 4000, 'approved withdrawals sum to exactly 4000', sumApproved.rows[0].s);

  const dblA = await Promise.all([
    api('POST', `/api/saccos/${gated}/savings/withdrawals/${(await pool.query('SELECT id FROM saccos_savings_withdrawals WHERE reference_id = $1', [KA])).rows[0].id}/approve`, owner.tok),
    api('POST', `/api/saccos/${gated}/savings/withdrawals/${(await pool.query('SELECT id FROM saccos_savings_withdrawals WHERE reference_id = $1', [KA])).rows[0].id}/approve`, owner.tok),
  ]);
  const endBal2 = Number((await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [g1.mid])).rows[0].balance);
  expect(dblA.every((x) => x.status === 200 && x.data.result.status === 'APPROVED'), 'two concurrent approvals of the same decision both return established APPROVED', dblA.map((x) => x.status));
  expect(endBal2 === 6000, 'double approval debits exactly once (balance still 6000)', endBal2);

  const wdRow = (await pool.query('SELECT id FROM saccos_savings_withdrawals WHERE reference_id = $1', [KA])).rows[0].id;
  const conflictApprove = await api('POST', `/api/saccos/${gated}/savings/withdrawals/${wdRow}/reject`, owner.tok);
  expect(conflictApprove.status === 400 && conflictApprove.data.code === 'SACCOS_SAVINGS_DECIDED', 'reject after approve -> 400 SACCOS_SAVINGS_DECIDED (opposing decision)', conflictApprove.data);

  section('9. Concurrent approve and reject of one pending request');
  const KC = key('KC');
  await api('POST', `/api/saccos/${gated}/savings/withdraw`, g1.tok, { amount: 1000 }, { 'Idempotency-Key': KC });
  const wdC = (await pool.query('SELECT id FROM saccos_savings_withdrawals WHERE reference_id = $1', [KC])).rows[0].id;
  const balBeforeC = Number((await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [g1.mid])).rows[0].balance);
  const [ap, rj] = await Promise.all([
    api('POST', `/api/saccos/${gated}/savings/withdrawals/${wdC}/approve`, owner.tok),
    api('POST', `/api/saccos/${gated}/savings/withdrawals/${wdC}/reject`, owner.tok),
  ]);
  const st = (await pool.query('SELECT status FROM saccos_savings_withdrawals WHERE id = $1', [wdC])).rows[0].status;
  const balAfterC = Number((await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [g1.mid])).rows[0].balance);
  const okCount = [ap, rj].filter((x) => x.status === 200).length;
  expect(okCount === 1 && (st === 'APPROVED' || st === 'REJECTED'), 'exactly one of concurrent approve/reject succeeds; final status is one terminal state', { ap: ap.status, rj: rj.status, st });
  const expectedBal = st === 'APPROVED' ? balBeforeC - 1000 : balBeforeC;
  expect(balAfterC === expectedBal, 'balance matches the single terminal decision', { balBeforeC, balAfterC, st });
  const mvStatus = (await pool.query('SELECT status FROM saccos_savings_movements WHERE reference_id = $1', [KC])).rows[0].status;
  expect(mvStatus === st, 'movement status agrees with withdrawal status', { mvStatus, st });

  section('10. Uncertain outcome after commit: retry returns established result');
  const KD = key('KD');
  const pendD = await api('POST', `/api/saccos/${gated}/savings/withdraw`, g1.tok, { amount: 700 }, { 'Idempotency-Key': KD });
  const wdD = (await pool.query('SELECT id FROM saccos_savings_withdrawals WHERE reference_id = $1', [KD])).rows[0].id;
  const apD = await api('POST', `/api/saccos/${gated}/savings/withdrawals/${wdD}/approve`, owner.tok);
  const balD1 = Number((await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [g1.mid])).rows[0].balance);
  const apD2 = await api('POST', `/api/saccos/${gated}/savings/withdrawals/${wdD}/approve`, owner.tok);
  const balD2 = Number((await pool.query('SELECT balance FROM saccos_savings_accounts WHERE member_id = $1', [g1.mid])).rows[0].balance);
  expect(pendD.status === 201 && apD.status === 200, 'approval of 700 succeeds', { pend: pendD.status, ap: apD.status });
  expect(apD2.status === 200 && apD2.data.result.dedup === true && apD2.data.result.status === 'APPROVED', 'retry of committed approval returns established APPROVED (dedup), not DECIDED/500', apD2.data);
  expect(balD2 === balD1, 'retry of committed approval does not debit again', { balD1, balD2 });
  const replayKD = await api('POST', `/api/saccos/${gated}/savings/withdraw`, g1.tok, { amount: 700 }, { 'Idempotency-Key': KD });
  expect(replayKD.status === 201 && replayKD.data.result.status === 'APPROVED' && replayKD.data.result.dedup === true, 'replay of committed gated withdrawal key returns established APPROVED (dedup)', replayKD.data);

  console.log(`\nP1.2 WITHDRAWAL IDEMPOTENCY: ${passed} passed, ${failed} failed`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  await pool.end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
