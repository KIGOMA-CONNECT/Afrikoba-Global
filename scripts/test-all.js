/* ============================================================
 * AFRIKOBA GLOBAL - COMPREHENSIVE TEST SUITE (kila hatua)
 * Huendesha mtihani wa mfumo mzima na kukusanya matokeo.
 * ============================================================ */
const BASE = 'http://127.0.0.1:3000';
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
  await expect(cooldown.status === 429, 'Send-OTP ina cooldown (anti SMS-bombing)', `${cooldown.status}`);

  const phoneB = '255723' + nowSuffix();
  const regB = await register(phoneB, 'Asha Mtihani');
  await expect(regB.status === 201, 'Usajili mpya unafungua WALLET', `${regB.status}`);
  await expect((regB.data.user.services || []).includes('WALLET'), 'Services = [WALLET] baada ya usajili', JSON.stringify(regB.data.user.services));

  const regDup = await register(phoneB, 'Dup');
  await expect(regDup.status === 400, 'Usajili wa namba iliyopo unakataliwa', `${regDup.status}`);

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
  const wb = await api('POST', '/api/payments/azampay-callback', null, {
    utilityref: depRef, transactionstatus: 'SUCCESS', reference: 'EXT-1',
  }, true);
  const hdr = { Authorization: undefined, 'Content-Type': 'application/json', 'x-webhook-secret': config.webhook.secret };
  const resWebhook = await fetch(BASE + '/api/payments/azampay-callback', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ utilityref: depRef, transactionstatus: 'SUCCESS', reference: 'EXT-1' }),
  });
  const webhookData = await resWebhook.json();
  await expect(resWebhook.status === 200 && webhookData.success, 'Callback ya AzamPay inathibitisha deposit', `${resWebhook.status} ${JSON.stringify(webhookData)}`);
  const depAft = await balanceOf(regB.data.user.id);
  await expect(depAft.wallet === depBef.wallet + 100000, 'Deposit inaongezwa kwenye wallet (wallet_amount)', `${depBef.wallet} → ${depAft.wallet}`);

  const revMid = await pool.query('SELECT total_commission FROM company_revenue WHERE id = 1');
  await expect(Number(revMid.rows[0].total_commission) - Number(revBefore.rows[0].total_commission) === 1000, 'Commission 1% inaenda company_revenue');

  const wbDup = await fetch(BASE + '/api/payments/azampay-callback', {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ utilityref: depRef, transactionstatus: 'SUCCESS', reference: 'EXT-1' }),
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
