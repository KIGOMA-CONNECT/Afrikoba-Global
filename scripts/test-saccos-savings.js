/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - SAVINGS
 * Increment 3 regression: member savings ledgered on the shared
 * double-entry core (deposit DR CUSTOMER_WALLET / CR per-entity
 * SACCOS<id>_SAVINGS_LIABILITY; withdrawal release DR liability /
 * CR wallet via engine creditWallet), config-driven savings
 * {minDeposit,maxDeposit,minBalanceToRetain,autoApproveWithdrawals},
 * PENDING withdrawal reservations (funds reserved, no money moved
 * until approval; rejections are free), OWNER/BOARD decisions,
 * summary and cross-entity isolation. Suite 47.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++; failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label); else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method, headers,
    body: !isGet && body !== undefined ? JSON.stringify(body) : undefined,
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
async function makeAdmin(reg, depth = 0) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (depth < 1) {
    const backup = await register('255679' + nowSuffix(), 'Savings Admin Backup');
    return makeAdmin(backup, depth + 1);
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }
async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'DEPOSIT', $4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'test-funding' })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [tx.rows[0].id, ref, userId, amount, 'Test funding']
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function wallet(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (103_saccos_savings)');
  const accCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_savings_accounts'`);
  const accOk = ['member_id', 'account_no', 'account_type', 'balance'].every((c) => accCols.rows.some((r) => r.column_name === c));
  await expect(accOk, 'saccos_savings_accounts columns present');

  const wdCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_savings_withdrawals'`);
  const wdOk = ['account_id', 'reference_id', 'amount', 'status', 'requires_approval'].every((c) => wdCols.rows.some((r) => r.column_name === c));
  await expect(wdOk, 'saccos_savings_withdrawals columns present');

  const mvCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_savings_movements'`);
  await expect(mvCols.rows.length >= 8, 'saccos_savings_movements columns present');

  // ---------- 2. Setup ----------
  await section('Setup: auto-approve org + member');
  const ownerReg = await register(phone(3001), 'Akiba Haya');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, {
    name: 'Asasi Akiba ' + suffix,
    config: { shareStructure: { autoApprove: true }, savings: { savingsType: 'VOLUNTARY', minDeposit: 1000, minBalanceToRetain: 500, autoApproveWithdrawals: true } },
  });
  await expect(create.status === 201, 'owner creates SACCOS with savings config');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const mReg = await register(phone(3002), 'M Akiba');
  const mTok = mReg.data.token;
  const mInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(3002) });
  await api('POST', `/api/saccos/${orgId}/members/${mInv.data.result.id}/accept`, mTok);
  await fundWallet(mReg.data.user.id, 1000000);

  // ---------- 3. Deposits ----------
  await section('Deposits + canonical ledger');
  const before = await wallet(mReg.data.user.id);
  const dep = await api('POST', `/api/saccos/${orgId}/savings/deposit`, mTok, { amount: 5000 });
  await expect(dep.status === 201 && dep.data.success && String(dep.data.result.reference).startsWith('SAV-') && dep.data.result.balance === 5000,
    'member deposits 5000 -> SAV-* balance 5000', `${dep.status}/${dep.data.code || ''}`);
  const savRef = dep.data.result.reference;
  await expect((await wallet(mReg.data.user.id)) === before - 5000, 'wallet debited 5000');

  const journal = await pool.query(
    `SELECT j.direction, j.amount, l.account_code FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1 ORDER BY j.direction`, [savRef]);
  const drC = journal.rows.find((r) => r.direction === 'DR' && r.account_code === 'CUSTOMER_WALLET');
  const crL = journal.rows.find((r) => r.direction === 'CR' && r.account_code === `SACCOS${orgId}_SAVINGS_LIABILITY`);
  await expect(drC && crL && Number(drC.amount) === 5000 && Number(crL.amount) === 5000,
    'balanced journal DR CUSTOMER_WALLET / CR SACCOS<id>_SAVINGS_LIABILITY (5k)', JSON.stringify(journal.rows.map((r) => `${r.account_code}:${r.direction}:${r.amount}`)));

  const txn = await pool.query(`SELECT type, status FROM transactions WHERE reference_id = $1`, [savRef]);
  await expect(txn.rows.length === 1 && txn.rows[0].type === 'SACCOS_SAVINGS_DEPOSIT', 'transactions SACCOS_SAVINGS_DEPOSIT row');

  const belowMin = await api('POST', `/api/saccos/${orgId}/savings/deposit`, mTok, { amount: 500 });
  await expect(belowMin.status === 400 && belowMin.data.code === 'SACCOS_SAVINGS_BELOW_MIN_DEPOSIT', 'deposit 500 (min 1000) -> SACCOS_SAVINGS_BELOW_MIN_DEPOSIT');
  const badAmt = await api('POST', `/api/saccos/${orgId}/savings/deposit`, mTok, { amount: -50 });
  await expect(badAmt.status === 400 && badAmt.data.code === 'SACCOS_SAVINGS_AMOUNT_INVALID', 'deposit -50 -> SACCOS_SAVINGS_AMOUNT_INVALID');

  const mine = await api('GET', `/api/saccos/${orgId}/savings/mine`, mTok);
  await expect(mine.status === 200 && mine.data.result.account && mine.data.result.account.balance === 5000
    && mine.data.result.account.account_type === 'VOLUNTARY' && mine.data.result.movements[0].type === 'DEPOSIT',
    'mine shows account SAV-* + balance + deposit movement', JSON.stringify(mine.data.result.account).slice(0, 120));

  // ---------- 4. Auto-approved withdrawals ----------
  await section('Auto-approved withdrawals');
  const wd1 = await api('POST', `/api/saccos/${orgId}/savings/withdraw`, mTok, { amount: 2000 });
  await expect(wd1.status === 201 && wd1.data.result.status === 'APPROVED' && wd1.data.result.newBalance === 3000,
    'auto withdrawal 2000 -> APPROVED balance 3000', `${wd1.status}`);
  await expect((await wallet(mReg.data.user.id)) === before - 5000 + 2000, 'wallet credited +2000');

  const wdJournal = await pool.query(
    `SELECT j.direction, j.amount, l.account_code FROM journal_entries j JOIN ledger_accounts l ON l.id = j.account_id
     WHERE j.reference_id = $1 ORDER BY j.direction`, [wd1.data.result.reference]);
  const drL = wdJournal.rows.find((r) => r.direction === 'DR' && r.account_code === `SACCOS${orgId}_SAVINGS_LIABILITY`);
  const crW = wdJournal.rows.find((r) => r.direction === 'CR' && r.account_code === 'CUSTOMER_WALLET');
  await expect(drL && crW && Number(drL.amount) === 2000 && Number(crW.amount) === 2000,
    'withdrawal journal DR SAVINGS_LIABILITY / CR wallet (2k)');

  const tooMuch = await api('POST', `/api/saccos/${orgId}/savings/withdraw`, mTok, { amount: 4000 });
  await expect(tooMuch.status === 400 && tooMuch.data.code === 'SACCOS_SAVINGS_INSUFFICIENT', 'withdraw 4000 (usable 2500) -> SACCOS_SAVINGS_INSUFFICIENT');
  const overRetain = await api('POST', `/api/saccos/${orgId}/savings/withdraw`, mTok, { amount: 2600 });
  await expect(overRetain.status === 400 && overRetain.data.code === 'SACCOS_SAVINGS_INSUFFICIENT', 'withdraw 2600 breaks minBalanceToRetain 500 -> INSUFFICIENT');

  const wd2 = await api('POST', `/api/saccos/${orgId}/savings/withdraw`, mTok, { amount: 2500 });
  await expect(wd2.status === 201 && wd2.data.result.newBalance === 500, 'withdraw 2500 (==usable) -> balance 500');

  const accountsList = await api('GET', `/api/saccos/${orgId}/savings/accounts`, ownerTok);
  await expect(accountsList.status === 200 && accountsList.data.result.length === 1 && accountsList.data.result[0].balance === 500,
    'owner lists savings accounts (1, balance 500)');

  const memberList = await api('GET', `/api/saccos/${orgId}/savings/accounts`, mTok);
  await expect(memberList.status === 403 && memberList.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot list accounts -> 403');

  const summary = await api('GET', `/api/saccos/${orgId}/savings/summary`, ownerTok);
  await expect(summary.status === 200 && Number(summary.data.result.total_deposits) === 5000
    && Number(summary.data.result.total_withdrawals) === 4500 && Number(summary.data.result.balance) === 500
    && summary.data.result.accounts === 1, 'summary deposits 5000 / withdrawals 4500 / balance 500');

  // ---------- 5. Approval-gated withdrawals ----------
  await section('Approval-gated withdrawals');
  const o2 = await register(phone(3003), 'S2 Akiba');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, {
    name: 'Idhibiti Akiba ' + suffix,
    config: { savings: { autoApproveWithdrawals: false } },
  });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);

  const fReg = await register(phone(3004), 'F Akiba');
  const fTok = fReg.data.token;
  const fInv = await api('POST', `/api/saccos/${s2Id}/members`, o2Tok, { phoneNumber: phone(3004) });
  await api('POST', `/api/saccos/${s2Id}/members/${fInv.data.result.id}/accept`, fTok);
  await fundWallet(fReg.data.user.id, 200000);

  await api('POST', `/api/saccos/${s2Id}/savings/deposit`, fTok, { amount: 10000 });
  const pendW = await api('POST', `/api/saccos/${s2Id}/savings/withdraw`, fTok, { amount: 4000 });
  await expect(pendW.status === 201 && pendW.data.result.status === 'PENDING' && pendW.data.result.newBalance === 10000,
    'gated withdrawal -> PENDING, balance unchanged (reserved)', `${pendW.status}/${pendW.data.code || ''}`);

  const second = await api('POST', `/api/saccos/${s2Id}/savings/withdraw`, fTok, { amount: 8000 });
  await expect(second.status === 400 && second.data.code === 'SACCOS_SAVINGS_INSUFFICIENT', 'second pending 8000 while 4000 pending -> INSUFFICIENT');

  const wids = await pool.query(
    `SELECT id FROM saccos_savings_withdrawals WHERE account_id = (SELECT id FROM saccos_savings_accounts WHERE member_id = $1)`,
    [fInv.data.result.id]);
  const wId = wids.rows[0].id;
  const memberSelfApprove = await api('POST', `/api/saccos/${s2Id}/savings/withdrawals/${wId}/approve`, fTok);
  await expect(memberSelfApprove.status === 403 && memberSelfApprove.data.code === 'SACCOS_RBAC', 'member cannot self-approve -> 403');
  const ownerApprove = await api('POST', `/api/saccos/${s2Id}/savings/withdrawals/${wId}/approve`, o2Tok);
  await expect(ownerApprove.status === 200 && ownerApprove.data.result.status === 'APPROVED', 'OWNER approves -> APPROVED');
  await expect((await wallet(fReg.data.user.id)) === 200000 - 10000 + 4000, 'wallet credited only on approval (+4000)');
  const mineF = await api('GET', `/api/saccos/${s2Id}/savings/mine`, fTok);
  await expect(mineF.data.result.account.balance === 6000, 'balance 6000 after approval');

  const dupW = await api('POST', `/api/saccos/${s2Id}/savings/withdrawals/${wId}/approve`, o2Tok);
  await expect(dupW.status === 400 && dupW.data.code === 'SACCOS_SAVINGS_DECIDED', 're-approve -> SACCOS_SAVINGS_DECIDED');

  const w3 = await api('POST', `/api/saccos/${s2Id}/savings/withdraw`, fTok, { amount: 3000 });
  await expect(w3.status === 201 && w3.data.result.status === 'PENDING', 'second gated withdrawal -> PENDING');
  const wids3 = await pool.query(
    `SELECT id FROM saccos_savings_withdrawals WHERE account_id = (SELECT id FROM saccos_savings_accounts WHERE member_id = $1) AND status = 'PENDING' ORDER BY id DESC LIMIT 1`,
    [fInv.data.result.id]);
  const w3Id = wids3.rows[0].id;
  const balBeforeRej = await wallet(fReg.data.user.id);
  const reject3 = await api('POST', `/api/saccos/${s2Id}/savings/withdrawals/${w3Id}/reject`, o2Tok);
  await expect(reject3.status === 200 && reject3.data.result.status === 'REJECTED', 'OWNER rejects PENDING withdrawal');
  await expect((await wallet(fReg.data.user.id)) === balBeforeRej, 'rejection moves no money');
  const mineF2 = await api('GET', `/api/saccos/${s2Id}/savings/mine`, fTok);
  await expect(mineF2.data.result.account.balance === 6000, 'balance unchanged after rejection (6000)');
  const dupR = await api('POST', `/api/saccos/${s2Id}/savings/withdrawals/${w3Id}/reject`, o2Tok);
  await expect(dupR.status === 400 && dupR.data.code === 'SACCOS_SAVINGS_DECIDED', 're-reject -> SACCOS_SAVINGS_DECIDED');

  const s2Sum = await api('GET', `/api/saccos/${s2Id}/savings/summary`, o2Tok);
  await expect(Number(s2Sum.data.result.balance) === 6000, 'org2 summary balance 6000');

  // ---------- 6. Isolation + oversight ----------
  await section('Isolation + oversight');
  const s1Cross = await api('GET', `/api/saccos/${s2Id}/savings/accounts`, ownerTok);
  await expect(s1Cross.status === 404, 'S1 owner cannot read S2 savings accounts -> 404');
  const codes = await pool.query(
    `SELECT account_code FROM ledger_accounts WHERE account_code IN ($1, $2)`,
    [`SACCOS${orgId}_SAVINGS_LIABILITY`, `SACCOS${s2Id}_SAVINGS_LIABILITY`]);
  await expect(codes.rows.length === 2, 'per-entity savings liability accounts distinct');

  const adminTok = await makeAdmin(await register(phone(3005), 'O Akiba'));
  const adminView = await api('GET', `/api/saccos/${s2Id}/savings/accounts`, adminTok);
  await expect(adminTok && adminView.status === 200 && adminView.data.result.length === 1, 'platform ADMIN cross-reads savings accounts');

  const missing = await api('POST', `/api/saccos/${s2Id}/savings/withdrawals/999999/approve`, o2Tok);
  await expect(missing.status === 404 && missing.data.code === 'SACCOS_SAVINGS_WITHDRAWAL_NOT_FOUND', 'unknown withdrawal -> 404');

  const audit = await pool.query(`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'SACCOS_SAVINGS%'`);
  await expect(audit.rows.length >= 2, 'audit trail has savings actions');

  console.log(`\nSACCOS SAVINGS: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });