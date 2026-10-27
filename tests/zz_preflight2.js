'use strict';
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'zz_out_preflight2.txt');
const buf = [];
const say = (s) => buf.push(s === undefined ? 'undefined' : String(s));
const H = (s) => { say(''); say('===== ' + s + ' ====='); };

function finish(code) {
  try { fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8'); } catch (e) {}
  process.exit(code || 0);
}
process.on('unhandledRejection', (e) => { say('UNHANDLED: ' + ((e && e.message) || e)); finish(1); });

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));

(async () => {
  H('financial_operations constraints/indexes');
  const con = await pool.query(
    `SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) def
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE rel.relname = 'financial_operations' ORDER BY con.conname`
  );
  con.rows.forEach(r => say('  [' + r.contype + '] ' + r.conname + ' :: ' + r.def));
  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='financial_operations' ORDER BY indexname`
  );
  idx.rows.forEach(r => say('  IDX ' + r.indexname + ' :: ' + r.indexdef));
  const uniq = await pool.query(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='financial_operations' AND indexdef ILIKE '%UNIQUE%'`
  );
  say('  >> UNIQUE index on reference_id exists = ' + uniq.rows.some(r => /reference_id/.test(r.indexdef)));

  H('ledger_accounts schema + codes');
  const la = await pool.query(
    `SELECT column_name, data_type, character_maximum_length len, is_nullable, COALESCE(column_default,'') d
       FROM information_schema.columns WHERE table_schema='public' AND table_name='ledger_accounts'
      ORDER BY ordinal_position`
  );
  la.rows.forEach(r => say('  ' + r.column_name + ' | ' + r.data_type + (r.len ? '('+r.len+')' : '') + ' | ' + r.is_nullable + (r.d ? ' | d='+r.d : '')));
  const codes = await pool.query(
    `SELECT id, account_code, account_type FROM ledger_accounts ORDER BY id`
  );
  say('  rows: ' + codes.rowCount);
  codes.rows.forEach(r => say('    ' + r.id + ' = ' + r.account_code + ' [' + r.account_type + ']'));

  H('financial_audit_log schema');
  const fal = await pool.query(
    `SELECT column_name, data_type, is_nullable, COALESCE(column_default,'') d
       FROM information_schema.columns WHERE table_schema='public' AND table_name='financial_audit_log'
      ORDER BY ordinal_position`
  );
  fal.rows.forEach(r => say('  ' + r.column_name + ' | ' + r.data_type + ' | ' + r.is_nullable + (r.d ? ' | d='+r.d : '')));

  H('journal_entries partitions');
  const parts = await pool.query(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname='journal_entries' ORDER BY c.relname`
  );
  say('  partitions: ' + parts.rows.map(r=>r.relname).join(', '));
  const dr = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='journal_entries' AND column_name='direction'`
  );
  say('  direction column present = ' + (dr.rowCount > 0));

  H('users constraints (for test-user insert)');
  const uc = await pool.query(
    `SELECT con.conname, pg_get_constraintdef(con.oid) def FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname='users' ORDER BY con.conname`
  );
  uc.rows.forEach(r => say('  ' + r.conname + ' :: ' + r.def));
  const utr = await pool.query(
    `SELECT tg.tgname, pg_get_triggerdef(tg.oid) def FROM pg_trigger tg
       JOIN pg_class rel ON rel.oid = tg.tgrelid
      WHERE rel.relname='users' AND NOT tg.tgisinternal ORDER BY tg.tgname`
  );
  say('  user triggers: ' + (utr.rowCount ? '' : '(none)'));
  utr.rows.forEach(r => say('    ' + r.tgname + ' :: ' + r.def));

  H('company_revenue row id=1 (deposit dependency)');
  const cr = await pool.query(`SELECT id FROM company_revenue WHERE id = 1`);
  say('  exists = ' + (cr.rowCount > 0));

  H('TRX/engine require smoke test');
  const t0 = Date.now();
  const engine = require(path.join(__dirname, '..', 'src', 'services', 'financialEngine'));
  say('  require OK in ' + (Date.now()-t0) + 'ms');
  say('  exports: ' + Object.keys(engine).sort().join(', '));

  H('BASELINE COUNTS (before any test)');
  const b1 = await pool.query(`SELECT count(*)::int c FROM financial_operations`);
  const b2 = await pool.query(`SELECT count(*)::int c FROM journal_entries`);
  const b3 = await pool.query(`SELECT count(*)::int c FROM wallet_ledger`);
  const b4 = await pool.query(`SELECT count(*)::int c FROM financial_audit_log`);
  say('  financial_operations = ' + b1.rows[0].c);
  say('  journal_entries     = ' + b2.rows[0].c);
  say('  wallet_ledger       = ' + b3.rows[0].c);
  say('  financial_audit_log = ' + b4.rows[0].c);
  const tx = await pool.query(
    `SELECT count(*)::int c FROM financial_operations
      WHERE reference_id ILIKE '%TX224%' OR reference_id ILIKE '%WD-3EC32D6D%'`);
  say('  TX224/WD-3EC32D6D ops = ' + tx.rows[0].c);
  const jtx = await pool.query(
    `SELECT count(*)::int c FROM journal_entries
      WHERE reference_id ILIKE '%TX224%' OR entry_group_id ILIKE '%WD-3EC32D6D%' OR description ILIKE '%TX224%'`);
  say('  TX224 journal rows  = ' + jtx.rows[0].c);

  say('');
  say('PREFLIGHT2 OK');
  finish(0);
})().catch((e) => { say('PREFLIGHT2 ERROR: ' + ((e && e.message) || e)); finish(1); });
