#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Remediation OBS-5: VICOBA social fund separation of duties
 *   requestSocialFundDisbursement  (src/services/vicobaService.js)
 *   approveSocialFundDisbursement  (src/services/vicobaService.js)
 *   callers: POST /vicoba/groups/:groupId/social-fund/request,
 *            POST /vicoba/social-fund-requests/:requestId/approve,
 *            four-eyes executor VICOBA_SOCIAL_FUND_DISBURSE (fourEyesRoutes.js)
 *
 * Rules enforced (documented, not new):
 *   - AFK-INST-16 §1 item 4: maker-checker for money actions, "no self-approval".
 *   - A group social fund request may only be filed by a member of that group.
 *
 *  1. Non-member request -> 403, no request row.
 *  2. Member request -> PENDING row (unchanged behaviour).
 *  3. Officer requests and approves own request -> 403; NOTHING moves:
 *     request still PENDING, no transaction, journal, claim, wallet or fund change, no SMS.
 *  4. A different officer approves -> DISBURSED once; wallet +amt, fund -amt,
 *     1 transaction, balanced journal DR VICOBA_GROUP / CR CUSTOMER_WALLET, 1 SMS.
 *  5. Duplicate approval after success -> 400, no second movement.
 *  6. Two officers approve the same request concurrently -> exactly one disbursement.
 *  7. Partial failure after the money step -> full rollback, request still PENDING.
 *  8. Static: guards run before the first write; the executor passes actorId to the
 *     service, where the guard lives.
 *
 * axios and smsService.sendSMS are stubbed: no network, and no phone number or SMS
 * text is printed. Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

setTimeout(() => {
  console.log('\nWATCHDOG: test process exceeded 90 s; exiting with failure.');
  process.exit(1);
}, 90000).unref();

require('axios');
const axiosPath = require.resolve('axios');
const httpCalls = [];
require.cache[axiosPath].exports = {
  post: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.post not expected'); },
  get: async (url) => { httpCalls.push(url); throw new Error('TEST: axios.get not expected'); },
};

// Stub SMS before vicobaService captures it: count calls, keep no phone/text.
const smsService = require('../src/services/smsService');
let smsCount = 0;
smsService.sendSMS = async () => { smsCount += 1; return { success: true, simulated: true }; };

const pool = require('../src/config/db');
const fin = require('../src/services/financialEngine');
const vicoba = require('../src/services/vicobaService');

const SERVICE_FILE = path.join(__dirname, '..', 'src', 'services', 'vicobaService.js');
const FOUR_EYES_FILE = path.join(__dirname, '..', 'src', 'routes', 'fourEyesRoutes.js');
const tag = crypto.randomBytes(4).toString('hex');
let seq = 0;

let passed = 0;
let failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  ✓ ' + label); }
function bad(label, extra) {
  failed++;
  failures.push(label);
  console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + extra : ''));
}
function expect(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function section(label) { console.log('\n--- ' + label + ' ---'); }
async function safe(fn) {
  try { return { value: await fn() }; } catch (e) { return { error: e.message || String(e), err: e }; }
}

const NOT_MEMBER = 'Hauko kwenye kikundi hiki.';
const SELF_APPROVAL = 'Huwezi kuidhinisha ombi lako mwenyewe.';

// ---- fixtures ---------------------------------------------------------------
async function makeUser(label) {
  seq += 1;
  const phone = `2557${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
  return (await pool.query(
    'INSERT INTO users (full_name, phone_number) VALUES ($1, $2) RETURNING id',
    [`P71SOD ${label} ${tag} ${seq}`, phone])).rows[0].id;
}
// Group with chair (MWENYEKITI), treasurer (MWEKAHAZINA), member (MJUMBE);
// social fund holding 100000.
async function makeGroup() {
  const chair = await makeUser('chair');
  const treasurer = await makeUser('treasurer');
  const member = await makeUser('member');
  const groupId = (await pool.query(
    `INSERT INTO vicoba_groups (group_name, created_by_user_id, share_value, status)
     VALUES ($1, $2, 1000, 'ACTIVE') RETURNING id`, [`P71SOD group ${tag} ${++seq}`, chair])).rows[0].id;
  for (const [uid, role] of [[chair, 'MWENYEKITI'], [treasurer, 'MWEKAHAZINA'], [member, 'MJUMBE']]) {
    await pool.query('INSERT INTO vicoba_members (group_id, user_id, role_in_group) VALUES ($1, $2, $3)', [groupId, uid, role]);
  }
  const fundId = (await pool.query(
    `INSERT INTO vicoba_social_fund (group_id, total_balance, total_collected, monthly_contribution)
     VALUES ($1, 100000, 100000, 5000) RETURNING id`, [groupId])).rows[0].id;
  return { groupId, fundId, chair, treasurer, member };
}
async function request(groupId, userId, amount = 20000) {
  return vicoba.requestSocialFundDisbursement(groupId, userId,
    { reasonType: 'ILLNESS', reasonDetail: 'P71SOD test', requestedAmount: amount });
}
// Everything approveSocialFundDisbursement can write for one request.
async function footprint(g, requestId, userId) {
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const req = await one('SELECT status, approved_by, approved_amount, disbursement_reference FROM vicoba_social_fund_requests WHERE id = $1', [requestId]);
  const txns = await one(
    `SELECT COUNT(*)::int AS c, MIN(reference_id) AS ref FROM transactions
      WHERE type = 'VICOBA_SOCIAL_FUND_DISBURSEMENT' AND (meta->>'request_id')::int = $1`, [requestId]);
  const ref = txns.ref;
  const journal = ref ? await one(
    `SELECT COUNT(*)::int AS c,
            COALESCE(SUM(CASE WHEN direction = 'DR' THEN amount END),0)::numeric AS dr,
            COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount END),0)::numeric AS cr
       FROM journal_entries WHERE reference_id = $1`, [ref]) : { c: 0, dr: 0, cr: 0 };
  const claims = ref ? (await one('SELECT COUNT(*)::int AS c FROM financial_operations WHERE reference_id = $1', [ref])).c : 0;
  const fund = await one('SELECT total_balance, total_disbursed FROM vicoba_social_fund WHERE id = $1', [g.fundId]);
  const wallet = await one('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return {
    status: req.status, approvedBy: req.approved_by, txns: txns.c, journal: journal.c,
    dr: Number(journal.dr), cr: Number(journal.cr), claims,
    fund: Number(fund.total_balance), disbursed: Number(fund.total_disbursed), wallet: Number(wallet.wallet_balance),
  };
}
const show = (o) => JSON.stringify(o);

// ---------------------------------------------------------------------------
async function testNonMember() {
  section('1. Non-member files a request -> 403, no row');
  const g = await makeGroup();
  const outsider = await makeUser('outsider');
  const before = (await pool.query('SELECT COUNT(*)::int AS c FROM vicoba_social_fund_requests WHERE group_id = $1', [g.groupId])).rows[0].c;
  const r = await safe(() => request(g.groupId, outsider));
  expect(r.error === NOT_MEMBER && r.err.statusCode === 403, 'non-member: 403 "Hauko kwenye kikundi hiki."', r.error || show(r.value));
  const after = (await pool.query('SELECT COUNT(*)::int AS c FROM vicoba_social_fund_requests WHERE group_id = $1', [g.groupId])).rows[0].c;
  expect(after === before, 'non-member: no request row created', `${before} -> ${after}`);
}

async function testMemberRequest() {
  section('2. Member files a request -> PENDING (unchanged)');
  const g = await makeGroup();
  const r = await safe(() => request(g.groupId, g.member));
  expect(!r.error && r.value && r.value.status === 'PENDING' && Number(r.value.requested_amount) === 20000,
    'member: PENDING request for 20000', r.error || show(r.value));
}

async function testSelfApproval() {
  section('3. Officer approves own request -> 403, nothing moves');
  const g = await makeGroup();
  for (const officer of ['treasurer', 'chair']) {
    const req = await request(g.groupId, g[officer]);
    const before = await footprint(g, req.id, g[officer]);
    const sms0 = smsCount;
    const r = await safe(() => vicoba.approveSocialFundDisbursement(g[officer], req.id));
    expect(r.error === SELF_APPROVAL && r.err.statusCode === 403, `${officer}: self-approval 403`, r.error || show(r.value));
    const after = await footprint(g, req.id, g[officer]);
    expect(after.status === 'PENDING' && after.approvedBy === null, `${officer}: request still PENDING, approved_by NULL`, show(after));
    expect(after.txns === 0 && after.journal === 0 && after.claims === 0, `${officer}: no transaction, journal or claim`, show(after));
    expect(after.fund === before.fund && after.wallet === before.wallet, `${officer}: fund and wallet unchanged`, `${show(before)} -> ${show(after)}`);
    expect(smsCount === sms0, `${officer}: no SMS`, smsCount - sms0);
    // Same request via a partial approved amount must also be refused.
    const r2 = await safe(() => vicoba.approveSocialFundDisbursement(g[officer], req.id, 1000));
    expect(r2.error === SELF_APPROVAL, `${officer}: self-approval with an explicit amount also 403`, r2.error || show(r2.value));
  }
}

async function testOtherOfficerAndDuplicate() {
  section('4/5. A different officer approves -> disbursed once; duplicate -> 400');
  const g = await makeGroup();
  const req = await request(g.groupId, g.treasurer, 20000);
  const before = await footprint(g, req.id, g.treasurer);
  const sms0 = smsCount;
  const r = await safe(() => vicoba.approveSocialFundDisbursement(g.chair, req.id));
  expect(!r.error && r.value && r.value.success === true, 'chair approves treasurer request: success', r.error || show(r.value));
  const after = await footprint(g, req.id, g.treasurer);
  expect(after.status === 'DISBURSED' && after.approvedBy === g.chair, 'request DISBURSED, approved_by = chair', show(after));
  expect(after.wallet === before.wallet + 20000, 'requester wallet +20000', `${before.wallet} -> ${after.wallet}`);
  expect(after.fund === before.fund - 20000 && after.disbursed === before.disbursed + 20000, 'fund -20000, total_disbursed +20000', show(after));
  expect(after.txns === 1 && after.claims === 1, '1 transaction, 1 claim', show(after));
  expect(after.journal === 2 && after.dr === 20000 && after.cr === 20000, 'journal 2 lines, DR = CR = 20000', show(after));
  const lines = (await pool.query(
    `SELECT la.account_code AS code, je.direction FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
      WHERE je.reference_id = (SELECT reference_id FROM transactions WHERE type = 'VICOBA_SOCIAL_FUND_DISBURSEMENT' AND (meta->>'request_id')::int = $1)
      ORDER BY je.direction DESC`, [req.id])).rows.map((x) => `${x.direction}:${x.code}`).join(',');
  expect(lines === 'DR:VICOBA_GROUP,CR:CUSTOMER_WALLET', 'journal DR VICOBA_GROUP / CR CUSTOMER_WALLET', lines);
  expect(smsCount === sms0 + 1, 'exactly 1 SMS', smsCount - sms0);

  const dup = await safe(() => vicoba.approveSocialFundDisbursement(g.chair, req.id));
  expect(dup.error === 'Ombi tayari limechakatwa.' && dup.err.statusCode === 400, 'duplicate approval: 400', dup.error || show(dup.value));
  const again = await footprint(g, req.id, g.treasurer);
  expect(again.wallet === after.wallet && again.fund === after.fund && again.txns === 1 && again.journal === 2,
    'duplicate: no second movement', show(again));

  // Member request approved by an officer: unchanged behaviour.
  const req2 = await request(g.groupId, g.member, 5000);
  const r3 = await safe(() => vicoba.approveSocialFundDisbursement(g.treasurer, req2.id));
  const f3 = await footprint(g, req2.id, g.member);
  expect(!r3.error && f3.status === 'DISBURSED' && f3.wallet === 5000, 'treasurer approves member request: disbursed 5000', r3.error || show(f3));
}

async function testConcurrent() {
  section('6. Two officers approve the same request concurrently -> one disbursement');
  const g = await makeGroup();
  const req = await request(g.groupId, g.member, 30000);
  const before = await footprint(g, req.id, g.member);
  const results = await Promise.all([
    safe(() => vicoba.approveSocialFundDisbursement(g.chair, req.id)),
    safe(() => vicoba.approveSocialFundDisbursement(g.treasurer, req.id)),
  ]);
  const wins = results.filter((x) => !x.error).length;
  const losers = results.filter((x) => x.error === 'Ombi tayari limechakatwa.').length;
  expect(wins === 1 && losers === 1, 'exactly one approval wins, the other gets "tayari limechakatwa"', show(results.map((x) => x.error || 'OK')));
  const after = await footprint(g, req.id, g.member);
  expect(after.wallet === before.wallet + 30000 && after.fund === before.fund - 30000, 'moved exactly once (wallet +30000, fund -30000)', show(after));
  expect(after.txns === 1 && after.journal === 2 && after.claims === 1, '1 transaction, 2 journal lines, 1 claim', show(after));
}

async function testRollback() {
  section('7. Failure after the money step -> full rollback');
  const g = await makeGroup();
  const req = await request(g.groupId, g.member, 10000);
  const before = await footprint(g, req.id, g.member);
  const real = fin.groupToWallet;
  fin.groupToWallet = async (args) => { await real(args); throw new Error('TEST: injected failure after groupToWallet'); };
  let r;
  try {
    r = await safe(() => vicoba.approveSocialFundDisbursement(g.chair, req.id));
  } finally { fin.groupToWallet = real; }
  expect(r.error === 'TEST: injected failure after groupToWallet', 'injected failure surfaced', r.error || show(r.value));
  const after = await footprint(g, req.id, g.member);
  expect(after.status === 'PENDING' && after.approvedBy === null, 'request still PENDING, approved_by NULL', show(after));
  expect(after.txns === 0 && after.journal === 0 && after.claims === 0, 'no transaction, journal or claim survives', show(after));
  expect(after.wallet === before.wallet && after.fund === before.fund, 'wallet and fund unchanged', `${show(before)} -> ${show(after)}`);
  // The same request can still be approved normally afterwards.
  const r2 = await safe(() => vicoba.approveSocialFundDisbursement(g.chair, req.id));
  const f2 = await footprint(g, req.id, g.member);
  expect(!r2.error && f2.status === 'DISBURSED' && f2.wallet === before.wallet + 10000, 'after rollback, a clean approval disburses once', r2.error || show(f2));
}

async function testStatic() {
  section('8. Static: guard placement and caller wiring');
  const src = fs.readFileSync(SERVICE_FILE, 'utf8');
  const reqFn = src.slice(src.indexOf('async function requestSocialFundDisbursement'), src.indexOf('async function approveSocialFundDisbursement'));
  const iMember = reqFn.indexOf('FROM vicoba_members');
  const iInsert = reqFn.indexOf('INSERT INTO vicoba_social_fund_requests');
  expect(iMember > 0 && iInsert > iMember, 'request: membership lookup precedes the INSERT', `${iMember} / ${iInsert}`);
  const apFn = src.slice(src.indexOf('async function approveSocialFundDisbursement'));
  const iSelf = apFn.indexOf('requester_id) === Number(actorUserId)');
  const iFirstWrite = apFn.indexOf('UPDATE vicoba_social_fund_requests');
  expect(iSelf > 0 && iFirstWrite > iSelf, 'approve: self-approval check precedes the first write', `${iSelf} / ${iFirstWrite}`);
  const fe = fs.readFileSync(FOUR_EYES_FILE, 'utf8');
  const exec = fe.slice(fe.indexOf("'VICOBA_SOCIAL_FUND_DISBURSE'"), fe.indexOf("'CARD_ADMIN_SETTLE'"));
  expect(/vicoba\.approveSocialFundDisbursement\(actorId,/.test(exec), 'four-eyes executor calls the guarded service with actorId', exec.slice(0, 120));
}

// ---------------------------------------------------------------------------
(async () => {
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS addr, inet_server_port() AS port`);
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);
    const silenced = console.error;
    console.error = () => {};
    try {
      for (const t of [testNonMember, testMemberRequest, testSelfApproval, testOtherOfficerAndDuplicate, testConcurrent, testRollback, testStatic]) {
        const res = await safe(t);
        if (res.error) bad(`${t.name} aborted`, res.error);
      }
    } finally {
      console.error = silenced;
    }
    expect(httpCalls.length === 0, 'no real provider HTTP call', httpCalls.length);
  } catch (e) {
    bad('unexpected error', e && e.stack || e);
  } finally {
    await pool.end().catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
})();
