/* ============================================================
 * AFRIKOBA GLOBAL - FOUR-EYES REGRESSION
 * Role-based maker-checker: policy gating, self-approval
 * rejection, quorum, executor execution (role change + refund),
 * reject/cancel/retry, and feature-flag kill-switch.
 * ============================================================ */
const BASE = process.env.FOUREYES_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const cardSvc = require('../src/services/cardService');
const fin = require('../src/services/financialEngine');
const circleSvc = require('../src/services/lendingCircleService');
const kilimoSvc = require('../src/services/kilimoAgriService');

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
  return refresh.data.token;
}

function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const mk = await register(`255720${suffix}`, 'Maker Admin');
  const ck = await register(`255721${suffix}`, 'Checker Admin');
  const ck2 = await register(`255722${suffix}`, 'Checker Admin 2');
  const target = await register(`255723${suffix}`, 'Target Member');
  const target2 = await register(`255724${suffix}`, 'Target Member 2');
  const stranger = await register(`255725${suffix}`, 'Stranger Member');
  const cardOwner = await register(`255726${suffix}`, 'Card Owner');
  await expect(mk.data.token && ck.data.token && ck2.data.token, 'Users registered');
  await expect(target.data.user.role === 'MJUMBE', 'Targets default to MJUMBE');

  const maker = await makeAdmin(mk); await expect(!!maker, 'Maker promoted to ADMIN');
  const checker = await makeAdmin(ck); await expect(!!checker, 'Checker promoted to ADMIN');
  const checker2 = await makeAdmin(ck2); await expect(!!checker2, 'Checker 2 promoted to ADMIN');
  const member = target.data.token;
  const memberId = target.data.user.id;
  const member2Id = target2.data.user.id;
  const strangerId = stranger.data.user.id;

  // ---------- basic guards ----------
  await section('Access control & kill-switch');
  let anon = await api('GET', '/api/admin/four-eyes/policies');
  await expect(anon.status === 401, 'Anonymous blocked', `status=${anon.status}`);

  let strangerList = await api('GET', '/api/admin/four-eyes/policies', member);
  await expect(strangerList.status === 403, 'Non-admin (MJUMBE) blocked', `status=${strangerList.status}`);

  let policies = await api('GET', '/api/admin/four-eyes/policies', maker);
  await expect(policies.status === 200 && policies.data.policies.some((p) => p.action_code === 'ADMIN_PROMOTE_ROLE'), 'Admin lists seeded policies', `status=${policies.status}`);

  let kill = await api('PUT', '/api/features/admin/FOUR_EYES', maker, { enabled: false });
  await expect(kill.status === 200 && kill.data.flag.enabled === false, 'FOUR_EYES flag disabled');
  let killed = await api('GET', '/api/admin/four-eyes/policies', maker);
  await expect(killed.status === 403 && killed.data.error === 'FEATURE_DISABLED', 'Four-eyes killed by flag', `status=${killed.status}`);
  await api('PUT', '/api/features/admin/FOUR_EYES', maker, { enabled: true });

  // ---------- promote flow (maker != checker) ----------
  await section('Promote role: quorum and execution');
  let initPromote = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: memberId, role: 'OPS' });
  await expect(initPromote.status === 201 && initPromote.data.request.status === 'PENDING', 'Maker queues promote request', `status=${initPromote.status}`);
  const promoteId = initPromote.data.request.id;

  let selfApprove = await api('POST', `/api/admin/four-eyes/requests/${promoteId}/approve`, maker, {});
  await expect(selfApprove.status === 403, 'Self-approval rejected', `status=${selfApprove.status}`);

  let approv = await api('POST', `/api/admin/four-eyes/requests/${promoteId}/approve`, checker, { note: 'ok' });
  await expect(approv.status === 200 && approv.data.executed && approv.data.request.status === 'EXECUTED', 'Checker approval executes promote', `status=${approv.status}`);
  const roleNow = await pool.query('SELECT role FROM users WHERE id = $1', [memberId]);
  await expect(roleNow.rows[0].role === 'OPS', 'Target role now OPS');

  let audit1 = await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'FOUR_EYES_ROLE_CHANGE' AND entity_id = $1", [memberId]);
  await expect(audit1.rows[0].n >= 1, 'Audit logged for role change', `n=${audit1.rows[0].n}`);

  // ---------- invalid promote target ----------
  await section('Executor validation (role not promotable)');
  let badPromote = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: member2Id, role: 'MJUMBE' });
  await expect(badPromote.status === 201, 'Invalid promote is queueable (executor runs at approval)');
  let badApprov = await api('POST', `/api/admin/four-eyes/requests/${badPromote.data.request.id}/approve`, checker, {});
  await expect(badApprov.status === 200, 'Approval returns ok');
  let badReq = await api('GET', `/api/admin/four-eyes/requests/${badPromote.data.request.id}`, maker);
  await expect(badReq.status === 200 && badReq.data.request.status === 'FAILED' && /haliruhusiwi/.test(badReq.data.request.error), 'Executor rejected MJUMBE promote (FAILED)', `status=${badReq.status}`);

  // ---------- quorum = 2 ----------
  await section('Quorum of 2 approvals');
  await api('PUT', '/api/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', maker, { requiredApprovers: 2 });
  let qInit = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: member2Id, role: 'OPS' });
  await expect(qInit.status === 201, 'Quorum request queued');
  const qId = qInit.data.request.id;
  let oneApprov = await api('POST', `/api/admin/four-eyes/requests/${qId}/approve`, checker, {});
  await expect(oneApprov.status === 200 && oneApprov.data.executed === false && oneApprov.data.request.status === 'PENDING' && oneApprov.data.approvalCounts.APPROVE === 1, 'One approval stays PENDING (no execution yet)', `status=${oneApprov.status} count=${oneApprov.data.approvalCounts?.APPROVE}`);
  let dupApprov = await api('POST', `/api/admin/four-eyes/requests/${qId}/approve`, checker, {});
  await expect(dupApprov.status === 409, 'Duplicate approver rejected', `status=${dupApprov.status}`);
  let twoApprov = await api('POST', `/api/admin/four-eyes/requests/${qId}/approve`, checker2, {});
  await expect(twoApprov.status === 200 && twoApprov.data.executed && twoApprov.data.request.status === 'EXECUTED', 'Second distinct approver executes', `status=${twoApprov.status}`);
  await api('PUT', '/api/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', maker, { requiredApprovers: 1 });

  // ---------- refund ----------
  await section('Large refund (engine-level money movement)');
  const before = await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [memberId]);
  let refund = await api('POST', '/api/admin/four-eyes/actions/large-refund', maker, { userId: memberId, amount: 5000 });
  await expect(refund.status === 201 && refund.data.request.status === 'PENDING', 'Refund queued', `status=${refund.status}`);
  let refundApprov = await api('POST', `/api/admin/four-eyes/requests/${refund.data.request.id}/approve`, checker, {});
  await expect(refundApprov.status === 200 && refundApprov.data.executed, 'Refund approved & executed', `status=${refundApprov.status}`);
  const after = await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [memberId]);
  const delta = Number(after.rows[0].b) - Number(before.rows[0].b);
  await expect(delta === 5000, `Wallet credited exactly 5000 (delta=${delta})`);

  // ---------- demote ----------
  await section('Demote role (restricted executor)');
  let demote = await api('POST', '/api/admin/four-eyes/actions/demote-role', maker, { userId: memberId, role: 'MJUMBE' });
  await expect(demote.status === 201, 'Demote queued');
  let demoteApprov = await api('POST', `/api/admin/four-eyes/requests/${demote.data.request.id}/approve`, checker, {});
  await expect(demoteApprov.status === 200 && demoteApprov.data.executed, 'Demote executed', `status=${demoteApprov.status}`);
  let demotedRole = await pool.query('SELECT role FROM users WHERE id = $1', [memberId]);
  await expect(demotedRole.rows[0].role === 'MJUMBE', 'Target demoted back to MJUMBE');

  let badDemote = await api('POST', '/api/admin/four-eyes/actions/demote-role', maker, { userId: member2Id, role: 'ADMIN' });
  await expect(badDemote.status === 201, 'Demote-to-ADMIN queued (executor decides)');
  let badDemoteApprov = await api('POST', `/api/admin/four-eyes/requests/${badDemote.data.request.id}/approve`, checker, {});
  let badDemoteReq = await api('GET', `/api/admin/four-eyes/requests/${badDemote.data.request.id}`, maker);
  await expect(badDemoteReq.status === 200 && badDemoteReq.data.request.status === 'FAILED' && /nahitaji jukumu/.test(badDemoteReq.data.request.error), 'Demote to ADMIN rejected by executor (FAILED)', `status=${badDemoteReq.status} err=${badDemoteReq.data.request?.error}`);

  // ---------- reject & cancel ----------
  await section('Reject & cancel');
  let rejInit = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: memberId, role: 'COMPLIANCE' });
  let rej = await api('POST', `/api/admin/four-eyes/requests/${rejInit.data.request.id}/reject`, checker, { note: 'nope' });
  await expect(rej.status === 200 && rej.data.request.status === 'REJECTED', 'Checker rejects request', `status=${rej.status}`);
  let rejRole = await pool.query('SELECT role FROM users WHERE id = $1', [memberId]);
  await expect(rejRole.rows[0].role === 'MJUMBE', 'Rejected request changed nothing');

  let canInit = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: memberId, role: 'COMPLIANCE' });
  let can = await api('POST', `/api/admin/four-eyes/requests/${canInit.data.request.id}/cancel`, maker, {});
  await expect(can.status === 200 && can.data.request.status === 'CANCELLED', 'Requester cancels own request', `status=${can.status}`);
  let canRole = await pool.query('SELECT role FROM users WHERE id = $1', [memberId]);
  await expect(canRole.rows[0].role === 'MJUMBE', 'Cancelled request changed nothing');

  let otherCancel = await api('POST', `/api/admin/four-eyes/requests/${canInit.data.request.id}/cancel`, checker, {});
  await expect(otherCancel.status === 403, 'Only the requester can cancel', `status=${otherCancel.status}`);
  let doubleCancel = await api('POST', `/api/admin/four-eyes/requests/${canInit.data.request.id}/cancel`, maker, {});
  await expect(doubleCancel.status === 409, 'Already-decided request cannot be cancelled', `status=${doubleCancel.status}`);

  // ---------- unregistered action -> FAILED -> retry ----------
  await section('Unregistered executor (FAILED + retry)');
  await api('PUT', '/api/admin/four-eyes/policies/TEST_ACTION_NOOP', maker, { description: 'noop', requiredApprovers: 1, approverRoles: ['ADMIN'], enabled: true });
  let noopInit = await api('POST', '/api/admin/four-eyes/requests', maker, { action_code: 'TEST_ACTION_NOOP', payload: { value: 1 } });
  await expect(noopInit.status === 201, 'Custom noop action queued', `status=${noopInit.status}`);
  let noopApprov = await api('POST', `/api/admin/four-eyes/requests/${noopInit.data.request.id}/approve`, checker, {});
  await expect(noopApprov.status === 200 && noopApprov.data.request.status === 'FAILED' && /No executor/.test(noopApprov.data.request.error), 'No executor -> FAILED', `status=${noopApprov.status}`);
  let retry = await api('POST', `/api/admin/four-eyes/requests/${noopInit.data.request.id}/retry`, maker, {});
  await expect(retry.status === 200 && retry.data.request.status === 'FAILED', 'Retry keeps FAILED (no executor)');

  let disabledPol = await api('PUT', '/api/admin/four-eyes/policies/TEST_ACTION_NOOP', maker, { enabled: false });
  await expect(disabledPol.data.policy.enabled === false, 'Policy disabled');
  let disabledInit = await api('POST', '/api/admin/four-eyes/requests', maker, { action_code: 'TEST_ACTION_NOOP', payload: {} });
  await expect(disabledInit.status === 403, 'Disabled policy blocks initiate', `status=${disabledInit.status}`);
  await api('PUT', '/api/admin/four-eyes/policies/TEST_ACTION_NOOP', maker, { enabled: true });
  await pool.query('DELETE FROM four_eyes_policies WHERE action_code = $1', ['TEST_ACTION_NOOP']);

  // ---------- validation ----------
  await section('Payload validation');
  let noUser = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: 999999999, role: 'OPS' });
  let noUserApprov = await api('POST', `/api/admin/four-eyes/requests/${noUser.data.request.id}/approve`, checker, {});
  let noUserReq = await api('GET', `/api/admin/four-eyes/requests/${noUser.data.request.id}`, maker);
  await expect(noUserReq.status === 200 && noUserReq.data.request.status === 'FAILED' && /hajapatikana/.test(noUserReq.data.request.error), 'Unknown user -> FAILED', `status=${noUserReq.status} err=${noUserReq.data.request?.error}`);
  let sameRole = await api('POST', '/api/admin/four-eyes/actions/promote-role', maker, { userId: member2Id, role: 'OPS' });
  let sameRoleApprov = await api('POST', `/api/admin/four-eyes/requests/${sameRole.data.request.id}/approve`, checker, {});
  await expect(sameRoleApprov.status === 200 && sameRoleApprov.data.request.status === 'FAILED' && /tayari ana jukumu/.test(sameRoleApprov.data.request.error), 'Same-role change -> FAILED', `status=${sameRoleApprov.status} err=${sameRoleApprov.data.request?.error}`);

  // ---------- new ops executors: card refund & settle ----------
  await section('Card ops via four-eyes (money movement)');
  const ownerId = cardOwner.data.user.id;
  await fin.postDeposit({ userId: ownerId, amount: 100000, reference: `TEST:CARD:${suffix}:${Date.now()}`, description: 'Four-eyes card test deposit' });
  const issued = await cardSvc.issueCard(ownerId, { scheme: 'VISA' });
  await expect(issued.card.status === 'ACTIVE', 'Card issued');
  const auth = await cardSvc.authorizeCard(ownerId, issued.card.id, { merchant_name: 'AFRIKOBA TEST MERCH', amount: 6000, cvv: issued.cvv });
  await expect(auth.status === 'AUTH_HOLD' && auth.auth_reference, 'Authorization hold created', `status=${auth.status}`);
  const authRef = auth.auth_reference;
  const balAfterAuth = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [ownerId])).rows[0].b);
  await expect(balAfterAuth === 94000, `Hold deducted 6000 (wallet=${balAfterAuth})`);

  let rf = await api('POST', '/api/admin/four-eyes/actions/card-refund', maker, { authReference: authRef });
  await expect(rf.status === 201 && rf.data.request.status === 'PENDING', 'Card refund queued', `status=${rf.status}`);
  let rfApp = await api('POST', `/api/admin/four-eyes/requests/${rf.data.request.id}/approve`, checker, {});
  await expect(rfApp.status === 200 && rfApp.data.executed && rfApp.data.request.status === 'EXECUTED', 'Card refund approved & executed', `status=${rfApp.status}`);
  const balRefund = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [ownerId])).rows[0].b);
  await expect(balRefund === 100000, `Refund restored wallet (wallet=${balRefund})`);
  const txRefund = await pool.query('SELECT status FROM card_transactions WHERE auth_reference = $1', [authRef]);
  await expect(txRefund.rows[0].status === 'REFUNDED', 'Card transaction REFUNDED');

  const auth2 = await cardSvc.authorizeCard(ownerId, issued.card.id, { merchant_name: 'AFRIKOBA TEST MERCH 2', amount: 6000, cvv: issued.cvv });
  await expect(auth2.status === 'AUTH_HOLD', 'Second authorization hold created', `status=${auth2.status}`);
  const auth2Ref = auth2.auth_reference;
  let st = await api('POST', '/api/admin/four-eyes/actions/card-settle', maker, { authReference: auth2Ref });
  await expect(st.status === 201, 'Card settle queued', `status=${st.status}`);
  let stApp = await api('POST', `/api/admin/four-eyes/requests/${st.data.request.id}/approve`, checker, {});
  await expect(stApp.status === 200 && stApp.data.executed, 'Card settle approved & executed', `status=${stApp.status}`);
  const balSettle = await pool.query('SELECT wallet_balance::numeric AS b, locked_balance::numeric AS l FROM users WHERE id = $1', [ownerId]);
  await expect(Number(balSettle.rows[0].b) === 94000 && Number(balSettle.rows[0].l) === 0, `Settle converts hold (wallet=${balSettle.rows[0].b}, locked=${balSettle.rows[0].l})`);
  const txSettle = await pool.query('SELECT status FROM card_transactions WHERE auth_reference = $1', [auth2Ref]);
  await expect(txSettle.rows[0].status === 'SETTLED', 'Card transaction SETTLED');

  // ---------- new ops executors: guarded failures ----------
  await section('New ops failed guards (loans + VICOBA + bogus ref)');
  let bogusRef = await api('POST', '/api/admin/four-eyes/actions/card-refund', maker, { authReference: 'NOPE-NOT-REAL-9' });
  await api('POST', `/api/admin/four-eyes/requests/${bogusRef.data.request.id}/approve`, checker, {});
  let bogusRefReq = await api('GET', `/api/admin/four-eyes/requests/${bogusRef.data.request.id}`, maker);
  await expect(bogusRefReq.data.request.status === 'FAILED' && /haipatikani/.test(bogusRefReq.data.request.error), 'Bogus authReference -> FAILED', `err=${bogusRefReq.data.request?.error}`);

  let cl = await api('POST', '/api/admin/four-eyes/actions/credit-loan-disburse', maker, { loanId: 999999999 });
  await api('POST', `/api/admin/four-eyes/requests/${cl.data.request.id}/approve`, checker, {});
  let clReq = await api('GET', `/api/admin/four-eyes/requests/${cl.data.request.id}`, maker);
  await expect(clReq.data.request.status === 'FAILED' && /haupatikani/.test(clReq.data.request.error), 'Unknown micro-loan -> FAILED', `err=${clReq.data.request?.error}`);

  let bl = await api('POST', '/api/admin/four-eyes/actions/business-loan-disburse', maker, { loanId: 999999999 });
  await api('POST', `/api/admin/four-eyes/requests/${bl.data.request.id}/approve`, checker, {});
  let blReq = await api('GET', `/api/admin/four-eyes/requests/${bl.data.request.id}`, maker);
  await expect(blReq.data.request.status === 'FAILED' && /haupatikani/.test(blReq.data.request.error), 'Unknown business loan -> FAILED', `err=${blReq.data.request?.error}`);

  let vl = await api('POST', '/api/admin/four-eyes/actions/vicoba-loan-disburse', maker, { loanId: 999999999 });
  await api('POST', `/api/admin/four-eyes/requests/${vl.data.request.id}/approve`, checker, {});
  let vlReq = await api('GET', `/api/admin/four-eyes/requests/${vl.data.request.id}`, maker);
  await expect(vlReq.data.request.status === 'FAILED' && /Hauko kwenye kikundi/.test(vlReq.data.request.error), 'VICOBA loan needs group officer -> FAILED', `err=${vlReq.data.request?.error}`);

  let vs = await api('POST', '/api/admin/four-eyes/actions/vicoba-social-disburse', maker, { requestId: 999999999 });
  await api('POST', `/api/admin/four-eyes/requests/${vs.data.request.id}/approve`, checker, {});
  let vsReq = await api('GET', `/api/admin/four-eyes/requests/${vs.data.request.id}`, maker);
  await expect(vsReq.data.request.status === 'FAILED' && /Ombi halipo/.test(vsReq.data.request.error), 'Unknown social fund request -> FAILED', `err=${vsReq.data.request?.error}`);

  // ---------- lending circle disbursement via four-eyes ----------
  await section('Lending circle disbursement (four-eyes)');
  const borrowerId = target2.data.user.id;
  const camp = await circleSvc.createCampaign(borrowerId, { title: `Four-eyes circle ${suffix}`, story: 'circle test', targetAmount: 100000 });
  await pool.query(`UPDATE crowdfund_campaigns SET status='FULLY_FUNDED', raised_amount=100000 WHERE id=$1`, [camp.id]);
  const campBefore = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [borrowerId])).rows[0].b);
  let ci = await api('POST', '/api/admin/four-eyes/actions/lending-circle-disburse', maker, { campaignId: camp.id });
  await expect(ci.status === 201 && ci.data.request.status === 'PENDING', 'Circle disbursement queued', `status=${ci.status}`);
  let ciApp = await api('POST', `/api/admin/four-eyes/requests/${ci.data.request.id}/approve`, checker, {});
  await expect(ciApp.status === 200 && ciApp.data.executed && ciApp.data.request.status === 'EXECUTED', 'Circle disbursement approved & executed', `status=${ciApp.status}`);
  const campAfter = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [borrowerId])).rows[0].b);
  await expect(campAfter - campBefore === 100000, `Borrower credited raised_amount (delta=${campAfter - campBefore})`);
  const campStatus = await pool.query('SELECT status FROM crowdfund_campaigns WHERE id = $1', [camp.id]);
  await expect(campStatus.rows[0].status === 'DISBURSED', 'Campaign moved to DISBURSED');

  let ciBad = await api('POST', '/api/admin/four-eyes/actions/lending-circle-disburse', maker, { campaignId: 999999999 });
  await api('POST', `/api/admin/four-eyes/requests/${ciBad.data.request.id}/approve`, checker, {});
  let ciBadReq = await api('GET', `/api/admin/four-eyes/requests/${ciBad.data.request.id}`, maker);
  await expect(ciBadReq.data.request.status === 'FAILED', 'Unknown campaign -> FAILED', `err=${ciBadReq.data.request?.error}`);

  // ---------- kilimo agri loan disbursement via four-eyes ----------
  await section('Kilimo agri-loan disbursement (four-eyes)');
  const farm = await kilimoSvc.createFarmProfile(borrowerId, { farmName: `Shamba ${suffix}`, region: 'Morogoro', district: 'Mvomero', sizeAcres: 2, primaryCrop: 'MAIZE' });
  const agri = await kilimoSvc.applyAgriLoan(borrowerId, { farmId: farm.id, amount: 20000, loanType: 'HARVEST_CYCLE' });
  const agriBefore = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [borrowerId])).rows[0].b);
  let ai = await api('POST', '/api/admin/four-eyes/actions/kilimo-loan-disburse', maker, { loanId: agri.id });
  await expect(ai.status === 201 && ai.data.request.status === 'PENDING', 'Agri-loan disbursement queued', `status=${ai.status}`);
  let aiApp = await api('POST', `/api/admin/four-eyes/requests/${ai.data.request.id}/approve`, checker, {});
  await expect(aiApp.status === 200 && aiApp.data.executed && aiApp.data.request.status === 'EXECUTED', 'Agri-loan approved & executed', `status=${aiApp.status}`);
  const agriAfter = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [borrowerId])).rows[0].b);
  await expect(agriAfter - agriBefore === 20000, `Farmer credited loan amount (delta=${agriAfter - agriBefore})`);
  const agriStatus = await pool.query('SELECT status FROM agri_loans WHERE id = $1', [agri.id]);
  await expect(agriStatus.rows[0].status === 'DISBURSED', 'Agri-loan moved to DISBURSED');

  let aiBad = await api('POST', '/api/admin/four-eyes/actions/kilimo-loan-disburse', maker, { loanId: 999999999 });
  await api('POST', `/api/admin/four-eyes/requests/${aiBad.data.request.id}/approve`, checker, {});
  let aiBadReq = await api('GET', `/api/admin/four-eyes/requests/${aiBad.data.request.id}`, maker);
  await expect(aiBadReq.data.request.status === 'FAILED' && /not found/.test(aiBadReq.data.request.error), 'Unknown agri-loan -> FAILED', `err=${aiBadReq.data.request?.error}`);

  console.log(`\n===== FOUR-EYES: ${passed} passed, ${failed} failed =====`);
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