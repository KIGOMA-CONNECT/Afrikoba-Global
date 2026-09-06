/* ============================================================
 * AFRIKOBA GLOBAL - USSD (MNO rails, feature-phone channel) REGRESSION
 * Verifies:
 *  - ussdGuard: session/phone validation, phone format, HMAC
 *    signature (valid/tampered/stale/missing), per-phone rate limit.
 *  - Menu flows: main menu, wallet balance, P2P transfer end->end
 *    (money moved, transactions + wallet_ledger + balanced journal
 *    rows), insufficient funds guard, invalid recipient/amount,
 *    bad option, VICOBA/ROSCA membership slots, P2P listing.
 *  - Unregistered-phone handling.
 * Depends on: register/send-otp dev flow, fin.internalTransfer.
 * USSD_SECRET: if set on both server + runner, signature path is
 * enforced and tested (CI sets it).
 * ============================================================ */
const crypto = require('crypto');
const BASE = process.env.USSD_TEST_BASE || 'http://127.0.0.1:3000';
const SECRET = process.env.USSD_SECRET || '';
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
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

// --- USSD gateway dialog helper (mirrors MNO callback payload + HMAC) ---
function sign(sessionId, phoneNumber, timestamp) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(`${sessionId}${phoneNumber}${timestamp}`)
    .digest('hex');
}

async function ussd(sessionId, phoneNumber, text, { signature = SECRET ? 'valid' : 'none', timestamp = Date.now() } = {}) {
  const body = { sessionId, phoneNumber, text: text || '', timestamp };
  const headers = { 'Content-Type': 'application/json' };
  if (signature === 'valid' && SECRET) {
    headers['x-ussd-signature'] = sign(sessionId, phoneNumber, timestamp);
  } else if (signature === 'invalid') {
    headers['x-ussd-signature'] = 'deadbeef'.repeat(8);
  }
  const res = await fetch(BASE + '/api/ussd', { method: 'POST', headers, body: JSON.stringify(body) });
  const textBody = await res.text();
  const isEnd = textBody.startsWith('END');
  return { status: res.status, isEnd, text: textBody };
}

let phoneCounter = 0;
const runSalt = String(Date.now()).slice(-5);
function uniqPhone() {
  phoneCounter++;
  // '2557' + 8 digits, salted per-run so re-runs never re-register phones
  return `2557${String(72000000 + parseInt(runSalt, 10) + phoneCounter * 7919).slice(0, 8)}`;
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) {
    console.log(`  [register failed] ${fullName} ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data)}`);
  }
  return r.data;
}

async function topUp(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1, updated_at = NOW() WHERE id = $2', [amount, userId]);
}

(async () => {
  await section('Guard: payload validation');
  let r = await fetch(BASE + '/api/ussd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: uniqPhone() }),
  });
  await expect(r.status === 400, 'missing sessionId -> 400');

  r = await fetch(BASE + '/api/ussd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sid-1', phoneNumber: '25512345' }),
  });
  await expect(r.status === 400, 'bad phone format -> 400');

  if (SECRET) {
    await section('Guard: HMAC signature enforcement');
    const ph = uniqPhone();
    let x = await ussd('sig-sess-1', ph, '', { signature: 'none' });
    await expect(x.status === 401, 'missing signature -> 401');

    x = await ussd('sig-sess-1', ph, '', { signature: 'invalid' });
    await expect(x.status === 401, 'tampered signature -> 401');

    const stale = Date.now() - 5 * 60 * 1000;
    x = await ussd('sig-sess-1', ph, '', { signature: 'valid', timestamp: stale });
    await expect(x.status === 401, 'stale timestamp -> 401');

    x = await ussd('sig-sess-1', ph, '', { signature: 'valid' });
    await expect(x.status === 200 && x.text.startsWith('END'), 'valid signature -> accepted');
  } else {
    console.log('  - USSD_SECRET not set; signature-enforcement checks skipped');
  }

  await section('Unregistered phone');
  const unk = await ussd('sess-unreg', uniqPhone(), '');
  await expect(unk.status === 200 && unk.isEnd, 'unregistered phone -> END');
  await expect(unk.text.includes('Hujajiungana'), 'unregistered prompt text');

  await section('Main menu + balance');
  const userBPhone = uniqPhone();
  const userB = await register(userBPhone, `UssdBalance${phoneCounter}`);
  const uidB = userB.user.id;
  await topUp(uidB, 250000);

  let m = await ussd('sess-bal', userBPhone, '');
  await expect(m.status === 200 && !m.isEnd, 'dial-in -> CON menu');
  await expect(m.text.includes('Salio la Pochi'), 'main menu lists options');

  m = await ussd('sess-bal', userBPhone, '9');
  await expect(m.status === 200 && !m.isEnd && m.text.includes('Chaguo si sahihi'), 'invalid option -> retry');

  m = await ussd('sess-bal', userBPhone, '1');
  await expect(m.status === 200 && m.isEnd && m.text.includes('Salio la Pochi: TZS 250,000'), 'balance shows funded amount');

  await section('VICOBA / ROSCA membership slots');
  const nv = await register(uniqPhone(), `UssdNoVicoba${phoneCounter}`);
  m = await ussd('sess-nv', nv.user.phone_number, '');
  m = await ussd('sess-nv', nv.user.phone_number, '3');
  await expect(m.status === 200 && m.isEnd && m.text.includes('Huna kikundi cha VICOBA'), 'non-member VICOBA -> END');

  const nr = await register(uniqPhone(), `UssdNoRosca${phoneCounter}`);
  m = await ussd('sess-nr', nr.user.phone_number, '');
  m = await ussd('sess-nr', nr.user.phone_number, '4');
  await expect(m.status === 200 && m.isEnd && m.text.includes('Huna upatu'), 'non-member ROSCA -> END');

  await section('P2P listing slot');
  const np = await register(uniqPhone(), `UssdNoP2p${phoneCounter}`);
  const activeProjects = await pool.query("SELECT COUNT(*)::int AS n FROM investment_projects WHERE status = 'ACTIVE'");
  m = await ussd('sess-np', np.user.phone_number, '');
  m = await ussd('sess-np', np.user.phone_number, '5');
  if (activeProjects.rows[0].n === 0) {
    await expect(m.status === 200 && m.isEnd && m.text.includes('Hakuna miradi'), 'no active projects -> END notice');
  } else {
    await expect(m.status === 200 && m.isEnd && m.text.includes('UWEKEZAJI'), 'active projects -> END listing');
  }

  await section('Main menu support slot');
  const nt = await register(uniqPhone(), `UssdHelp${phoneCounter}`);
  m = await ussd('sess-nh', nt.user.phone_number, '');
  m = await ussd('sess-nh', nt.user.phone_number, '6');
  await expect(m.status === 200 && m.isEnd && m.text.includes('MSAADA'), 'help -> END contact card');

  await section('Transfer: recipient validation');
  const send1 = await register(uniqPhone(), `UssdSend1${phoneCounter}`);
  const s1Phone = send1.user.phone_number;
  const recv = await register(uniqPhone(), `UssdRecv${phoneCounter}`);
  const recvPhone = recv.user.phone_number;
  const recvBefore = recv.user.id;
  await topUp(send1.user.id, 100000);

  m = await ussd('sess-t1', s1Phone, '');
  m = await ussd('sess-t1', s1Phone, '2');
  await expect(m.text.includes('Weka nambari ya simu'), 'transfer step 1 -> phone prompt');

  m = await ussd('sess-t1', s1Phone, '255711111111');
  await expect(m.text.includes('Simu hii haijapatikana'), 'unknown recipient -> CON notice');

  m = await ussd('sess-t1', s1Phone, '0');
  await expect(m.text.includes('Salio la Pochi'), '0 -> back to main menu');

  await section('Transfer: amount validation');
  m = await ussd('sess-t1', s1Phone, '2');
  m = await ussd('sess-t1', s1Phone, recvPhone);
  await expect(m.text.includes('Kuhamisha kwa'), 'recipient selected');
  m = await ussd('sess-t1', s1Phone, 'abc');
  await expect(m.text.includes('Kiasi si sahihi'), 'non-numeric amount -> CON notice');
  m = await ussd('sess-t1', s1Phone, recvPhone);
  m = await ussd('sess-t1', s1Phone, '0');
  await expect(m.text.includes('Salio la Pochi'), 'amount step 0 -> back to main menu');

  await section('Transfer: success');
  // Fresh sender so this dialog stays well under the 10 req/min USSD limit
  const s2 = await register(uniqPhone(), `UssdSend2${phoneCounter}`);
  const s2Phone = s2.user.phone_number;
  await topUp(s2.user.id, 100000);
  m = await ussd('sess-t2', s2Phone, '');
  m = await ussd('sess-t2', s2Phone, '2');
  m = await ussd('sess-t2', s2Phone, recvPhone);
  m = await ussd('sess-t2', s2Phone, '15000');
  await expect(m.text.includes('Thibitisha kuhamisha'), 'confirm prompt');

  const senderBalBefore = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [s2.user.id])).rows[0].wallet_balance;
  const recvBalBefore = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [recvBefore])).rows[0].wallet_balance;

  m = await ussd('sess-t2', s2Phone, '1');
  await expect(m.status === 200 && m.text.includes('Uhamisho umefanikiwa'), 'transfer confirmed');

  const senderBalAfter = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [s2.user.id])).rows[0].wallet_balance;
  const recvBalAfter = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [recvBefore])).rows[0].wallet_balance;
  await expect(Number(senderBalAfter) === Number(senderBalBefore) - 15000, `sender debited (${senderBalBefore} -> ${senderBalAfter})`);
  await expect(Number(recvBalAfter) === Number(recvBalBefore) + 15000, `receiver credited (${recvBalBefore} -> ${recvBalAfter})`);

  const tx = await pool.query(
    `SELECT reference_id FROM transactions WHERE user_id = $1 AND type = 'TRANSFER' AND status = 'SUCCESS'
     ORDER BY id DESC LIMIT 1`,
    [s2.user.id]
  );
  const ref = tx.rows[0]?.reference_id;
  await expect(!!ref && ref.startsWith('USSD-'), `transaction reference recorded (${ref || 'NONE'})`);

  const ledger = await pool.query('SELECT COUNT(*)::int AS n FROM wallet_ledger WHERE reference_id = $1', [ref]);
  await expect(ledger.rows[0].n >= 1, 'wallet_ledger row written');

  const journal = await pool.query('SELECT COUNT(*)::int AS n FROM journal_entries WHERE reference_id = $1', [ref]);
  await expect(journal.rows[0].n >= 2, `balanced journal entries written (${journal.rows[0].n})`);

  await section('Transfer: insufficient funds');
  const low = await register(uniqPhone(), `UssdLow${phoneCounter}`);
  await topUp(low.user.id, 5000);
  const lowPhone = low.user.phone_number;
  const lowBalBefore = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [low.user.id])).rows[0].wallet_balance;

  m = await ussd('sess-t3', lowPhone, '');
  m = await ussd('sess-t3', lowPhone, '2');
  m = await ussd('sess-t3', lowPhone, recvPhone);
  m = await ussd('sess-t3', lowPhone, '50000');
  m = await ussd('sess-t3', lowPhone, '1');
  await expect(m.status === 200 && m.text.includes('Salio haletoshi'), 'insufficient funds -> notice');

  const lowBalAfter = (await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [low.user.id])).rows[0].wallet_balance;
  await expect(Number(lowBalAfter) === Number(lowBalBefore), 'no money moved on insufficient funds');

  await section('Rate limit (per-phone, 10/min)');
  const burstPhone = uniqPhone();
  let limited = false;
  for (let i = 0; i < 11; i++) {
    const resp = await ussd(`sess-rl-${i}`, burstPhone, '');
    if (resp.status === 429) { limited = true; }
  }
  await expect(limited, '11th request in a minute -> 429');

  console.log(`\n===== USSD TEST SUMMARY: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('FAILED:', failures.join(', '));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR', err.message);
  process.exit(1);
});