'use strict';
/** Read-only confirmation: attribute the reconciliation gap to its exact cause. */
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'zz_out_confirm.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => say('\n===== ' + s + ' =====');
function finish(c) { try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {} process.exit(c || 0); }
process.on('unhandledRejection', (e) => { say('FATAL ' + ((e && e.stack) || e)); finish(9); });
const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));
const show = (t, o) => say('  ' + t + ' = ' + (typeof o === 'object' ? JSON.stringify(o) : o));

(async () => {
  say('READ-ONLY CONFIRMATION  (no mutation)');

  H('1. Journal groups whose operation did NOT complete successfully');
  const orphan = await pool.query(
    `SELECT fo.id op_id, fo.operation_type, fo.reference_id, fo.status, fo.last_error,
            COUNT(je.id)::int lines, COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric dr,
            COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric cr
       FROM financial_operations fo
       JOIN journal_entries je ON je.reference_id = fo.reference_id
      WHERE fo.status <> 'SUCCESS'
      GROUP BY fo.id, fo.operation_type, fo.reference_id, fo.status, fo.last_error
      ORDER BY fo.id`
  );
  orphan.rows.forEach((r) => show('op#' + r.op_id + ' ' + r.operation_type + ' ' + r.reference_id + ' status=' + r.status,
    { lines: r.lines, dr: r.dr, cr: r.cr, last_error: r.last_error }));
  show('orphan group count', orphan.rowCount);
  const orphanSum = orphan.rows.reduce((s, r) => s + Number(r.dr), 0);
  show('TOTAL value posted to the ledger for operations that did not succeed', orphanSum);

  H('2. Operations left in transient NEW state');
  const newOps = await pool.query(`SELECT id, operation_type, reference_id, amount, status FROM financial_operations WHERE status='NEW' ORDER BY id`);
  newOps.rows.forEach((r) => say('  op#' + r.id + ' ' + r.operation_type + ' ' + r.reference_id + ' amount=' + r.amount + ' status=' + r.status));
  show('NEW count', newOps.rowCount);

  H('3. CARD_HOLD ledger account vs users.locked_balance projection');
  const acct = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) hold_cr,
       (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric FROM journal_entries WHERE account_id=(SELECT id FROM ledger_accounts WHERE account_code='CARD_HOLD')) hold_dr,
       (SELECT COALESCE(SUM(locked_balance),0)::numeric FROM users WHERE full_name LIKE 'ZZ Live Regression %') proj_locked,
       (SELECT COALESCE(SUM(wallet_balance),0)::numeric FROM users WHERE full_name LIKE 'ZZ Live Regression %') proj_wallet`
  );
  const a = acct.rows[0];
  show('CARD_HOLD credited (CR)', a.hold_cr);
  show('CARD_HOLD debited  (DR)', a.hold_dr);
  show('CARD_HOLD net credit', Number(a.hold_cr) - Number(a.hold_dr));
  show('users.locked_balance projection', a.proj_locked);
  show('users.wallet_balance projection', a.proj_wallet);
  const recon = Number(a.hold_cr) - Number(a.hold_dr) - Number(a.proj_locked);
  show('RECONCILIATION GAP', recon);
  show('GAP equals the orphan ledger total?', recon === -orphanSum ? 'YES (' + recon + ' = -' + orphanSum + ')' : 'NO');

  H('4. Global double-entry integrity (unchanged by the defect)');
  const g = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric dr, COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric cr, count(*)::int n FROM journal_entries`);
  show('TOTAL DR', g.rows[0].dr);
  show('TOTAL CR', g.rows[0].cr);
  show('DIFFERENCE', Number(g.rows[0].dr) - Number(g.rows[0].cr));
  const unbal = await pool.query(
    `SELECT je.entry_group_id, COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric dr,
            COALESCE(SUM(je.amount) FILTER (WHERE je.direction='CR'),0)::numeric cr
       FROM journal_entries je GROUP BY je.entry_group_id HAVING ABS(SUM(je.amount) FILTER (WHERE je.direction='DR') - SUM(je.amount) FILTER (WHERE je.direction='CR')) > 0.000001`
  );
  show('unbalanced entry groups', unbal.rowCount);
  const single = await pool.query(`SELECT entry_group_id, count(*)::int n FROM journal_entries GROUP BY entry_group_id HAVING count(*) < 2`);
  show('single-sided entry groups', single.rowCount);

  H('5. Non-negativity backstop held throughout');
  const neg = await pool.query(`SELECT count(*)::int c FROM users WHERE full_name LIKE 'ZZ Live Regression %' AND (wallet_balance < 0 OR locked_balance < 0)`);
  show('test users with negative wallet/locked', neg.rows[0].c);
  const neg2 = await pool.query(`SELECT count(*)::int c FROM users WHERE wallet_balance < 0 OR locked_balance < 0`);
  show('ALL users in DB with negative wallet/locked', neg2.rows[0].c);

  H('6. TX224 final safety verification');
  const t1 = await pool.query(`SELECT count(*)::int c FROM financial_operations WHERE reference_id ILIKE '%TX224%' OR reference_id ILIKE '%3EC32D6D%' OR reference_id='WD-3EC32D6D'`);
  show('financial_operations rows referencing TX224', t1.rows[0].c);
  const t2 = await pool.query(`SELECT count(*)::int c FROM journal_entries WHERE reference_id ILIKE '%TX224%' OR entry_group_id ILIKE '%TX224%' OR entry_group_id ILIKE '%3EC32D6D%' OR description ILIKE '%TX224%' OR product_ref ILIKE '%TX224%'`);
  show('journal_entries rows referencing TX224', t2.rows[0].c);
  const t3 = await pool.query(`SELECT count(*)::int c FROM wallet_ledger WHERE reference_id ILIKE '%TX224%' OR description ILIKE '%TX224%'`);
  show('wallet_ledger rows referencing TX224', t3.rows[0].c);
  const t4 = await pool.query(`SELECT count(*)::int c FROM financial_audit_log WHERE reference_id ILIKE '%TX224%'`);
  show('financial_audit_log rows referencing TX224', t4.rows[0].c);
  const t5 = await pool.query(`SELECT count(*)::int c FROM financial_anomalies WHERE reference ILIKE '%TX224%' OR reference_id ILIKE '%TX224%'`);
  show('financial_anomalies rows referencing TX224', t5.rows[0].c);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'financialEngine.js'), 'utf8');
  show('TX224 literals in financialEngine.js', (src.match(/TX224|3EC32D6D/g) || []).length);
  show('engine file size (unchanged by testing)', fs.statSync(path.join(__dirname, '..', 'src', 'services', 'financialEngine.js')).size + ' bytes');

  H('7. Test-user inventory created by this validation');
  const inv = await pool.query(`SELECT id, full_name, phone_number, wallet_balance, locked_balance FROM users WHERE full_name LIKE 'ZZ Live Regression %' ORDER BY id`);
  inv.rows.forEach((u) => say('  user#' + u.id + ' phone=' + u.phone_number + ' wallet=' + u.wallet_balance + ' locked=' + u.locked_balance));
  show('total test users created', inv.rowCount);

  say('\nCONFIRMATION COMPLETE (read-only)');
  finish(0);
})().catch((e) => { say('ERROR ' + ((e && e.stack) || e)); finish(1); });
