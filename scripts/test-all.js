/* ============================================================
 * AFRIKOBA GLOBAL - COMPREHENSIVE TEST SUITE (kila hatua)
 * Huendesha mtihani wa mfumo mzima na kukusanya matokeo.
 * ============================================================ */
const BASE = 'http://localhost:3000';
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
    const p = '255728' + (i + 1) + nowSuffix();
    const reg = await register(p, `Rosca Member ${i + 1}`);
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
