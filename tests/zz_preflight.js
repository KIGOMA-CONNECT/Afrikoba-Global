'use strict';
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'zz_out_preflight.txt');
let buf = [];
const say = (s) => { buf.push(s === undefined ? 'undefined' : String(s)); };
const sayObj = (o) => buf.push(JSON.stringify(o, null, 1));

process.on('unhandledRejection', (e) => {
  say('UNHANDLED_REJECTION: ' + ((e && e.message) || e));
  finish(1);
});
process.on('uncaughtException', (e) => {
  say('UNCAUGHT: ' + ((e && e.message) || e));
  finish(1);
});

function finish(code) {
  try {
    fs.writeFileSync(OUT, buf.join('\n') + '\n', 'utf8');
  } catch (e) { /* nothing else we can do */ }
  process.exit(code === undefined ? 0 : code);
}

const kill = setTimeout(() => { say('HARD TIMEOUT after 60s'); finish(2); }, 60000);
kill.unref && kill.unref();

const pool = require(path.join(__dirname, '..', 'src', 'config', 'db'));

(async () => {
  const info = await pool.query(
    `SELECT current_database() db, current_user usr, inet_server_port() port, version() ver`
  );
  const r = info.rows[0];
  say('DB      = ' + r.db);
  say('PORT    = ' + r.port);
  say('DB user = ' + r.usr);
  say('version = ' + String(r.ver).split(' ').slice(0, 2).join(' '));

  for (const t of ['users', 'financial_operations', 'journal_entries', 'wallet_ledger']) {
    const exists = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
      [t]
    );
    if (!exists.rowCount) { say('\n== ' + t + ' == (ABSENT)'); continue; }
    const c = await pool.query(
      `SELECT column_name, data_type, character_maximum_length len,
              is_nullable, COALESCE(column_default,'') dflt
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position`,
      [t]
    );
    say('\n== ' + t + ' ==');
    c.rows.forEach((x) => {
      const len = x.len ? '(' + x.len + ')' : '';
      const nulls = x.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      say('  ' + x.column_name + ' | ' + x.data_type + len + ' | ' + nulls + (x.dflt ? ' | default=' + x.dflt : ''));
    });
    const req = c.rows.filter((x) => x.is_nullable === 'NO' && !x.dflt);
    say('  >> INSERT-REQUIRED (NOT NULL, no default): ' + (req.map((x) => x.column_name).join(', ') || '(none)'));
  }

  const reflen = await pool.query(
    `SELECT column_name, character_maximum_length len, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='financial_operations'
        AND column_name IN ('reference_id','reference')`
  );
  say('\nreference columns = ' + JSON.stringify(reflen.rows));

  const jt = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND (table_name ILIKE '%journal%' OR table_name ILIKE '%ledger%' OR table_name ILIKE '%entry%' OR table_name ILIKE '%financ%')
      ORDER BY table_name`
  );
  say('financial/journal/ledger tables = ' + jt.rows.map((x) => x.table_name).join(', '));

  const tx = await pool.query(
    `SELECT count(*)::int c FROM financial_operations
      WHERE reference_id ILIKE '%TX224%' OR reference_id ILIKE '%WD-3EC32D6D%'`
  );
  say('existing TX224/WD-3EC32D6D ops in regression DB = ' + tx.rows[0].c);

  say('\nPREFLIGHT OK (read-only, no mutation)');
  clearTimeout(kill);
  finish(0);
})().catch((e) => {
  say('PREFLIGHT ERROR: ' + ((e && e.message) || e));
  finish(1);
});
