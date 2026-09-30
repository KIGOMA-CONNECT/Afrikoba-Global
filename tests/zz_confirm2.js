'use strict';
/** Final read-only confirmation: exact divergence attribution + finish TX224 + inventory. */
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'zz_out_confirm2.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => say('\n===== ' + s + ' =====');
function finish(c) { try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {} process.exit(c || 0); }
process.on('unhandledRejection', (e) => { say('FATAL ' + ((e && e.stack) || e)); finish(9); });
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const show = (t, o) => say('  ' + t + ' = ' + (typeof o === 'object' ? JSON.stringify(o) : o));

(async () => {
  say('READ-ONLY CONFIRMATION 2  (no mutation)');

  H('1. financial_anomalies REAL columns (no assumptions)');
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='financial_anomalies' ORDER BY ordinal_position`
  );
  cols.rows.forEach((r) => say('  ' + r.column_name + ' | ' + r.data_type));
  const textCols = cols.rows.filter((r) => r.data_type === 'character varying' || r.data_type === 'text' || r.data_type === 'character').map((r) => r.column_name);
  show('text-ish columns', textCols);
  for (const c of textCols) {
    const q = await pool.query(`SELECT count(*)::int n FROM financial_anomalies WHERE "${c}" ILIKE '%TX224%' OR "${c}" ILIKE '%3EC32D6D%'`);
    say('  financial_anomalies rows where ' + c + ' mentions TX224 = ' + q.rows[0].n);
  }

  H('2. Divergence attribution: journal posted WITHOUT a balance mutation');
  say('  (auditBalance writes a financial_audit_log row only after the balance UPDATE succeeds)');
  const q = await pool.query(
    `SELECT fo.id op_id, fo.operation_type, fo.reference_id, fo.status, fo.last_error,
            (SELECT count(*)::int FROM journal_entries je WHERE je.reference_id=fo.reference_id) jlines,
            (SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric FROM journal_entries je WHERE je.reference_id=fo.reference_id) jdr,
            (SELECT count(*)::int FROM financial_audit_log fa WHERE fa.reference_id=fo.reference_id) alines
       FROM financial_operations fo
      WHERE EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_id=fo.reference_id)
      ORDER BY fo.id`
  );
  let bad = 0, badSum = 0;
  q.rows.forEach((r) => {
    const flag = r.alines === 0 ? '  <<< LEDGER POSTED, NO BALANCE MOVEMENT' : '';
    if (r.alines === 0) { bad += 1; badSum += Number(r.jdr); }
    say('  op#' + r.op_id + ' ' + r.operation_type + ' ' + r.reference_id + ' status=' + r.status
      + ' journalLines=' + r.jlines + ' journalDR=' + r.jdr + ' auditRows=' + r.alines + flag);
  });
  show('divergent operations (journal without balance movement)', bad);
  show('ledger value posted with no matching balance movement', badSum);

  H('3. Reconciliation, stated as a ledger-vs-projection identity');
  const a = await pool.query(
    `SELECT
      (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) hold_cr,
      (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) hold_dr,
      (SELECT COALESCE(SUM(locked_balance),0)::numeric FROM users WHERE full_name LIKE 'ZZ Live Regression %') proj_locked`
  );
  const x = a.rows[0];
  show('CARD_HOLD net credit (CR-DR) = ledger view of held funds', Number(x.hold_cr) - Number(x.hold_dr));
  show('users.locked_balance             = projection view of held funds', x.proj_locked);
  show('IDENTITY GAP (ledger - projection)', (Number(x.hold_cr) - Number(x.hold_dr)) - Number(x.proj_locked));
  show('expected value for a correct engine', 0);
  const net = Number(x.hold_cr) - Number(x.hold_dr);
  show('ledger implies held funds of', net + ' (negative = ledger believes nothing is held / phantom debits)');
  show('projection says held funds of', x.proj_locked);

  H('4. TX224 final safety verification (all tables, no assumptions)');
  const tables = ['financial_operations', 'journal_entries', 'wallet_ledger', 'financial_audit_log', 'financial_anomalies'];
  for (const t of tables) {
    const tc = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('character varying','text','character')`,
      [t]
    );
    for (const c of tc.rows) {
      const q2 = await pool.query(`SELECT count(*)::int n FROM "${t}" WHERE "${c.column_name}" ILIKE '%TX224%' OR "${c.column_name}" ILIKE '%3EC32D6D%'`);
      if (q2.rows[0].n > 0) say('  !! ' + t + '.' + c.column_name + ' = ' + q2.rows[0].n);
    }
  }
  say('  (no lines above = zero TX224 / WD-3EC32D6D rows in any scanned text column)');
  const srcPath = path.join(__dirname, '..', 'src', 'services', 'financialEngine.js');
  const src = fs.readFileSync(srcPath, 'utf8');
  show('TX224 / WD-3EC32D6D literals in financialEngine.js', (src.match(/TX224|3EC32D6D/g) || []).length);
  show('financialEngine.js size', fs.statSync(srcPath).size + ' bytes');
  show('financialEngine.js mtime', fs.statSync(srcPath).mtime.toISOString());
  const wl = await pool.query(`SELECT count(*)::int c FROM wallet_ledger`);
  show('wallet_ledger total rows (engine never writes it)', wl.rows[0].c);

  H('5. Test-user inventory created by this validation');
  const inv = await pool.query(`SELECT id, phone_number, wallet_balance, locked_balance FROM users WHERE full_name LIKE 'ZZ Live Regression %' ORDER BY id`);
  inv.rows.forEach((u) => say('  user#' + u.id + ' phone=' + u.phone_number + ' wallet=' + u.wallet_balance + ' locked=' + u.locked_balance));
  show('total test users created', inv.rowCount);
  const allRefs = await pool.query(`SELECT DISTINCT reference_id FROM financial_operations ORDER BY reference_id`);
  const lens = allRefs.rows.map((r) => r.reference_id.length);
  show('distinct references used', allRefs.rowCount);
  show('reference length range', Math.min(...lens) + '..' + Math.max(...lens) + ' (limit 15)');
  const others = await pool.query(`SELECT count(*)::int c FROM users WHERE full_name NOT LIKE 'ZZ Live Regression %'`);
  show('pre-existing (non-test) users in regression DB', others.rows[0].c);

  say('\nCONFIRMATION 2 COMPLETE (read-only)');
  finish(0);
})().catch((e) => { say('ERROR ' + ((e && e.stack) || e)); finish(1); });
