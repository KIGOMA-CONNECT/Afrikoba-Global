/* ============================================================
 * AFRIKOBA GLOBAL - LEDGER INTEGRITY / RECONCILIATION REGRESSION
 * Encodes the DB invariants the financial core must always hold,
 * regardless of which service posted the movement. This suite
 * turns the one-off full-platform audit into a permanent net:
 *  - journal_entries: every entry_group balances (DR == CR)
 *  - no orphan transaction FKs from wallet_ledger / journal_entries
 *  - no negative customer wallet balances
 *  - debit-flow convention: wallet_amount > 0 (non-ROSCA payouts)
 *    => total_charged == wallet_amount + commission
 *  - credit/merchant conventions stay internally consistent:
 *    MERCH-* (merchant receiving, wallet_amount=0, commission=0),
 *    MPO-*    (MERCHANT_PAYOUT gross in total_charged, fee in commission,
 *              wallet_amount=0 because recipient is not a customer wallet),
 *    ROSCA_PAYOUT (total_charged == credited wallet_amount)
 *  - serials ahead of table max ids (no collision risk)
 * Fresh-DB deterministic; runs in seconds.
 * ============================================================ */
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

async function scalarCount(sql, params) {
  const r = await pool.query(sql, params);
  return Number(r.rows[0].n);
}

async function run() {
  await section('Balanced journal groups (double-entry integrity)');
  const unbalanced = await scalarCount(
    `SELECT COUNT(*) AS n FROM (
       SELECT entry_group_id FROM journal_entries
       GROUP BY entry_group_id
       HAVING ABS(SUM(CASE WHEN direction='DR' THEN amount ELSE -amount END)) > 0.01) x`
  );
  await expect(unbalanced === 0, `zero unbalanced journal groups (got ${unbalanced})`);

  await section('No orphan transaction references');
  const wlOrphans = await scalarCount(
    `SELECT COUNT(*) AS n FROM wallet_ledger w
     LEFT JOIN transactions t ON t.id = w.transaction_id
     WHERE w.transaction_id IS NOT NULL AND t.id IS NULL`
  );
  await expect(wlOrphans === 0, `wallet_ledger orphan FKs 0 (got ${wlOrphans})`);

  const jOrphans = await scalarCount(
    `SELECT COUNT(*) AS n FROM journal_entries j
     LEFT JOIN transactions t ON t.id = j.transaction_id
     WHERE j.transaction_id IS NOT NULL AND t.id IS NULL`
  );
  await expect(jOrphans === 0, `journal_entries orphan FKs 0 (got ${jOrphans})`);

  await section('Customer wallet balances (no overdraw)');
  const negative = await scalarCount(
    `SELECT COUNT(*) AS n FROM users WHERE wallet_balance < 0`
  );
  await expect(negative === 0, `no negative wallet balances (got ${negative})`);

  await section('Debit-flow total_charged convention');
  const debitViolations = await scalarCount(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE status='SUCCESS'
       AND wallet_amount > 0
       AND type <> 'ROSCA_PAYOUT'
       AND total_charged <> COALESCE(wallet_amount,0) + COALESCE(commission,0)`
  );
  await expect(debitViolations === 0,
    `wallet>0 non-ROSCA: total_charged == wallet_amount + commission (got ${debitViolations})`);

  await section('Credit / merchant conventions stay internally consistent');
  const merchViolations = await scalarCount(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE type='TRANSFER' AND reference_id LIKE 'MERCH-%'
       AND (wallet_amount <> 0 OR commission <> 0 OR total_charged <= 0)`
  );
  await expect(merchViolations === 0,
    `MERCH-* rows: wallet=0, commission=0, total_charged>0 (got ${merchViolations})`);

  const mpoViolations = await scalarCount(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE type='MERCHANT_PAYOUT' AND status='SUCCESS'
       AND (wallet_amount <> 0 OR commission < 0 OR total_charged < commission)`
  );
  await expect(mpoViolations === 0,
    `MERCHANT_PAYOUT: wallet=0, commission>=0, total_charged>=commission (got ${mpoViolations})`);

  const roscaViolations = await scalarCount(
    `SELECT COUNT(*) AS n FROM transactions
     WHERE type='ROSCA_PAYOUT' AND status='SUCCESS'
       AND total_charged <> wallet_amount`
  );
  await expect(roscaViolations === 0,
    `ROSCA_PAYOUT: total_charged == credited wallet_amount (got ${roscaViolations})`);

  await section('Serial / sequence health (no id-collision risk)');
  for (const table of ['users', 'transactions', 'wallet_ledger', 'journal_entries', 'audit_logs', 'supported_countries']) {
    const seqRes = await pool.query(`SELECT pg_get_serial_sequence($1, 'id') AS seq`, [`public.${table}`]);
    const seq = seqRes.rows[0].seq;
    if (!seq) { fail(`${table}: no serial on id`); continue; }
    const r = await pool.query(
      `SELECT (SELECT last_value FROM ${seq}) AS last_value,
              (SELECT COALESCE(MAX(id),0) FROM public.${table}) AS max_id`
    );
    const lastValue = Number(r.rows[0].last_value || 0);
    const maxId = Number(r.rows[0].max_id || 0);
    await expect(lastValue >= maxId, `${table} serial ahead of max id (${lastValue} >= ${maxId})`);
  }
}

run()
  .then(() => {
    console.log(`\n===== LEDGER INTEGRITY: ${passed} passed, ${failed} failed =====`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });