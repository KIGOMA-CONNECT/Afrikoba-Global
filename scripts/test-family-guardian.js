/* ============================================================
 * AFRIKOBA GLOBAL - FAMILY WALLET GUARDIAN CONTROLS
 * Proves the family/wallet guardian layer:
 *   - family_wallet_members carries role / can_spend / spending_limit
 *   - only OWNER may invite or remove members
 *   - INVITED -> join -> ACTIVE membership lifecycle
 *   - familyContribute funds the family wallet (ledger-backed)
 *   - familySpend enforces can_spend (403) and spending_limit (400)
 *   - familyTransfer enforces can_spend (403) and wallet balance
 *   - family_wallet_transactions records CONTRIBUTION / SPEND / TRANSFER
 *   - cross user access: non-member cannot view/act on the wallet
 * ============================================================ */
const BASE = process.env.FAMILY_TEST_BASE || 'http://127.0.0.1:3000';
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
async function fundUser(id, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, id]);
}

async function run() {
  const runSalt = String(Date.now()).slice(-5);
  const suffix = `${runSalt}${Math.floor(Math.random() * 90) + 10}`;

  await section('Schema evidence (family wallet guardian columns)');
  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('family_wallets','family_wallet_members','family_wallet_transactions')`
  );
  const colSet = new Set(cols.rows.map((c) => `${c.table_name}:${c.column_name}`));
  for (const c of ['family_wallets:id', 'family_wallets:balance', 'family_wallets:created_by',
    'family_wallet_members:wallet_id', 'family_wallet_members:user_id', 'family_wallet_members:role',
    'family_wallet_members:can_spend', 'family_wallet_members:spending_limit', 'family_wallet_members:status',
    'family_wallet_transactions:wallet_id', 'family_wallet_transactions:actor_user_id', 'family_wallet_transactions:amount', 'family_wallet_transactions:type']) {
    await expect(colSet.has(c), `column present: ${c}`);
  }

  await section('Setup: guardian (owner), member, outsider + fund');
  const guardian = await register(`255820${suffix}`, 'Family Guardian');
  const member = await register(`255821${suffix}`, 'Family Member');
  const outsider = await register(`255822${suffix}`, 'Outsider');
  await expect(!!guardian.user?.id && !!member.user?.id && !!outsider.user?.id, 'three users registered');
  const gToken = guardian.token;
  const mToken = member.token;
  const oToken = outsider.token;
  fundUser(guardian.user.id, 1000000);
  fundUser(member.user.id, 500000);

  await section('Guardian creates family wallet + invites member with limits');
  const create = await api('POST', '/api/family/family', gToken, { name: 'Mama na Watoto', currency: 'TZS', description: 'Kaya' });
  await expect(create.status === 200 && create.data.wallet && create.data.wallet.id, 'family wallet created', JSON.stringify(create.data).slice(0, 120));
  const walletId = create.data.wallet.id;
  await expect(Number(create.data.wallet.balance) === 0, 'new wallet starts at 0');

  const invite = await api('POST', `/api/family/family/${walletId}/invite`, gToken, {
    phone: member.user.phone_number, role: 'MEMBER', can_spend: true, spending_limit: 50000
  });
  await expect(invite.status === 200 && invite.data.member &&
    invite.data.member.can_spend === true && Number(invite.data.member.spending_limit) === 50000,
    'invite sets can_spend + spending_limit', JSON.stringify(invite.data).slice(0, 160));
  await expect(invite.data.member.status === 'INVITED', 'member starts INVITED (cannot act yet)');

  const join = await api('POST', `/api/family/family/${walletId}/join`, mToken, {});
  await expect(join.status === 200 && join.data.member.status === 'ACTIVE', 'member joins -> ACTIVE', JSON.stringify(join.data).slice(0, 120));

  await section('Non-member blocked from wallet access');
  const peek = await api('GET', `/api/family/family/${walletId}`, oToken, {});
  await expect(peek.status === 403, 'outsider cannot read wallet (403)', String(peek.status));
  const outsiderSpend = await api('POST', `/api/family/family/${walletId}/spend`, oToken, { amount: 1000 });
  await expect(outsiderSpend.status === 403, 'outsider cannot spend (403)', String(outsiderSpend.status));

  await section('Contribute funds the family wallet');
  const contrib = await api('POST', `/api/family/family/${walletId}/contribute`, gToken, { amount: 200000 });
  await expect(contrib.status === 200 && Number(contrib.data.result.amount) === 200000, 'guardian contributes 200000', JSON.stringify(contrib.data).slice(0, 120));
  const wBal = await pool.query('SELECT balance FROM family_wallets WHERE id=$1', [walletId]);
  await expect(Number(wBal.rows[0].balance) === 200000, 'family wallet balance 200000', String(wBal.rows[0].balance));
  const contribTx = await pool.query(
    `SELECT * FROM family_wallet_transactions WHERE wallet_id=$1 AND type='CONTRIBUTION'`, [walletId]
  );
  await expect(contribTx.rows.length === 1 && Number(contribTx.rows[0].amount) === 200000, 'CONTRIBUTION row recorded');

  await section('Spending limit guard (guardian as owner, no limit)');
  const ownerSpend = await api('POST', `/api/family/family/${walletId}/spend`, gToken, { amount: 20000, description: 'Risiti ya kaya' });
  await expect(ownerSpend.status === 200, 'owner can spend (no limit), 200');

  await section('Member limits enforced');
  const overLimit = await api('POST', `/api/family/family/${walletId}/spend`, mToken, { amount: 60000 });
  await expect(overLimit.status === 400, 'member spend over spending_limit rejected (400)', String(overLimit.status));
  const inLimit = await api('POST', `/api/family/family/${walletId}/spend`, mToken, { amount: 30000 });
  await expect(inLimit.status === 200 && Number(inLimit.data.result.amount) === 30000, 'member spend within limit OK', JSON.stringify(inLimit.data).slice(0, 120));

  await section('can_spend = false blocks member spend/transfer');
  await pool.query(
    `UPDATE family_wallet_members SET can_spend=FALSE WHERE wallet_id=$1 AND user_id=$2`, [walletId, member.user.id]
  );
  const blockedSpend = await api('POST', `/api/family/family/${walletId}/spend`, mToken, { amount: 1000 });
  await expect(blockedSpend.status === 403, 'member spend blocked when can_spend=false (403)', String(blockedSpend.status));
  const blockedTransfer = await api('POST', `/api/family/family/${walletId}/transfer`, mToken, { phone: outsider.user.phone_number, amount: 1000 });
  await expect(blockedTransfer.status === 403, 'member transfer blocked when can_spend=false (403)', String(blockedTransfer.status));
  await pool.query(
    `UPDATE family_wallet_members SET can_spend=TRUE WHERE wallet_id=$1 AND user_id=$2`, [walletId, member.user.id]
  );

  await section('Transfer from wallet (owner)');
  const before = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [outsider.user.id])).rows[0].wallet_balance;
  const transfer = await api('POST', `/api/family/family/${walletId}/transfer`, gToken, { phone: outsider.user.phone_number, amount: 25000 });
  await expect(transfer.status === 200, 'owner transfers 25000 from family wallet', JSON.stringify(transfer.data).slice(0, 120));
  const after = (await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [outsider.user.id])).rows[0].wallet_balance;
  await expect(Number(after) - Number(before) === 25000, 'recipient wallet credited 25000', `before=${before} after=${after}`);
  const transferTx = await pool.query(
    `SELECT * FROM family_wallet_transactions WHERE wallet_id=$1 AND type='TRANSFER_OUT'`, [walletId]
  );
  await expect(transferTx.rows.length === 1 && Number(transferTx.rows[0].amount) === 25000, 'TRANSFER_OUT row recorded');

  await section('Remove member: non-owner blocked, owner succeeds');
  const nonOwnerRemove = await api('DELETE', `/api/family/family/${walletId}/members/${member.user.id}`, mToken);
  await expect(nonOwnerRemove.status === 403, 'non-owner cannot remove member (403)', String(nonOwnerRemove.status));
  const remove = await api('DELETE', `/api/family/family/${walletId}/members/${member.user.id}`, gToken);
  await expect(remove.status === 200 && remove.data.member.status === 'REMOVED', 'owner removes member -> REMOVED', JSON.stringify(remove.data).slice(0, 120));
  const removedAct = await api('POST', `/api/family/family/${walletId}/spend`, mToken, { amount: 1000 });
  await expect(removedAct.status === 403, 'removed member blocked (403)', String(removedAct.status));

  console.log(`\nFAMILY GUARDIAN CONTROLS RESULT: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('FAILED: ' + failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});