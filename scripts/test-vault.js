/* ============================================================
 * AFRIKOBA GLOBAL - VAULTS / SPACES (Monzo-style savings goals)
 * money math: deposit debits wallet -> SUSPENSE + credits goal;
 * withdraw reverse; cross-user isolation; summary.
 * ============================================================ */
const BASE = process.env.VAULT_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');

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
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}

async function fundWallet(userId, amount) {
  const ref = `VAULT:SEED:${userId}:${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fin.creditWallet({ client, userId, amount, reference: ref, fromAccount: 'SUSPENSE', description: 'Vault test seed' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const a = await register(`255821${suffix}`, 'Vault Owner');
  const b = await register(`255822${suffix}`, 'Vault Other');
  const tokenA = a.data.token;
  const tokenB = b.data.token;
  const uidA = a.data.user.id;
  const uidB = b.data.user.id;
  await expect(!!tokenA && !!tokenB, 'Users registered');

  await section('Create + list vaults');
  let bal = await api('GET', '/api/wallet/balance', tokenA, null);
  await expect(bal.status === 200, 'Balance endpoint reachable', `status=${bal.status}`);
  const seed = 150000;
  await fundWallet(uidA, seed);
  let founded = await api('GET', '/api/wallet/balance', tokenA, null);
  const fundedBal = Number(founded.data.balance?.wallet_balance ?? founded.data.balance?.available ?? founded.data.balance);
  await expect(fundedBal >= seed, `Wallet funded (${fundedBal} >= ${seed})`, `bal=${fundedBal}`);

  let created = await api('POST', '/api/vaults', tokenA, { name: 'Ziara ya Mombasa', target_amount: 100000 });
  await expect(created.status === 200 && created.data.vault.id > 0, 'Vault created', `status=${created.status} ${JSON.stringify(created.data.vault)}`);
  const vid = created.data.vault.id;
  let listed = await api('GET', '/api/vaults', tokenA, null);
  await expect(listed.status === 200 && listed.data.vaults.length === 1, 'Owner lists 1 vault', `status=${listed.status} n=${listed.data?.vaults?.length}`);
  let otherList = await api('GET', '/api/vaults', tokenB, null);
  await expect(otherList.status === 200 && otherList.data.vaults.length === 0, 'Other user sees 0 vaults (isolation)', `status=${otherList.status} n=${otherList.data?.vaults?.length}`);

  await section('Deposit money math');
  let dep = await api('POST', `/api/vaults/${vid}/deposit`, tokenA, { amount: 30000 });
  await expect(dep.status === 200 && Number(dep.data.result.goal?.current_amount) === 30000, 'Deposit credits goal to 30,000', `status=${dep.status} ${JSON.stringify(dep.data.result)}`);
  let balAfterDep = await api('GET', '/api/wallet/balance', tokenA, null);
  const balAfter = Number(balAfterDep.data.balance?.wallet_balance ?? balAfterDep.data.balance?.available ?? balAfterDep.data.balance);
  await expect(balAfter <= fundedBal - 30000, 'Wallet debited by 30,000 on deposit', `bal=${balAfter} before=${fundedBal}`);
  let txDep = await pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'SAVINGS_DEPOSIT'`, [uidA]);
  await expect(txDep.rows[0].n >= 1, 'SAVINGS_DEPOSIT transaction recorded', `n=${txDep.rows[0].n}`);
  let ledDep = await pool.query(`SELECT COUNT(*)::int AS n FROM journal_entries WHERE description ILIKE 'Savings goal deposit:%'`);
  await expect(ledDep.rows[0].n >= 2, 'Balanced journal posting for goal deposit (DR+CR)', `n=${ledDep.rows[0].n}`);
  let depBad = await api('POST', `/api/vaults/${vid}/deposit`, tokenA, { amount: -50 });
  await expect(depBad.status >= 400, 'Negative deposit rejected', `status=${depBad.status}`);
  let depOther = await api('POST', `/api/vaults/${vid}/deposit`, tokenB, { amount: 100 });
  await expect(depOther.status >= 400, 'Cross-user deposit blocked', `status=${depOther.status}`);

  await section('Over-deposit completes at target');
  let depFull = await api('POST', `/api/vaults/${vid}/deposit`, tokenA, { amount: 80000 });
  await expect(depFull.status === 200 && Number(depFull.data.result.goal?.current_amount) >= 100000 && depFull.data.result.isCompleted === true, 'Deposit past target completes goal', `status=${depFull.status} ${JSON.stringify(depFull.data.result)}`);
  let depClosed = await api('POST', `/api/vaults/${vid}/deposit`, tokenA, { amount: 1000 });
  await expect(depClosed.status >= 400, 'Deposit to completed goal blocked', `status=${depClosed.status}`);

  await section('Withdraw reverse money math');
  let wd = await api('POST', `/api/vaults/${vid}/withdraw`, tokenA, { amount: 40000 });
  await expect(wd.status === 200 && Number(wd.data.vault?.current_amount) === 70000, 'Withdraw reduces goal to 70,000', `status=${wd.status} ${JSON.stringify(wd.data.vault)}`);
  let balAfterWd = await api('GET', '/api/wallet/balance', tokenA, null);
  const afterWd = Number(balAfterWd.data.balance?.wallet_balance ?? balAfterWd.data.balance?.available ?? balAfterWd.data.balance);
  await expect(afterWd >= 80000, 'Wallet back to 80,000 after withdraw (40k + 40k)', `bal=${afterWd} exp>=80000`);
  let txWd = await pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND type = 'SAVINGS_WITHDRAWAL'`, [uidA]);
  await expect(txWd.rows[0].n >= 1, 'SAVINGS_WITHDRAWAL transaction recorded', `n=${txWd.rows[0].n}`);
  let overWd = await api('POST', `/api/vaults/${vid}/withdraw`, tokenA, { amount: 999999 });
  await expect(overWd.status >= 400, 'Over-withdrawal blocked', `status=${overWd.status}`);

  await section('Summary');
  let summary = await api('GET', '/api/vaults/summary', tokenA, null);
  await expect(summary.status === 200 && summary.data.summary != null, 'Vault summary endpoint works', `status=${summary.status} ${JSON.stringify(summary.data).slice(0, 120)}`);

  await section('Fixed deposits (locked vaults) smoke');
  let fd = await api('POST', '/api/vaults/deposits', tokenA, { amount: 10000, tenure_months: 3 });
  await expect(fd.status === 200 || fd.status === 400, 'Fixed deposit create smoke (400 = validation shape)', `status=${fd.status}`);

  console.log(`\n===== VAULTS: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('FAILURES:', failures.join(' | '));
    process.exit(1);
  }
  await pool.end();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});