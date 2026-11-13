#!/usr/bin/env node
'use strict';
/* R36 regression (found by r28-s6 during R36 regression) — internal callers that pass a STORED NUMERIC
 * amount (pg returns NUMERIC as a string, e.g. "1500.00") into a strict-amount service must convert it
 * explicitly; the strict check is for client input, not for values the system validated at creation.
 *  [1] payment request: createRequest 1500 then payRequest -> PAID; requester +150000 cents, payer
 *      -150000 cents, exactly once.
 *  [2] scheduled payment worker (outside the pilot): a due ONCE row of 1000 is executed -> COMPLETED and
 *      the recipient is credited 100000 cents once (the full matrix is r28-s6).
 *  [3] the client boundary stays strict: transferWallet("1500") is still refused 400.
 */
const h = require('./r36-harness');
const { check, user, q1, attempt } = h;
const pr = require(h.path.join(h.ROOT, 'src/services/paymentRequestService'));
const net = require(h.path.join(h.ROOT, 'src/services/networkService'));
const ws = require(h.path.join(h.ROOT, 'src/services/walletService'));
const cents = async (id) => Math.round(Number((await q1('SELECT wallet_balance FROM users WHERE id=$1', [id])).wallet_balance) * 100);

(async () => {
  console.log('\n[1] payment request paid from a stored NUMERIC amount');
  {
    const requester = await user('requester', 0); const payer = await user('payer', 50000);
    const c = await pr.createRequest(requester.id, { payerPhone: payer.phone, amount: 1500, note: 'r36' });
    const id = c.id || (c.request && c.request.id);
    const r0 = await cents(requester.id); const p0 = await cents(payer.id);
    const p = await attempt(() => pr.payRequest(payer.id, id, 'r36'));
    check('[1] payRequest -> PAID', p.ok && p.r.status === 'PAID', p);
    check('[1] requester +150000, payer -150000 cents', (await cents(requester.id)) === r0 + 150000 && (await cents(payer.id)) === p0 - 150000);
    const again = await attempt(() => pr.payRequest(payer.id, id, 'r36'));
    check('[1] second pay is idempotent (alreadyPaid), no further movement', again.ok && again.r.alreadyPaid === true && (await cents(payer.id)) === p0 - 150000, again);
  }

  console.log('\n[2] scheduled payment worker executes a stored NUMERIC amount (not pilot)');
  {
    delete process.env.PILOT_MODE;
    const from = await user('sched-from', 50000); const to = await user('sched-to', 0);
    const row = await q1(`INSERT INTO scheduled_payments (user_id, recipient_phone, amount, type, description, scheduled_for, recurrence, status)
                          VALUES ($1,$2,1000,'TRANSFER','r36',NOW() - interval '1 minute','ONCE','ACTIVE') RETURNING id`, [from.id, to.phone]);
    const t0 = await cents(to.id);
    const r = await attempt(() => net.processDueScheduledPayments());
    const after = await q1('SELECT status FROM scheduled_payments WHERE id=$1', [row.id]);
    check('[2] row COMPLETED and recipient +100000 cents once', r.ok && after.status === 'COMPLETED' && (await cents(to.id)) === t0 + 100000, { r, after });
  }

  console.log('\n[3] client boundary still strict');
  {
    const a = await user('strict-a', 50000); const b = await user('strict-b', 0);
    const r = await attempt(() => ws.transferWallet(a.id, b.phone, '1500', 'r36'));
    check('[3] transferWallet("1500") -> 400', !r.ok && r.status === 400, r);
  }

  await h.finish('R36 (6) internal NUMERIC callers');
})().catch(h.fatal);
