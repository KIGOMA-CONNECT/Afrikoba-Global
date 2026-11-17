/* ============================================================
 * Phase 70.1 - LEGACY ADMIN_LARGE_REFUND RECONCILIATION SUITE
 * Synthetic REF-<approver>-<ms> fixtures run only in a fresh, isolated
 * phase69_four_eyes_<suffix> database explicitly selected by PHASE69_TEST_DB.
 * The legacy database naming convention is retained for compatibility.
 * Run-unique amounts are supplementary; database guards, not amount uniqueness,
 * prevent collision with prior fixture evidence. Fixture writes are one
 * transaction (all-or-nothing). The harness does not create or drop databases,
 * and committed fixtures remain in the disposable database after the run.
 * Verifies reconciliation classifications, population completeness, read-only
 * execution, and deployment-gate refusal of unresolved or invalid requests.
 * ============================================================ */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const EXPECTED_DB = process.env.PHASE69_TEST_DB;
if (!EXPECTED_DB || !process.env.DB_NAME || process.env.DB_NAME !== EXPECTED_DB ||
    !/^phase69_four_eyes_[a-z0-9_]+$/i.test(EXPECTED_DB)) {
  console.error('REFUSING: DB_NAME and PHASE69_TEST_DB must match a phase69_four_eyes_<suffix> disposable database.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];
function expect(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}
function section(label) { console.log('\n--- ' + label + ' ---'); }

async function counts(c) {
  const ops = (await c.query('SELECT COUNT(*)::int AS n FROM financial_operations')).rows[0].n;
  const jn = (await c.query('SELECT COUNT(*)::int AS n FROM journal_entries')).rows[0].n;
  const reqs = (await c.query("SELECT status, COUNT(*)::int AS n FROM four_eyes_requests WHERE action_code = 'ADMIN_LARGE_REFUND' GROUP BY status ORDER BY status")).rows;
  const audits = (await c.query('SELECT COUNT(*)::int AS n FROM financial_audit_log')).rows[0].n;
  const approvals = (await c.query('SELECT COUNT(*)::int AS n FROM four_eyes_approvals')).rows[0].n;
  const wallets = (await c.query('SELECT COALESCE(SUM(wallet_balance),0)::numeric AS s FROM users')).rows[0].s;
  return {
    operations: ops,
    journal_rows: jn,
    financial_audit_rows: audits,
    approval_rows: approvals,
    refund_requests: reqs,
    wallet_total: String(wallets)
  };
}

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: EXPECTED_DB,
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p70-'));
const LEGACY_DESC = 'Malipo ya marejesho (four-eyes)';

let fixtureClient = null;

function runNode(args, env) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function main() {
  const c = new Client(cfg);
  fixtureClient = c;
  await c.connect();
  const id = (await c.query('SELECT current_database() AS db')).rows[0].db;
  if (id !== EXPECTED_DB) {
    throw new Error(`REFUSING: connected database '${id}' does not match expected '${EXPECTED_DB}'`);
  }
  console.log(`[guard] connected database verified: ${id}`);

  const existing = Number((await c.query(
    "SELECT COUNT(*)::int AS n FROM four_eyes_requests WHERE action_code = 'ADMIN_LARGE_REFUND'"
  )).rows[0].n);
  if (existing !== 0) {
    throw new Error(`REFUSING: disposable database already contains ${existing} ADMIN_LARGE_REFUND requests; use a fresh isolated database`);
  }
  console.log('[guard] no pre-existing ADMIN_LARGE_REFUND requests');

  const legacyEvidence = (await c.query(
    `SELECT
       (SELECT COUNT(*)::int FROM financial_operations
         WHERE reference_id LIKE 'REF-%'
           AND created_at >= NOW() - INTERVAL '5 minutes') AS recent_operations,
       (SELECT COUNT(*)::int FROM journal_entries
         WHERE (reference_id LIKE 'REF-%' OR entry_group_id LIKE 'REF-%')
           AND posted_at >= NOW() - INTERVAL '5 minutes') AS recent_journals,
       (SELECT COUNT(*)::int FROM financial_audit_log
         WHERE reference_id LIKE 'REF-%'
           AND created_at >= NOW() - INTERVAL '5 minutes') AS recent_audits`
  )).rows[0];
  if (Number(legacyEvidence.recent_operations) !== 0 ||
      Number(legacyEvidence.recent_journals) !== 0 ||
      Number(legacyEvidence.recent_audits) !== 0) {
    throw new Error(
      `REFUSING: disposable database contains recent legacy evidence ` +
      `(operations=${legacyEvidence.recent_operations}, journals=${legacyEvidence.recent_journals}, audits=${legacyEvidence.recent_audits}); use a fresh isolated database`
    );
  }
  console.log('[guard] no pre-existing REF-% operations, journal or audit evidence in the fixture window');

  const acct = await c.query("SELECT id, account_code FROM ledger_accounts WHERE account_code IN ('SUSPENSE','CUSTOMER_WALLET')");
  const acctId = Object.fromEntries(acct.rows.map((r) => [r.account_code, Number(r.id)]));
  expect(acctId.SUSPENSE && acctId.CUSTOMER_WALLET, 'system ledger accounts SUSPENSE and CUSTOMER_WALLET exist (seeded)', acctId);
  const other = Number((await c.query("SELECT id FROM ledger_accounts WHERE account_code NOT IN ('SUSPENSE','CUSTOMER_WALLET') ORDER BY id LIMIT 1")).rows[0].id);

  const users = (await c.query(
    "SELECT id FROM users WHERE role <> 'ADMIN' OR role IS NULL ORDER BY id LIMIT 3"
  )).rows.map((r) => Number(r.id));
  const [requester, recipient, decider] = users;
  expect(users.length === 3, 'three distinct non-ADMIN users available as requester, recipient, decider');

  const approvers = (await c.query(
    "SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id LIMIT 8"
  )).rows.map((r) => Number(r.id));
  expect(approvers.length === 8, 'eight distinct ADMIN approvers available for isolated fixtures');
  const approver = approvers[1];

  const base = Date.now();
  // Run-unique amounts: 1e8 + (seconds mod 1e7)*10, plus a case offset 1..7.
  const unit = 100000000 + (Math.floor(base / 1000) % 10000000) * 10;
  const A = { F1: unit + 1, F2: unit + 2, F3: unit + 3, F4: unit + 4, F5: unit + 5, F6: unit + 6, F7: unit + 7, F8: unit + 8, F9: unit + 9, F10: unit + 14, F11: unit + 15, C1: unit + 11, C2: unit + 12, C3: unit + 13, F0: unit + 10 };

  section('Fixtures (one transaction; all-or-nothing)');
  const before = await counts(c);
  const fx = {};
  let seq = 0;
  const ref = (approverId) => {
    const value = `REF-${approverId}-${base + (seq++)}`;
    return value;
  };
  await c.query('BEGIN');
  try {
    async function request({ key, approverId, status = 'APPROVED', amount, withApproval = true }) {
      const r = await c.query(
        `INSERT INTO four_eyes_requests (action_code, requester_id, payload, status, created_at, updated_at)
         VALUES ('ADMIN_LARGE_REFUND', $1, $2, $3, NOW() - INTERVAL '1 minute', NOW()) RETURNING id`,
        [requester, JSON.stringify({ userId: recipient, amount }), status]);
      const rid = Number(r.rows[0].id);
      if (withApproval) {
        await c.query(
          `INSERT INTO four_eyes_approvals (request_id, approver_id, approver_role, decision, note, created_at)
           VALUES ($1, $2, 'ADMIN', 'APPROVE', 'legacy fixture', NOW() - INTERVAL '30 seconds')`, [rid, approverId]);
      }
      fx[key] = rid;
      return rid;
    }
    async function op(reference, amount, status) {
      await c.query(
        `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts, created_at, updated_at)
         VALUES ('CREDIT', $1, NULL, $2, $3, $4, 1, NOW(), NOW())`, [reference, recipient, amount, status]);
    }
    async function journalPair(reference, amount, approverId, accountB = acctId.CUSTOMER_WALLET, referenceId = reference) {
      await c.query(
        `INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id, description, posted_by, posted_at)
         VALUES ($1,$2,'DR',$3,$7,$4,$5,NOW()), ($1,$6,'CR',$3,$7,$4,$5,NOW())`,
        [reference, acctId.SUSPENSE, amount, LEGACY_DESC, `four-eyes:${approverId}`, accountB, referenceId]);
    }
    async function canonicalJournalPair(reference, amount, approverId) {
      await c.query(
        `INSERT INTO journal_entries (entry_group_id, account_id, direction, amount, reference_id, description, posted_by, posted_at)
         VALUES ($1,$2,'DR',$3,$1,$4,$5,NOW()),
                ($1,$6,'CR',$3,$1,$4,$5,NOW())`,
        [reference, acctId.SUSPENSE, amount, LEGACY_DESC,
          `four-eyes:${approverId}`, acctId.CUSTOMER_WALLET]);
    }
    async function auditCredit(reference, amount, approverId) {
      await c.query(
        `INSERT INTO financial_audit_log
           (account_kind, account_id, operation, amount, balance_before, balance_after, reference_id, actor, created_at)
         VALUES ('USER_BALANCE', $1, 'credit', $2, 0, $2, $3, $4, NOW())`,
        [recipient, amount, reference, `four-eyes:${approverId}`]);
    }

    await request({ key: 'F0_status_executed', approverId: approvers[0], status: 'EXECUTED', amount: A.F0 });
    await request({ key: 'F1_executed', approverId: approvers[1], amount: A.F1 });
    { const r = ref(approvers[1]); await op(r, A.F1, 'SUCCESS'); await journalPair(r, A.F1, approvers[1]); await auditCredit(r, A.F1, approvers[1]); }
    await request({ key: 'F2_unexecuted', approverId: approvers[2], amount: A.F2 });
    await request({ key: 'F3_new_operation', approverId: approvers[3], amount: A.F3 });
    { const r = ref(approvers[3]); await op(r, A.F3, 'NEW'); }
    await request({ key: 'F4_two_candidates', approverId: approvers[4], amount: A.F4 });
    { const r1 = ref(approvers[4]); await op(r1, A.F4, 'SUCCESS'); await journalPair(r1, A.F4, approvers[4]); const r2 = ref(approvers[4]); await op(r2, A.F4, 'SUCCESS'); await journalPair(r2, A.F4, approvers[4]); }
    await request({ key: 'F5_unlinked_journal', approverId: approvers[5], amount: A.F5 });
    { const r = ref(approvers[5]); await journalPair(r, A.F5, approvers[5], acctId.CUSTOMER_WALLET, null); }
    await request({ key: 'F6_wrong_accounts', approverId: approvers[6], amount: A.F6 });
    { const r = ref(approvers[6]); await op(r, A.F6, 'SUCCESS'); await journalPair(r, A.F6, approvers[6], other); }
    await request({ key: 'F7_no_approval', approverId: approvers[7], amount: A.F7, withApproval: false });
    await request({ key: 'F8_partial_journal_linkage', approverId: approvers[0], amount: A.F8 });
    { const r = ref(approvers[0]); await op(r, A.F8, 'SUCCESS'); await journalPair(r, A.F8, approvers[0], acctId.CUSTOMER_WALLET, null); }
    await request({ key: 'F9_orphan_wrong_amount_actor', approverId: approvers[7], amount: A.F9 });
    { const r = ref(approvers[7]); await journalPair(r, A.F9 + 123, decider, acctId.CUSTOMER_WALLET, null); }
    await request({ key: 'F10_legacy_approver_mismatch', approverId: approvers[0], amount: A.F10 });
    { const r = ref(approvers[1]); await op(r, A.F10, 'SUCCESS'); await journalPair(r, A.F10, approvers[1]); await auditCredit(r, A.F10, approvers[1]); }
    await request({ key: 'F11_audit_only_orphan', approverId: approvers[2], amount: A.F11 });
    { const r = ref(approvers[2]); await auditCredit(r, A.F11, approvers[2]); }
    const c1 = await request({ key: 'C1_canonical_success', approverId: approvers[1], amount: A.C1 });
    const c1ref = `FOUR_EYES_REFUND:${c1}`;
    await c.query(
      `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts, created_at, updated_at)
       VALUES ('CREDIT', $1, NULL, $2, $3, 'SUCCESS', 1, NOW(), NOW())`,
      [c1ref, recipient, A.C1]);
    await canonicalJournalPair(c1ref, A.C1, approvers[1]);
    await auditCredit(c1ref, A.C1, approvers[1]);

    const c2 = await request({ key: 'C2_canonical_incomplete', approverId: approvers[2], amount: A.C2 });
    const c2ref = `FOUR_EYES_REFUND:${c2}`;
    await c.query(
      `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts, created_at, updated_at)
       VALUES ('CREDIT', $1, NULL, $2, $3, 'SUCCESS', 1, NOW(), NOW())`,
      [c2ref, recipient, A.C2]);

    const c3 = await request({ key: 'C3_canonical_no_approval', approverId: approvers[3], amount: A.C3, withApproval: false });
    const c3ref = `FOUR_EYES_REFUND:${c3}`;
    await c.query(
      `INSERT INTO financial_operations (operation_type, reference_id, transaction_id, user_id, amount, status, attempts, created_at, updated_at)
       VALUES ('CREDIT', $1, NULL, $2, $3, 'SUCCESS', 1, NOW(), NOW())`,
      [c3ref, recipient, A.C3]);
    await canonicalJournalPair(c3ref, A.C3, approvers[3]);
    await auditCredit(c3ref, A.C3, approvers[3]);

    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  }
  const after = await counts(c);
  console.log(`  fixtures committed: ${Object.keys(fx).length} (1 non-APPROVED control; 11 legacy + 3 canonical APPROVED cases)`);

  section('Reconciler run (read-only transaction)');
  const reconPath = path.join(dir, 'reconciliation.json');
  const rr = runNode(['scripts/reconcile-legacy-four-eyes-refunds.js'],
    { RECONCILE_CONFIRM: 'read-only', RECONCILE_OUTPUT: reconPath, DB_NAME: EXPECTED_DB });
  expect(rr.status === 0 && /RECONCILE_OK/.test(rr.out), 'reconciler exits 0 and reports RECONCILE_OK', { status: rr.status, out: rr.out.slice(0, 300) });
  const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));
  const reconSha = crypto.createHash('sha256').update(fs.readFileSync(reconPath)).digest('hex');
  expect(recon.transaction_read_only === 'on', 'reconciler ran in a READ ONLY transaction', recon.transaction_read_only);
  expect(recon.database === EXPECTED_DB, 'reconciler reports the expected disposable database', recon.database);

  const dbApproved = Number((await c.query("SELECT COUNT(*)::int AS n FROM four_eyes_requests WHERE action_code = 'ADMIN_LARGE_REFUND' AND status = 'APPROVED'")).rows[0].n);
  expect(recon.population === dbApproved, `population equals every APPROVED ADMIN_LARGE_REFUND request in the database (${dbApproved})`, { population: recon.population, dbApproved });
  const byReq = Object.fromEntries(recon.requests.map((r) => [r.request_id, r]));
  expect(!byReq[fx.F0_status_executed], 'non-APPROVED control request excluded from the legacy population');
  const fixtureIds = ['F1_executed', 'F2_unexecuted', 'F3_new_operation', 'F4_two_candidates', 'F5_unlinked_journal', 'F6_wrong_accounts', 'F7_no_approval', 'F8_partial_journal_linkage', 'F9_orphan_wrong_amount_actor', 'F10_legacy_approver_mismatch', 'F11_audit_only_orphan', 'C1_canonical_success', 'C2_canonical_incomplete', 'C3_canonical_no_approval'].map((k) => fx[k]);
  expect(fixtureIds.every((x) => byReq[x]), 'every fixture legacy request is in the reconciled population');

  const want = {
    F1_executed: ['EXECUTED', null],
    F2_unexecuted: ['UNEXECUTED', null],
    F3_new_operation: ['INDETERMINATE', /operation status NEW/],
    F4_two_candidates: ['INDETERMINATE', /2 REF- operations fall within the request time window/],
    F5_unlinked_journal: ['INDETERMINATE', /unlinked journal/],
    F6_wrong_accounts: ['INDETERMINATE', /journal evidence differs from expected SUSPENSE DR \/ CUSTOMER_WALLET CR/],
    F7_no_approval: ['INDETERMINATE', /no valid ADMIN APPROVE approval row/],
    F8_partial_journal_linkage: ['INDETERMINATE', /journal evidence differs from expected SUSPENSE DR \/ CUSTOMER_WALLET CR/],
    F9_orphan_wrong_amount_actor: ['INDETERMINATE', /unlinked journal/],
    F10_legacy_approver_mismatch: ['INDETERMINATE', /legacy REF approver .* differs from latest APPROVE approver/],
    F11_audit_only_orphan: ['INDETERMINATE', /unlinked REF- financial_audit_log row/],
    C1_canonical_success: ['EXECUTED', /canonical SUCCESS CREDIT has valid ADMIN approval/],
    C2_canonical_incomplete: ['INDETERMINATE', /canonical journal evidence is incomplete/],
    C3_canonical_no_approval: ['INDETERMINATE', /no valid ADMIN APPROVE approval row/],
  };
  section('Classification');
  for (const [k, [cls, reasonRe]] of Object.entries(want)) {
    const r = byReq[fx[k]];
    expect(r && r.classification === cls, `${k} classified ${cls}`, r && { c: r.classification, reasons: r.reasons });
    if (reasonRe) expect(r && r.reasons.some((x) => reasonRe.test(x)), `${k} reason recorded (${reasonRe})`, r && r.reasons);
  }
  const e1 = byReq[fx.F1_executed];
  const e1Candidate = e1 && e1.candidates.length === 1 ? e1.candidates[0] : null;
  const e1Audit = e1Candidate && e1Candidate.audit;
  const e1AuditRow = e1Audit && e1Audit.rows === 1 ? e1Audit.entries[0] : null;
  expect(
    !!e1Candidate &&
      e1Candidate.operation_type === 'CREDIT' &&
      e1Candidate.status === 'SUCCESS' &&
      e1Candidate.user_id === recipient &&
      Math.abs(e1Candidate.amount - A.F1) < 0.005 &&
      e1Candidate.journal.lines === 2 &&
      e1Candidate.journal.balanced &&
      e1Candidate.journal.line_evidence.length === 2 &&
      e1Candidate.journal.line_evidence.every((line) =>
        line.reference_id === e1Candidate.reference_id &&
        line.entry_group_id === e1Candidate.reference_id
      ) &&
      e1Candidate.journal.transaction_ids.length === 1 &&
      e1Candidate.journal.transaction_ids[0] === null &&
      !!e1AuditRow &&
      e1AuditRow.account_kind === 'USER_BALANCE' &&
      e1AuditRow.account_id === recipient &&
      e1AuditRow.operation === 'credit' &&
      Math.abs(e1AuditRow.amount - A.F1) < 0.005 &&
      Math.abs((e1AuditRow.balance_after - e1AuditRow.balance_before) - A.F1) < 0.005 &&
      e1AuditRow.actor === `four-eyes:${approver}`,
    'EXECUTED evidence: SUCCESS CREDIT, balanced journal and exact financial audit credit',
    e1Candidate
  );

  const f8 = byReq[fx.F8_partial_journal_linkage];
  expect(
    !!f8 &&
      f8.candidates.length === 1 &&
      f8.candidates[0].journal.line_evidence.length === 2 &&
      f8.candidates[0].journal.line_evidence.every((line) =>
        line.entry_group_id === f8.candidates[0].reference_id &&
        line.reference_id === null
      ) &&
      f8.unlinked_journal_refs.length === 0,
    'partial linkage: matching entry_group_id prevents false orphan attribution, while null reference_id remains visible as invalid candidate evidence',
    f8
  );

  const f10 = byReq[fx.F10_legacy_approver_mismatch];
  expect(
    !!f10 &&
      f10.candidates.length === 1 &&
      f10.candidates[0].legacy_approver_id === approvers[1] &&
      f10.candidates[0].journal.line_evidence.length === 2 &&
      f10.candidates[0].journal.line_evidence.every((line) =>
        line.posted_by === `four-eyes:${approvers[1]}`
      ) &&
      f10.candidates[0].audit.rows === 1 &&
      f10.candidates[0].audit.entries[0].actor === `four-eyes:${approvers[1]}` &&
      f10.reasons.some((reason) =>
        reason.includes(`legacy REF approver ${approvers[1]} differs from latest APPROVE approver ${approvers[0]}`)
      ),
    'approver mismatch: internally consistent legacy ledger and audit evidence cannot override the latest APPROVE identity',
    f10
  );

  const f9 = byReq[fx.F9_orphan_wrong_amount_actor];
  expect(
    !!f9 &&
      f9.candidates.length === 0 &&
      f9.unlinked_journal_refs.length === 1 &&
      f9.unlinked_journal_refs[0].reference_id === null &&
      f9.unlinked_journal_refs[0].entry_group_id.startsWith('REF-') &&
      Math.abs(f9.unlinked_journal_refs[0].dr_total - (A.F9 + 123)) < 0.005 &&
      Math.abs(f9.unlinked_journal_refs[0].cr_total - (A.F9 + 123)) < 0.005 &&
      f9.unlinked_journal_refs[0].lines === 2,
    'orphan journal: evidence retained despite amount and actor mismatch',
    f9
  );

  const f11 = byReq[fx.F11_audit_only_orphan];
  const f11Audit = f11 && f11.unlinked_audit_refs && f11.unlinked_audit_refs[0];
  expect(
    !!f11 &&
      f11.candidates.length === 0 &&
      f11.unlinked_journal_refs.length === 0 &&
      f11.unlinked_audit_refs.length === 1 &&
      f11Audit.account_kind === 'USER_BALANCE' &&
      f11Audit.account_id === recipient &&
      f11Audit.operation === 'credit' &&
      Math.abs(f11Audit.amount - A.F11) < 0.005 &&
      f11Audit.balance_before === 0 &&
      Math.abs(f11Audit.balance_after - A.F11) < 0.005 &&
      f11Audit.reference_id.startsWith('REF-') &&
      f11Audit.actor === `four-eyes:${approvers[2]}` &&
      !!f11Audit.created_at,
    'audit-only orphan: exact recipient, amount, balance movement, reference, actor and timestamp retained',
    f11
  );

  section('Read-only evidence (database state unchanged by reconciliation)');
  const after2 = await counts(c);
  expect(JSON.stringify(after) === JSON.stringify(after2), 'database state identical before and after the reconciler run', { after, after2 });
  expect(JSON.stringify(before) !== JSON.stringify(after), 'fixtures were committed (before/after differ)');

  section('Deployment gate');
  const gate = path.join('scripts', 'gate-legacy-refund-dispositions.js');
  const emptyPath = path.join(dir, 'disp_empty.json');
  fs.writeFileSync(emptyPath, JSON.stringify({ reconciliation_sha256: reconSha, dispositions: [] }));
  const g1 = runNode([gate, reconPath, emptyPath], {});
  const missing = (g1.out.match(/missing disposition/g) || []).length;
  expect(g1.status === 1 && /GATE FAIL/.test(g1.out) && missing === recon.population, 'no dispositions -> gate FAIL, every legacy request reported missing', { status: g1.status, missing, population: recon.population });

  const valid = recon.requests.map((r, i) => ({
    request_id: r.request_id,
    classification_reviewed: r.classification,
    disposition: { EXECUTED: 'CLOSE_AS_EXECUTED', UNEXECUTED: 'RECOVER_VIA_NEW_REFERENCE', INDETERMINATE: 'RESOLVED_WITH_EVIDENCE' }[r.classification],
    decided_by: decider,
    decided_at: new Date().toISOString(),
    evidence_ref: `TEST-EVID-${r.request_id}`,
    rationale: `synthetic test disposition ${i}`,
  }));
  const validPath = path.join(dir, 'disp_valid.json');
  fs.writeFileSync(validPath, JSON.stringify({ reconciliation_sha256: reconSha, dispositions: valid }));
  const g2 = runNode([gate, reconPath, validPath], {});
  expect(g2.status === 0 && /GATE PASS/.test(g2.out), 'complete, bound, class-consistent dispositions -> gate PASS', { status: g2.status, out: g2.out.slice(0, 300) });

  function runGateCase(label, reconDoc, dispDoc, expectedPattern) {
    const rp = path.join(dir, `case_${label}_recon.json`);
    const dp = path.join(dir, `case_${label}_disp.json`);
    fs.writeFileSync(rp, JSON.stringify(reconDoc));
    fs.writeFileSync(dp, JSON.stringify(dispDoc));
    const result = runNode([gate, rp, dp], {});
    expect(
      result.status === 1 && expectedPattern.test(result.out),
      `${label} -> gate FAIL`,
      { status: result.status, output: result.out.slice(0, 500) }
    );
  }

  const numericStringId = JSON.parse(JSON.stringify(valid));
  numericStringId[0].request_id = String(numericStringId[0].request_id);
  runGateCase('numeric-string request_id rejected', recon, {
    reconciliation_sha256: reconSha, dispositions: numericStringId
  }, /invalid disposition request_id/);

  const numericStringDecider = JSON.parse(JSON.stringify(valid));
  numericStringDecider[0].decided_by = String(numericStringDecider[0].decided_by);
  runGateCase('numeric-string decided_by rejected', recon, {
    reconciliation_sha256: reconSha, dispositions: numericStringDecider
  }, /decided_by must be a positive safe integer/);

  const duplicateDisposition = [...valid, { ...valid[0] }];
  runGateCase('duplicate disposition rejected', recon, {
    reconciliation_sha256: reconSha, dispositions: duplicateDisposition
  }, /duplicate disposition/);

  const unknownDisposition = [...valid, {
    ...valid[0], request_id: Number.MAX_SAFE_INTEGER
  }];
  runGateCase('unknown request disposition rejected', recon, {
    reconciliation_sha256: reconSha, dispositions: unknownDisposition
  }, /outside the reconciled population/);

  const duplicateRecon = JSON.parse(JSON.stringify(recon));
  duplicateRecon.requests.push({ ...duplicateRecon.requests[0] });
  runGateCase('duplicate reconciliation request rejected', duplicateRecon, {
    reconciliation_sha256: reconSha, dispositions: valid
  }, /duplicate reconciliation request_id/);

  const malformedRecon = JSON.parse(JSON.stringify(recon));
  malformedRecon.requests[0] = null;
  runGateCase('malformed reconciliation entry rejected', malformedRecon, {
    reconciliation_sha256: reconSha, dispositions: valid
  }, /invalid reconciliation request entry/);

  const invalidRequester = JSON.parse(JSON.stringify(recon));
  invalidRequester.requests[0].requester_id = String(invalidRequester.requests[0].requester_id);
  runGateCase('numeric-string requester_id rejected', invalidRequester, {
    reconciliation_sha256: reconSha, dispositions: valid
  }, /requester_id must be a positive safe integer/);

  const wrongClass = JSON.parse(JSON.stringify(valid));
  const wi = wrongClass.findIndex((d) => d.request_id === fx.F1_executed);
  wrongClass[wi].classification_reviewed = 'UNEXECUTED';
  const wcPath = path.join(dir, 'disp_wrongclass.json');
  fs.writeFileSync(wcPath, JSON.stringify({ reconciliation_sha256: reconSha, dispositions: wrongClass }));
  const g3 = runNode([gate, reconPath, wcPath], {});
  expect(g3.status === 1 && /reviewed as/.test(g3.out), 'EXECUTED request reviewed as UNEXECUTED -> gate FAIL', g3.status);

  // Self-decision regression: bind strictly to the F2 fixture.
  const f2Id = Number(fx.F2_unexecuted);
  const f2Request = byReq[f2Id];
  const si = valid.findIndex((d) => Number(d.request_id) === f2Id);

  const f2MappingValid =
    Number.isSafeInteger(f2Id) &&
    f2Id > 0 &&
    !!f2Request &&
    Number(f2Request.request_id) === f2Id &&
    f2Request.classification === 'UNEXECUTED' &&
    si >= 0;

  expect(
    f2MappingValid,
    'F2 fixture maps to its exact UNEXECUTED reconciliation request',
    { fixtureId: fx.F2_unexecuted, request: f2Request || null, dispositionIndex: si }
  );

  if (f2MappingValid) {
    const selfDec = JSON.parse(JSON.stringify(valid));
    const target = selfDec[si];
    target.decided_by = Number(f2Request.requester_id);

    const identityValid =
      Number(target.request_id) === f2Id &&
      Number(target.decided_by) === Number(f2Request.requester_id);

    expect(
      identityValid,
      'self-decision targets F2 and uses its actual requester',
      {
        request_id: target.request_id,
        expected_request_id: f2Id,
        decided_by: target.decided_by,
        requester_id: f2Request.requester_id
      }
    );

    const onlyF2Changed = selfDec.every((d, i) => {
      if (i === si) {
        return Object.keys(valid[i]).every(
          (key) => key === 'decided_by' || d[key] === valid[i][key]
        );
      }
      return JSON.stringify(d) === JSON.stringify(valid[i]);
    });

    expect(onlyF2Changed, 'self-decision mutation changes only F2 decided_by');

    if (identityValid && onlyF2Changed) {
      const sdPath = path.join(dir, 'disp_self.json');
      fs.writeFileSync(
        sdPath,
        JSON.stringify({ reconciliation_sha256: reconSha, dispositions: selfDec })
      );
      const g4 = runNode([gate, reconPath, sdPath], {});
      expect(
        g4.status === 1 && /requester may not decide/.test(g4.out),
        'requester deciding own F2 request -> gate FAIL',
        { status: g4.status, output: g4.out }
      );
    }
  }

  const unboundPath = path.join(dir, 'disp_unbound.json');
  fs.writeFileSync(unboundPath, JSON.stringify({ reconciliation_sha256: '0'.repeat(64), dispositions: valid }));
  const g5 = runNode([gate, reconPath, unboundPath], {});
  expect(g5.status === 1 && /not bound to this reconciliation/.test(g5.out), 'dispositions bound to a different reconciliation -> gate FAIL', g5.status);

  const disallowed = JSON.parse(JSON.stringify(valid));
  const di = disallowed.findIndex((d) => d.request_id === fx.F6_wrong_accounts);
  disallowed[di].disposition = 'CLOSE_AS_EXECUTED';
  const dPath = path.join(dir, 'disp_disallowed.json');
  fs.writeFileSync(dPath, JSON.stringify({ reconciliation_sha256: reconSha, dispositions: disallowed }));
  const g6 = runNode([gate, reconPath, dPath], {});
  expect(g6.status === 1 && /not allowed/.test(g6.out), 'INDETERMINATE closed as EXECUTED -> gate FAIL', g6.status);

  console.log(`\nLEGACY REFUND RECONCILIATION: ${passed} passed, ${failed} failed`);
  console.log(`evidence: reconciliation sha256=${reconSha} database=${recon.database} snapshot_at=${recon.snapshot_at} population=${recon.population} summary=${JSON.stringify(recon.summary)}`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log('  - ' + f)); }
  return failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    if (fixtureClient) await fixtureClient.end().catch(() => {});
    process.exitCode = code;
  })
  .catch(async (e) => {
    console.error('FATAL', e && e.stack ? e.stack : e);
    if (fixtureClient) await fixtureClient.end().catch(() => {});
    process.exitCode = 1;
  });
