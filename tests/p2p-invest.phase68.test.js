'use strict';
/**
 * Phase 68 — P2P invest money-path matrix.
 *
 * Runs against a disposable Postgres database only (name must match
 * /^phase68_amount_guard_[a-z0-9_]+$/ and PHASE68_TEST_DB must equal DB_NAME).
 * SMS, audit and contract generation are stubbed: no network, no provider call.
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DB_NAME = process.env.DB_NAME || '';
if (!/^phase68_amount_guard_[a-z0-9_]+$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR: DB_NAME and PHASE68_TEST_DB must match an explicit phase68_amount_guard_<unique_suffix> disposable database name.');
  process.exit(2);
}

function stubModule(rel, exportsObj) {
  const p = path.join(ROOT, rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stubModule('src/services/smsService.js', { sendSMS: async () => ({ success: true }) });
stubModule('src/services/auditService.js', { logAudit: async () => {}, logAction: async () => {} });
stubModule('src/services/contractService.js', { generateInvestmentContract: async () => ({ url: 'http://test/contract.pdf' }) });

const pool = require(path.join(ROOT, 'src/config/db'));
const p2p = require(path.join(ROOT, 'src/services/p2pService'));
const fin = require(path.join(ROOT, 'src/services/financialEngine'));

const uniq = (p) => `${p}-P2P-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

async function freshUser() {
  const { rows: cols } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name <> 'id'
      ORDER BY ordinal_position`
  );
  const names = cols.map((c) => c.column_name);
  const { rows: uniqueCols } = await pool.query(
    `SELECT a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE i.indrelid = 'users'::regclass AND i.indisunique AND NOT i.indisprimary
        AND array_length(i.indkey::int2[], 1) = 1`
  );
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const overrides = new Map([
    ['phone_number', `255${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`],
  ]);
  for (const u of uniqueCols) {
    if (/char|text/.test(u.typ)) overrides.set(u.col, String(Math.floor(Math.random() * 9e9) + 1e9));
  }
  overrides.set('email', `p2p-${suffix}@p2p.invalid`);
  const params = [];
  const select = names.map((c) => {
    if (c === 'wallet_balance' || c === 'locked_balance') return '0';
    if (overrides.has(c)) { params.push(overrides.get(c)); return `$${params.length}`; }
    return `"${c}"`;
  });
  const { rows } = await pool.query(
    `INSERT INTO users (${names.map((c) => `"${c}"`).join(', ')})
     SELECT ${select.join(', ')} FROM users WHERE id = (SELECT min(id) FROM users WHERE phone_number IS NOT NULL)
     RETURNING id`,
    params
  );
  return rows[0].id;
}

async function createActiveProject(ownerId, targetAmount, sharePrice) {
  const { rows } = await pool.query(
    `INSERT INTO investment_projects
       (owner_user_id, title, sector, description, target_amount, share_price, roi_percentage,
        tenure_months, payback_start_months, business_plan, team_info, status, raised_amount, min_investment_amount)
     VALUES ($1, $2, 'TECH', 'desc', $3, $4, 10, 12, 3, 'plan', 'team', 'ACTIVE', 0, 0)
     RETURNING id`,
    [ownerId, uniq('PROJ'), targetAmount, sharePrice]
  );
  return rows[0].id;
}

const balance = async (uid) => parseFloat((await pool.query(
  `SELECT wallet_balance FROM users WHERE id = $1`, [uid]
)).rows[0].wallet_balance);

const journalCount = async (ref) => (await pool.query(
  `SELECT count(*)::int AS n FROM journal_entries WHERE reference_id = $1`, [ref]
)).rows[0].n;

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('P1 invest succeeds: wallet debited, journal balanced, raised_amount updated', async () => {
  const owner = await freshUser();
  const investor = await freshUser();
  const projectId = await createActiveProject(owner, 10000, 100);
  await pool.query(`UPDATE users SET wallet_balance = 5000 WHERE id = $1`, [investor]);

  const before = await balance(investor);
  const res = await p2p.invest(investor, projectId, 5, '127.0.0.1');
  assert.ok(res.success, 'invest did not succeed');
  assert.strictEqual(await balance(investor), before - 500, 'wallet not debited');
  assert.strictEqual(await journalCount(res.referenceId), 2, 'journal not balanced (expect 2 lines)');

  const proj = await pool.query(`SELECT raised_amount FROM investment_projects WHERE id = $1`, [projectId]);
  assert.strictEqual(parseFloat(proj.rows[0].raised_amount), 500, 'raised_amount not updated');

  const inv = await pool.query(`SELECT count(*)::int AS n FROM investments WHERE project_id = $1`, [projectId]);
  assert.strictEqual(inv.rows[0].n, 1, 'investment row not created');
});

scenario('P2 invest with insufficient funds is refused with no residue', async () => {
  const owner = await freshUser();
  const investor = await freshUser();
  const projectId = await createActiveProject(owner, 10000, 100);
  await pool.query(`UPDATE users SET wallet_balance = 100 WHERE id = $1`, [investor]);

  const before = await balance(investor);
  const beforeRaised = parseFloat((await pool.query(
    `SELECT raised_amount FROM investment_projects WHERE id = $1`, [projectId]
  )).rows[0].raised_amount);

  await assert.rejects(
    p2p.invest(investor, projectId, 5, '127.0.0.1'),
    /Salio la wallet lako halitoshi/
  );

  assert.strictEqual(await balance(investor), before, 'wallet changed on a refused invest');
  const afterRaised = parseFloat((await pool.query(
    `SELECT raised_amount FROM investment_projects WHERE id = $1`, [projectId]
  )).rows[0].raised_amount);
  assert.strictEqual(afterRaised, beforeRaised, 'raised_amount changed on a refused invest');
  const inv = await pool.query(`SELECT count(*)::int AS n FROM investments WHERE project_id = $1`, [projectId]);
  assert.strictEqual(inv.rows[0].n, 0, 'investment row created on a refused invest');
});

scenario('P3 invest static parity: transaction-scoped and engine-backed', () => {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(ROOT, 'src/services/p2pService.js'), 'utf8').replace(/\r\n/g, '\n');
  const idx = source.indexOf('async function invest');
  assert.ok(idx >= 0, 'invest function not found');
  const body = source.slice(idx);
  const commitIdx = body.indexOf("await client.query('COMMIT')");
  assert.ok(commitIdx > 0, 'invest has no COMMIT');
  const rollbackIdx = body.indexOf("await client.query('ROLLBACK')");
  assert.ok(rollbackIdx > commitIdx || rollbackIdx > 0, 'invest has no ROLLBACK');
  const beginIdx = body.indexOf("await client.query('BEGIN')");
  assert.ok(beginIdx >= 0, 'invest has no BEGIN');
  const debitIdx = body.indexOf('fin.debitWallet');
  assert.ok(debitIdx > beginIdx && debitIdx < commitIdx, 'debitWallet is not inside the transaction');
});

(async () => {
  let failed = 0;
  for (const s of scenarios) {
    try {
      await s.fn();
      console.log(`PASS ${s.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${s.name}\n     ${(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')}`);
    }
  }

  console.log(`RESULT: ${scenarios.length - failed} passed, ${failed} failed of ${scenarios.length}`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})();
