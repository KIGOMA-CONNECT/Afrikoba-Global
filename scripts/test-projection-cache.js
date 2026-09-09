/* ============================================================
 * AFRIKOBA GLOBAL - PROJECTION-CACHE AUDIT
 * `users.wallet_balance` is a projection cache maintained alongside
 * the authoritative per-user `wallet_ledger` trail. This suite proves
 * the cache never drifts from the trail across a representative spread
 * of money paths that record ledger rows:
 *   - seed (funded with an audited trail row)
 *   - wallet transfer (TR-*)
 *   - payment request settle (PRQ-* -> canonical transfer)
 *   - standing instruction sweep (SI-*)
 *
 * After every operation the exact-balance reconciliation is re-run for
 * every touched user: wallet_balance MUST equal
 *   SUM(ledger.to_user) - SUM(ledger.from_user)
 * A self-test then tampers a balance by 9 TZS and proves the audit
 * DETECTS the drift (and restores it), so any future regression that
 * lets the projection cache drift fails CI permanently.
 *
 * Scope note: card/marketplace authorisations hold funds via
 * `locked_balance` (journal-only, no ledger row) and are covered by
 * their own suites; this audit covers the ledger-writing paths that
 * the projection cache mirrors 1:1.
 * ============================================================ */
const BASE = process.env.PROJECTION_CACHE_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

/**
 * Authoritative per-user trail net: credits - debits from wallet_ledger.
 * NOTE: suites that connect with real integers must use numeric math; the
 * results are compared exactly against the integer cache.
 */
async function ledgerNet(userId) {
  const r = await pool.query(
    `SELECT
       COALESCE((SELECT SUM(amount::numeric) FROM wallet_ledger WHERE to_user_id = $1), 0)
     - COALESCE((SELECT SUM(amount::numeric) FROM wallet_ledger WHERE from_user_id = $1), 0)
     AS net`,
    [userId]
  );
  return Number(r.rows[0].net);
}

async function cachedBalance(userId) {
  const r = await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].b);
}

/** Seed a user with an audited trail row so the cache has a recorded origin. */
async function fundUserTrail(id, amount, phone) {
  const ref = `SEED:${phone}`;
  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, id]);
    await pool.query(
      `INSERT INTO wallet_ledger (reference_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, 'Seed (audited trail - projection baseline)')`,
      [ref, id, amount]
    );
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}

/** Scan-only drift detector: returns mismatches WITHOUT asserting. */
async function driftScan(userIds) {
  const mismatches = [];
  for (const id of userIds) {
    const net = await ledgerNet(id);
    const bal = await cachedBalance(id);
    if (bal !== net) mismatches.push({ id, bal, net });
  }
  return mismatches;
}

/** Reconciliation sweep: cached balance MUST equal the ledger trail net. */
async function reconcile(label, userIds) {
  const mismatches = await driftScan(userIds);
  await expect(mismatches.length === 0, label,
    mismatches.length ? JSON.stringify(mismatches) : undefined);
  return mismatches;
}

async function run() {
  const runSalt = String(Date.now()).slice(-5);
  const suffix = `${runSalt}${Math.floor(Math.random() * 90) + 10}`;
  const ids = [];
  const track = (id) => { ids.push(id); return id; };

  await section('Schema evidence (projection cache vs trail)');
  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name = 'wallet_ledger'`
  );
  const colSet = new Set(cols.rows.map((c) => `${c.table_name}:${c.column_name}`));
  for (const c of ['wallet_ledger:id', 'wallet_ledger:transaction_id', 'wallet_ledger:reference_id',
    'wallet_ledger:from_user_id', 'wallet_ledger:to_user_id', 'wallet_ledger:amount']) {
    await expect(colSet.has(c), `column present: ${c}`);
  }

  await section('Setup: register 4 users, seed with audited trail rows');
  const alice = await register(`255831${suffix}`, `ProjAlice${suffix}`);
  const bob = await register(`255832${suffix}`, `ProjBob${suffix}`);
  const carol = await register(`255833${suffix}`, `ProjCarol${suffix}`);
  const dan = await register(`255834${suffix}`, `ProjDan${suffix}`);
  await fundUserTrail(track(alice.user.id), 50000, alice.user.phone_number);
  await fundUserTrail(track(bob.user.id), 40000, bob.user.phone_number);
  await fundUserTrail(track(carol.user.id), 30000, carol.user.phone_number);
  await fundUserTrail(track(dan.user.id), 20000, dan.user.phone_number);
  await expect(true, 'users registered + seeded with trail');
  await reconcile('baseline projection == trail (all 4)', ids);
  await expect(await cachedBalance(alice.user.id) === 50000, 'alice baseline 50,000');

  await section('Path 1: wallet transfer (TR-*)');
  const tr = await api('POST', '/api/wallet/transfer', alice.token, { toPhoneNumber: bob.user.phone_number, amount: 5000, note: 'Proj transfer' });
  await expect(tr.status === 200 && tr.data.referenceId && String(tr.data.referenceId).startsWith('TR-'), 'transfer 200 + TR-*', String(tr.status));
  await expect(await cachedBalance(alice.user.id) === 45000 && await cachedBalance(bob.user.id) === 45000, 'alice 45k / bob 45k after transfer');
  await reconcile('projection == trail after transfer', ids);

  await section('Path 2: payment request settle (PRQ-* -> canonical transfer)');
  const prq = await api('POST', '/api/banking/payment-requests', carol.token, { payerPhone: bob.user.phone_number, amount: 3000, note: 'Proj PRQ' });
  await expect(prq.status === 200 && prq.data.request && prq.data.request.status === 'PENDING', 'PRQ created PENDING', String(prq.status));
  const pay = await api('POST', `/api/banking/payment-requests/${prq.data.request.id}/pay`, bob.token, { note: 'Sawa' });
  await expect(pay.status === 200 && pay.data.status === 'PAID', 'PRQ paid', String(pay.status));
  await expect(await cachedBalance(bob.user.id) === 42000 && await cachedBalance(carol.user.id) === 33000, 'bob 42k / carol 33k after PRQ settle');
  await reconcile('projection == trail after PRQ settle', ids);

  await section('Path 3: standing instruction sweep (SI-*)');
  const adm = alice; // promote the same account to ADMIN so the sweep route authorises
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [adm.user.id]);
  const rule = await api('POST', '/api/recurrence/rules', adm.token, {
    name: 'projection SI', taskType: 'STANDING_INSTRUCTION', frequency: 'DAILY', intervalStep: 1,
    payload: { fromUserId: alice.user.id, toPhoneNumber: dan.user.phone_number, amount: 2000, note: 'Proj SI' },
  });
  await expect(rule.status === 200 && rule.data.rule && rule.data.rule.id, 'rule created', String(rule.status));
  const ruleId = rule.data.rule.id;
  await pool.query("UPDATE recurrence_rules SET next_run_at = NOW() - interval '1 minute' WHERE id = $1", [ruleId]);
  const sweep = await api('POST', '/api/recurrence/sweep', adm.token);
  await expect(sweep.status === 200, 'sweep 200', String(sweep.status));
  const exec = await pool.query("SELECT status, detail FROM recurrence_executions WHERE rule_id = $1 ORDER BY run_at DESC LIMIT 1", [ruleId]);
  await expect(exec.rows.length === 1 && exec.rows[0].status === 'SUCCESS', 'SI execution SUCCESS', JSON.stringify(exec.rows[0] || {}).slice(0, 120));
  await expect(await cachedBalance(alice.user.id) === 43000 && await cachedBalance(dan.user.id) === 22000, 'alice 43k / dan 22k after SI');
  await reconcile('projection == trail after SI sweep', ids);

  await section('Journal invariance across this suite (no unbalanced groups)');
  const unbalanced = await pool.query(
    `SELECT entry_group_id,
            SUM(CASE WHEN direction = 'DR' THEN amount::numeric ELSE -amount::numeric END) AS bal
     FROM journal_entries
     WHERE description ILIKE '%Proj%' OR reference_id LIKE 'SEED:%'
     GROUP BY entry_group_id
     HAVING ABS(SUM(CASE WHEN direction='DR' THEN amount::numeric ELSE -amount::numeric END)) > 0.000001`
  );
  await expect(unbalanced.rows.length === 0, 'no unbalanced journal groups', JSON.stringify(unbalanced.rows).slice(0, 160));

  await section('Drift detection self-test (audit catches tampering)');
  const driftId = alice.user.id;
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + 9 WHERE id = $1', [driftId]);
  const tampered = await driftScan([driftId]);
  await expect(tampered.length === 1 && tampered[0].id === driftId && (tampered[0].bal - tampered[0].net) === 9,
    'detector FLAGS a +9 TZS cache tamper', JSON.stringify(tampered));
  await pool.query('UPDATE users SET wallet_balance = wallet_balance - 9 WHERE id = $1', [driftId]);
  await expect((await driftScan([driftId])).length === 0, 'tamper restored clean');
  await reconcile('projection restored == trail', ids);
}

run()
  .then(() => {
    console.log(`\nPROJECTION CACHE: ${passed} passed, ${failed} failed`);
    if (failures.length) {
      console.log('FAILED:', failures.join(' | '));
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('\nFATAL:', e && e.message ? e.message : e);
    process.exit(1);
  });