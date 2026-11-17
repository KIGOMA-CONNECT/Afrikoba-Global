#!/usr/bin/env node
'use strict';
/* R36 Task 3 — strict amount validation on the pilot financial endpoints (no silent coercion).
 *  [1] schemas (zod): 5000 parses to the identical number; "5000", " 5000 ", true, null, undefined,
 *      NaN, Infinity, -5000, 0 are rejected, for every pilot amount field.
 *  [2] helper strictAmount: same accept/reject set; returns the same number (Object.is).
 *  [3] HTTP, each pilot endpoint, each JSON-representable bad value ("5000", " 5000 ", true, null,
 *      missing, -5000, raw 1e400 = Infinity after JSON.parse, raw NaN = JSON parse error):
 *      400 and NO DB change. Endpoints: contribute, schedule pay, loan request, MHASIBU decision,
 *      MWENYEKITI approve, repay, withdrawal request, social-fund init/request/approve, mkoba transfer.
 *  [4] service level with real NaN / Infinity / undefined (not representable in JSON): refused, no DB change.
 *  [5] 5000 accepted, and the value used is exactly the value given: contribute 5000 -> transaction
 *      wallet_amount 5000.00, ledger 5000.00, member contribution +5000, group +5000; loan 5000 ->
 *      requested_amount 5000.00, MHASIBU 5000 -> approved 5000.00, final disbursement exactly 500000 cents;
 *      fractional 5000.25 contribute -> 5000.25 stored (no truncation/rounding by the validator).
 */
const h = require('./r36-harness');
const { check, call, group, q1, snap, diffSnap, attempt } = h;
const schemas = require(h.path.join(h.ROOT, 'src/validations/schemas'));
const { strictAmount } = require(h.path.join(h.ROOT, 'src/utils/strictAmount'));
const vicoba = require(h.path.join(h.ROOT, 'src/services/vicobaService'));
const wallet = require(h.path.join(h.ROOT, 'src/services/walletService'));
const mkoba = require(h.path.join(h.ROOT, 'src/services/mkobaService'));

const BAD = [['"5000"', '5000'], ['" 5000 "', ' 5000 '], ['true', true], ['null', null], ['undefined', undefined], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['-5000', -5000], ['0', 0]];
const cents = (v) => Math.round(Number(v) * 100);

(async () => {
  console.log('\n[1] zod schemas');
  const FIELDS = [
    ['wallet.transfer', 'amount', { toPhoneNumber: '255712345678' }], ['wallet.deposit', 'amount', { provider: 'Mpesa' }], ['wallet.withdraw', 'amount', { provider: 'Mpesa' }],
    ['vicoba.contribute', 'amount', {}], ['vicoba.requestLoan', 'requestedAmount', { applicantUserId: 1 }], ['vicoba.approveLoan', 'approvedAmount', {}],
    ['vicoba.payContribution', 'amount', {}], ['vicoba.socialFund', 'monthlyContribution', {}], ['vicoba.socialFundRequest', 'requestedAmount', { reasonType: 'MSIBA', reasonDetail: 'x' }],
    ['vicoba.socialFundApprove', 'approvedAmount', {}], ['vicoba.repayLoan', 'amount', {}], ['vicoba.withdrawal', 'amount', {}], ['vicoba.bonus', 'amount', {}],
    ['mkoba.transfer', 'amount', { transferType: 'LOAN', recipientUserId: 1 }], ['mkoba.attendance', 'fineAmount', { userId: 1, status: 'ABSENT' }],
  ];
  for (const [name, field, rest] of FIELDS) {
    const [sec, key] = name.split('.');
    const sch = schemas[sec][key];
    const good = sch.safeParse({ ...rest, [field]: 5000 });
    const optional = sch.safeParse({ ...rest }).success;
    const rejected = BAD.filter(([l, v]) => !(l === 'undefined' && optional)).every(([, v]) => !sch.safeParse({ ...rest, [field]: v }).success);
    check(`[1] ${name}.${field}: 5000 -> same number; bad values rejected${optional ? ' (field optional: absent allowed)' : ''}`,
      good.success && Object.is(good.data[field], 5000) && rejected, { good: good.success, bad: BAD.filter(([, v]) => sch.safeParse({ ...rest, [field]: v }).success).map(([l]) => l) });
  }
  check('[1] sharesCount strict integer (contribute): "2" and 2.5 rejected, 2 accepted',
    !schemas.vicoba.contribute.safeParse({ amount: 5000, sharesCount: '2' }).success && !schemas.vicoba.contribute.safeParse({ amount: 5000, sharesCount: 2.5 }).success && schemas.vicoba.contribute.safeParse({ amount: 5000, sharesCount: 2 }).success);

  console.log('\n[2] strictAmount helper');
  check('[2] 5000 returned as the identical number', Object.is(strictAmount(5000), 5000) && Object.is(strictAmount(5000.25), 5000.25));
  for (const [l, v] of BAD) {
    const r = await attempt(() => strictAmount(v));
    check(`[2] ${l} -> 400`, !r.ok && r.status === 400, r);
  }

  await h.listen(h.buildApp());
  const s = await group([['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE'], ['member2', 'MJUMBE']], 2000000, 1000000);
  await h.pool.query('UPDATE vicoba_members SET contribution_balance = 100000 WHERE group_id = $1', [s.g]);
  await h.pool.query(`INSERT INTO vicoba_contribution_schedules (group_id, cycle_number, due_date) VALUES ($1, 1, CURRENT_DATE + 30)`, [s.g]);
  const submit = (body) => call('POST', `/api/v1/vicoba/groups/${s.g}/loans`, s.member, body);
  const decide = (lid, who, body) => call('POST', `/api/v1/vicoba/loans/${lid}/decision`, who, body);
  const newLoan = async (amt = 5000) => { const r = await submit({ requestedAmount: amt }); if (r.status !== 201) throw new Error(`setup loan ${JSON.stringify(r.body)}`); return r.body.loan.id; };
  const atMhasibu = async () => { const lid = await newLoan(); const r = await decide(lid, s.katibu, { step: 'KATIBU', decision: 'APPROVE' }); if (r.status !== 200) throw new Error(`setup KATIBU ${JSON.stringify(r.body)}`); return lid; };
  const lidM = await atMhasibu();
  const lidF = await atMhasibu();
  { const r = await decide(lidF, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 5000 }); if (r.status !== 200) throw new Error(`setup MHASIBU ${JSON.stringify(r.body)}`); }
  const sfr = await call('POST', `/api/v1/vicoba/groups/${s.g}/social-fund`, s.chair, { monthlyContribution: 2000 });
  if (sfr.status >= 300) throw new Error(`setup social fund ${JSON.stringify(sfr.body)}`);
  await h.pool.query('UPDATE vicoba_social_fund SET total_balance = 100000 WHERE group_id = $1', [s.g]);
  const sreq = await call('POST', `/api/v1/vicoba/groups/${s.g}/social-fund/request`, s.member, { reasonType: 'MSIBA', reasonDetail: 'r36', requestedAmount: 5000 });
  if (sreq.status >= 300) throw new Error(`setup social fund request ${JSON.stringify(sreq.body)}`);
  const sreqId = (sreq.body.request || sreq.body).id;
  const g2 = await group([['chair', 'MWENYEKITI'], ['member', 'MJUMBE']]);

  const ENDPOINTS = [
    ['contribute', 'POST', `/api/v1/vicoba/groups/${s.g}/contribute`, s.member, 'amount', {}],
    ['schedule pay', 'POST', `/api/v1/vicoba/groups/${s.g}/schedules/1/pay`, s.member, 'amount', {}],
    ['loan request', 'POST', `/api/v1/vicoba/groups/${s.g}/loans`, s.member2, 'requestedAmount', {}],
    ['MHASIBU decision', 'POST', `/api/v1/vicoba/loans/${lidM}/decision`, s.treasurer, 'approvedAmount', { step: 'MHASIBU', decision: 'APPROVE' }],
    ['MWENYEKITI approve', 'POST', `/api/v1/vicoba/loans/${lidF}/approve`, s.chair, 'approvedAmount', {}],
    ['repay', 'POST', `/api/v1/vicoba/loans/${lidF}/repay`, s.member, 'amount', {}],
    ['withdrawal', 'POST', `/api/v1/vicoba/groups/${s.g}/withdrawals`, s.member, 'amount', {}],
    ['social fund init', 'POST', `/api/v1/vicoba/groups/${g2.g}/social-fund`, g2.chair, 'monthlyContribution', {}],
    ['social fund request', 'POST', `/api/v1/vicoba/groups/${s.g}/social-fund/request`, s.member2, 'requestedAmount', { reasonType: 'MSIBA', reasonDetail: 'r36' }],
    ['social fund approve', 'POST', `/api/v1/vicoba/social-fund-requests/${sreqId}/approve`, s.chair, 'approvedAmount', {}],
    ['mkoba transfer', 'POST', `/api/v1/vicoba/groups/${s.g}/transfers`, s.katibu, 'amount', { transferType: 'LOAN', recipientUserId: s.member.id }],
  ];
  // optional fields: absent means "use the stored amount", so "missing" is not a bad value there
  const OPTIONAL = new Set(['MHASIBU decision', 'MWENYEKITI approve', 'social fund approve']);
  const HTTP_BAD = [['"5000"', '5000'], ['" 5000 "', ' 5000 '], ['true', true], ['null', null], ['-5000', -5000], ['0', 0], ['missing', undefined]];

  console.log('\n[3] HTTP: every pilot endpoint refuses every bad value with no DB change');
  for (const [label, method, url, who, field, rest] of ENDPOINTS) {
    for (const [l, v] of HTTP_BAD) {
      if (l === 'missing' && OPTIONAL.has(label)) continue;
      const body = { ...rest }; if (v !== undefined) body[field] = v;
      const before = await snap();
      const r = await call(method, url, who, body);
      const d = diffSnap(before, await snap());
      check(`[3] ${label} ${field}=${l} -> 400, no DB change`, r.status === 400 && d.length === 0, { status: r.status, body: r.body, d });
    }
    for (const [l, raw] of [['1e400 (Infinity)', `{"${field}":1e400}`], ['NaN (raw)', `{"${field}":NaN}`]]) {
      const extra = JSON.stringify(rest).slice(1, -1);
      const before = await snap();
      const r = await call(method, url, who, undefined, raw.replace('{', `{${extra ? `${extra},` : ''}`));
      check(`[3] ${label} ${field}=${l} -> 400, no DB change`, r.status === 400 && diffSnap(before, await snap()).length === 0, { status: r.status, body: r.body });
    }
  }

  console.log('\n[4] service level: NaN / Infinity / undefined / strings');
  const SVC = [
    ['contributeShares', (v) => vicoba.contributeShares(s.g, s.member.id, v, 1)],
    ['payContribution', (v) => vicoba.payContribution(s.g, s.member.id, 1, v)],
    ['requestLoan', (v) => vicoba.requestLoan(s.member2.id, { groupId: s.g, requestedAmount: v })],
    ['repayLoan', (v) => vicoba.repayLoan(s.member.id, lidF, v)],
    ['requestWithdrawal', (v) => vicoba.requestWithdrawal(s.member.id, s.g, v)],
    ['requestSocialFundDisbursement', (v) => vicoba.requestSocialFundDisbursement(s.g, s.member2.id, { reasonType: 'MSIBA', reasonDetail: 'r36', requestedAmount: v })],
    ['transferWallet (internal test wallet)', (v) => wallet.transferWallet(s.member.id, s.member2.phone, v, 'r36')],
    ['mkoba.initiateTransfer', (v) => mkoba.initiateTransfer(s.katibu.id, s.g, { transferType: 'LOAN', recipientUserId: s.member.id, amount: v })],
  ];
  for (const [name, fn] of SVC) {
    for (const [l, v] of BAD) {
      const before = await snap();
      const r = await attempt(() => fn(v));
      check(`[4] ${name}(${l}) -> 400, no DB change`, !r.ok && r.status === 400 && diffSnap(before, await snap()).length === 0, r);
    }
  }
  for (const [l, v] of [['NaN', NaN], ['Infinity', Infinity], ['"5000"', '5000'], ['null', null], ['true', true]]) {
    const before = await snap();
    const r1 = await attempt(() => vicoba.decideLoanStep(s.treasurer.id, lidM, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: v }));
    const r2 = await attempt(() => vicoba.approveLoan(s.chair.id, lidF, v));
    check(`[4] decideLoanStep/approveLoan approvedAmount=${l} -> 400 VICOBA_LOAN_AMOUNT_INVALID, no DB change`,
      !r1.ok && r1.code === 'VICOBA_LOAN_AMOUNT_INVALID' && !r2.ok && r2.code === 'VICOBA_LOAN_AMOUNT_INVALID' && diffSnap(before, await snap()).length === 0, { r1, r2 });
  }

  console.log('\n[5] 5000 accepted; the validated value is the value used');
  {
    const g0 = cents((await q1('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [s.g])).group_wallet_balance);
    const m0 = cents((await q1('SELECT contribution_balance FROM vicoba_members WHERE group_id=$1 AND user_id=$2', [s.g, s.member.id])).contribution_balance);
    const r = await call('POST', `/api/v1/vicoba/groups/${s.g}/contribute`, s.member, { amount: 5000 });
    const tx = await q1('SELECT id, wallet_amount FROM transactions WHERE reference_id=$1', [r.body && r.body.referenceId]);
    const led = tx && await q1('SELECT amount FROM wallet_ledger WHERE transaction_id=$1', [tx.id]);
    check('[5] contribute 5000 -> 200', r.status === 200 && r.body.success === true, r.body);
    check('[5] transaction wallet_amount = 5000.00 and ledger amount = 5000.00', tx && String(tx.wallet_amount) === '5000.00' && led && String(led.amount) === '5000.00', { tx, led });
    check('[5] group +500000 cents, member contribution +500000 cents',
      cents((await q1('SELECT group_wallet_balance FROM vicoba_groups WHERE id=$1', [s.g])).group_wallet_balance) === g0 + 500000
      && cents((await q1('SELECT contribution_balance FROM vicoba_members WHERE group_id=$1 AND user_id=$2', [s.g, s.member.id])).contribution_balance) === m0 + 500000);
    const rf = await call('POST', `/api/v1/vicoba/groups/${s.g}/contribute`, s.member, { amount: 5000.25 });
    const txf = await q1('SELECT wallet_amount FROM transactions WHERE reference_id=$1', [rf.body && rf.body.referenceId]);
    check('[5] contribute 5000.25 stored exactly 5000.25 (validator neither truncates nor rounds)', rf.status === 200 && txf && String(txf.wallet_amount) === '5000.25', { rf: rf.body, txf });

    const lr = await submit({ requestedAmount: 5000 });
    check('[5] loan request 5000 -> requested_amount 5000.00', lr.status === 201 && String((await q1('SELECT requested_amount FROM vicoba_loan_requests WHERE id=$1', [lr.body.loan.id])).requested_amount) === '5000.00', lr.body);
    const mh = await decide(lidM, s.treasurer, { step: 'MHASIBU', decision: 'APPROVE', approvedAmount: 5000 });
    check('[5] MHASIBU 5000 -> approved_amount 5000.00', mh.status === 200 && String((await q1('SELECT approved_amount FROM vicoba_loan_requests WHERE id=$1', [lidM])).approved_amount) === '5000.00', mh.body);
    const w0 = cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [s.member.id])).wallet_balance);
    const fin = await call('POST', `/api/v1/vicoba/loans/${lidF}/approve`, s.chair, { approvedAmount: 5000 });
    check('[5] final approve 5000 -> member wallet +500000 cents exactly', fin.status === 200 && cents((await q1('SELECT wallet_balance FROM users WHERE id=$1', [s.member.id])).wallet_balance) === w0 + 500000, fin.body);
  }

  await h.finish('R36 (3) strict amounts');
})().catch(h.fatal);
