#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / R26-#3: governanceService.decideApprovalFlow TOCTOU
 *
 *  decideApprovalFlow read the flow status with an unlocked SELECT, then set
 *  APPROVED with an unconditional UPDATE and ran the registered executor after
 *  COMMIT. Concurrent approvals by different admins could therefore each pass
 *  the PENDING check and each run the executor (a second financial effect
 *  unless the executor's own guards stopped it). When a later executor run
 *  failed (because the first already acted), the flow was reverted to PENDING
 *  even though the operation had executed.
 *
 *  Required (R26-#3): the flow row is locked FOR UPDATE inside the decision
 *  transaction, the status claim is conditional, the executor runs exactly
 *  once, and every other approver gets the same 409 "already decided" answer.
 *
 *  Executors covered (all governance executors that move money):
 *    BUSINESS_LOAN_DISBURSE, CREDIT_LOAN_DISBURSE, WALLET_TRANSFER,
 *    EVENT_WITHDRAWAL, plus card settle / card refund run through the same
 *    decision path (test-only action types wrapping cardService), and the
 *    four-eyes path for CARD_ADMIN_SETTLE / CARD_ADMIN_REFUND.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix> on
 * 127.0.0.1:55471. axios is stubbed: no real network.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_PORT !== '55471') {
  console.error('REFUSING: DB_HOST/DB_PORT must be the disposable p71-ci-db (127.0.0.1:55471).');
  process.exit(2);
}

const path = require('path');
const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve(path.join(ROOT, 'node_modules/axios'));
require(axiosPath);
require.cache[axiosPath].exports = {
  post: async () => { throw new Error('network disabled in test'); },
  get: async () => { throw new Error('network disabled in test'); },
  create() { return this; },
  defaults: { headers: { common: {} } },
  interceptors: { request: { use() {} }, response: { use() {} } },
};
const pool = require(path.join(ROOT, 'src/config/db'));
const logger = require(path.join(ROOT, 'src/utils/logger'));
logger.error = () => {}; logger.warn = () => {}; logger.info = () => {};
const fin = require(path.join(ROOT, 'src/services/financialEngine'));
const gov = require(path.join(ROOT, 'src/services/governanceService'));
const business = require(path.join(ROOT, 'src/services/businessService'));
const credit = require(path.join(ROOT, 'src/services/savingsCreditService'));
const walletService = require(path.join(ROOT, 'src/services/walletService'));
const eventService = require(path.join(ROOT, 'src/services/eventService'));
const card = require(path.join(ROOT, 'src/services/cardService'));
const fe = require(path.join(ROOT, 'src/services/fourEyesService'));
// Loading the routers registers the production executors exactly as server.js does.
require(path.join(ROOT, 'src/routes/businessRoutes'));
require(path.join(ROOT, 'src/routes/creditRoutes'));
require(path.join(ROOT, 'src/routes/walletRoutes'));
require(path.join(ROOT, 'src/routes/eventRoutes'));
require(path.join(ROOT, 'src/routes/fourEyesRoutes'));

let passed = 0; let failed = 0;
function check(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); }
}
async function section(fn) {
  try { await fn(); } catch (e) { failed++; console.log(`  ✗ section aborted — ${e.message}`); }
}
const q1 = async (sql, p) => (await pool.query(sql, p)).rows[0];
const num = async (sql, p) => Number(Object.values(await q1(sql, p))[0]);
let seq = 0;
async function user(label, role) {
  seq++;
  const phone = `2556${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  const id = (await q1('INSERT INTO users (full_name, phone_number) VALUES ($1,$2) RETURNING id', [`R26G ${label} ${seq}`, phone])).id;
  if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
  return { id, phone };
}
async function fund(userId, amount) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await fin.creditWallet({ client: c, userId, amount, reference: `R26G-FUND-${userId}-${seq}-${Date.now()}`, description: 'test funding' });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const wallet = (id) => num('SELECT wallet_balance FROM users WHERE id=$1', [id]);
async function expectReject(fn) { try { await fn(); return null; } catch (e) { return e; } }

// Count executor invocations by wrapping the service function the executor
// calls (executors look the function up on the module object at call time).
const calls = {};
function countOn(mod, fnName, key) {
  const orig = mod[fnName];
  calls[key] = 0;
  mod[fnName] = async function counted(...a) { calls[key]++; return orig.apply(this, a); };
}
countOn(business, 'adminDisburseLoan', 'business');
countOn(credit, 'adminDisburseMicroLoan', 'credit');
countOn(walletService, 'transferWallet', 'wallet');
countOn(eventService, 'executeEventWithdrawal', 'event');
countOn(card, 'settleCardAuth', 'settle');
countOn(card, 'refundCardAuth', 'refund');
// Card settle/refund have no production governance executor; run them through
// the same decision path with test-only action types.
gov.registerExecutor('R26T_CARD_SETTLE', async (p, approverId) => card.settleCardAuth(approverId, p.authReference));
gov.registerExecutor('R26T_CARD_REFUND', async (p, approverId) => card.refundCardAuth(approverId, p.authReference));

const N = 4; // concurrent approvers
async function approvers(n) { const a = []; for (let i = 0; i < n; i++) a.push(await user(`checker${i}`, 'ADMIN')); return a; }

// Fire N concurrent APPROVE decisions and assert the common contract.
async function raceApprove(label, flowId, key) {
  const before = calls[key];
  const chk = await approvers(N);
  const r = await Promise.allSettled(chk.map((c) => gov.decideApprovalFlow(flowId, c.id, 'APPROVE', `r26 ${label}`)));
  const ok = r.filter((x) => x.status === 'fulfilled');
  const bad = r.filter((x) => x.status === 'rejected').map((x) => x.reason);
  const invoked = calls[key] - before;
  console.log(`  · observed: executor invocations=${invoked} fulfilled=${ok.length} rejected=${bad.map((e) => `${e.statusCode || '-'}:${e.message.slice(0, 40)}`).join(' | ') || 'none'}`);
  check(`${label}: executor invoked exactly once (got ${invoked})`, invoked === 1);
  check(`${label}: exactly 1 of ${N} approvals fulfilled`, ok.length === 1, ok.length);
  check(`${label}: every other approver gets 409 "already decided"`,
    bad.length === N - 1 && bad.every((e) => e.statusCode === 409 && /tayari limeamuliwa/.test(e.message)),
    bad.map((e) => `${e.statusCode}:${e.message}`));
  const f = await q1('SELECT status, decided_at FROM approval_flows WHERE id=$1', [flowId]);
  check(`${label}: flow ends APPROVED with decided_at (not reverted to PENDING)`, f.status === 'APPROVED' && !!f.decided_at, f);
  check(`${label}: exactly one approval_actions row`, (await num('SELECT COUNT(*) FROM approval_actions WHERE flow_id=$1', [flowId])) === 1);
  return { ok, bad, invoked };
}

(async () => {
  const id = await q1('SELECT current_database() db, inet_server_port() port, inet_server_addr() addr');
  console.log(`DB identity: database=${id.db} server_addr=${id.addr} server_port=${id.port} client_target=${process.env.DB_HOST}:${process.env.DB_PORT}`);
  if (!DB_GUARD.test(id.db)) throw new Error('REFUSING: connected database is not disposable');

  console.log('\n[1] BUSINESS_LOAN_DISBURSE: concurrent approvals disburse once');
  await section(async () => {
    const maker = await user('maker', 'ADMIN');
    const owner = await user('owner');
    const biz = await business.registerBusiness(owner.id, { business_name: 'R26G shop 1' });
    const loan = await q1(`INSERT INTO business_loans (business_id, applicant_user_id, amount, interest_rate, term_months, status)
                           VALUES ($1,$2,9000,10,12,'APPROVED') RETURNING id`, [biz.id, owner.id]);
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'BUSINESS_LOAN_DISBURSE', refType: 'BUSINESS_LOAN', refId: loan.id, data: { loanId: loan.id, requesterId: maker.id, amount: 9000 } });
    await raceApprove('business loan', flow.id, 'business');
    check('business credited once (9,000)', (await num('SELECT balance FROM business_accounts WHERE id=$1', [biz.id])) === 9000);
    check('loan DISBURSED', (await q1('SELECT status FROM business_loans WHERE id=$1', [loan.id])).status === 'DISBURSED');
  });

  console.log('\n[2] CREDIT_LOAN_DISBURSE: concurrent approvals disburse once');
  await section(async () => {
    const maker = await user('maker', 'ADMIN');
    const borrower = await user('borrower');
    const w0 = await wallet(borrower.id);
    const loan = await q1(`INSERT INTO micro_loans (user_id, amount, interest_rate, term_months, status, approved_at)
                           VALUES ($1,7000,10,1,'APPROVED',NOW()) RETURNING id`, [borrower.id]);
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'CREDIT_LOAN_DISBURSE', refType: 'MICRO_LOAN', refId: loan.id, data: { loanId: loan.id, requesterId: maker.id, amount: 7000 } });
    await raceApprove('credit loan', flow.id, 'credit');
    check('borrower wallet credited once (+7,000)', (await wallet(borrower.id)) - w0 === 7000, (await wallet(borrower.id)) - w0);
    check('installment schedule created once (1 row)', (await num('SELECT COUNT(*) FROM loan_installments WHERE loan_id=$1', [loan.id])) === 1);
    check('one LOAN_CREDIT transaction row', (await num(`SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND meta->>'feature'='micro_loan'`, [borrower.id])) === 1);
  });

  console.log('\n[3] WALLET_TRANSFER: concurrent approvals transfer once');
  await section(async () => {
    const maker = await user('sender');
    const to = await user('recipient');
    await fund(maker.id, 50000);
    const s0 = await wallet(maker.id); const r0 = await wallet(to.id);
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'WALLET_TRANSFER', refType: 'WALLET_TRANSFER', data: { fromUserId: maker.id, toPhoneNumber: to.phone, amount: 10000, note: 'r26' } });
    await raceApprove('wallet transfer', flow.id, 'wallet');
    const sent = s0 - (await wallet(maker.id)); const got = (await wallet(to.id)) - r0;
    check('recipient credited once (+10,000)', got === 10000, got);
    check('sender debited for one transfer (10,000 plus any fee, < 20,000)', sent >= 10000 && sent < 20000, sent);
  });

  console.log('\n[4] EVENT_WITHDRAWAL: concurrent approvals pay once');
  await section(async () => {
    const owner = await user('event-owner');
    const ev = await q1(`INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R26G ev',$1,100000,40000) RETURNING id`, [owner.id]);
    const ref = `R26G-EVW-${Date.now()}`;
    const w = await q1(`INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status, requires_approval)
                        VALUES ($1,$2,'FUNDRAISING',15000,$3,'PENDING',TRUE) RETURNING id`, [ev.id, owner.id, ref]);
    const w0 = await wallet(owner.id);
    const flow = await gov.createApprovalFlow({ requesterId: owner.id, actionType: 'EVENT_WITHDRAWAL', refType: 'EVENT_WITHDRAWAL', refId: w.id, data: { eventId: ev.id, withdrawalId: w.id, mode: 'FUNDRAISING', amount: 15000, userId: owner.id, reference: ref } });
    await raceApprove('event withdrawal', flow.id, 'event');
    check('recipient paid once (+15,000)', (await wallet(owner.id)) - w0 === 15000, (await wallet(owner.id)) - w0);
    check('event pool debited once (25,000 left)', (await num('SELECT collected_amount FROM social_events WHERE id=$1', [ev.id])) === 25000);
  });

  async function heldCard(label) {
    const o = await user(label); await fund(o.id, 10000);
    const iss = await card.issueCard(o.id, { daily_limit: 100000, per_txn_limit: 100000 });
    const a = await card.authorizeCard(o.id, iss.card.id, { merchant_name: 'R26G', amount: 3000, cvv: iss.cvv });
    const ref = a.auth_reference || a.authReference || (a.transaction && a.transaction.auth_reference)
      || (await q1(`SELECT auth_reference FROM card_transactions WHERE card_id=$1 AND status='AUTH_HOLD' ORDER BY id DESC LIMIT 1`, [iss.card.id])).auth_reference;
    return { o, ref };
  }
  const cardState = (ref) => q1('SELECT status FROM card_transactions WHERE auth_reference=$1', [ref]);

  console.log('\n[5] card settle through decideApprovalFlow: executor once');
  await section(async () => {
    const maker = await user('maker', 'ADMIN');
    const { o, ref } = await heldCard('card-settle');
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'R26T_CARD_SETTLE', refType: 'CARD_AUTH', data: { authReference: ref } });
    await raceApprove('card settle', flow.id, 'settle');
    check('card transaction SETTLED', (await cardState(ref)).status === 'SETTLED');
    check('hold released, wallet debited once (7,000 left, 0 locked)',
      (await wallet(o.id)) === 7000 && (await num('SELECT locked_balance FROM users WHERE id=$1', [o.id])) === 0,
      { w: await wallet(o.id) });
  });

  console.log('\n[6] card refund through decideApprovalFlow: executor once');
  await section(async () => {
    const maker = await user('maker', 'ADMIN');
    const { o, ref } = await heldCard('card-refund');
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'R26T_CARD_REFUND', refType: 'CARD_AUTH', data: { authReference: ref } });
    await raceApprove('card refund', flow.id, 'refund');
    check('card transaction REFUNDED', (await cardState(ref)).status === 'REFUNDED');
    check('wallet restored (10,000, 0 locked)',
      (await wallet(o.id)) === 10000 && (await num('SELECT locked_balance FROM users WHERE id=$1', [o.id])) === 0,
      { w: await wallet(o.id) });
  });

  console.log('\n[7] APPROVE racing REJECT: exactly one decision');
  await section(async () => {
    const maker = await user('sender');
    const to = await user('recipient');
    await fund(maker.id, 20000);
    const r0 = await wallet(to.id);
    const before = calls.wallet;
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'WALLET_TRANSFER', refType: 'WALLET_TRANSFER', data: { fromUserId: maker.id, toPhoneNumber: to.phone, amount: 5000, note: 'r26' } });
    const [a, b] = await approvers(2);
    const r = await Promise.allSettled([gov.decideApprovalFlow(flow.id, a.id, 'APPROVE'), gov.decideApprovalFlow(flow.id, b.id, 'REJECT')]);
    const f = await q1('SELECT status FROM approval_flows WHERE id=$1', [flow.id]);
    const acts = await num('SELECT COUNT(*) FROM approval_actions WHERE flow_id=$1', [flow.id]);
    const ran = calls.wallet - before;
    check('exactly one decision fulfilled', r.filter((x) => x.status === 'fulfilled').length === 1, r.map((x) => x.status));
    check('exactly one approval_actions row', acts === 1, acts);
    check('state consistent: APPROVED⇔transfer ran once, REJECTED⇔no transfer',
      (f.status === 'APPROVED' && ran === 1 && (await wallet(to.id)) - r0 === 5000)
      || (f.status === 'REJECTED' && ran === 0 && (await wallet(to.id)) === r0), { status: f.status, ran });
  });

  console.log('\n[8] unchanged rules: self-approval refused; executor failure reverts to PENDING and retry works');
  await section(async () => {
    const maker = await user('sender');
    const to = await user('recipient');
    const flow = await gov.createApprovalFlow({ requesterId: maker.id, actionType: 'WALLET_TRANSFER', refType: 'WALLET_TRANSFER', data: { fromUserId: maker.id, toPhoneNumber: to.phone, amount: 4000, note: 'r26' } });
    const eSelf = await expectReject(() => gov.decideApprovalFlow(flow.id, maker.id, 'APPROVE'));
    check('requester cannot approve own flow', !!eSelf && /four-eyes/.test(eSelf.message), eSelf && eSelf.message);
    const [a, b] = await approvers(2);
    const eFail = await expectReject(() => gov.decideApprovalFlow(flow.id, a.id, 'APPROVE')); // sender has 0 balance
    check('executor failure surfaces as an error (400)', !!eFail && eFail.statusCode === 400, eFail && `${eFail.statusCode}:${eFail.message}`);
    check('flow reverted to PENDING after executor failure', (await q1('SELECT status FROM approval_flows WHERE id=$1', [flow.id])).status === 'PENDING');
    await fund(maker.id, 10000);
    const ok = await gov.decideApprovalFlow(flow.id, b.id, 'APPROVE').catch((e) => e);
    check('retry by another approver executes', ok && ok.flow && ok.flow.status === 'APPROVED', ok && (ok.message || ok.flow));
    const eAgain = await expectReject(() => gov.decideApprovalFlow(flow.id, a.id, 'APPROVE'));
    check('sequential approval after decision → 409 "already decided"', !!eAgain && eAgain.statusCode === 409 && /tayari limeamuliwa/.test(eAgain.message), eAgain && `${eAgain.statusCode}:${eAgain.message}`);
  });

  console.log('\n[9] four-eyes path CARD_ADMIN_SETTLE / CARD_ADMIN_REFUND: concurrent approvals execute once');
  await section(async () => {
    for (const [code, key, final] of [['CARD_ADMIN_SETTLE', 'settle', 'SETTLED'], ['CARD_ADMIN_REFUND', 'refund', 'REFUNDED']]) {
      const pol = await q1('SELECT enabled, required_approvers FROM four_eyes_policies WHERE action_code=$1', [code]);
      if (!pol || !pol.enabled) { check(`${code}: policy present and enabled`, false, pol); continue; }
      const maker = await user('fe-maker', 'ADMIN');
      const { ref } = await heldCard(`fe-${key}`);
      const req = await fe.initiateRequest({ actionCode: code, requesterId: maker.id, payload: { authReference: ref } });
      const reqId = req.id || (req.request && req.request.id);
      const before = calls[key];
      const chk = await approvers(N);
      const r = await Promise.allSettled(chk.map((c) => fe.approve(reqId, c.id, 'ADMIN', 'r26')));
      const ran = calls[key] - before;
      console.log(`  · observed ${code}: executor invocations=${ran} fulfilled=${r.filter((x) => x.status === 'fulfilled').length}`);
      check(`${code}: executor invoked exactly once`, ran === 1, ran);
      check(`${code}: card transaction ${final}`, (await cardState(ref)).status === final);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
