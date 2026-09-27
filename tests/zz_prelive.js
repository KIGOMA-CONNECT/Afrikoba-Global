'use strict';
/** Pre-live gate: identity of the file under test + TX224 untouched + contract inventory. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const OUT = path.join(__dirname, 'zz_out_prelive.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => say('\n===== ' + s + ' =====');
function finish(c) { try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {} process.exit(c || 0); }
process.on('unhandledRejection', (e) => { say('FATAL ' + ((e && e.stack) || e)); finish(9); });

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));

(async () => {
  H('4. WHICH FILE IS ACTUALLY UNDER TEST');
  const resolved = require.resolve(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));
  say('  require.resolve -> ' + resolved);
  const engine = require(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));
  const expected = path.resolve(path.join(__dirname, '..', 'src', 'services', 'financialEngine.js'));
  say('  expected path     -> ' + expected);
  say('  resolved === expected : ' + (resolved === expected));
  const src = fs.readFileSync(resolved, 'utf8');
  const st = fs.statSync(resolved);
  say('  size   = ' + st.size + ' bytes');
  say('  mtime  = ' + st.mtime.toISOString());
  say('  sha256 = ' + crypto.createHash('sha256').update(src).digest('hex'));
  say('  exports = ' + Object.keys(engine).sort().join(', '));
  say('  no duplicate/competing engine file: ' + (fs.readdirSync(path.join(__dirname, '..', 'src', 'services')).filter(f => /financialEngine/i.test(f)).join(', ')));

  H('POST-FIX CONTRACT INVENTORY (static, from the file above)');
  const fns = ['postDeposit', 'holdFunds', 'releaseHold', 'captureHold', 'transfer', 'creditWallet', 'debitWallet', 'internalTransfer', 'walletToGroup', 'groupToWallet', 'lockWallet', 'unlockWallet', 'captureLock'];
  for (const f of fns) {
    const start = src.indexOf('async function ' + f + '(');
    if (start < 0) { say('  ' + f.padEnd(16) + ' NOT FOUND'); continue; }
    const end = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, end < 0 ? src.length : end);
    const g = (body.match(/wallet_balance >= \$1/g) || []).length + (body.match(/locked_balance >= \$1/g) || []).length;
    const rc = (body.match(/rowCount !== 1/g) || []).length;
    const su = (body.match(/status: 'SUCCESS'/g) || []).length;
    const fa = (body.match(/status: 'FAILED'/g) || []).length;
    const jIdx = body.indexOf('postJournal({');
    const uIdx = Math.max(...[body.search(/UPDATE users SET wallet_balance = wallet_balance \+ \$1/), body.search(/UPDATE users SET wallet_balance = wallet_balance - \$1/), body.search(/UPDATE users SET locked_balance = locked_balance - \$1/)].filter((x) => x >= 0));
    const order = (jIdx >= 0 && uIdx >= 0) ? (uIdx < jIdx ? 'UPDATE-then-JOURNAL' : 'JOURNAL-then-UPDATE  <<< DEFECT') : 'n/a';
    say('  ' + f.padEnd(16) + ' guards=' + g + ' rowCountChecks=' + rc + ' SUCCESS=' + su + ' FAILED=' + fa + '  ' + order);
  }
  say('  "JOURNAL-then-UPDATE" lines above = functions still violating FIX B');
  say('  functions with SUCCESS=0            = still able to end in NEW');

  H('3. TX224 / WD-3EC32D6D UNTOUCHED (live DB, read-only)');
  for (const t of ['financial_operations', 'journal_entries', 'wallet_ledger', 'financial_audit_log', 'financial_anomalies']) {
    const tc = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND data_type IN ('character varying','text','character')`, [t]);
    for (const c of tc.rows) {
      const q = await pool.query(`SELECT count(*)::int n FROM "${t}" WHERE "${c.column_name}" ILIKE '%TX224%' OR "${c.column_name}" ILIKE '%3EC32D6D%'`);
      say('  ' + t + '.' + c.column_name + ' TX224 matches = ' + q.rows[0].n);
    }
  }
  say('  literals TX224|WD-3EC32D6D in engine source = ' + (src.match(/TX224|3EC32D6D/g) || []).length);

  H('BASELINE STATE CARRIED OVER FROM THE PRE-FIX RUN (must NOT be altered)');
  const b = await pool.query(
    `SELECT (SELECT count(*)::int FROM financial_operations) ops,
            (SELECT count(*)::int FROM journal_entries) je,
            (SELECT count(*)::int FROM financial_audit_log) audit,
            (SELECT count(*)::int FROM users) users,
            (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='DR'),0)::numeric FROM journal_entries) dr,
            (SELECT COALESCE(SUM(amount) FILTER (WHERE direction='CR'),0)::numeric FROM journal_entries) cr`
  );
  say('  ' + JSON.stringify(b.rows[0]));
  const legacy = await pool.query(
    `SELECT COALESCE(SUM(je.amount) FILTER (WHERE je.direction='DR'),0)::numeric v, count(DISTINCT fo.reference_id)::int refs
       FROM journal_entries je JOIN financial_operations fo ON fo.reference_id=je.reference_id
      WHERE fo.status <> 'SUCCESS'`
  );
  say('  pre-existing residue (journal for ops that never succeeded) = ' + legacy.rows[0].v + ' across ' + legacy.rows[0].refs + ' refs');
  say('  >> This is the DEFECT BASELINE from the previous run. It is disclosed, NOT deleted and NOT netted into the new reconciliation verdict.');

  H('CONTAINER / TARGET');
  const id = await pool.query(`SELECT current_database() db, current_user usr`);
  say('  ' + JSON.stringify(id.rows[0]) + ' via host port 5436');

  say('\nPRE-LIVE GATE COMPLETE');
  finish(0);
})().catch((e) => { say('ERROR ' + ((e && e.stack) || e)); finish(1); });
