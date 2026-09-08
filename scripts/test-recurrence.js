/* ============================================================
 * AFRIKOBA GLOBAL - STANDING INSTRUCTIONS (recurring transfers)
 * recurrenceService STANDING_INSTRUCTION dispatcher: a recurrence
 * rule with payload { fromUserId, toPhoneNumber, amount, note? }
 * is executed at each due run through the full money path:
 *   - SI-<ref> idempotent transfer (financial_operations claim)
 *   - balanced journal (DR/CR CUSTOMER_WALLET) via postJournal
 *   - transactions row (TRANSFER, meta via=STANDING_INSTRUCTION)
 *   - wallet_ledger row
 *   - audit trail (TRANSFER CREATE via STANDING_INSTRUCTION)
 *   - execution recorded in recurrence_executions
 * This proves: transfer contract, idempotent re-run dedup,
 * insufficient-balance failure handling, RBAC on rule endpoints,
 * and disabled rules skipped.
 * ============================================================ */
const BASE = process.env.RECURRENCE_TEST_BASE || 'http://127.0.0.1:3000';
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
async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}
async function fundUser(id, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, id]);
}

async function run() {
  const runSalt = String(Date.now()).slice(-5);
  const suffix = `${runSalt}${Math.floor(Math.random() * 90) + 10}`;

  await section('Schema evidence (migration 067)');
  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('recurrence_rules','recurrence_executions')`
  );
  const colSet = new Set(cols.rows.map((c) => `${c.table_name}:${c.column_name}`));
  for (const c of ['recurrence_rules:id', 'recurrence_rules:task_type', 'recurrence_rules:frequency',
    'recurrence_rules:payload', 'recurrence_rules:next_run_at', 'recurrence_rules:enabled',
    'recurrence_executions:rule_id', 'recurrence_executions:status', 'recurrence_executions:detail']) {
    await expect(colSet.has(c), `column present: ${c}`);
  }

  await section('Setup: register admin + sender + recipient, fund sender');
  const adm = await register(`255810${suffix}`, 'Recurrence Admin');
  const sender = await register(`255811${suffix}`, 'SI Sender');
  const recipient = await register(`255812${suffix}`, 'SI Recipient');
  const admId = await makeAdmin(adm);
  await expect(!!admId, 'admin promoted');
  await expect(!!sender.user?.id && !!recipient.user?.id, 'users registered');
  await fundUser(sender.user.id, 500000);
  const senderBalance0 = Number((await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [sender.user.id])).rows[0].wallet_balance);
  await expect(senderBalance0 >= 500000, `sender funded (balance ${senderBalance0})`);

  await section('RBAC: non-admin cannot create/list rules');
  const forUser = await api('POST', '/api/recurrence/rules', sender.token, {
    name: 'forbidden', taskType: 'STANDING_INSTRUCTION', frequency: 'WEEKLY',
    payload: { fromUserId: sender.user.id, toPhoneNumber: recipient.user.phone_number, amount: 1000 },
  });
  await expect(forUser.status === 403, `non-admin create rule -> 403 (got ${forUser.status})`);
  const forList = await api('GET', '/api/recurrence/rules', sender.token);
  await expect(forList.status === 403, `non-admin list rules -> 403 (got ${forList.status})`);
  const anonCreate = await api('POST', '/api/recurrence/rules', null, { name: 'x', taskType: 'STANDING_INSTRUCTION', frequency: 'WEEKLY' });
  const anonSweep = await api('POST', '/api/recurrence/sweep', null);
  await expect(anonCreate.status === 401 && anonSweep.status === 401, `unauthenticated rule/sweep -> 401`);

  await section('Create STANDING_INSTRUCTION rule + force due');
  const created = await api('POST', '/api/recurrence/rules', adm.token, {
    name: 'SI Test - monthly stipend',
    taskType: 'STANDING_INSTRUCTION',
    frequency: 'MONTHLY',
    intervalStep: 1,
    payload: { fromUserId: sender.user.id, toPhoneNumber: recipient.user.phone_number, amount: 25000, note: 'Pesa za usafiri' },
  });
  await expect(created.status === 200, `create rule 200 (got ${created.status})`);
  const ruleId = created.data.rule?.id;
  await expect(!!ruleId, `rule id present (got ${ruleId})`);
  await expect(created.data.rule?.task_type === 'STANDING_INSTRUCTION', 'rule task_type STANDING_INSTRUCTION');
  await pool.query('UPDATE recurrence_rules SET next_run_at = NOW() - interval \'1 minute\' WHERE id = $1', [ruleId]);

  await section('Sweep executes the transfer');
  const sweep1 = await api('POST', '/api/recurrence/sweep', adm.token);
  await expect(sweep1.status === 200, `sweep endpoint 200 (got ${sweep1.status})`);

  const exec = await pool.query(
    `SELECT status, detail FROM recurrence_executions WHERE rule_id = $1 ORDER BY id DESC LIMIT 1`, [ruleId]
  );
  await expect(exec.rows.length === 1, 'execution recorded');
  await expect(exec.rows[0]?.status === 'SUCCESS', `execution SUCCESS (got ${exec.rows[0]?.status})`);
  const det = exec.rows[0]?.detail || {};
  const result = det.result || {};
  await expect(result.transferred === 25000, `detail shows transferred 25000 (got ${result.transferred})`);
  await expect(/^SI-/.test(result.reference || ''), `detail reference SI-* (got ${result.reference})`);

  const txn = await pool.query(
    `SELECT reference_id, user_id, wallet_amount, total_charged, status, type, meta
       FROM transactions WHERE reference_id = $1`, [result.reference]
  );
  await expect(txn.rows.length === 1, 'transactions row created');
  await expect(txn.rows[0]?.type === 'TRANSFER' && txn.rows[0]?.status === 'SUCCESS', 'txn type TRANSFER/SUCCESS');
  await expect(Number(txn.rows[0]?.wallet_amount) === 25000, `wallet_amount 25000 (got ${txn.rows[0]?.wallet_amount})`);
  await expect(txn.rows[0]?.user_id === sender.user.id, `txn owner is sender (got ${txn.rows[0]?.user_id})`);
  const txnMeta = txn.rows[0]?.meta || {};
  await expect(txnMeta.to_user_id === recipient.user.id && txnMeta.via === 'STANDING_INSTRUCTION',
    `meta records recipient + via (got ${JSON.stringify(txnMeta).slice(0, 80)})`);

  const wl = await pool.query(
    `SELECT * FROM wallet_ledger WHERE reference_id = $1`, [result.reference]
  );
  await expect(wl.rows.length === 1 && wl.rows[0].from_user_id === sender.user.id && wl.rows[0].to_user_id === recipient.user.id,
    'wallet_ledger row links sender -> recipient');

  const journal = await pool.query(
    `SELECT direction, amount FROM journal_entries WHERE reference_id = $1`, [result.reference]
  );
  await expect(journal.rows.length === 2, `balanced journal pair (${journal.rows.length} lines)`);
  const dr = journal.rows.filter((r) => r.direction === 'DR').reduce((s, r) => s + Number(r.amount), 0);
  const cr = journal.rows.filter((r) => r.direction === 'CR').reduce((s, r) => s + Number(r.amount), 0);
  await expect(dr === cr && dr === 25000, `journal DR=${dr} CR=${cr} balanced`);

  const sBal = await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [sender.user.id]);
  const rBal = await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [recipient.user.id]);
  const senderAfter = Number(sBal.rows[0].wallet_balance);
  const recipientAfter = Number(rBal.rows[0].wallet_balance);
  await expect(senderAfter === senderBalance0 - 25000, `sender debited (${senderBalance0} -> ${senderAfter})`);
  await expect(recipientAfter === 25000, `recipient credited (0 -> ${recipientAfter})`);

  const audit = await pool.query(
    `SELECT action, meta FROM audit_logs WHERE entity_type='TRANSACTION' ORDER BY id DESC LIMIT 5`
  );
  await expect(audit.rows.some((r) => r.action === 'TRANSFER' && JSON.stringify(r.meta || '').includes('STANDING_INSTRUCTION')),
    'audit trail records TRANSFER via STANDING_INSTRUCTION');

  await section('Re-sweep is idempotent (rule no longer due)');
  const beforeCount = Number((await pool.query('SELECT COUNT(*) AS c FROM transactions WHERE reference_id LIKE \'SI-%\'')).rows[0].c);
  const nextRun = await pool.query('SELECT next_run_at FROM recurrence_rules WHERE id = $1', [ruleId]);
  const sweep2 = await api('POST', '/api/recurrence/sweep', adm.token);
  await expect(sweep2.status === 200, `re-sweep 200 (got ${sweep2.status})`);
  const afterCount = Number((await pool.query('SELECT COUNT(*) AS c FROM transactions WHERE reference_id LIKE \'SI-%\'' )).rows[0].c);
  await expect(afterCount === beforeCount, `no duplicate transfer (SI txns ${beforeCount} -> ${afterCount})`);
  await expect(new Date(nextRun.rows[0].next_run_at) > new Date(), 'rule next_run_at advanced into the future');

  await section('Insufficient balance -> FAILED execution, no money moved');
  const poor = await register(`255813${suffix}`, 'SI Poor Sender');
  const poorTo = await register(`255814${suffix}`, 'SI Poor Recipient');
  const poorRule = await api('POST', '/api/recurrence/rules', adm.token, {
    name: 'SI insufficient', taskType: 'STANDING_INSTRUCTION', frequency: 'WEEKLY',
    payload: { fromUserId: poor.user.id, toPhoneNumber: poorTo.user.phone_number, amount: 100000 },
  });
  const poorRuleId = poorRule.data.rule?.id;
  await expect(!!poorRuleId, 'insufficient rule created');
  await pool.query('UPDATE recurrence_rules SET next_run_at = NOW() - interval \'1 minute\' WHERE id = $1', [poorRuleId]);
  await api('POST', '/api/recurrence/sweep', adm.token);
  const poorExec = await pool.query(
    `SELECT status, detail FROM recurrence_executions WHERE rule_id = $1 ORDER BY id DESC LIMIT 1`, [poorRuleId]
  );
  await expect(poorExec.rows[0]?.status === 'FAILED', `insufficient-balance execution FAILED (got ${poorExec.rows[0]?.status})`);
  await expect(JSON.stringify(poorExec.rows[0]?.detail).includes('Salio'), 'detail mentions insufficient balance');
  const poorToBal = Number((await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [poorTo.user.id])).rows[0].wallet_balance);
  await expect(poorToBal === 0, `recipient of failed run unchanged (${poorToBal})`);

  await section('Disabled rules are skipped');
  const disRule = await api('POST', '/api/recurrence/rules', adm.token, {
    name: 'SI disabled', taskType: 'STANDING_INSTRUCTION', frequency: 'DAILY', intervalStep: 1,
    payload: { fromUserId: sender.user.id, toPhoneNumber: recipient.user.phone_number, amount: 5000 },
  });
  const disRuleId = disRule.data.rule?.id;
  await expect(!!disRuleId, 'disabled rule created');
  await pool.query(`UPDATE recurrence_rules SET enabled = FALSE, next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [disRuleId]);
  const siBefore = Number((await pool.query('SELECT COUNT(*) AS c FROM transactions WHERE reference_id LIKE \'SI-%\'')).rows[0].c);
  await api('POST', '/api/recurrence/sweep', adm.token);
  const siAfter = Number((await pool.query('SELECT COUNT(*) AS c FROM transactions WHERE reference_id LIKE \'SI-%\'')).rows[0].c);
  await expect(siAfter === siBefore, `disabled rule not executed (SI txns ${siBefore} -> ${siAfter})`);
}

run()
  .then(() => {
    console.log(`\nSTANDING INSTRUCTIONS: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });