#!/usr/bin/env node
'use strict';
/* R36 Task 4 — the pilot configuration boundary (src/config/pilot.js) is enforced server-side.
 *  [1] unit: PILOT_MODE='true' disables every PILOT_DISABLED feature; unknown feature names throw;
 *      PILOT_MODE unset/'false' -> features follow their own flags (addBonus still OFF by default).
 *  [2] HTTP gates as mounted by server.js (mountPilotGates per prefix, before the routers): with
 *      PILOT_MODE='true' every disabled path on /api/v1 AND /api returns 403 PILOT_FEATURE_DISABLED and
 *      never reaches a router; enabled pilot paths (VICOBA shares/contributions/loans/fines/social fund,
 *      internal wallet transfer) pass the gate. With PILOT_MODE unset the disabled paths pass the gate
 *      (except addBonus, OFF by default).
 *  [3] service level under PILOT_MODE='true' (authority even without HTTP): registerUser,
 *      createScheduledPayment, quote/send/pickupRemittance, calculate/approveProfitDistribution,
 *      AzamPay token/checkout/payout/status + initiateDeposit + withdrawToMno (even with config.azampay.enabled=true),
 *      processCrossNetworkTopUp -> 403 PILOT_FEATURE_DISABLED and no DB change; workers
 *      processDueScheduledPayments and recurrence runDueTasks execute nothing (a due rule stays unrun).
 *  [4] enabled features still work under PILOT_MODE='true': contribute, loan request, internal wallet
 *      transfer, social fund init.
 *  [5] production config: validateConfig() lists the PILOT_MODE error when it is unset or not exactly
 *      'true'/'false', and not when it is explicit.
 *  [6] static: server.js mounts the gates first inside the prefix loop; SACCOS mount stays behind
 *      SACCOS_ENABLED as well.
 */
const h = require('./r36-harness');
const fs = require('fs');
const { check, call, group, q1, snap, diffSnap, attempt, user } = h;
const pilot = require(h.path.join(h.ROOT, 'src/config/pilot'));
const config = require(h.path.join(h.ROOT, 'src/config'));

(async () => {
  console.log('\n[1] unit');
  {
    process.env.PILOT_MODE = 'true';
    const all = Object.keys(pilot.PILOT_DISABLED);
    check('[1] the nine disabled features are exactly the R36 list', JSON.stringify(all) === JSON.stringify(['vicobaAddBonus', 'annualDividends', 'p2p', 'saccos', 'remittance', 'recurringPayments', 'cards', 'externalPayments', 'publicRegistration']), all);
    check('[1] PILOT_MODE=true: all disabled', all.every((f) => pilot.isFeatureEnabled(f) === false));
    check('[1] unknown feature throws', !(await attempt(() => pilot.isFeatureEnabled('nope'))).ok && !(await attempt(() => pilot.requireFeature('nope'))).ok);
    for (const v of ['TRUE', '1', 'yes']) { process.env.PILOT_MODE = v; check(`[1] PILOT_MODE=${v} is not pilot mode and not explicit`, !pilot.isPilotMode() && !pilot.pilotModeExplicit()); }
    delete process.env.PILOT_MODE;
    check('[1] PILOT_MODE unset: others enabled, addBonus OFF', all.filter((f) => f !== 'vicobaAddBonus').every((f) => pilot.isFeatureEnabled(f)) && !pilot.isFeatureEnabled('vicobaAddBonus'));
    check('[1] enabled list documented', pilot.PILOT_ENABLED.length === 6);
  }

  console.log('\n[2] HTTP gates (server.js mount order, sentinel router behind them)');
  {
    const app = h.express();
    for (const prefix of ['/api/v1', '/api']) pilot.mountPilotGates(app, prefix);
    app.use((req, res) => res.status(299).json({ reached: true }));
    await h.listen(app);
    const DISABLED = [
      ['GET', '/p2p/requests'], ['POST', '/p2p/send'], ['POST', '/saccos/1/dividends'], ['GET', '/cards'], ['POST', '/cards/issue'],
      ['POST', '/recurrence/rules'], ['POST', '/network/scheduled'], ['POST', '/network/scheduled/process'], ['POST', '/network/remittance/send'],
      ['POST', '/network/remittance/pickup'], ['POST', '/payments/azampay-callback'], ['POST', '/auth/register'], ['POST', '/vicoba/groups/5/bonus'],
      ['POST', '/vicoba/groups/5/profits/calculate'], ['POST', '/vicoba/profits/9/approve'], ['POST', '/vicoba/groups/5/topup/cross-network'],
    ];
    const ENABLED = [
      ['POST', '/vicoba/groups/5/contribute'], ['POST', '/vicoba/groups/5/schedules/1/pay'], ['POST', '/vicoba/groups/5/loans'], ['POST', '/vicoba/loans/7/decision'],
      ['POST', '/vicoba/loans/7/approve'], ['POST', '/vicoba/penalties/3/pay'], ['POST', '/vicoba/groups/5/social-fund/request'], ['POST', '/wallet/transfer'],
      ['POST', '/auth/login'], ['GET', '/vicoba/groups/5'],
    ];
    process.env.PILOT_MODE = 'true';
    for (const prefix of ['/api/v1', '/api']) {
      for (const [m, p] of DISABLED) {
        const r = await call(m, `${prefix}${p}`, null, {});
        check(`[2] PILOT ${m} ${prefix}${p} -> 403 PILOT_FEATURE_DISABLED, router not reached`, r.status === 403 && r.body.code === 'PILOT_FEATURE_DISABLED' && !r.body.reached, r);
      }
      for (const [m, p] of ENABLED) {
        const r = await call(m, `${prefix}${p}`, null, {});
        check(`[2] PILOT ${m} ${prefix}${p} -> passes the gate`, r.status === 299, r);
      }
    }
    delete process.env.PILOT_MODE;
    for (const [m, p] of DISABLED) {
      const r = await call(m, `/api/v1${p}`, null, {});
      const expectOff = p.endsWith('/bonus');
      check(`[2] not pilot: ${m} ${p} -> ${expectOff ? '403 (addBonus OFF by default)' : 'passes the gate'}`, expectOff ? r.status === 403 : r.status === 299, r);
    }
  }

  console.log('\n[3] service-level enforcement under PILOT_MODE=true');
  const s = await group([['chair', 'MWENYEKITI'], ['katibu', 'KATIBU'], ['treasurer', 'MWEKAHAZINA'], ['member', 'MJUMBE']], 500000, 100000);
  const other = await user('other', 0);
  {
    process.env.PILOT_MODE = 'true';
    const authService = require(h.path.join(h.ROOT, 'src/services/authService'));
    const net = require(h.path.join(h.ROOT, 'src/services/networkService'));
    const mk = require(h.path.join(h.ROOT, 'src/services/mkobaService'));
    const az = require(h.path.join(h.ROOT, 'src/services/azampayService'));
    const ws = require(h.path.join(h.ROOT, 'src/services/walletService'));
    const rec = require(h.path.join(h.ROOT, 'src/services/recurrenceService'));
    const prevAz = config.azampay.enabled; config.azampay.enabled = true;
    const CALLS = [
      ['authService.registerUser', () => authService.registerUser({ fullName: 'R36 Reg', phoneNumber: '0719000111', password: 'abcdefghij12' })],
      ['networkService.createScheduledPayment', () => net.createScheduledPayment(s.member.id, { recipientPhone: other.phone, amount: 5000, scheduledFor: new Date().toISOString() })],
      ['networkService.quoteRemittance', () => net.quoteRemittance(s.member.id, { amount: 5000, corridor: 'TZ-KE' })],
      ['networkService.sendRemittance', () => net.sendRemittance(s.member.id, { amount: 5000 })],
      ['networkService.pickupRemittance', () => net.pickupRemittance('X', other.phone, 'x')],
      ['mkobaService.calculateProfitDistribution', () => mk.calculateProfitDistribution(s.g, 1, 5000, s.chair.id)],
      ['mkobaService.approveProfitDistribution', () => mk.approveProfitDistribution(1, s.chair.id)],
      ['azampayService.getAzamPayToken (config enabled=true)', () => az.getAzamPayToken()],
      ['azampayService.triggerMnoCheckout (config enabled=true)', () => az.triggerMnoCheckout({ amount: 5000, phone: other.phone, provider: 'Mpesa', externalId: 'r36' })],
      ['azampayService.triggerPayout (config enabled=true)', () => az.triggerPayout({ amount: 5000, phone: other.phone, provider: 'Mpesa', externalId: 'r36' })],
      ['azampayService.queryTransactionStatus (config enabled=true)', () => az.queryTransactionStatus('r36')],
      ['walletService.initiateDeposit (config enabled=true)', () => ws.initiateDeposit(s.member.id, 5000, 'Mpesa')],
      ['walletService.withdrawToMno (config enabled=true)', () => ws.withdrawToMno(s.member.id, 5000, 'Mpesa')],
      ['mkobaService.processCrossNetworkTopUp', () => mk.processCrossNetworkTopUp(s.g, s.member.id, { amount: 5000, provider: 'AZAMPAY' })],
    ];
    for (const [name, fn] of CALLS) {
      const before = await snap();
      const r = await attempt(fn);
      check(`[3] ${name} -> 403 PILOT_FEATURE_DISABLED, no DB change`, !r.ok && r.status === 403 && r.code === 'PILOT_FEATURE_DISABLED' && diffSnap(before, await snap()).length === 0, { r, d: diffSnap(before, await snap()) });
    }
    config.azampay.enabled = prevAz;
    // workers: a due recurrence rule must stay unrun
    const rule = await q1(`INSERT INTO recurrence_rules (name, task_type, frequency, payload, next_run_at, enabled) VALUES ('r36 due', 'R36_NOOP', 'DAILY', '{}', NOW() - interval '1 hour', TRUE) RETURNING id`);
    const before = await snap();
    const w1 = await attempt(() => net.processDueScheduledPayments());
    const w2 = await attempt(() => rec.runDueTasks());
    const ruleAfter = await q1('SELECT run_count, last_run_at FROM recurrence_rules WHERE id=$1', [rule.id]);
    check('[3] processDueScheduledPayments executes nothing', w1.ok && w1.r.skipped === 'PILOT_FEATURE_DISABLED', w1);
    check('[3] recurrence runDueTasks: due rule not run (run_count 0, no execution row)', w2.ok && w2.r.skipped === 'PILOT_FEATURE_DISABLED' && ruleAfter.run_count === 0 && ruleAfter.last_run_at === null, { w2, ruleAfter });
    check('[3] workers changed nothing', diffSnap(before, await snap()).length === 0, diffSnap(before, await snap()));
    // control: not pilot -> the same due rule IS run (proves the check above is not vacuous)
    delete process.env.PILOT_MODE;
    await rec.runDueTasks();
    check('[3] control: outside pilot the due rule runs', (await q1('SELECT run_count FROM recurrence_rules WHERE id=$1', [rule.id])).run_count === 1);
    await h.pool.query('UPDATE recurrence_rules SET enabled = FALSE WHERE id=$1', [rule.id]);
  }

  console.log('\n[4] enabled pilot features still work under PILOT_MODE=true');
  {
    process.env.PILOT_MODE = 'true';
    await h.listen(h.buildApp());
    const c = await call('POST', `/api/v1/vicoba/groups/${s.g}/contribute`, s.member, { amount: 5000 });
    check('[4] VICOBA contribute 5000 -> 200', c.status === 200 && c.body.success, c.body);
    const l = await call('POST', `/api/v1/vicoba/groups/${s.g}/loans`, s.member, { requestedAmount: 5000 });
    check('[4] VICOBA loan request -> 201', l.status === 201, l.body);
    const sf = await call('POST', `/api/v1/vicoba/groups/${s.g}/social-fund`, s.chair, { monthlyContribution: 2000 });
    check('[4] social fund init -> 2xx', sf.status >= 200 && sf.status < 300, sf.body);
    const ws = require(h.path.join(h.ROOT, 'src/services/walletService'));
    const t = await attempt(() => ws.transferWallet(s.member.id, other.phone, 1000, 'r36'));
    check('[4] internal test wallet transfer works', t.ok, t);
    delete process.env.PILOT_MODE;
  }

  console.log('\n[5] production config requires an explicit PILOT_MODE');
  {
    const prevEnv = config.nodeEnv; config.nodeEnv = 'production';
    const errFor = (v) => { if (v === undefined) delete process.env.PILOT_MODE; else process.env.PILOT_MODE = v; try { config.validateConfig(); return ''; } catch (e) { return e.message; } };
    check('[5] unset -> PILOT_MODE error', /PILOT_MODE/.test(errFor(undefined)));
    check('[5] "TRUE" -> PILOT_MODE error', /PILOT_MODE/.test(errFor('TRUE')));
    check('[5] "true" -> no PILOT_MODE error', !/PILOT_MODE/.test(errFor('true')));
    check('[5] "false" -> no PILOT_MODE error', !/PILOT_MODE/.test(errFor('false')));
    config.nodeEnv = prevEnv; delete process.env.PILOT_MODE;
  }

  console.log('\n[6] static');
  {
    const src = fs.readFileSync(h.path.join(h.ROOT, 'src/server.js'), 'utf8');
    const loop = src.indexOf('for (const prefix of versionPrefixes) {');
    const iGate = src.indexOf("mountPilotGates(app, prefix)", loop);
    const iFirst = src.indexOf('app.use(`${prefix}/', loop);
    check('[6] server.js mounts the pilot gates before the first router in the prefix loop', loop > 0 && iGate > loop && iGate < iFirst, { loop, iGate, iFirst });
    check('[6] SACCOS mount still behind SACCOS_ENABLED', /if \(process\.env\.SACCOS_ENABLED === 'true'\) \{\s*app\.use\(`\$\{prefix\}\/saccos`/.test(src));
  }

  await h.finish('R36 (4) pilot boundary');
})().catch(h.fatal);
