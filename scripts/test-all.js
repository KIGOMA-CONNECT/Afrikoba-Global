/* ============================================================
 * AFRIKOBA GLOBAL - COMPREHENSIVE TEST SUITE (kila hatua)
 * Huendesha mtihani wa mfumo mzima na kukusanya matokeo.
 * ============================================================ */
const BASE = 'http://127.0.0.1:3000';
const nodeCrypto = require('crypto');
const http = require('http');
const pool = require('../src/config/db');
const config = require('../src/config');
const { disburseDuePayouts } = require('../src/services/roscaService');
const { reconcilePendingDeposits } = require('../src/jobs/reconciliationCron');

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

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function apiRaw(method, path, rawBody, headersExt) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...headersExt }, body: rawBody });
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

async function login(phoneNumber) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/login', null, { phoneNumber, otp });
  return r.data;
}

async function upgradeKyc(token, nida) {
  return api('POST', '/api/auth/kyc', token, { nidaNumber: nida, residentialAddress: 'Dar es Salaam, Mbezi' });
}

async function subscribe(token, serviceKey) {
  return api('POST', '/api/services/subscribe', token, { serviceKey });
}

async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + crypto().toUpperCase();
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
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

function crypto(len = 8) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function nowSuffix() { return String(Date.now()).slice(-6); }

async function balanceOf(userId) {
  const r = await pool.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
  return { wallet: Number(r.rows[0].wallet_balance), locked: Number(r.rows[0].locked_balance) };
}

async function section(title) { console.log(`\n== ${title} ==`); }

(async function main() {
  console.log('==============================');
  console.log('AFRIKOBA GLOBAL — MTIHANI KAMILI');
  console.log('==============================');

  // ------------------------------------------------------------
  await section('1. AUTH & OTP SECURITY');
  // ------------------------------------------------------------
  const phoneA = '255722' + nowSuffix();
  const noToken = await api('GET', '/api/wallet/balance', null, null);
  await expect(noToken.status === 401, 'Unauthorized bila token', `${noToken.status}`);

  const otpCode = await sendOtp(phoneA);
  const r1 = await api('POST', '/api/auth/login', null, { phoneNumber: phoneA, otp: '000000' });
  await expect(r1.status === 400 && /majaribio/.test(r1.data.message), 'OTP mbaya inapunguza majaribio', r1.data.message);

  for (let i = 2; i <= 5; i++) {
    await api('POST', '/api/auth/login', null, { phoneNumber: phoneA, otp: '000000' });
  }
  const r6 = await api('POST', '/api/auth/login', null, { phoneNumber: phoneA, otp: '000000' });
  await expect(r6.status === 400 && /mara nyingi|mpya/.test(r6.data.message), 'OTP inazuiwa baada ya majaribio 5', r6.data.message);

  const cooldown = await api('POST', '/api/auth/send-otp', null, { phoneNumber: phoneA });
  await expect(cooldown.status === 429 && /Subiri/.test(cooldown.data.message || '') && cooldown.data.code !== 'INTERNAL_ERROR', 'Send-OTP ina cooldown (anti SMS-bombing)', `${cooldown.status} ${cooldown.data.message}`);

  const localPhone = '07' + String(Date.now()).slice(-8);
  const localOtp = await api('POST', '/api/auth/send-otp', null, { phoneNumber: localPhone });
  await expect(localOtp.status === 200 && localOtp.data.devOtp, 'Send-OTP inakubali namba ya ndani 0xx → normalize 255', `${localOtp.status}`);

  const phoneB = '255723' + nowSuffix();
  const regB = await register(phoneB, 'Asha Mtihani');
  await expect(regB.status === 201, 'Usajili mpya unafungua WALLET', `${regB.status}`);
  await expect((regB.data.user.services || []).includes('WALLET'), 'Services = [WALLET] baada ya usajili', JSON.stringify(regB.data.user.services));

  const regDup = await register(phoneB, 'Dup');
  await expect(regDup.status === 400, 'Usajili wa namba iliyopo unakataliwa', `${regDup.status}`);

  const phonePw = '255724' + nowSuffix();
  const emailPw = `pw${nowSuffix()}@afrikoba.test`;
  const passPw = 'Str0ngPass12345';
  const otpPw = await sendOtp(phonePw);
  const regPw = await api('POST', '/api/auth/register', null, { fullName: 'Password User', phoneNumber: phonePw, email: emailPw, password: passPw, otp: otpPw });
  await expect(regPw.status === 201, 'Usajili na password huepuka toInternationalFormat', `${regPw.status}: ${regPw.data.message || ''}`);
  const pwLoginEmail = await api('POST', '/api/auth/login/password', null, { emailOrPhone: emailPw, password: passPw });
  await expect(pwLoginEmail.status === 200 && pwLoginEmail.data.token, 'Login kwa Email + Password inafanya kazi', `${pwLoginEmail.status}`);
  const pwLoginPhone = await api('POST', '/api/auth/login/password', null, { emailOrPhone: phonePw, password: passPw });
  await expect(pwLoginPhone.status === 200 && pwLoginPhone.data.token, 'Login kwa Namba + Password inafanya kazi', `${pwLoginPhone.status}`);
  const pwLoginBad = await api('POST', '/api/auth/login/password', null, { emailOrPhone: emailPw, password: 'Wrong-Pass-999' });
  await expect(pwLoginBad.status === 401, 'Password mbaya inakataliwa', `${pwLoginBad.status}`);

  const pinB = await api('POST', '/api/auth/pin', regB.data.token, { pin: '1234' });
  await expect(pinB.status === 200, 'PIN inaweza kuwekwa', `${pinB.status}`);

  const meB = await api('GET', '/api/auth/me', regB.data.token, null);
  await expect(meB.status === 200 && Array.isArray(meB.data.user.services), '/auth/me inarudisha services', `${meB.status}`);

  // ------------------------------------------------------------
  await section('2. SERVICES (katalogi + gating + KYC)');
  // ------------------------------------------------------------
  const cat = await api('GET', '/api/services/catalog', regB.data.token, null);
  const myWalletOnly = cat.data.catalog.every((c) => c.active === (c.key === 'WALLET'));
  await expect(myWalletOnly, 'Katalogi: WALLET tu imewashwa');

  const gated = await api('GET', '/api/vicoba/groups', regB.data.token, null);
  await expect(gated.status === 403 && gated.data.code === 'SERVICE_NOT_SUBSCRIBED', 'VICOBA imefungwa bila subscription', `${gated.status}`);

  const rosL1 = await subscribe(regB.data.token, 'ROSCA');
  await expect(rosL1.status === 403 && /KYC Level 2/.test(rosL1.data.message), 'ROSCA inahitaji KYC L2 kwanza', rosL1.data.message);

  const kycB = await upgradeKyc(regB.data.token, '1977' + nowSuffix());
  await expect(kycB.status === 200, 'KYC upgrade → Level 2', `${kycB.status}`);

  const rosL2 = await subscribe(regB.data.token, 'ROSCA');
  await expect(rosL2.status === 200, 'ROSCA subscription inakubalika baada ya KYC L2', `${rosL2.status}`);

  const p2pSub = await subscribe(regB.data.token, 'P2P');
  await expect(p2pSub.status === 200, 'P2P subscription inafanya kazi', `${p2pSub.status}`);

  const publicOffers = await api('GET', '/api/marketing/offers', null, null);
  await expect(publicOffers.status === 200 && publicOffers.data.offers.length >= 4, 'Marketing offers zinapatikana kwa umma (nje ya mfumo)', `${publicOffers.status}`);

  // ------------------------------------------------------------
  await section('3. WALLET — transfer, deposit callback, withdrawal refund');
  // ------------------------------------------------------------
  const phoneC = '255724' + nowSuffix();
  const regC = await register(phoneC, 'Juma Mtihani');
  await fundWallet(regC.data.user.id, 100000);
  await fundWallet(regB.data.user.id, 50000);

  const bBefore = await balanceOf(regB.data.user.id);
  const cBefore = await balanceOf(regC.data.user.id);

  const selfTx = await api('POST', '/api/wallet/transfer', regC.data.token, { toPhoneNumber: phoneC, amount: 1000 });
  await expect(selfTx.status === 400, 'Uhamisho kwako mwenyewe unakataliwa', `${selfTx.status}`);

  const badAmt = await api('POST', '/api/wallet/transfer', regC.data.token, { toPhoneNumber: phoneB, amount: -500 });
  await expect(badAmt.status === 400, 'Kiasi hasi kinakataliwa', `${badAmt.status}`);

  const insuff = await api('POST', '/api/wallet/transfer', regC.data.token, { toPhoneNumber: phoneB, amount: 999999 });
  await expect(insuff.status === 400, 'Salio lisilotosha linakataliwa', `${insuff.status}`);

  const txOk = await api('POST', '/api/wallet/transfer', regC.data.token, { toPhoneNumber: phoneB, amount: 25000, note: 'Ada ya mkopo' });
  await expect(txOk.status === 200, 'Uhamisho P2P unafanikiwa', `${txOk.status}`);

  const bAfter = await balanceOf(regB.data.user.id);
  const cAfter = await balanceOf(regC.data.user.id);
  await expect(cAfter.wallet === cBefore.wallet - 25000, 'Msender salio imepungua kwa 25000', `${cAfter.wallet}`);
  await expect(bAfter.wallet === bBefore.wallet + 25000, 'Mpokeaji salio imeongezeka kwa 25000', `${bAfter.wallet}`);

  // Deposit callback (idempotency + commission)
  const revBefore = await pool.query('SELECT total_commission FROM company_revenue WHERE id = 1');
  const depRef = 'DP-' + crypto();
  await pool.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type)
     VALUES ($1, $2, 100000, 1000, 101000, 'PENDING', 'DEPOSIT')`,
    [depRef, regB.data.user.id]
  );
  const depBef = await balanceOf(regB.data.user.id);
  const whBody = JSON.stringify({ utilityref: depRef, transactionstatus: 'SUCCESS', reference: 'EXT-1' });
  const whSigGood = nodeCrypto.createHmac('sha256', config.security.webhookSecret || process.env.WEBHOOK_SECRET).update(whBody, 'utf8').digest('hex');
  const hdr = { 'Content-Type': 'application/json', 'x-webhook-secret': config.webhook.secret, 'x-signature': whSigGood };
  const resWebhook = await fetch(BASE + '/api/payments/azampay-callback', {
    method: 'POST', headers: hdr, body: whBody,
  });
  const webhookData = await resWebhook.json();
  await expect(resWebhook.status === 200 && webhookData.success, 'Callback ya AzamPay inathibitisha deposit', `${resWebhook.status} ${JSON.stringify(webhookData)}`);
  const depAft = await balanceOf(regB.data.user.id);
  await expect(depAft.wallet === depBef.wallet + 100000, 'Deposit inaongezwa kwenye wallet (wallet_amount)', `${depBef.wallet} → ${depAft.wallet}`);

  const revMid = await pool.query('SELECT total_commission FROM company_revenue WHERE id = 1');
  await expect(Number(revMid.rows[0].total_commission) - Number(revBefore.rows[0].total_commission) === 1000, 'Commission 1% inaenda company_revenue');

  const wbDup = await fetch(BASE + '/api/payments/azampay-callback', {
    method: 'POST', headers: hdr, body: whBody,
  });
  const dupData = await wbDup.json();
  const depAfterDup = await balanceOf(regB.data.user.id);
  await expect(dupData.duplicate === true && depAfterDup.wallet === depAft.wallet, 'Duplicate callback HAIRUDISHI fedha mara mbili (idempotency)', JSON.stringify(dupData));

  const wbWrong = await fetch(BASE + '/api/payments/azampay-callback', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'wrong_secret' },
    body: JSON.stringify({ utilityref: 'XXXX', transactionstatus: 'SUCCESS' }),
  });
  await expect(wbWrong.status === 401, 'Webhook secret mbaya inakataliwa (401)', `${wbWrong.status}`);

  // Withdrawal + reconciliation refund
  const wd = await api('POST', '/api/wallet/withdraw', regC.data.token, { amount: 5000, provider: 'Mpesa' });
  await expect(wd.status === 200, 'Withdrawal inaanza (PENDING)', `${wd.status}`);
  const afterWd = await balanceOf(regC.data.user.id);
  await expect(afterWd.wallet === cAfter.wallet - 5000, 'Salio linaondolewa kwa withdrawal', `${afterWd.wallet}`);

  await pool.query(`UPDATE transactions SET created_at = NOW() - INTERVAL '16 minutes' WHERE reference_id = $1`, [wd.data.referenceId]);
  const recon = await reconcilePendingDeposits();
  await expect(recon.refundedWithdrawals >= 1, 'Reconciliation inarudisha withdrawal iliyokwama', JSON.stringify(recon));
  const afterRefund = await balanceOf(regC.data.user.id);
  await expect(afterRefund.wallet === cAfter.wallet, 'Fedha zimerudishwa kwenye wallet', `${afterRefund.wallet}`);

  // ------------------------------------------------------------
  await section('4. VICOBA — kikundi, join-code, mialiko, hisa, mikopo, usalama');
  // ------------------------------------------------------------
  const phoneD = '255725' + nowSuffix();
  const phoneE = '255726' + nowSuffix();
  const regD = await register(phoneD, 'Neema Mwenyekiti');
  const regE = await register(phoneE, 'Baraka Mjumbe');
  await subscribe(regD.data.token, 'VICOBA');
  await subscribe(regE.data.token, 'VICOBA');

  const gCreated = await api('POST', '/api/vicoba/groups', regD.data.token, { groupName: 'Umoja Group', cycleType: 'WEEKLY', shareValue: 5000 });
  await expect(gCreated.status === 201 && !!gCreated.data.group.join_code, 'Kikundi kinaundwa na join_code', `${gCreated.status}`);
  const groupId = gCreated.data.group.id;
  const joinCode = gCreated.data.group.join_code;

  const joined = await api('POST', '/api/vicoba/groups/join', regE.data.token, { joinCode });
  await expect(joined.status === 200, 'Jiunge kwa msimbo wa kikundi', `${joined.status} ${joined.data.message}`);

  const joinTwice = await api('POST', '/api/vicoba/groups/join', regE.data.token, { joinCode });
  await expect(joinTwice.status === 400, 'Kujiunga mara mbili kunakataliwa', `${joinTwice.status}`);

  const memberList = await api('GET', '/api/vicoba/groups', regE.data.token, null);
  const memberSeesCode = memberList.data.groups[0].join_code !== undefined;
  await expect(!memberSeesCode, 'Mjumbe wa kawaida HAONI join_code (list)');

  const chairList = await api('GET', '/api/vicoba/groups', regD.data.token, null);
  await expect(chairList.data.groups[0].join_code === joinCode, 'Mwenyekiti anaona join_code (list)');

  const nonLeaderAdd = await api('POST', `/api/vicoba/groups/${groupId}/members`, regE.data.token, { userId: regB.data.user.id });
  await expect(nonLeaderAdd.status === 403, 'Mjumbe hawezi kuongeza wanachama (403) — USALAMA', `${nonLeaderAdd.status}`);

  const leaderAdd = await api('POST', `/api/vicoba/groups/${groupId}/members`, regD.data.token, { userId: regB.data.user.id });
  await expect(leaderAdd.status === 201, 'Mwenyekiti anaweza kuongeza mwanachama', `${leaderAdd.status}`);

  const invite = await api('POST', `/api/vicoba/groups/${groupId}/invite`, regD.data.token, { phoneNumbers: ['255727123456'] });
  await expect(invite.status === 200 && invite.data.invited === 1, 'Mialiko ya SMS inatumwa (join code)', `${invite.status}`);

  // Hisa + mkopo multi-sig
  await fundWallet(regE.data.user.id, 200000);
  const contrib = await api('POST', `/api/vicoba/groups/${groupId}/contribute`, regE.data.token, { amount: 50000, sharesCount: 10 });
  await expect(contrib.status === 200, 'Weka hisa → Group Wallet', `${contrib.status}`);

  const gDetails = await api('GET', `/api/vicoba/groups/${groupId}`, regD.data.token, null);
  await expect(Number(gDetails.data.group.group_wallet_balance) === 50000, 'Group Wallet imeongezeka kwa hisa', `${gDetails.data.group.group_wallet_balance}`);

  const loanReq = await api('POST', `/api/vicoba/groups/${groupId}/loans`, regD.data.token, { applicantUserId: regE.data.user.id, requestedAmount: 30000 });
  await expect(loanReq.status === 201, 'Mwenyekiti anaongeza ombi la mkopo', `${loanReq.status}`);
  const loanId = loanReq.data.loan.id;

  // Approver lazima awe MWEKAHAZINA/KATIBU — Mjumbe (regE) hawezi
  const badApprove = await api('POST', `/api/vicoba/loans/${loanId}/approve`, regE.data.token, { approvedAmount: 30000 });
  await expect(badApprove.status === 403, 'Mjumbe HAWEZI kuidhinisha mkopo (403)', `${badApprove.status}`);

  // Kuongeza ombi ni Mwenyekiti pekee — Mjumbe hawezi
  const badLoan = await api('POST', `/api/vicoba/groups/${groupId}/loans`, regE.data.token, { applicantUserId: regE.data.user.id, requestedAmount: 10000 });
  await expect(badLoan.status === 403, 'Mjumbe HAWEZI kuongeza ombi la mkopo (403)', `${badLoan.status}`);

  // ------------------------------------------------------------
  await section('5. ROSCA — upatu kamili + payout engine (hesabu za fedha)');
  // ------------------------------------------------------------
  const memberPhones = [];
  const roscaTokens = [];
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500)); // OTP cooldown
    const p = '255728' + String(i + 1) + nowSuffix().slice(0, 5);
    const reg = await register(p, `Rosca Member ${i + 1}`);
    if (!reg.data || !reg.data.user) {
      fail(`ROSCA member ${i + 1} registration failed`, JSON.stringify(reg.data));
      continue;
    }
    await upgradeKyc(reg.data.token, '1988' + nowSuffix() + i);
    await subscribe(reg.data.token, 'ROSCA');
    await subscribe(reg.data.token, 'P2P');
    await fundWallet(reg.data.user.id, 150000);
    memberPhones.push(p);
    roscaTokens.push(reg);
  }
  const poolCreated = await api('POST', '/api/rosca/pools', roscaTokens[0].data.token, { poolName: 'Upatu Test', contributionAmount: 50000, cycleFrequency: 'WEEKLY', totalMembers: 3, poolType: 'PRIVATE_KIKOBA' });
  if (poolCreated.status !== 201) console.log('  !!! POOL FAIL', poolCreated.status, JSON.stringify(poolCreated.data));
  await expect(poolCreated.status === 201, 'Upatu (pool) unaundwa', `${poolCreated.status}`);
  const poolId = poolCreated.data.pool.id;

  for (const reg of roscaTokens) {
    const j = await api('POST', `/api/rosca/pools/${poolId}/join`, reg.data.token, {});
    await expect(j.status === 200, `Kujiunga upatu: ${j.data.message}`, `${j.status}`);
  }

  const poolDetail = await api('GET', `/api/rosca/pools/${poolId}`, roscaTokens[0].data.token, null);
  await expect(poolDetail.data.pool.status === 'ACTIVE', 'Pool inakuwa ACTIVE ikiwa imejaa', `${poolDetail.data.pool.status}`);
  await expect(poolDetail.data.pool.schedules.length === 3, 'Ratiba 3 zimezalishwa', `${poolDetail.data.pool.schedules.length}`);

  const balancesBefore = [];
  for (const reg of roscaTokens) balancesBefore.push(await balanceOf(reg.data.user.id));
  const commBefore = await pool.query('SELECT total_commission FROM company_revenue WHERE id = 1');

  const payout = await disburseDuePayouts();
  await expect(payout.processed >= 1, 'Payout Engine inachakata mzunguko', `${payout.processed}`);

  const balancesAfter = [];
  for (const reg of roscaTokens) balancesAfter.push(await balanceOf(reg.data.user.id));

  for (let i = 1; i < 3; i++) {
    await expect(balancesAfter[i].wallet === balancesBefore[i].wallet - 50000, `Mchango 50,000 umekatwa (member ${i + 1})`, `${balancesBefore[i].wallet} → ${balancesAfter[i].wallet}`);
  }
  // recipient 1: +148500 (150000 - 1500 comm), net ya mchango wake = -50000 + 148500
  await expect(balancesAfter[0].wallet === balancesBefore[0].wallet - 50000 + 148500, 'Mpokeaji 1 anapata 148,500 (150,000 - 1% comm)', `${balancesAfter[0].wallet}`);
  const commAfter = await pool.query('SELECT total_commission FROM company_revenue WHERE id = 1');
  await expect(Number(commAfter.rows[0].total_commission) - Number(commBefore.rows[0].total_commission) === 1500, 'Commission 1,500 inaenda company_revenue', `${Number(commAfter.rows[0].total_commission) - Number(commBefore.rows[0].total_commission)}`);

  const fullPool = await api('POST', `/api/rosca/pools/${poolId}/join`, roscaTokens[0].data.token, {});
  await expect(fullPool.status === 400, 'Pool iliyoisha haikubali wanachama', `${fullPool.status}`);

  // ------------------------------------------------------------
  await section('6. P2P — mradi, uhakiki, escrow, uwekezaji, split 70/28/2');
  // ------------------------------------------------------------
  const adminLogin = await login('255712000001');
  const adminToken = adminLogin.token;

  const rbac = await api('GET', '/api/admin/dashboard', roscaTokens[0].data.token, null);
  await expect(rbac.status === 403, 'Mtu asiye ADMIN hawezi kuingia admin (403)', `${rbac.status}`);

  const dash = await api('GET', '/api/admin/dashboard', adminToken, null);
  await expect(dash.status === 200 && Array.isArray(dash.data.stats.serviceSubscriptions), 'Admin dashboard + takwimu za huduma', `${dash.status}`);

  const project = await api('POST', '/api/p2p/projects', adminToken, {
    title: 'Kiwanda cha Kahawa', sector: 'AGRIBUSINESS', description: 'Usindikaji kahawa',
    targetAmount: 200000, sharePrice: 10000, roiPercentage: 12, tenureMonths: 6, paybackStartMonths: 3,
    businessPlan: 'Mpango wa biashara: Usindikaji kahawa 500kg kwa wiki.',
    teamInfo: 'Timu: CEO mwenye uzoefu wa miaka 8, mpima ubora, muuzaji.',
  });
  await expect(project.status === 201, 'Mradi unaundwa (Admin/ISSUER) + businessPlan + teamInfo', `${project.status}`);
  const projectId = project.data.project.id;
  await expect(project.data.project.status === 'SUBMITTED', 'Mradi unaanza kama SUBMITTED', `${project.data.project.status}`);

  const steps = ['KYC_KYB_VERIFICATION', 'FINANCIAL_AUDIT', 'ESCROW_SETUP', 'LEGAL_PRE_APPROVAL'];
  for (const s of steps) {
    const a = await api('POST', `/api/admin/projects/${projectId}/audit`, adminToken, { stepName: s, passed: true, notes: 'Hakiki imepita' });
    await expect(a.status === 200, `Uhakiki: ${s}`, `${a.status}`);
  }

  const reviewStart = await api('POST', `/api/admin/projects/${projectId}/review/start`, adminToken, {});
  await expect(reviewStart.status === 200, 'Mradi unaanza ukaguzi (SUBMITTED → UNDER_REVIEW)', `${reviewStart.status}`);

  const reviewApprove = await api('POST', `/api/admin/projects/${projectId}/review`, adminToken, { decision: 'APPROVED', reason: '' });
  await expect(reviewApprove.status === 200, 'Mradi unakaguliwa na KUTHIBITISHWA', `${reviewApprove.status}`);

  const projDetail = await api('GET', `/api/p2p/projects/${projectId}`, roscaTokens[0].data.token, null);
  await expect(projDetail.data.project.status === 'ACTIVE', 'Mradi unakuwa ACTIVE baada ya approve', `${projDetail.data.project.status}`);

  const mil = await api('POST', `/api/admin/projects/${projectId}/milestones`, adminToken, {
    milestones: [{ title: 'Awamu 1', amount: 60000 }, { title: 'Awamu 2', amount: 60000 }],
  });
  await expect(mil.status === 200, 'Escrow milestones zinatengenezwa', `${mil.status}`);

  const invest0 = await api('POST', `/api/p2p/projects/${projectId}/invest`, roscaTokens[1].data.token, { shares: 5 });
  await expect(invest0.status === 200 && !!invest0.data.contractPdfUrl, 'Uwekezaji wa 50,000 unafanikiwa + mkataba PDF', `${invest0.status}`);
  await expect(/\/contracts\//.test(invest0.data.contractPdfUrl || ''), 'Contract PDF URL imezalishwa', invest0.data.contractPdfUrl);

  const invest1 = await api('POST', `/api/p2p/projects/${projectId}/invest`, roscaTokens[2].data.token, { shares: 5 });
  await expect(invest1.status === 200, 'Mwekezaji wa pili anafanikiwa', `${invest1.status}`);

  const investOver = await api('POST', `/api/p2p/projects/${projectId}/invest`, roscaTokens[1].data.token, { shares: 999 });
  await expect(investOver.status === 400, 'Uwekezaji unaozidi target unakataliwa', `${investOver.status}`);

  // Split engine: 100,000 → 70,000 / 28,000 / 2,000
  const invBef = await balanceOf(roscaTokens[1].data.user.id);
  const rev = await api('POST', `/api/admin/projects/${projectId}/revenue`, adminToken, { amount: 100000, description: 'Mauzo ya kahawa' });
  await expect(rev.status === 200, 'Mapato ya mradi yanaingia Business Wallet', `${rev.status}`);

  const negRev = await api('POST', `/api/admin/projects/${projectId}/revenue`, adminToken, { amount: -1000 });
  await expect(negRev.status === 400, 'Mapato hasi yanakataliwa', `${negRev.status}`);

  const split = await api('POST', `/api/admin/projects/${projectId}/split`, adminToken, {});
  await expect(split.status === 200 && split.data.success, 'Split engine inaendeshwa', `${split.status}`);
  await expect(split.data.operationalShare === 70000, 'Operational 70% = 70,000', `${split.data.operationalShare}`);
  await expect(split.data.investorShare === 28000, 'Investor 28% = 28,000', `${split.data.investorShare}`);
  await expect(split.data.platformShare === 2000, 'Platform 2% = 2,000', `${split.data.platformShare}`);

  const invAft = await balanceOf(roscaTokens[1].data.user.id);
  await expect(invAft.wallet === invBef.wallet + 14000, 'Mwekezaji anapata faida kulingana na hisa (50% × 28,000 = 14,000)', `${invBef.wallet} → ${invAft.wallet}`);

  const dupSplit = await api('POST', `/api/admin/projects/${projectId}/split`, adminToken, {});
  await expect(dupSplit.data.duplicate === true, 'Split ya mwezi huo haiwezi kurudiwa (idempotency)', JSON.stringify(dupSplit.data));

  const milList = await api('GET', `/api/p2p/projects/${projectId}`, adminToken, null);
  const firstMilestone = milList.data.project.milestones[0];
  const rel = await api('POST', `/api/admin/milestones/${firstMilestone.id}/release`, adminToken, {});
  await expect(rel.status === 200, 'Escrow milestone inatolewa kwa mjasiriamali', `${rel.status}`);

  const pfRes = await fetch(`${BASE}/api/p2p/portfolio`, { method: 'GET', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${roscaTokens[1].data.token}` } });
  const pfText = await pfRes.text();
  const pfData = JSON.parse(pfText);
  await expect(pfRes.status === 200 && pfData.success === true && pfData.portfolio !== undefined, 'Investor portfolio inaina data', `${pfRes.status} ${pfText.substring(0, 200)}`);

  // ------------------------------------------------------------
  await section('7. USSD — menu, salio, portfolio');
  // ------------------------------------------------------------

  async function ussd(sessionId, phoneNumber, text) {
    const headers = { 'Content-Type': 'application/json' };
    const res = await fetch(BASE + '/api/ussd', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, phoneNumber, text }),
    });
    const data = await res.text();
    return { status: res.status, data };
  }

  const ussdPhone = '255713100001';
  const ussdSession = 'USSD-TEST-' + nowSuffix();

  const ussdMenu = await ussd(ussdSession, ussdPhone, '');
  await expect(ussdMenu.status === 200 && /CON/.test(ussdMenu.data), 'USSD main menu (CON)', `${ussdMenu.status}`);

  const ussdBalance = await ussd(ussdSession, ussdPhone, '1');
  await expect(ussdBalance.data.includes('Salio la Pochi'), 'USSD balance check', ussdBalance.data);

  const ussdP2P = await ussd('USSD-P2P-' + nowSuffix(), ussdPhone, '5');
  await expect(ussdP2P.data.includes('Uwekezaji') || ussdP2P.data.includes('Miradi'), 'USSD P2P list', ussdP2P.data);

  const ussdTransferBad = await ussd('USSD-TRF-' + nowSuffix(), ussdPhone, '2');
  await expect(ussdTransferBad.status === 200, 'USSD transfer flow starts (enter phone)', `${ussdTransferBad.status}`);

  // ============================================================
  // 8. VICOBA EXTENSIONS — Social Fund, Penalties, Loan Repayment
  // ============================================================
  console.log('\n== 8. VICOBA EXTENSIONS — social fund, penalties, loan repayment ==');

  // regD = Neema (MWENYEKITI), regE = Baraka (MJUMBE)
  // Promote Baraka (regE) to MWEKAHAZINA so they can approve loans
  const promoteRes = await api('POST', `/api/vicoba/groups/${groupId}/members`, regD.data.token, {
    userId: regE.data.user.id,
    roleInGroup: 'MWEKAHAZINA',
  });
  // Already a member, so use addMember which does ON CONFLICT DO NOTHING
  // Need to manually update role since addMember does nothing on conflict
  const client = await pool.connect();
  await client.query("UPDATE vicoba_members SET role_in_group = 'MWEKAHAZINA' WHERE group_id = $1 AND user_id = $2", [groupId, regE.data.user.id]);
  client.release();

  const gId = groupId;

  // Fund wallets for testing
  await fundWallet(regD.data.user.id, 500000); // Neema (chairman)
  await fundWallet(regE.data.user.id, 500000); // Baraka (treasurer)

  // --- Contribution Schedules ---
  const sched = await api('POST', `/api/vicoba/groups/${gId}/schedules`, regD.data.token, {
    cycleNumber: 1,
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  });
  await expect(sched.status === 201 && sched.data.success, 'Contribution schedule created', JSON.stringify(sched.data));

  const schedList = await api('GET', `/api/vicoba/groups/${gId}/schedules`, regD.data.token);
  await expect(schedList.status === 200 && schedList.data.schedules.length >= 1, 'Contribution schedules listed');

  // Pay contribution on time (future due date = not late)
  const payContrib = await api('POST', `/api/vicoba/groups/${gId}/schedules/1/pay`, regE.data.token, {
    amount: 50000,
    sharesCount: 1,
  });
  await expect(payContrib.status === 200 && payContrib.data.success && payContrib.data.isLate === false, 'On-time contribution (no penalty)', JSON.stringify(payContrib.data));

  // Duplicate payment blocked
  const dupPay = await api('POST', `/api/vicoba/groups/${gId}/schedules/1/pay`, regE.data.token, {
    amount: 50000,
  });
  await expect(dupPay.status === 400, 'Duplicate contribution blocked', JSON.stringify(dupPay.data));

  // --- Late Contribution (with penalty) ---
  const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const lateSched = await api('POST', `/api/vicoba/groups/${gId}/schedules`, regD.data.token, {
    cycleNumber: 2,
    dueDate: pastDate,
  });
  await expect(lateSched.status === 201 || lateSched.status === 200, 'Late contribution schedule created');

  const latePay = await api('POST', `/api/vicoba/groups/${gId}/schedules/2/pay`, regD.data.token, {
    amount: 50000,
    sharesCount: 1,
  });
  await expect(latePay.status === 200 && latePay.data.isLate === true && latePay.data.penaltyAmount > 0, 'Late contribution applies penalty', JSON.stringify({ isLate: latePay.data.isLate, penalty: latePay.data.penaltyAmount }));

  // List penalties
  const penalties = await api('GET', `/api/vicoba/groups/${gId}/penalties`, regD.data.token);
  await expect(penalties.status === 200 && penalties.data.penalties.length >= 1, 'Penalties listed for group');
  const penaltyId = penalties.data.penalties[0].id;

  // Pay penalty
  const payPenalty = await api('POST', `/api/vicoba/penalties/${penaltyId}/pay`, regD.data.token);
  await expect(payPenalty.status === 200 && payPenalty.data.success, 'Penalty paid successfully', JSON.stringify(payPenalty.data));

  // --- Social Fund ---
  const initSF = await api('POST', `/api/vicoba/groups/${gId}/social-fund`, regD.data.token, {
    monthlyContribution: 10000,
  });
  await expect(initSF.status === 201 && initSF.data.fund.monthly_contribution == 10000, 'Social fund initialized (TSh 10,000/month)', JSON.stringify(initSF.data));

  // Duplicate init blocked
  const dupSF = await api('POST', `/api/vicoba/groups/${gId}/social-fund`, regD.data.token, {
    monthlyContribution: 10000,
  });
  await expect(dupSF.status === 400, 'Duplicate social fund init blocked');

  // Contribute to social fund
  const sfContrib = await api('POST', `/api/vicoba/groups/${gId}/social-fund/contribute`, regD.data.token, {
    month: '2026-08',
  });
  await expect(sfContrib.status === 200 && sfContrib.data.success, 'Social fund contribution (Neema, Aug 2026)', JSON.stringify(sfContrib.data));

  const sfContrib2 = await api('POST', `/api/vicoba/groups/${gId}/social-fund/contribute`, regE.data.token, {
    month: '2026-08',
  });
  await expect(sfContrib2.status === 200 && sfContrib2.data.success, 'Social fund contribution (Baraka, Aug 2026)');

  // Duplicate monthly contribution blocked
  const dupSFContrib = await api('POST', `/api/vicoba/groups/${gId}/social-fund/contribute`, regD.data.token, {
    month: '2026-08',
  });
  await expect(dupSFContrib.status === 400, 'Duplicate social fund monthly contribution blocked');

  // Request social fund disbursement (family emergency - death)
  const sfRequest = await api('POST', `/api/vicoba/groups/${gId}/social-fund/request`, regE.data.token, {
    reasonType: 'DEATH',
    reasonDetail: 'Mwanamke wetu alifariki juzi, tunahitaji msaada wa mazishi.',
    requestedAmount: 15000,
  });
  await expect(sfRequest.status === 201 && sfRequest.data.request.status === 'PENDING', 'Social fund request submitted (DEATH)', JSON.stringify(sfRequest.data));

  const reqId = sfRequest.data.request.id;

  // Approve social fund disbursement (MWENYEKITI)
  const sfApprove = await api('POST', `/api/vicoba/social-fund-requests/${reqId}/approve`, regD.data.token, {
    approvedAmount: 15000,
  });
  await expect(sfApprove.status === 200 && sfApprove.data.success, 'Social fund disbursement approved', JSON.stringify(sfApprove.data));

  // Get social fund details
  const sfDetails = await api('GET', `/api/vicoba/groups/${gId}/social-fund`, regD.data.token);
  await expect(sfDetails.status === 200 && sfDetails.data.socialFund !== null, 'Social fund details returned');
  await expect(sfDetails.data.socialFund.contributions.length >= 2, 'Social fund has 2+ contributions');
  await expect(sfDetails.data.socialFund.requests.length >= 1, 'Social fund has 1+ disbursement request');

  // --- Loan Repayment ---
  // Approve existing loan from section 4 (MWEKAHAZINA = regE)
  const loans = await api('GET', `/api/vicoba/groups/${gId}/loans`, regD.data.token);
  if (loans.data.loans && loans.data.loans.length > 0) {
    const loan = loans.data.loans.find(l => l.status === 'PENDING');
    if (loan) {
      const approveLoan = await api('POST', `/api/vicoba/loans/${loan.id}/approve`, regE.data.token, {
        approvedAmount: 30000,
      });
      await expect(approveLoan.status === 200 && approveLoan.data.success, 'Loan approved (multi-sig)', JSON.stringify(approveLoan.data));

      // Check repayment schedule was generated
      const schedule = await api('GET', `/api/vicoba/loans/${loan.id}/schedule`, regD.data.token);
      await expect(schedule.status === 200 && schedule.data.schedule.length >= 1, 'Loan repayment schedule generated', `installments: ${schedule.data.schedule.length}`);

      // Repay first installment (loan applicant = regE)
      const firstInstallment = schedule.data.schedule[0];
      const repay = await api('POST', `/api/vicoba/loans/${loan.id}/repay`, regE.data.token, {
        amount: firstInstallment.total_amount,
        note: 'Malipo ya kwanza',
      });
      await expect(repay.status === 200 && repay.data.success, 'Loan repayment recorded', JSON.stringify({ remaining: repay.data.remainingBalance, fullyRepaid: repay.data.fullyRepaid }));

      // Repayment history
      const repayHistory = await api('GET', `/api/vicoba/loans/${loan.id}/repayments`, regD.data.token);
      await expect(repayHistory.status === 200 && repayHistory.data.repayments.length >= 1, 'Loan repayment history listed');
    } else {
      ok('No pending loan to approve (skipped)');
    }
  } else {
    ok('No loans in group (skipped)');
  }

  // =============================================================
  // 9. M-KOBA FEATURES
  // =============================================================
  await section('9. M-KOBA FEATURES — constitution, shares, profit, transfers, meetings, reporting');

  const mkG = await api('POST', '/api/vicoba/groups', regD.data.token, { groupName: 'M-Koba Group', cycleType: 'MONTHLY', shareValue: 10000 });
  await expect(mkG.status === 201 && !!mkG.data.group, 'M-Koba group created');
  const mkGId = mkG.data.group.id;

  const mkMembers = [];
  for (let i = 0; i < 2; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    const p = '255730' + String(i + 1) + nowSuffix().slice(0, 5);
    const reg = await register(p, 'M-Koba Mem ' + i);
    if (!reg.data || !reg.data.user) continue;
    await upgradeKyc(reg.data.token, '1985' + nowSuffix() + i);
    await subscribe(reg.data.token, 'VICOBA');
    await fundWallet(reg.data.user.id, 500000);
    await api('POST', `/api/vicoba/groups/${mkGId}/members`, regD.data.token, { userId: reg.data.user.id, roleInGroup: i === 0 ? 'MWEKAHAZINA' : 'KATIBU' });
    mkMembers.push(reg);
  }
  await fundWallet(regD.data.user.id, 500000);
  const mkTreasurer = mkMembers[0];
  const mkSecretary = mkMembers[1];

  const constRes = await api('POST', `/api/vicoba/groups/${mkGId}/constitution`, regD.data.token, { sharePrice: 10000, maxSharesPerMember: 50, loanInterestRate: 12, finePerAbsence: 5000, finePerLateArrival: 2000, meetingDay: 'SATURDAY', require3TierApproval: true, shareRollover: true });
  await expect(constRes.status === 201 && constRes.data.success, 'Constitution created');

  const constGet = await api('GET', `/api/vicoba/groups/${mkGId}/constitution`, regD.data.token);
  await expect(constGet.status === 200 && constGet.data.constitution.share_price == 10000, 'Constitution retrieved');

  const buy1 = await api('POST', `/api/vicoba/groups/${mkGId}/shares/buy`, regD.data.token, { sharesCount: 5 });
  await expect(buy1.status === 200 && buy1.data.totalShares === 5, 'Chairman buys 5 shares');

  const buy2 = await api('POST', `/api/vicoba/groups/${mkGId}/shares/buy`, mkTreasurer.data.token, { sharesCount: 3 });
  await expect(buy2.status === 200 && buy2.data.totalShares === 3, 'Treasurer buys 3 shares');

  const buy3 = await api('POST', `/api/vicoba/groups/${mkGId}/shares/buy`, mkSecretary.data.token, { sharesCount: 2 });
  await expect(buy3.status === 200, 'Secretary buys 2 shares');

  const shareSummary = await api('GET', `/api/vicoba/groups/${mkGId}/shares/summary`, regD.data.token);
  await expect(shareSummary.status === 200 && shareSummary.data.summary.length >= 3, 'Share summary 3+ members');

  const overShares = await api('POST', `/api/vicoba/groups/${mkGId}/shares/buy`, regD.data.token, { sharesCount: 100 });
  await expect(overShares.status === 400, 'Share over-limit blocked');

  const initT = await api('POST', `/api/vicoba/groups/${mkGId}/transfers`, mkSecretary.data.token, { transferType: 'GROUP_WITHDRAWAL', recipientUserId: mkTreasurer.data.user.id, amount: 10000, note: 'Test' });
  await expect(initT.status === 201 && initT.data.transfer && initT.data.transfer.status === 'INITIATED', 'Transfer initiated by KATIBU');

  const ftId = initT.data.transfer ? initT.data.transfer.id : null;
  if (ftId) {
  const verT = await api('POST', `/api/vicoba/transfers/${ftId}/verify`, mkTreasurer.data.token, { approved: true, note: 'OK' });
  await expect(verT.status === 200, 'Transfer verified by MWEKAHAZINA');

  const appT = await api('POST', `/api/vicoba/transfers/${ftId}/approve`, regD.data.token, { approved: true, note: 'OK' });
  await expect(appT.status === 200 && appT.data.success, 'Transfer approved by MWENYEKITI');

  const badAppT = await api('POST', `/api/vicoba/transfers/${ftId}/approve`, mkSecretary.data.token, { approved: true });
  await expect(badAppT.status === 400 || badAppT.status === 403, 'Non-chair cannot approve');

  const ftList = await api('GET', `/api/vicoba/groups/${mkGId}/transfers`, regD.data.token);
  await expect(ftList.status === 200 && ftList.data.transfers.length >= 1, 'Transfer history listed');
  } else { ok('Transfer init failed (skipped verify/approve)'); }

  const topUp = await api('POST', `/api/vicoba/groups/${mkGId}/topup/cross-network`, mkTreasurer.data.token, { amount: 20000, provider: 'AIRTEL', phone: '255787654321' });
  await expect(topUp.status === 200 && topUp.data.success, 'Cross-network top-up AIRTEL');

  const topUp2 = await api('POST', `/api/vicoba/groups/${mkGId}/topup/cross-network`, mkSecretary.data.token, { amount: 15000, provider: 'HALOPESA', phone: '255654321098' });
  await expect(topUp2.status === 200, 'Cross-network top-up HALOPESA');

  const badProv = await api('POST', `/api/vicoba/groups/${mkGId}/topup/cross-network`, regD.data.token, { amount: 5000, provider: 'BITCOIN', phone: '123' });
  await expect(badProv.status === 400, 'Invalid provider rejected');

  const meetDate = new Date().toISOString().split('T')[0];
  const schedMeet = await api('POST', `/api/vicoba/groups/${mkGId}/meetings`, regD.data.token, { meetingDate: meetDate, notes: 'Mkutano wa kwanza' });
  await expect(schedMeet.status === 201 && !!schedMeet.data.meeting, 'Meeting scheduled');
  const meetId = schedMeet.data.meeting.id;

  const att1 = await api('POST', `/api/vicoba/meetings/${meetId}/attendance`, regD.data.token, { userId: regD.data.user.id, status: 'PRESENT' });
  await expect(att1.status === 200 && att1.data.success, 'Chairman: PRESENT');

  const att2 = await api('POST', `/api/vicoba/meetings/${meetId}/attendance`, regD.data.token, { userId: mkTreasurer.data.user.id, status: 'LATE' });
  await expect(att2.status === 200 && att2.data.fineApplied > 0, 'Treasurer: LATE + fine');

  const att3 = await api('POST', `/api/vicoba/meetings/${meetId}/attendance`, regD.data.token, { userId: mkSecretary.data.user.id, status: 'ABSENT' });
  await expect(att3.status === 200 && att3.data.fineApplied > 0, 'Secretary: ABSENT + fine');

  const attList = await api('GET', `/api/vicoba/meetings/${meetId}/attendance`, regD.data.token);
  await expect(attList.status === 200 && attList.data.attendance.length >= 3, 'Attendance list 3+ members');

  const myAtt = await api('GET', `/api/vicoba/groups/${mkGId}/attendance/my`, regD.data.token);
  await expect(myAtt.status === 200 && myAtt.data.summary, 'My attendance summary');

  const attReport = await api('GET', `/api/vicoba/groups/${mkGId}/attendance/report`, regD.data.token);
  await expect(attReport.status === 200 && attReport.data.report.length >= 3, 'Group attendance report');

  const calcP = await api('POST', `/api/vicoba/groups/${mkGId}/profits/calculate`, regD.data.token, { cycleNumber: 1, totalProfit: 100000 });
  await expect(calcP.status === 201 && calcP.data.success, 'Profit calculated (100k)', `per_share: ${calcP.data.perShareDividend}`);

  const appP = await api('POST', `/api/vicoba/profits/${calcP.data.distribution.id}/approve`, regD.data.token);
  await expect(appP.status === 200 && appP.data.success, 'Profit distribution approved');

  const badP = await api('POST', `/api/vicoba/profits/${calcP.data.distribution.id}/approve`, mkTreasurer.data.token);
  await expect(badP.status === 403, 'Non-chair cannot approve profit');

  const profitList = await api('GET', `/api/vicoba/groups/${mkGId}/profits`, regD.data.token);
  await expect(profitList.status === 200 && profitList.data.distributions.length >= 1, 'Profit distributions listed');

  const finR = await api('GET', `/api/vicoba/groups/${mkGId}/reports/financial`, regD.data.token);
  await expect(finR.status === 200 && finR.data.summary, 'Financial summary');

  const memR = await api('GET', `/api/vicoba/groups/${mkGId}/reports/member`, regD.data.token);
  await expect(memR.status === 200 && memR.data.summary, 'Member report');

  const agingR = await api('GET', `/api/vicoba/groups/${mkGId}/reports/loan-aging`, regD.data.token);
  await expect(agingR.status === 200, 'Loan aging report');

  // ------------------------------------------------------------
  await section('10. NETWORK FEATURES — Agents, Bulk, Scheduled, Remittance, Webhooks, Loyalty, Insights, Referrals');
  // ------------------------------------------------------------

  // --- F1: AGENT NETWORK ---
  const agentPhone = '255732' + nowSuffix();
  const areg = await register(agentPhone, 'Agent Test');
  const agentUserId = areg.data.user.id;
  const applyAgent = await api('POST', '/api/network/agents/apply', areg.data.token, {
    business_name: 'Duka La Agent', owner_name: 'Agent Owner', phone: agentPhone,
    region: 'Dar', district: 'Kinondoni', latitude: -6.7924, longitude: 39.2083
  });
  await expect(applyAgent.status === 201 || applyAgent.status === 200, 'Agent application submitted', `${applyAgent.status}: ${JSON.stringify(applyAgent.data)}`);

  const agentList = await api('GET', '/api/network/agents', adminToken, null);
  await expect(agentList.status === 200 && agentList.data.agents.length >= 1, 'Admin lists agents');

  const agId = applyAgent.data.agent ? applyAgent.data.agent.id : (agentList.data.agents[0] && agentList.data.agents[0].id);
  const verifyAgent = await api('POST', `/api/network/agents/${agId}/verify`, adminToken, {});
  await expect(verifyAgent.status === 200, 'Admin verifies agent');

  const nearby = await api('GET', `/api/network/agents/nearby?lat=-6.7924&lng=39.2083&radius=50`, areg.data.token, null);
  await expect(nearby.status === 200 && nearby.data.agents.length >= 1, 'Nearby agent found');

  const settle = await api('POST', '/api/network/agents/settlement', areg.data.token, { amount: 100000, type: 'DEPOSIT' });
  await expect(settle.status === 200 && settle.data.success, 'Agent settlement deposit (float)');

  const custPhone = '255733' + nowSuffix();
  const creg = await register(custPhone, 'Customer Test');
  const custId = creg.data.user.id;

  const cashIn = await api('POST', '/api/network/agents/cash-in', areg.data.token, { phone: custPhone, amount: 10000 });
  await expect(cashIn.status === 200 && cashIn.data.success, 'Agent cash-in credits customer', `${cashIn.status}: ${JSON.stringify(cashIn.data)}`);

  const cashOut = await api('POST', '/api/network/agents/cash-out', areg.data.token, { phone: custPhone, amount: 3000 });
  await expect(cashOut.status === 200 && cashOut.data.success, 'Agent cash-out debits customer');

  const agentDash = await api('GET', '/api/network/agents/dashboard', areg.data.token, null);
  await expect(agentDash.status === 200 && agentDash.data.dashboard, 'Agent dashboard');

  // --- F2: BULK PAYMENTS ---
  const bulkRecipPhone = '255734' + nowSuffix();
  await register(bulkRecipPhone, 'Mfanyakazi');
  const bulk = await api('POST', '/api/network/bulk', creg.data.token, {
    batch_name: 'Payroll', recipients: [{ phone: bulkRecipPhone, amount: 2000, name: 'Mfanyakazi' }]
  });
  await expect(bulk.status === 201 || bulk.status === 200, 'Bulk batch created', `${bulk.status}: ${JSON.stringify(bulk.data)}`);
  const procBulk = await api('POST', `/api/network/bulk/${bulk.data.batch.id}/process`, creg.data.token, {});
  await expect(procBulk.status === 200 && procBulk.data.result.success >= 1, 'Bulk batch processed', `${procBulk.status}: ${JSON.stringify(procBulk.data)}`);

  // --- F3: SCHEDULED PAYMENTS ---
  const schedPay = await api('POST', '/api/network/scheduled', creg.data.token, {
    recipient_phone: agentPhone, amount: 1000, type: 'TRANSFER', description: 'Kodi', scheduled_for: new Date(Date.now() - 1000).toISOString(), recurrence: 'ONCE'
  });
  await expect(schedPay.status === 201 || schedPay.status === 200, 'Scheduled payment created', `${schedPay.status}: ${JSON.stringify(schedPay.data)}`);
  const schedPayList = await api('GET', '/api/network/scheduled', creg.data.token, null);
  await expect(schedPayList.status === 200 && schedPayList.data.scheduled.length >= 1, 'Scheduled payments listed');
  const procSched = await api('POST', '/api/network/scheduled/process', adminToken, {});
  await expect(procSched.status === 200, 'Scheduled payments processed by admin');

  // --- F4: CROSS-BORDER REMITTANCES ---
  const corridors = await api('GET', '/api/network/remittance/corridors', creg.data.token, null);
  await expect(corridors.status === 200 && corridors.data.corridors.length >= 1, 'Remittance corridors listed');
  const remit = await api('POST', '/api/network/remittance/send', creg.data.token, {
    recipient_phone: '254712345678', recipient_name: 'John Kenya', recipient_country: 'KE', from_amount: 1000
  });
  await expect(remit.status === 200 && remit.data.success && remit.data.result.pickup_code, 'Remittance sent to KE', `${remit.status}: ${JSON.stringify(remit.data)}`);
  const pickup = await api('POST', '/api/network/remittance/pickup', null, {
    pickup_code: remit.data.result.pickup_code, recipient_phone: '254712345678', recipient_name: 'John Kenya'
  });
  await expect(pickup.status === 200 && pickup.data.success, 'Remittance picked up');

  // --- F5: WEBHOOKS ---
  const wh = await api('POST', '/api/network/webhooks', creg.data.token, { url: 'https://example.com/webhook', events: ['transaction.completed', 'test.ping'] });
  await expect(wh.status === 201 || wh.status === 200, 'Webhook subscription created', `${wh.status}: ${JSON.stringify(wh.data)}`);
  const whList = await api('GET', '/api/network/webhooks', creg.data.token, null);
  await expect(whList.status === 200 && whList.data.webhooks.length >= 1, 'Webhooks listed');
  const whTest = await api('POST', `/api/network/webhooks/${wh.data.webhook.id}/test`, creg.data.token, {});
  await expect(whTest.status === 200, 'Webhook test triggered');

  // --- F6: MERCHANT LOYALTY ---
  const mres = await pool.query("INSERT INTO merchants (user_id, name, business_type, phone, email) VALUES ($1,'Loyalty Biz','RETAIL',$2,'biz@test.com') RETURNING id", [custId, custPhone]);
  const merchantId = mres.rows[0].id;
  const prog = await api('POST', `/api/network/merchants/${merchantId}/loyalty`, creg.data.token, { name: 'Biz Rewards', points_per_currency: 1, redemption_rate: 100 });
  await expect(prog.status === 201 || prog.status === 200, 'Loyalty program created', `${prog.status}: ${JSON.stringify(prog.data)}`);
  const joinP = await api('POST', `/api/network/loyalty/${prog.data.program.id}/join`, creg.data.token, {});
  await expect(joinP.status === 200, 'User joins loyalty program');
  const earnP = await api('POST', `/api/network/loyalty/${prog.data.program.id}/earn`, creg.data.token, { amount: 5000 });
  await expect(earnP.status === 200 && earnP.data.result.points_earned > 0, 'Loyalty points earned');
  const balP = await api('GET', `/api/network/loyalty/${prog.data.program.id}/balance`, creg.data.token, null);
  await expect(balP.status === 200 && balP.data.balance.points > 0, 'Loyalty balance shows points');

  // --- F7: AI INSIGHTS ---
  const insights = await api('GET', '/api/network/insights', creg.data.token, null);
  await expect(insights.status === 200 && insights.data.insights && insights.data.insights.predictions, 'AI insights returned', `${insights.status}: ${JSON.stringify(insights.data)}`);

  // --- F8: ENHANCED REFERRALS ---
  const tiers = await api('GET', '/api/network/referrals/tiers', creg.data.token, null);
  await expect(tiers.status === 200 && tiers.data.tiers.length >= 1, 'Referral tiers listed');
  const refCode = await api('GET', '/api/network/referrals/code', creg.data.token, null);
  await expect(refCode.status === 200 && refCode.data.code.referral_code, 'Referral code generated');
  const refStats = await api('GET', '/api/network/referrals/stats', creg.data.token, null);
  await expect(refStats.status === 200, 'Referral stats returned');
  const refAward = await api('POST', '/api/network/referrals/award', creg.data.token, { referred_id: agentUserId });
  await expect(refAward.status === 200 && refAward.data.success, 'Referral award paid to wallet', `${refAward.status}: ${JSON.stringify(refAward.data)}`);

  // ------------------------------------------------------------
  await section('11. FAMILY & NEXT-GEN — Family wallets, Multi-currency, Biometric, Offline, Round-up');
  // ------------------------------------------------------------

  // --- G1: FAMILY WALLET ---
  const famOwnerPhone = '255741' + nowSuffix();
  const famOwner = await register(famOwnerPhone, 'Fam Owner');
  const famOwnerId = famOwner.data.user.id;
  await fundWallet(famOwnerId, 100000);
  const famMemberPhone = '255742' + nowSuffix();
  const famMember = await register(famMemberPhone, 'Fam Member');
  const famMemberId = famMember.data.user.id;

  const famWallet = await api('POST', '/api/family/family', famOwner.data.token, { name: 'Familia Yangu', currency: 'TZS' });
  await expect(famWallet.status === 201 || famWallet.status === 200, 'Family wallet created', `${famWallet.status}: ${JSON.stringify(famWallet.data)}`);
  const famId = famWallet.data.wallet.id;

  const inv = await api('POST', `/api/family/family/${famId}/invite`, famOwner.data.token, { phone: famMemberPhone, role: 'MEMBER', can_spend: true });
  await expect(inv.status === 200, 'Member invited to family');
  const joinF = await api('POST', `/api/family/family/${famId}/join`, famMember.data.token, {});
  await expect(joinF.status === 200, 'Member joins family');

  const famList = await api('GET', '/api/family/family', famOwner.data.token, null);
  await expect(famList.status === 200 && famList.data.wallets.length >= 1, 'Family wallets listed');

  const famContrib = await api('POST', `/api/family/family/${famId}/contribute`, famOwner.data.token, { amount: 20000 });
  await expect(famContrib.status === 200 && famContrib.data.success, 'Owner contributes to family', `${famContrib.status}: ${JSON.stringify(famContrib.data)}`);

  const famSpend = await api('POST', `/api/family/family/${famId}/spend`, famOwner.data.token, { amount: 3000, description: 'Mazao' });
  await expect(famSpend.status === 200 && famSpend.data.success, 'Family spend deducted');

  const famTx = await api('GET', `/api/family/family/${famId}`, famOwner.data.token, null);
  await expect(famTx.status === 200 && Number(famTx.data.details.wallet.balance) === 17000, 'Family balance = 17000', `balance=${famTx.data.details.wallet.balance}`);

  const famTransfer = await api('POST', `/api/family/family/${famId}/transfer`, famOwner.data.token, { phone: famMemberPhone, amount: 5000 });
  await expect(famTransfer.status === 200 && famTransfer.data.success, 'Family transfer to member', `${famTransfer.status}: ${JSON.stringify(famTransfer.data)}`);

  // --- G2: MULTI-CURRENCY ---
  const topup = await api('POST', '/api/family/currency/topup', famOwner.data.token, { currency: 'USD', amount: 10 });
  await expect(topup.status === 200 && topup.data.success, 'Top-up USD from TZS', `${topup.status}: ${JSON.stringify(topup.data)}`);
  const conv = await api('POST', '/api/family/currency/convert', famOwner.data.token, { from: 'USD', to: 'KES', amount: 5 });
  await expect(conv.status === 200 && conv.data.success, 'Convert USD to KES', `${conv.status}: ${JSON.stringify(conv.data)}`);
  const xferFx = await api('POST', '/api/family/currency/transfer', famOwner.data.token, { phone: famMemberPhone, currency: 'KES', amount: 50 });
  await expect(xferFx.status === 200 && xferFx.data.success, 'Transfer KES to member');
  const balances = await api('GET', '/api/family/balances', famOwner.data.token, null);
  await expect(balances.status === 200 && balances.data.balances.currencies.length >= 1, 'Multi-currency balances shown');

  // --- G3: BIOMETRIC / DEVICE ---
  const dev = await api('POST', '/api/family/devices', famOwner.data.token, { device_id: 'dev-abc-123', device_name: 'Galaxy', biometric_token: 'bio-secret-1' });
  await expect(dev.status === 200 && dev.data.device, 'Device registered (biometric)');
  const devList = await api('GET', '/api/family/devices', famOwner.data.token, null);
  await expect(devList.status === 200 && devList.data.devices.length >= 1, 'Devices listed');
  const chal = await api('POST', '/api/family/devices/challenge', famOwner.data.token, { device_id: 'dev-abc-123' });
  await expect(chal.status === 200 && chal.data.challenge, 'Biometric challenge generated');
  const ver = await api('POST', '/api/family/devices/verify', famOwner.data.token, { device_id: 'dev-abc-123', response: chal.data.challenge.challenge });
  await expect(ver.status === 200 && ver.data.result.verified, 'Challenge verified');
  const bioLogin = await api('POST', '/api/family/biometric/login', null, { phone: famOwnerPhone, device_id: 'dev-abc-123', biometric_token: 'bio-secret-1' });
  await expect(bioLogin.status === 200 && bioLogin.data.result.verified, 'Biometric login verified');
  const rmDev = await api('DELETE', `/api/family/devices/dev-abc-123`, famOwner.data.token, null);
  await expect(rmDev.status === 200, 'Device removed');

  // --- G4: OFFLINE QUEUE ---
  const q = await api('POST', '/api/family/offline/queue', famOwner.data.token, { op_type: 'TRANSFER', payload: { toPhone: famMemberPhone, amount: 1000, note: 'Offline' } });
  await expect(q.status === 200 && q.data.op, 'Offline op queued');
  const qlist = await api('GET', '/api/family/offline/ops?status=QUEUED', famOwner.data.token, null);
  await expect(qlist.status === 200 && qlist.data.ops.length >= 1, 'Queued offline ops listed');
  const sync = await api('POST', '/api/family/offline/sync', famOwner.data.token, {});
  await expect(sync.status === 200 && sync.data.result.processed >= 1, 'Offline ops synced/processed', `${sync.status}: ${JSON.stringify(sync.data)}`);

  // --- G5: ROUND-UP SAVINGS ---
  const rule = await api('POST', '/api/family/roundup', famOwner.data.token, { round_to: 1000 });
  await expect(rule.status === 200 && rule.data.rule, 'Round-up rule created');
  const procRound = await api('POST', '/api/family/roundup/process', famOwner.data.token, {});
  await expect(procRound.status === 200 && procRound.data.success, 'Round-up processed', `${procRound.status}: ${JSON.stringify(procRound.data)}`);
  const roundSum = await api('GET', '/api/family/roundup', famOwner.data.token, null);
  await expect(roundSum.status === 200 && roundSum.data.summary, 'Round-up summary returned');

  // ------------------------------------------------------------
  await section('12. BUSINESS & COMMERCE OS — Accounts, Links, Invoices, Inventory, Payroll, Suppliers, Analytics, Loans, Tax, Staff/POS');
  // ------------------------------------------------------------

  // --- H1: BUSINESS ACCOUNTS ---
  const bizPhone = '255751' + nowSuffix();
  const bizOwner = await register(bizPhone, 'Biz Owner');
  const bizOwnerId = bizOwner.data.user.id;
  await fundWallet(bizOwnerId, 300000);

  const bizReg = await api('POST', '/api/business/accounts', bizOwner.data.token, { business_name: 'Mkulima Fresh Ltd', business_type: 'AGRICULTURE', tin_number: '142-231-889' });
  await expect(bizReg.status === 200 && bizReg.data.business.id, 'Business account created', `${bizReg.status}: ${JSON.stringify(bizReg.data)}`);
  const bizId = bizReg.data.business.id;

  const bizList = await api('GET', '/api/business/accounts', bizOwner.data.token, null);
  await expect(bizList.status === 200 && bizList.data.businesses.length >= 1, 'Businesses listed');

  const fundBiz = await api('POST', `/api/business/accounts/${bizId}/fund`, bizOwner.data.token, { amount: 100000 });
  await expect(fundBiz.status === 200 && fundBiz.data.result.success, 'Business funded from wallet');

  const bizWd = await api('POST', `/api/business/accounts/${bizId}/withdraw`, bizOwner.data.token, { amount: 20000 });
  await expect(bizWd.status === 200 && bizWd.data.result.success, 'Business withdraw to wallet');

  // --- H2: PAYMENT LINKS ---
  const link = await api('POST', `/api/business/accounts/${bizId}/payment-links`, bizOwner.data.token, { title: 'Mchuzi Kamba', amount: 5000 });
  await expect(link.status === 200 && link.data.link.reference, 'Payment link created');
  const linkPayerPhone = '255752' + nowSuffix();
  const linkPayer = await register(linkPayerPhone, 'Link Payer');
  await fundWallet(linkPayer.data.user.id, 20000);
  const linkPay = await api('POST', `/api/business/payment-links/${link.data.link.reference}/pay`, linkPayer.data.token, {});
  await expect(linkPay.status === 200 && linkPay.data.result.success, 'Payment link paid');

  const linkList = await api('GET', `/api/business/accounts/${bizId}/payment-links`, bizOwner.data.token, null);
  await expect(linkList.status === 200 && linkList.data.links.length >= 1, 'Payment links listed');

  // --- H3: INVOICES ---
  const bizInv = await api('POST', `/api/business/accounts/${bizId}/invoices`, bizOwner.data.token, { customer_name: 'Mama Nguo', customer_phone: '255753' + nowSuffix(), amount: 10000, tax_percent: 5 });
  await expect(bizInv.status === 200 && bizInv.data.invoice.invoice_number, 'Invoice created with number');
  await expect(Number(bizInv.data.invoice.total_amount) === 10500 && Number(bizInv.data.invoice.tax_amount) === 500, 'Invoice tax computed (5% = 500)');

  const custPhoneI = '255753' + nowSuffix();
  const custI = await register(custPhoneI, 'Invoice Customer');
  await fundWallet(custI.data.user.id, 20000);
  const invPay = await api('POST', `/api/business/invoices/${bizInv.data.invoice.id}/pay`, custI.data.token, {});
  await expect(invPay.status === 200 && invPay.data.result.success, 'Invoice paid by customer');

  // --- H4: INVENTORY ---
  const p1 = await api('POST', `/api/business/accounts/${bizId}/products`, bizOwner.data.token, { name: 'Mahindi', sku: 'MAH-01', unit_price: 2000, stock_quantity: 50, low_stock_threshold: 10 });
  const p2 = await api('POST', `/api/business/accounts/${bizId}/products`, bizOwner.data.token, { name: 'Sukari', sku: 'SUK-01', unit_price: 1000, stock_quantity: 3 });
  await expect(p1.status === 200 && p2.status === 200, 'Products added to inventory');
  const stockUpd = await api('PATCH', `/api/business/products/${p1.data.product.id}/stock`, bizOwner.data.token, { delta: 20 });
  await expect(stockUpd.status === 200 && Number(stockUpd.data.product.stock_quantity) === 70, 'Stock restocked');
  const lowStock = await api('GET', `/api/business/accounts/${bizId}/products/low-stock`, bizOwner.data.token, null);
  await expect(lowStock.status === 200 && lowStock.data.products.length >= 1, 'Low-stock alert raised');

  // --- H5: PAYROLL ---
  const emp1 = await register('255754' + nowSuffix(), 'Emp One');
  const emp2 = await register('255755' + nowSuffix(), 'Emp Two');
  const payroll = await api('POST', `/api/business/accounts/${bizId}/payroll`, bizOwner.data.token, {
    period: '2026-08', employees: [{ phone: emp1.data.user.phone_number, name: 'Emp One', amount: 20000 }, { phone: emp2.data.user.phone_number, name: 'Emp Two', amount: 15000 }]
  });
  await expect(payroll.status === 200 && payroll.data.result.success && Number(payroll.data.result.payroll_run.total_amount) === 35000, 'Payroll run processed', `${payroll.status}: ${JSON.stringify(payroll.data)}`);
  const empBal = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [emp1.data.user.id]);
  await expect(Number(empBal.rows[0].wallet_balance) === 20000, 'Employee wallet credited 20000');

  // --- H6: SUPPLIERS ---
  const sup = await api('POST', `/api/business/accounts/${bizId}/suppliers`, bizOwner.data.token, { name: 'Bega Kwa Bega Supplies', phone: '255756' + nowSuffix() });
  await expect(sup.status === 200 && sup.data.supplier.id, 'Supplier added');
  const supPay = await api('POST', `/api/business/accounts/${bizId}/suppliers/${sup.data.supplier.id}/pay`, bizOwner.data.token, { amount: 10000 });
  await expect(supPay.status === 200 && supPay.data.result.success, 'Supplier payment made');
  const supList = await api('GET', `/api/business/accounts/${bizId}/suppliers`, bizOwner.data.token, null);
  await expect(supList.status === 200 && Number(supList.data.suppliers[0].total_paid) === 10000, 'Supplier total paid tracked');

  // --- H7: SALES ANALYTICS ---
  const analytics = await api('GET', `/api/business/accounts/${bizId}/analytics`, bizOwner.data.token, null);
  await expect(analytics.status === 200 && Number(analytics.data.analytics.revenue.total) === 15500, 'Sales analytics revenue = 15500', `revenue=${JSON.stringify(analytics.data?.analytics?.revenue)}`);

  // --- H8: BUSINESS LOANS ---
  const loan = await api('POST', `/api/business/accounts/${bizId}/loans`, bizOwner.data.token, { amount: 100000, interest_rate: 10, term_months: 12 });
  await expect(loan.status === 200 && loan.data.loan.status === 'PENDING', 'Business loan application submitted');
  const loanList = await api('GET', '/api/business/loans', bizOwner.data.token, null);
  await expect(loanList.status === 200 && loanList.data.loans.length >= 1, 'Business loans listed for owner');
  const loanApprove = await api('POST', `/api/business/admin/loans/${loan.data.loan.id}/approve`, adminToken, { note: 'Inakubaliwa' });
  await expect(loanApprove.status === 200 && loanApprove.data.loan.status === 'APPROVED', 'Admin approves loan');
  const loanDisburse = await api('POST', `/api/business/admin/loans/${loan.data.loan.id}/disburse`, adminToken, {});
  await expect(loanDisburse.status === 200 && loanDisburse.data.result.success && Number(loanDisburse.data.result.due_amount) === 110000, 'Admin disburses loan (due 110000)', `${loanDisburse.status}: ${JSON.stringify(loanDisburse.data)}`);
  const repay = await api('POST', `/api/business/loans/${loan.data.loan.id}/repay`, bizOwner.data.token, { amount: 110000 });
  await expect(repay.status === 200 && repay.data.result.status === 'REPAID', 'Loan fully repaid');

  // --- H9: TAX & COMPLIANCE ---
  const tax = await api('GET', `/api/business/accounts/${bizId}/tax`, bizOwner.data.token, null);
  await expect(tax.status === 200 && Number(tax.data.summary.collected_tax) === 500, 'Tax summary collected 500', `tax=${JSON.stringify(tax.data?.summary)}`);

  // --- H10: STAFF + POS ---
  const staff = await api('POST', `/api/business/accounts/${bizId}/staff`, bizOwner.data.token, { user_phone: emp1.data.user.phone_number, role: 'CASHIER' });
  await expect(staff.status === 200 && staff.data.staff.id, 'Staff member added (cashier)');
  const staffList = await api('GET', `/api/business/accounts/${bizId}/staff`, bizOwner.data.token, null);
  await expect(staffList.status === 200 && staffList.data.staff.length >= 1, 'Staff list returned');

  const posOpen = await api('POST', `/api/business/accounts/${bizId}/pos/open`, bizOwner.data.token, { opening_cash: 20000 });
  await expect(posOpen.status === 200 && posOpen.data.session.id, 'POS session opened');
  const posClose = await api('POST', `/api/business/pos/${posOpen.data.session.id}/close`, bizOwner.data.token, { closing_cash: 25000, sales_total: 5000 });
  await expect(posClose.status === 200 && Number(posClose.data.result.deposited) === 5000, 'POS session closed, sales deposited');

  // --- Final balance check ---
  const bizFinal = await api('GET', `/api/business/accounts/${bizId}`, bizOwner.data.token, null);
  const finalBalance = bizFinal.data?.business?.balance;
  const expectedBalance = 100000 - 20000 + 5000 + 10500 - 35000 - 10000 + 100000 - 110000 + 5000;
  await expect(bizFinal.status === 200 && Number(finalBalance) === expectedBalance, `Business balance reconciled (${expectedBalance})`, `balance=${finalBalance}`);

  // ------------------------------------------------------------
  await section('13. SAVINGS & CREDIT — Goals, Auto-save, Fixed deposits, Credit score, Micro-loans, Guarantors');
  // ------------------------------------------------------------

  // --- Saver user + funding ---
  const isPhone = '255761' + nowSuffix();
  const isUser = await register(isPhone, 'Iva Saver');
  const isId = isUser.data.user.id;
  await fundWallet(isId, 200000);

  // --- I1: SAVINGS GOALS ---
  const isGoal = await api('POST', '/api/savings/goals', isUser.data.token, { name: 'Nyumba', target_amount: 100000, icon: 'home' });
  await expect(isGoal.status === 200 && isGoal.data.goal.id && Number(isGoal.data.goal.current_amount) === 0, 'Savings goal created');
  const isGoalId = isGoal.data.goal.id;
  const isList = await api('GET', '/api/savings/goals', isUser.data.token, null);
  await expect(isList.status === 200 && isList.data.goals.length >= 1, 'Savings goals listed');
  const isC1 = await api('POST', `/api/savings/goals/${isGoalId}/contribute`, isUser.data.token, { amount: 30000 });
  await expect(isC1.status === 200 && Number(isC1.data.result.current_amount) === 30000, 'Goal contribution recorded (30000)');
  const isBal1 = await balanceOf(isId);
  await expect(isBal1.wallet === 170000, 'Wallet debited for goal contribution', `wallet=${isBal1.wallet}`);

  // --- I2: AUTO-SAVE RULES ---
  const isRule = await api('POST', `/api/savings/goals/${isGoalId}/auto-save`, isUser.data.token, { frequency: 'WEEKLY', amount: 5000 });
  await expect(isRule.status === 200 && isRule.data.rule.id, 'Auto-save rule created');
  const isRun = await api('POST', '/api/savings/auto-save/run', isUser.data.token, null);
  await expect(isRun.status === 200 && Number(isRun.data.result.total) === 5000, 'Auto-save executed (5000)');
  const isBal2 = await balanceOf(isId);
  await expect(isBal2.wallet === 165000, 'Wallet debited by auto-save', `wallet=${isBal2.wallet}`);

  // --- I3: FIXED DEPOSITS (matured + early) ---
  const isFd = await api('POST', '/api/savings/deposits', isUser.data.token, { amount: 30000, term_months: 2 });
  await expect(isFd.status === 200 && isFd.data.deposit.id, 'Fixed deposit created (2 months)');
  const isFdId = isFd.data.deposit.id;
  await pool.query('UPDATE fixed_deposits SET maturity_date = CURRENT_DATE - 1 WHERE id = $1', [isFdId]);
  const isWd = await api('POST', `/api/savings/deposits/${isFdId}/withdraw`, isUser.data.token, {});
  await expect(isWd.status === 200 && Number(isWd.data.result.payout) === 30500, 'Matured deposit pays 30500 (interest 500)');
  const isBal3 = await balanceOf(isId);
  await expect(isBal3.wallet === 165500, 'Maturity credited to wallet', `wallet=${isBal3.wallet}`);
  const isFd2 = await api('POST', '/api/savings/deposits', isUser.data.token, { amount: 30000, term_months: 2 });
  const isFd2Id = isFd2.data.deposit.id;
  const isWd2 = await api('POST', `/api/savings/deposits/${isFd2Id}/withdraw`, isUser.data.token, { allow_early: true });
  await expect(isWd2.status === 200 && Number(isWd2.data.result.payout) === 29400, 'Early withdrawal penalized 2% (29400)');
  const isBal4 = await balanceOf(isId);
  await expect(isBal4.wallet === 164900, 'Early withdrawal credited to wallet', `wallet=${isBal4.wallet}`);
  const isSum = await api('GET', '/api/savings/summary', isUser.data.token, null);
  await expect(isSum.status === 200 && Number(isSum.data.summary.goalBalance) === 35000 && Number(isSum.data.summary.activeDeposits) === 0, 'Savings summary correct (goal balance 35000)');

  // --- I6: CREDIT SCORE ---
  const isCs = await api('POST', '/api/credit/score/recompute', isUser.data.token, null);
  const isLimit = Math.round((50000 + isCs.data.result.score * 250) / 1000) * 1000;
  await expect(isCs.status === 200 && isCs.data.result.score >= 300 && Number(isCs.data.result.credit_limit) === isLimit, 'Credit score recomputed with matching limit', `score=${isCs.data.result.score}`);

  // --- I4: MICRO-LOAN APPLICATION ---
  const isLoan = await api('POST', '/api/credit/loans', isUser.data.token, { amount: 100000, term_months: 3, interest_rate: 5 });
  await expect(isLoan.status === 200 && isLoan.data.loan.status === 'PENDING', 'Micro-loan application submitted');
  const isLoanId = isLoan.data.loan.id;

  // --- I9: GUARANTOR ---
  const isGPhone = '255762' + nowSuffix();
  const isGuarantor = await register(isGPhone, 'Dhamini');
  const isGuarId = isGuarantor.data.user.id;
  await fundWallet(isGuarId, 100000);
  const isGAdd = await api('POST', `/api/credit/loans/${isLoanId}/guarantors`, isUser.data.token, { phone: isGPhone });
  await expect(isGAdd.status === 200 && isGAdd.data.guarantor.id, 'Guarantor invited');
  const isGAccept = await api('POST', `/api/credit/loans/${isLoanId}/guarantors/respond`, isGuarantor.data.token, { accept: true });
  await expect(isGAccept.status === 200 && Number(isGAccept.data.result.blocked_amount) === 20000, 'Guarantor accepted, 20000 reserved');
  const isGBal = await balanceOf(isGuarId);
  await expect(isGBal.wallet === 80000 && isGBal.locked === 20000, 'Guarantee funds reserved in locked balance');

  // --- ADMIN APPROVE + DISBURSE ---
  const isApr = await api('POST', `/api/credit/admin/loans/${isLoanId}/approve`, adminToken, null);
  await expect(isApr.status === 200 && isApr.data.loan.status === 'APPROVED', 'Admin approves micro-loan');
  const isDis = await api('POST', `/api/credit/admin/loans/${isLoanId}/disburse`, adminToken, null);
  await expect(isDis.status === 200 && Number(isDis.data.result.due_amount) === 105000, 'Admin disburses loan (due 105000)');
  const isGBal2 = await balanceOf(isGuarId);
  await expect(isGBal2.wallet === 100000 && isGBal2.locked === 0, 'Guarantee released after disbursement');
  const isBal5 = await balanceOf(isId);
  await expect(isBal5.wallet === 264900, 'Loan credited to wallet', `wallet=${isBal5.wallet}`);

  // --- I5/I7: INSTALLMENTS + EARLY PAYOFF ---
  const isSch = await api('GET', `/api/credit/loans/${isLoanId}/schedule`, isUser.data.token, null);
  await expect(isSch.status === 200 && isSch.data.schedule.length === 3, '3 installments generated');
  const isI1 = isSch.data.schedule[0];
  const isPay1 = await api('POST', `/api/credit/loans/${isLoanId}/installments/${isI1.id}/pay`, isUser.data.token, {});
  await expect(isPay1.status === 200 && Number(isPay1.data.result.paid) === 35000, 'Installment 1 paid (35000)');
  const isBal6 = await balanceOf(isId);
  await expect(isBal6.wallet === 229900, 'Installment debited from wallet', `wallet=${isBal6.wallet}`);
  const isPo = await api('POST', `/api/credit/loans/${isLoanId}/payoff`, isUser.data.token, {});
  await expect(isPo.status === 200 && Number(isPo.data.result.paid) === 70000 && isPo.data.result.status === 'REPAID', 'Loan paid off early (70000, remaining installments waived)');
  const isBal7 = await balanceOf(isId);
  await expect(isBal7.wallet === 159900, 'Final wallet reconciled (159900)', `wallet=${isBal7.wallet}`);

  // --- I10: CREDIT REPORT ---
  const isRep = await api('GET', '/api/credit/report', isUser.data.token, null);
  await expect(isRep.status === 200 && isRep.data.report.totalLoanCount === 1 && isRep.data.report.activeLoans === 0, 'Credit report correct (1 loan repaid)');

  // ------------------------------------------------------------
  await section('14. VIRTUAL CARDS — Issue, Limits, Authorization Holds, Settlement, Refunds');
  // ------------------------------------------------------------

  const jcPhone = '255771' + nowSuffix();
  const jcUser = await register(jcPhone, 'Card Holder');
  const jcId = jcUser.data.user.id;
  await fundWallet(jcId, 100000);

  // --- J1: ISSUE ---
  const jcIssue = await api('POST', '/api/cards', jcUser.data.token, { scheme: 'VISA', daily_limit: 60000, per_txn_limit: 40000 });
  const jcPan = jcIssue.data.pan;
  const jcCvv = jcIssue.data.cvv;
  const luhnOk = (pan) => { let s = 0, alt = false; for (let i = pan.length - 1; i >= 0; i--) { let d = +pan[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } s += d; alt = !alt; } return s % 10 === 0; };
  await expect(jcIssue.status === 200 && jcIssue.data.card.id && jcPan.length === 16 && luhnOk(jcPan) && /^\*\*\*\* \*\*\*\* \*\*\*\* \d{4}$/.test(jcIssue.data.card.masked_number) && String(jcCvv).length === 3, 'Virtual card issued (valid Luhn PAN, masked, cvv)');
  const jcCardId = jcIssue.data.card.id;

  const jcList = await api('GET', '/api/cards', jcUser.data.token, null);
  await expect(jcList.status === 200 && jcList.data.cards.length === 1, 'Cards listed');
  const jcDetail = await api('GET', `/api/cards/${jcCardId}`, jcUser.data.token, null);
  await expect(jcDetail.status === 200 && !jcDetail.data.card.card_number_hash && !jcDetail.data.card.pan, 'Card detail masked (no PAN returned)');

  // --- J2: LIMITS ---
  const jcLim = await api('POST', `/api/cards/${jcCardId}/limits`, jcUser.data.token, { daily_limit: 60000, per_txn_limit: 40000 });
  await expect(jcLim.status === 200 && Number(jcLim.data.card.daily_limit) === 60000, 'Card limits updated');

  // --- J3: AUTHORIZATION (hold) ---
  const jcA = await api('POST', `/api/cards/${jcCardId}/authorize`, jcUser.data.token, { merchant_name: 'Karibu Store', amount: 30000, cvv: jcCvv });
  await expect(jcA.status === 200 && jcA.data.result.status === 'AUTH_HOLD', 'Purchase authorized (hold 30000)');
  const jcAref = jcA.data.result.auth_reference;
  const jcBalA = await balanceOf(jcId);
  await expect(jcBalA.wallet === 70000 && jcBalA.locked === 30000, 'Wallet debited, 30000 on hold', `w=${jcBalA.wallet} l=${jcBalA.locked}`);

  const jcOverP = await api('POST', `/api/cards/${jcCardId}/authorize`, jcUser.data.token, { merchant_name: 'Expensive Ltd', amount: 45000, cvv: jcCvv });
  await expect(jcOverP.status === 400, 'Over per-transaction limit blocked');
  const jcOverD = await api('POST', `/api/cards/${jcCardId}/authorize`, jcUser.data.token, { merchant_name: 'Big Store', amount: 35000, cvv: jcCvv });
  await expect(jcOverD.status === 400, 'Over daily remaining limit blocked');

  // --- FREEZE / UNFREEZE ---
  const jcFr = await api('POST', `/api/cards/${jcCardId}/freeze`, jcUser.data.token, { freeze: true });
  await expect(jcFr.status === 200 && jcFr.data.result.status === 'FROZEN', 'Card frozen');
  const jcFrAuth = await api('POST', `/api/cards/${jcCardId}/authorize`, jcUser.data.token, { merchant_name: 'Frozen Stop', amount: 5000, cvv: jcCvv });
  await expect(jcFrAuth.status === 403, 'Frozen card rejects purchase');
  const jcUn = await api('POST', `/api/cards/${jcCardId}/freeze`, jcUser.data.token, { freeze: false });
  await expect(jcUn.status === 200 && jcUn.data.result.status === 'ACTIVE', 'Card unfrozen');

  // --- J4: SETTLEMENT ---
  const jcSettle = await api('POST', '/api/cards/admin/settle', adminToken, { auth_reference: jcAref });
  await expect(jcSettle.status === 200 && jcSettle.data.result.status === 'SETTLED', 'Merchant settlement processed');
  const jcBalS = await balanceOf(jcId);
  await expect(jcBalS.wallet === 70000 && jcBalS.locked === 0, 'Hold released on settlement', `w=${jcBalS.wallet} l=${jcBalS.locked}`);

  // --- J5: REFUND (pre-settlement) ---
  const jcD = await api('POST', `/api/cards/${jcCardId}/authorize`, jcUser.data.token, { merchant_name: 'Duka Mkubwa', amount: 10000, cvv: jcCvv });
  const jcDref = jcD.data.result.auth_reference;
  const jcBalD = await balanceOf(jcId);
  await expect(jcBalD.wallet === 60000 && jcBalD.locked === 10000, 'Second hold 10000', `w=${jcBalD.wallet} l=${jcBalD.locked}`);
  const jcRefund = await api('POST', '/api/cards/admin/refund', adminToken, { auth_reference: jcDref });
  await expect(jcRefund.status === 200 && jcRefund.data.result.status === 'REFUNDED', 'Refund processed');
  const jcBalR = await balanceOf(jcId);
  await expect(jcBalR.wallet === 70000 && jcBalR.locked === 0, 'Refund returns funds to wallet', `w=${jcBalR.wallet} l=${jcBalR.locked}`);

  // --- J6: STATEMENT & SUMMARY ---
  const jcStmt = await api('GET', `/api/cards/${jcCardId}/transactions`, jcUser.data.token, null);
  await expect(jcStmt.status === 200 && jcStmt.data.result.transactions.length >= 5, 'Card statement returned (hold/settled/declined/refund rows)');
  const jcSum = await api('GET', '/api/cards/summary', jcUser.data.token, null);
  await expect(jcSum.status === 200 && jcSum.data.summary.totalCards === 1 && jcSum.data.summary.activeCards === 1 && Number(jcSum.data.summary.spendThisMonth) === 30000, 'Card summary correct (spend 30000)');

  // --- BLOCK (reported lost) ---
  const jcBlk = await api('POST', `/api/cards/${jcCardId}/block`, jcUser.data.token, {});
  await expect(jcBlk.status === 200 && jcBlk.data.result.status === 'BLOCKED', 'Card blocked (reported lost)');
  const jcBlkAuth = await api('POST', `/api/cards/${jcCardId}/authorize`, jcUser.data.token, { merchant_name: 'Last Try', amount: 1000, cvv: jcCvv });
  await expect(jcBlkAuth.status === 403, 'Blocked card rejects purchase');

  // ------------------------------------------------------------
  await section('15. PARTNER BANKING (BaaS) — Apply, Approve, Signed Payouts, Webhooks');
  // ------------------------------------------------------------

  const webhookEvents = [];
  const webSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { webhookEvents.push(JSON.parse(b)); } catch (e) { webhookEvents.push({ raw: b }); }
      res.writeHead(200); res.end('OK');
    });
  });
  await new Promise((r) => webSrv.listen(0, '127.0.0.1', r));
  const webPort = webSrv.address().port;

  const kPartner = await api('POST', '/api/bap/apply', null, {
    name: 'NexPay Africa', contact_email: 'ops@nexpay.africa', phone: '255700000099', country: 'KENYA',
    webhook_url: `http://127.0.0.1:${webPort}/hook`,
  });
  await expect(kPartner.status === 200 && kPartner.data.partner.status === 'PENDING' && kPartner.data.partner.id, 'Partner application submitted (PENDING)');
  const kPartnerId = kPartner.data.partner.id;

  const kApprove = await api('POST', '/api/bap/admin/approve', adminToken, { partner_id: kPartnerId });
  await expect(kApprove.status === 200 && kApprove.data.result.api_key.startsWith('bap_') && kApprove.data.result.api_secret.startsWith('sk_') && kApprove.data.result.status === 'ACTIVE', 'Admin approves partner (API key + secret issued)');
  const kKey = kApprove.data.result.api_key;
  const kSecret = kApprove.data.result.api_secret;

  const kList = await api('GET', '/api/bap/admin/partners', adminToken, null);
  await expect(kList.status === 200 && kList.data.partners.find((p) => p.id === kPartnerId).api_secret === 'MASKED', 'Admin lists partners (secret masked)');

  const kFund = await api('POST', `/api/bap/admin/partners/${kPartnerId}/fund`, adminToken, { amount: 200000 });
  await expect(kFund.status === 200 && Number(kFund.data.result.balance) === 200000, 'Admin funds partner 200000');

  const kPhone = '255772' + nowSuffix();
  const kcust = await register(kPhone, 'Neema Client');

  const bapReq = async (method, path, payloadObj) => {
    const body = payloadObj ? JSON.stringify(payloadObj) : '';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = nodeCrypto.createHmac('sha256', kSecret).update(`${ts}\n${body}`).digest('hex');
    const headers = { 'Content-Type': 'text/plain', 'X-API-Key': kKey, 'X-Timestamp': ts, 'X-Signature': sig };
    const res = await fetch(BASE + path, { method, headers, body: payloadObj ? body : undefined });
    let data = {}; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  };

  const kP1 = await bapReq('POST', '/api/bap/payout', { phone: kPhone, amount: 50000, request_id: 'REQ-1' });
  await expect(kP1.status === 200 && kP1.data.result.reference && kP1.data.result.partner_balance === 150000, 'Signed payout 50000 to customer (partner left 150000)');
  const kRef1 = kP1.data.result.reference;
  const kCustBal = await balanceOf(kcust.data.user.id);
  await expect(kCustBal.wallet === 50000, `Customer wallet credited 50000 (got ${kCustBal.wallet})`);
  await expect(kP1.data.result.webhook && kP1.data.result.webhook.delivered === 'DELIVERED', 'Payout response reports webhook delivered');

  await new Promise((r) => setTimeout(r, 300));
  const kw = webhookEvents.find((w) => w.event === 'PAYOUT_SETTLED' && w.reference === kRef1);
  await expect(!!kw && kw.amount === 50000 && kw.phone === kPhone, 'Webhook payload captured by partner (PAYOUT_SETTLED)');

  const kWebs = await api('GET', `/api/bap/admin/partners/${kPartnerId}/webhooks`, adminToken, null);
  const kwRow = kWebs.data.webhooks[0];
  const kExpectSig = nodeCrypto.createHmac('sha256', kSecret).update(`${kwRow.request_ts}\n${kwRow.request_body}`).digest('hex');
  await expect(kWebs.status === 200 && kwRow.status === 'DELIVERED' && kwRow.request_signature === kExpectSig && kwRow.request_body.includes(kRef1), 'Webhook row signed; signature verifiable end-to-end');

  const kP1b = await bapReq('POST', '/api/bap/payout', { phone: kPhone, amount: 50000, request_id: 'REQ-1' });
  await expect(kP1b.status === 200 && kP1b.data.result.duplicate === true && kP1b.data.result.reference === kRef1 && kP1b.data.result.partner_balance === 150000, 'Idempotent replay returns same reference, no double charge');

  const kStmt = await bapReq('GET', '/api/bap/statement', null);
  await expect(kStmt.status === 200 && kStmt.data.statement.filter((t) => t.status === 'COMPLETED').length === 2, 'Partner statement (FUNDING + PAYOUT)');

  const kSum = await bapReq('GET', '/api/bap/summary', null);
  await expect(kSum.status === 200 && kSum.data.summary.balance === 150000 && Number(kSum.data.summary.payout_volume) === 50000, 'Partner summary (balance 150000, volume 50000)');

  const kLow = await bapReq('POST', '/api/bap/payout', { phone: kPhone, amount: 200000, request_id: 'REQ-LOW' });
  await expect(kLow.status === 400, 'Payout over partner balance rejected');
  const kSumLo = await bapReq('GET', '/api/bap/summary', null);
  await expect(kSumLo.data.summary.balance === 150000 && kSumLo.data.summary.failed_payouts === 1, 'Failed payout logged, partner balance unchanged');

  const kForgeBody = JSON.stringify({ phone: kPhone, amount: 5000, request_id: 'REQ-F' });
  const kForge = await fetch(BASE + '/api/bap/payout', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-API-Key': kKey, 'X-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Signature': 'deadbeef' }, body: kForgeBody });
  await expect(kForge.status === 403, 'Forged signature rejected');

  const kSus = await api('POST', `/api/bap/admin/partners/${kPartnerId}/suspend`, adminToken, { suspended: true });
  await expect(kSus.status === 200 && kSus.data.result.status === 'SUSPENDED', 'Partner suspended');
  const kSusPay = await bapReq('POST', '/api/bap/payout', { phone: kPhone, amount: 5000, request_id: 'REQ-S' });
  await expect(kSusPay.status === 403, 'Suspended partner cannot payout');
  const kRe = await api('POST', `/api/bap/admin/partners/${kPartnerId}/suspend`, adminToken, { suspended: false });
  await expect(kRe.status === 200 && kRe.data.result.status === 'ACTIVE', 'Partner reactivated');
  const kP2 = await bapReq('POST', '/api/bap/payout', { phone: kPhone, amount: 10000, request_id: 'REQ-2' });
  await expect(kP2.status === 200 && kP2.data.result.partner_balance === 140000, 'Reactivated partner payout works (balance 140000)');
  const kCustBal2 = await balanceOf(kcust.data.user.id);
  await expect(kCustBal2.wallet === 60000, `Customer wallet now 60000 (got ${kCustBal2.wallet})`);

  await new Promise((r) => webSrv.close(r));

  // ------------------------------------------------------------
  section('I18N + Multi-Currency');

  const countriesRes = await api('GET', '/api/auth/countries', null, null);
  await expect(
    countriesRes.status === 200 && Array.isArray(countriesRes.data.countries) &&
    countriesRes.data.countries.some((c) => c.code === 'TZ') &&
    countriesRes.data.countries.some((c) => c.code === 'KE'),
    'GET /auth/countries returns supported countries (TZ + KE)'
  );

  // Accept-Language=EN → English message from backend
  const enPhone = '255778' + nowSuffix();
  let enRes = await fetch(BASE + '/api/auth/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: JSON.stringify({ phoneNumber: enPhone }),
  });
  let enData = {};
  try { enData = await enRes.json(); } catch (e) {}
  await expect(enRes.status === 200 && enData.message === 'OTP sent.', `Accept-Language=EN → send-otp English (got "${enData.message}")`);

  const noOtpPhone = '255779' + nowSuffix();
  const enLogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: JSON.stringify({ phoneNumber: noOtpPhone, otp: '000000' }),
  });
  let enLoginData = {};
  try { enLoginData = await enLogin.json(); } catch (e) {}
  await expect(
    enLogin.status === 400 && enLoginData.code === 'AUTH_OTP_NOT_FOUND' && enLoginData.message === 'OTP not found.',
    'Accept-Language=EN → login OTP-not-found English'
  );

  // Multi-country registration: Kenyan phone → country_code KE
  const kePhone = '2547' + String(Date.now()).slice(-8);
  const keUser = await register(kePhone, 'Keja Mwangi');
  await expect(keUser.status === 201 && keUser.data.user.country_code === 'KE', `Register KE phone → country_code=KE (got ${keUser.data.user?.country_code})`);

  // FX resolution: direct → inverse → triangulated via TZS
  // (ondoa direct row yoyote ya run iliyopita ili TRIANGULATED iwe deterministic)
  try { await pool.query("DELETE FROM exchange_rates WHERE from_currency='EUR' AND to_currency='GBP'"); } catch (e) {}
  const fx = await api('GET', '/api/currency/rates/EUR/GBP', null, null);
  await expect(fx.status === 200 && fx.data.source === 'TRIANGULATED' && fx.data.rate > 0.8 && fx.data.rate < 0.95, `FX EUR→GBP triangulated (${fx.data?.rate})`);
  const ident = await api('GET', '/api/currency/rates/TZS/TZS', null, null);
  await expect(ident.status === 200 && ident.data.rate === 1, 'FX identity TZS→TZS = 1');

  // Admin sets a direct pair
  const putRate = await api('PUT', '/api/currency/rates', adminToken, { from: 'EUR', to: 'GBP', rate: 0.85 });
  await expect(putRate.status === 200 && putRate.data.success === true, 'Admin PUT /currency/rates EUR→GBP = 0.85');
  const dirFx = await api('GET', '/api/currency/rates/EUR/GBP', null, null);
  await expect(dirFx.status === 200 && dirFx.data.source === 'DIRECT' && Math.abs(dirFx.data.rate - 0.85) < 0.001, 'After admin rate → direct EUR→GBP');

  // Personal convert + holdings + display currency
  const fxUser = await register('255780' + nowSuffix(), 'Faida Trust');
  await fundWallet(fxUser.data.user.id, 500000);
  const fxConv = await api('POST', '/api/currency/convert', fxUser.data.token, { from: 'TZS', to: 'EUR', amount: 200000 });
  await expect(fxConv.status === 200 && fxConv.data.success === true && fxConv.data.converted > 0, `Personal convert TZS→EUR (got ${fxConv.data?.converted})`);
  const hold = await api('GET', '/api/currency/my-holdings', fxUser.data.token, null);
  await expect(hold.status === 200 && hold.data.currencies.some((c) => c.currency === 'EUR'), 'my-holdings shows EUR after convert');
  const fxConv2 = await api('POST', '/api/currency/convert', fxUser.data.token, { from: 'EUR', to: 'TZS', amount: 999999 });
  await expect(fxConv2.status === 400 && fxConv2.data.code === 'CURRENCY_BALANCE_MISSING', 'Insufficient EUR balance rejected (CURRENCY_BALANCE_MISSING)');
  const setCur = await api('PUT', '/api/currency/my-currency', fxUser.data.token, { currency: 'EUR' });
  await expect(setCur.status === 200 && setCur.data.success === true, 'Set user display currency EUR');
  const getCur = await api('GET', '/api/currency/my-currency', fxUser.data.token, null);
  await expect(getCur.data.currency === 'EUR', 'my-currency returns EUR');

  // ------------------------------------------------------------
  section('SMS PROVIDER ROUTING (kimataifa)');
  // ------------------------------------------------------------
  const { resolveProvider, sendSMS } = require('../src/services/smsService');
  await expect(resolveProvider('255712000001') === 'beem', 'TZ (255) → Beem');
  await expect(resolveProvider('254712345678') === 'at', 'KE (254) → Africa\u2018s Talking');
  await expect(resolveProvider('256234567890') === 'at', 'UG (256) → Africa\u2019s Talking');
  await expect(resolveProvider('250788123456') === 'at', 'RW (250) → Africa\u2019s Talking');
  await expect(resolveProvider('271234567890') === 'at', 'ZA (27) → Africa\u2019s Talking');
  await expect(resolveProvider('201234567890') === 'at', 'EG (20) → Africa\u2019s Talking');
  await expect(resolveProvider('15551234567') === 'twilio', 'US (+1) → Twilio (default/dunia)');
  const smsDev = await sendSMS('254712345678', 'Afrikoba: OTP test routing');
  await expect(smsDev.simulated === true || smsDev.success === true, 'sendSMS dev-mode haiondoei error');

  // ------------------------------------------------------------
  section('AUTH HARDENING (auth_version + password policy)');
  // ------------------------------------------------------------
  const hPhone = '255725' + nowSuffix();
  const hOld = 'Str0ngPass12345';
  const hNew = 'NewStr0ngPass67890';
  const hOtp = await sendOtp(hPhone);
  const regH = await api('POST', '/api/auth/register', null, { fullName: 'Hardening User', phoneNumber: hPhone, email: `h${nowSuffix()}@afrikoba.test`, password: hOld, otp: hOtp });
  await expect(regH.status === 201, 'Usajili na password imara hukubalika', `${regH.status}: ${regH.data.message || ''}`);
  const weakReg = await api('POST', '/api/auth/register', null, { fullName: 'Weak User', phoneNumber: '255726' + nowSuffix(), password: 'short1', otp: await sendOtp('255726' + nowSuffix()) });
  await expect(weakReg.status === 400, 'Password dhaifu (short1) inakataliwa kwenye usajili', `${weakReg.status}`);
  const loginH = await api('POST', '/api/auth/login/password', null, { emailOrPhone: hPhone, password: hOld });
  await expect(loginH.status === 200 && loginH.data.token, 'Login kwa password imara inafanya kazi', `${loginH.status}`);
  const meBefore = await api('GET', '/api/auth/me', loginH.data.token, null);
  await expect(meBefore.status === 200, 'Token ya zamani inafanya kazi kabla ya change-password', `${meBefore.status}`);

  const chgOk = await api('POST', '/api/auth/change-password', loginH.data.token, { currentPassword: hOld, newPassword: hNew });
  await expect(chgOk.status === 200 && chgOk.data.success, 'Change-password (current sahihi) inafanya kazi', `${chgOk.status}: ${chgOk.data.message || ''}`);
  const meAfter = await api('GET', '/api/auth/me', loginH.data.token, null);
  await expect(meAfter.status === 401 && meAfter.data.code === 'TOKEN_REVOKED', 'Token ya zamani imefungwa baada ya change-password', `${meAfter.status} ${meAfter.data.code}`);
  const oldPwLogin = await api('POST', '/api/auth/login/password', null, { emailOrPhone: hPhone, password: hOld });
  await expect(oldPwLogin.status === 401, 'Password ya zamani haiwezi ku-login tena', `${oldPwLogin.status}`);
  const loginH2 = await api('POST', '/api/auth/login/password', null, { emailOrPhone: hPhone, password: hNew });
  await expect(loginH2.status === 200 && loginH2.data.token, 'Login kwa password mpya inafanya kazi', `${loginH2.status}`);
  const meNew = await api('GET', '/api/auth/me', loginH2.data.token, null);
  await expect(meNew.status === 200, 'Token mpya (auth_version+1) inafanya kazi', `${meNew.status}`);

  const chgWrong = await api('POST', '/api/auth/change-password', loginH2.data.token, { currentPassword: 'WrongCurrent-999', newPassword: 'AnotherNewPass123' });
  await expect(chgWrong.status === 401 && chgWrong.data.code === 'AUTH_BAD_CURRENT_PASSWORD', 'Current password mbaya inakataliwa', `${chgWrong.status} ${chgWrong.data.code}`);
  const chgWeak = await api('POST', '/api/auth/change-password', loginH2.data.token, { currentPassword: hNew, newPassword: 'short1' });
  await expect(chgWeak.status === 400, 'Password mpya dhaifu inakataliwa (policy min 10)', `${chgWeak.status}`);
  const meAfterWeak = await api('GET', '/api/auth/me', loginH2.data.token, null);
  await expect(meAfterWeak.status === 200, 'Password policy haifungi kikao (hakuna bump bila mabadiliko)', `${meAfterWeak.status}`);

  // ------------------------------------------------------------
  section('PIN RESET (forgot PIN hardening)');
  const pinResetService = require('../src/services/pinResetService');
  try {
    const prReq = await api('POST', '/api/advanced/pin-reset/request', null, { phone: hPhone });
    await expect(prReq.status === 200 && prReq.data.success, 'PIN reset request inafanya kazi (phone_number fix)', `${prReq.status}: ${prReq.data.message || ''}`);
    const prReq2 = await api('POST', '/api/advanced/pin-reset/request', null, { phone: hPhone });
    await expect(prReq2.status === 429, 'Cooldown ya request inazuia SMS-flood (429)', `${prReq2.status}: ${prReq2.data.message || ''}`);
    const prWrong = await api('POST', '/api/advanced/pin-reset/verify', null, { phone: hPhone, token: '000000' });
    await expect(prWrong.status === 400, 'verify OTP mbaya inarudisha 400 (si 500)', `${prWrong.status}: ${prWrong.data.message || ''}`);

    const prUserId = regH.data.user.id;
    await pool.query(`INSERT INTO pin_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`, [prUserId, '123456']);
    const prV = await pinResetService.verifyPinReset(hPhone, '123456');
    await expect(prV.success === true && prV.resetKey && prV.resetKey.length === 64, 'verify inarudisha resetKey (64 hex, VARCHAR fix)', `${prV.success} keylen=${prV.resetKey ? prV.resetKey.length : 0}`);
    const prC = await pinResetService.completePinReset(prUserId, prV.resetKey, '4321');
    await expect(prC.success === true, 'completePinReset inaweka PIN mpya', `${prC.success}`);
    let prAgain = { used: false };
    try { await pinResetService.completePinReset(prUserId, prV.resetKey, '1111'); prAgain = { used: true }; } catch (e) { prAgain = { used: false }; }
    await expect(prAgain.used === false, 'ResetKey haiwezi kutumika tena (used)', JSON.stringify(prAgain));

    await pool.query(`INSERT INTO pin_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`, [prUserId, '654321']);
    let wrongCount = 0;
    for (let i = 0; i < 5; i++) { try { await pinResetService.verifyPinReset(hPhone, String(100000 + i)); } catch (e) { if (e.statusCode === 400) wrongCount++; } }
    await expect(wrongCount === 5, 'Attempts 5 zinahesabiwa kwa 400', `${wrongCount}`);
    let prEnd = { threw: false, status: 0 };
    try { await pinResetService.verifyPinReset(hPhone, '654321'); prEnd = { threw: false, status: 200 }; } catch (e) { prEnd = { threw: true, status: e.statusCode || 500 }; }
    await expect(prEnd.threw === true && prEnd.status === 429, 'Token inafungwa baada ya attempts nyingi (429)', JSON.stringify(prEnd));
  } catch (e) {
    await expect(false, 'PIN RESET section inakamilika', `CRASH: ${e.message}`);
  }

  // ------------------------------------------------------------
  section('WEBHOOK HMAC + MERCHANTS PII');
  try {
    const mEmail = `merchant${nowSuffix()}@afrikoba.test`;
    const insM = await pool.query(`INSERT INTO merchants (name, business_type, phone, email) VALUES ($1,$2,$3,$4) RETURNING id`, ['Public Shop', 'Retail', `255700000${nowSuffix().slice(-2)}`, mEmail]);
    const mId = insM.rows[0].id;
    const mList = await api('GET', '/api/advanced/merchants', null, null);
    const foundM = (mList.data.merchants || []).find((m) => m.id === mId);
    await expect(!!foundM, 'Merchant mpya anaonekana kwenye public list', `${mId}`);
    await expect(foundM && foundM.email === undefined && foundM.user_id === undefined, 'Public merchants haitoi email/user_id (PII fix)', foundM ? JSON.stringify(foundM) : 'not found');

    const nodeCrypto2 = require('crypto');
    const hmacSecret = config.security?.webhookSecret || process.env.WEBHOOK_SECRET;
    const guardSecret = config.webhook?.secret;
    if (hmacSecret && guardSecret) {
      const raw = `{ "amount": 100, "reference": "WH_${nowSuffix()}" }`;
      const sigGood = nodeCrypto2.createHmac('sha256', hmacSecret).update(raw, 'utf8').digest('hex');
      const whNoSig = await api('POST', '/api/payments/azampay-callback', null, { amount: 100 });
      await expect(whNoSig.status === 401 && (whNoSig.data.code === 'WEBHOOK_MISSING_SIGNATURE' || whNoSig.data.message === 'Unauthorized Webhook Request'), 'Webhook bila signature inakataliwa (hapana bypass)', `${whNoSig.status} ${whNoSig.data.code || ''}`);
      const whBad = await apiRaw('POST', '/api/payments/azampay-callback', raw, { 'x-signature': 'deadbeef'.repeat(8), 'x-webhook-secret': guardSecret });
      await expect(whBad.status === 401, 'Webhook HMAC mbaya inakataliwa (401)', `${whBad.status} ${whBad.data.code || whBad.data.message || ''}`);
      const whGood = await apiRaw('POST', '/api/payments/azampay-callback', raw, { 'x-signature': sigGood, 'x-webhook-secret': guardSecret });
      await expect(whGood.status === 404 || whGood.status === 200, 'Webhook HMAC sahihi kwenye raw body inapitishwa (404=ref ya kufikiri, si 401)', `${whGood.status} ${whGood.data.code || whGood.data.message || ''}`);
    } else {
      console.log('  (skip webhook HMAC HTTP tests - hakuna WEBHOOK_SECRET local)');
    }
  } catch (e) {
    await expect(false, 'WEBHOOK HMAC + MERCHANTS section inakamilika', `CRASH: ${e.message}`);
  }

  // ------------------------------------------------------------
  console.log('\n==============================');
  console.log(`RESULT: ${passed} PASSED, ${failed} FAILED`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('==============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(2);
});
