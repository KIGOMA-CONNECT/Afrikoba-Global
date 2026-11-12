#!/usr/bin/env node
'use strict';
/* R34 S5 (i) — migration 149: VICOBA loan three-tier approval data.
 * The test applies db/migrations/149_vicoba_loan_three_tier_approvals.sql ITSELF (run it on a
 * disposable DB WITHOUT the migration pre-applied), so it can prove that pre-existing rows are not
 * changed, and that a second application is a no-op.
 *  [1] legacy rows (all old statuses, including an unknown one) are byte-identical after the migration;
 *      new columns are NULL on them; the status CHECKs are NOT VALID (do not rewrite or reject history).
 *  [2] the migration is idempotent (second application succeeds, changes nothing).
 *  [3] vicoba_loan_approvals: UNIQUE(loan_id, step_no) and UNIQUE(loan_id, actor_user_id) hold.
 *  [4] guard trigger: applicant as actor -> 23514; group mismatch -> 23514; UPDATE / DELETE -> 42501.
 *  [5] CHECKs: REJECTED needs a reason; chain v1 step codes fixed; amount > 0.
 *  [6] vicoba_loan_requests CHECKs on new/updated rows: unknown status; chain v1 'PENDING';
 *      chain v1 initiator != applicant; ON_HOLD without hold fields; CANCELLED by a non-applicant.
 *  [7] legacy flow still writes: a chain-NULL 'PENDING' row inserts and moves to DISBURSED.
 *  [8] a group with approvals cannot be deleted (ON DELETE RESTRICT keeps the audit).
 * Requires a DISPOSABLE database phase71_financial_audit_<suffix> on 127.0.0.1:55481.
 */
const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
if (!DB_GUARD.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55481') {
  console.error('REFUSING: disposable r26-ci-db (127.0.0.1:55481, phase71_financial_audit_*) only'); process.exit(2);
}
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const pool = require(path.join(ROOT, 'src/config/db'));
const MIG = path.join(ROOT, 'db/migrations/149_vicoba_loan_three_tier_approvals.sql');

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
const q1 = async (s, p) => (await pool.query(s, p)).rows[0];
const codeOf = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code || e.message; } };
let seq = 0;
async function user(label) {
  seq++;
  return (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R34M ${label}`, `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`])).id;
}
async function applyMigration() {
  const sql = fs.readFileSync(MIG, 'utf8');
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const LEGACY_COLS = 'id, group_id, applicant_user_id, requested_amount, approved_amount, interest_rate, repayment_months, chairman_approval, chairman_approved_by, treasurer_approval, treasurer_approved_by, status, rejection_reason, created_at, updated_at, total_repaid, outstanding_balance, next_due_date';
const legacyHash = async () => (await q1(`SELECT count(*)::int n, md5(COALESCE(string_agg(t::text, '|' ORDER BY id), '')) h FROM (SELECT ${LEGACY_COLS} FROM vicoba_loan_requests) t`));

(async () => {
  const id = await q1('SELECT current_database() db');
  console.log(`DB identity: database=${id.db} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');
  if (!fs.existsSync(MIG)) { check('migration file 149 exists', false, MIG); console.log(`\nR34 migration 149: ${passed} passed, ${failed} failed`); await pool.end(); process.exit(1); }
  check('precondition: vicoba_loan_approvals absent before the test applies 149', (await q1("SELECT to_regclass('vicoba_loan_approvals') r")).r === null);

  const chair = await user('chair'); const sec = await user('sec'); const tre = await user('tre'); const mem = await user('mem'); const mem2 = await user('mem2');
  const g = (await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ('R34M g', $1, 1000, 'ACTIVE', 100000) RETURNING id`, [chair])).id;
  const g2 = (await q1(`INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status, group_wallet_balance) VALUES ('R34M g2', $1, 1000, 'ACTIVE', 0) RETURNING id`, [chair])).id;
  for (const st of ['PENDING', 'APPROVED', 'DISBURSED', 'REJECTED', 'REPAID', 'WEIRD_OLD']) {
    await pool.query(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, chairman_approval, chairman_approved_by, status, rejection_reason) VALUES ($1,$2,1000,TRUE,$3,$4,$5)`, [g, mem, chair, st, st === 'REJECTED' ? 'x' : null]);
  }
  const before = await legacyHash();

  console.log('\n[1] legacy rows unchanged by the migration');
  await applyMigration();
  const after = await legacyHash();
  check('[1] legacy rows byte-identical (count + md5 of all pre-existing columns)', before.n === 6 && before.n === after.n && before.h === after.h, { before, after });
  const nulls = await q1('SELECT count(*)::int n FROM vicoba_loan_requests WHERE approval_chain_version IS NULL AND initiated_by_user_id IS NULL AND hold_reason IS NULL AND cancelled_by_user_id IS NULL');
  check('[1] new columns are NULL on legacy rows', nulls.n === 6, nulls);
  const nv = (await pool.query("SELECT conname, convalidated FROM pg_constraint WHERE conrelid='vicoba_loan_requests'::regclass AND conname LIKE 'ck_vicoba_loan_requests_%' ORDER BY 1")).rows;
  check('[1] four request CHECKs exist and are NOT VALID (history not validated)', nv.length === 4 && nv.every((r) => r.convalidated === false), nv);

  console.log('\n[2] idempotent');
  const e2 = await codeOf(applyMigration);
  const after2 = await legacyHash();
  check('[2] second application succeeds and changes nothing', e2 === 'OK' && after2.h === before.h, { e2 });

  console.log('\n[3] UNIQUE constraints');
  const lid = (await q1(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, initiated_by_user_id, approval_chain_version, requested_amount, status) VALUES ($1,$2,$2,1,1000,'PENDING_KATIBU') RETURNING id`, [g, mem])).id;
  const ins = (step, code, actor, role, decision = 'APPROVED', reason = null, grp = g, amount = null) => pool.query(
    `INSERT INTO vicoba_loan_approvals (loan_id, group_id, chain_version, step_no, step_code, actor_user_id, actor_role_at_action, decision, reason, amount) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
    [lid, grp, step, code, actor, role, decision, reason, amount]);
  check('[3] first approval inserts', (await codeOf(() => ins(1, 'KATIBU', sec, 'KATIBU'))) === 'OK');
  check('[3] same step again (other actor) -> 23505', (await codeOf(() => ins(1, 'KATIBU', tre, 'KATIBU'))) === '23505');
  check('[3] same actor on another step -> 23505', (await codeOf(() => ins(2, 'MHASIBU', sec, 'MWEKAHAZINA'))) === '23505');

  console.log('\n[4] guard trigger');
  check('[4] applicant as actor -> 23514', (await codeOf(() => ins(2, 'MHASIBU', mem, 'MWEKAHAZINA'))) === '23514');
  check('[4] group mismatch -> 23514', (await codeOf(() => ins(2, 'MHASIBU', tre, 'MWEKAHAZINA', 'APPROVED', null, g2))) === '23514');
  check('[4] UPDATE -> 42501', (await codeOf(() => pool.query("UPDATE vicoba_loan_approvals SET reason='x' WHERE loan_id=$1", [lid]))) === '42501');
  check('[4] DELETE -> 42501', (await codeOf(() => pool.query('DELETE FROM vicoba_loan_approvals WHERE loan_id=$1', [lid]))) === '42501');

  console.log('\n[5] approval CHECKs');
  check('[5] REJECTED without reason -> 23514', (await codeOf(() => ins(2, 'MHASIBU', tre, 'MWEKAHAZINA', 'REJECTED', '  '))) === '23514');
  check('[5] chain v1 wrong step code -> 23514', (await codeOf(() => ins(2, 'KATIBU', tre, 'MWEKAHAZINA'))) === '23514');
  check('[5] amount 0 -> 23514', (await codeOf(() => ins(2, 'MHASIBU', tre, 'MWEKAHAZINA', 'APPROVED', null, g, 0))) === '23514');
  check('[5] valid step 2 inserts', (await codeOf(() => ins(2, 'MHASIBU', tre, 'MWEKAHAZINA', 'APPROVED', null, g, 1000))) === 'OK');

  console.log('\n[6] request CHECKs on new rows');
  const newRow = (cols, vals) => codeOf(() => pool.query(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, ${cols}) VALUES ($1,$2,1000,${vals.map((_, i) => `$${i + 3}`).join(',')})`, [g, mem, ...vals]));
  check('[6] unknown status -> 23514', (await newRow('status', ['BOGUS'])) === '23514');
  check('[6] chain v1 legacy PENDING -> 23514', (await newRow('status, approval_chain_version, initiated_by_user_id', ['PENDING', 1, mem])) === '23514');
  check('[6] chain v1 initiator != applicant -> 23514', (await newRow('status, approval_chain_version, initiated_by_user_id', ['PENDING_KATIBU', 1, chair])) === '23514');
  check('[6] ON_HOLD without hold fields -> 23514', (await newRow('status, approval_chain_version, initiated_by_user_id', ['ON_HOLD', 1, mem])) === '23514');
  check('[6] CANCELLED by a non-applicant -> 23514', (await newRow('status, approval_chain_version, initiated_by_user_id, cancelled_by_user_id, cancelled_at', ['CANCELLED', 1, mem, chair, new Date()])) === '23514');
  check('[6] valid ON_HOLD inserts', (await newRow('status, approval_chain_version, initiated_by_user_id, hold_reason, hold_step, held_at', ['ON_HOLD', 1, mem, 'APPROVER_MISSING', 'MHASIBU', new Date()])) === 'OK');
  for (const st of ['PENDING_KATIBU', 'PENDING_MHASIBU', 'PENDING_MWENYEKITI', 'REJECTED', 'APPROVED', 'DISBURSED', 'REPAID']) {
    check(`[6] chain v1 status ${st} inserts`, (await newRow('status, approval_chain_version, initiated_by_user_id', [st, 1, mem])) === 'OK');
  }
  check('[6] valid CANCELLED (by the applicant) inserts', (await newRow('status, approval_chain_version, initiated_by_user_id, cancelled_by_user_id, cancelled_at', ['CANCELLED', 1, mem, mem, new Date()])) === 'OK');
  check('[6] update of the unknown legacy status row to another unknown -> 23514', (await codeOf(() => pool.query("UPDATE vicoba_loan_requests SET status='WEIRD_NEW' WHERE status='WEIRD_OLD'"))) === '23514');

  console.log('\n[7] legacy chain still writes');
  const l7 = (await q1(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, chairman_approval, chairman_approved_by) VALUES ($1,$2,1000,TRUE,$3) RETURNING id, status`, [g, mem2, chair]));
  const u7 = await codeOf(() => pool.query("UPDATE vicoba_loan_requests SET status='DISBURSED', treasurer_approval=TRUE, treasurer_approved_by=$2 WHERE id=$1", [l7.id, tre]));
  check('[7] legacy PENDING row inserts (default status) and moves to DISBURSED', l7.status === 'PENDING' && u7 === 'OK', { l7, u7 });

  console.log('\n[8] audit kept');
  check('[8] deleting a group that has approvals is refused', (await codeOf(() => pool.query('DELETE FROM vicoba_groups WHERE id=$1', [g]))) !== 'OK');

  console.log('\n[9] concurrency: two open transactions insert the same step / the same actor');
  for (const [label, a2, step2] of [['same step', chair, 1], ['same actor', sec, 2]]) {
    const l9 = (await q1(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, initiated_by_user_id, approval_chain_version, requested_amount, status) VALUES ($1,$2,$2,1,1000,'PENDING_KATIBU') RETURNING id`, [g, mem2])).id;
    const c1 = await pool.connect(); const c2 = await pool.connect();
    const sql = `INSERT INTO vicoba_loan_approvals (loan_id, group_id, chain_version, step_no, step_code, actor_user_id, actor_role_at_action, decision) VALUES ($1,$2,1,$3,$4,$5,'X','APPROVED')`;
    const codes = ['KATIBU', 'MHASIBU'];
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      await c1.query(sql, [l9, g, 1, 'KATIBU', sec]);
      const p2 = c2.query(sql, [l9, g, step2, codes[step2 - 1], a2]).then(() => 'OK', (e) => e.code);
      const early = await Promise.race([p2.then(() => 'settled'), new Promise((r) => setTimeout(() => r('waiting'), 300))]);
      await c1.query('COMMIT');
      const r2 = await p2; await c2.query(r2 === 'OK' ? 'COMMIT' : 'ROLLBACK');
      const n = (await q1('SELECT count(*)::int n FROM vicoba_loan_approvals WHERE loan_id=$1', [l9])).n;
      check(`[9] ${label}: second waits on the first, then 23505; one row`, early === 'waiting' && r2 === '23505' && n === 1, { early, r2, n });
    } finally { c1.release(); c2.release(); }
  }

  console.log(`\nR34 migration 149: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { await pool.end(); } catch (x) { /* */ } process.exit(1); });
