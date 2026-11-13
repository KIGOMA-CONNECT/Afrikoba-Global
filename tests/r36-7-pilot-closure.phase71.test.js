#!/usr/bin/env node
'use strict';
/* R36 closure — server-side proof for the excluded services, workers, executors, environment and the
 * corrected Phase68 contract.
 *  [1] pilot ALLOW-LIST: every service mounted in src/server.js (parsed from the source, plus the root-mounted
 *      projectRoutes paths and an unknown future segment) answers 403 PILOT_SERVICE_EXCLUDED (or the more
 *      specific PILOT_FEATURE_DISABLED) on /api/v1 and /api under PILOT_MODE=true unless it is in
 *      PILOT_ALLOWED_SERVICES; allowed services pass; outside the pilot (NODE_ENV=test) the A services pass; tier B is decided by serviceCatalog (r36-9).
 *  [2] background jobs: node-cron and every job function stubbed; with PILOT_MODE=true only the five
 *      allowed housekeeping/reconciliation jobs and (R36B) the ROSCA payout execute; outside the pilot all 15 execute; unclassified job
 *      names throw; server.js event schedulers are pilot-guarded.
 *  [3] four-eyes / approval-flow executors: excluded executors throw 403 in pilot mode without running;
 *      allowed ones run; both registries wrap at registration.
 *  [4] admin cross-border transfer (/admin/countries/transfer -> countryService.executeTransfer) refused in
 *      pilot with no DB change.
 *  [5] environment: devOtp in /auth/send-otp and stack traces in error JSON only for NODE_ENV exactly
 *      'development' or 'test'; unset, 'staging', 'pilot', 'production' -> neither. 5xx messages generic.
 *  [6] assertPilotEnvironment: PILOT_MODE=true refuses to start unless NODE_ENV=production.
 *  [7] Phase68 intent (corrected contract): the social fund request rejects every non-number, including
 *      partial-parse inputs ("5000abc", "50 00", "5e3", "0x1388", " 5000", "5000 ", ""), with no DB change; the
 *      function uses strictAmount and contains no parseFloat/Number() of the raw input.
 */
const h = require('./r36-harness');
const fs = require('fs');
const { check, call, attempt, user, group, snap, diffSnap } = h;
const pilot = require(h.path.join(h.ROOT, 'src/config/pilot'));

(async () => {
  console.log('\n[1] pilot allow-list over every mounted service');
  {
    const src = fs.readFileSync(h.path.join(h.ROOT, 'src/server.js'), 'utf8');
    const segs = [...new Set([...src.matchAll(/app\.use\(`\$\{prefix\}\/([a-z0-9-]+)/g)].map((m) => m[1]))];
    check('[1] parsed the mounted services (>= 50)', segs.length >= 50, segs.length);
    const app = h.express();
    for (const prefix of ['/api/v1', '/api']) pilot.mountPilotGates(app, prefix);
    app.use((req, res) => res.status(299).json({ reached: true }));
    await h.listen(app);
    const targets = [...segs.map((s) => `/${s}/x`), '/projects', '/investors', '/r36-future-service/x'];
    process.env.PILOT_MODE = 'true';
    const excludedSeen = [];
    for (const prefix of ['/api/v1', '/api']) {
      for (const t of targets) {
        const seg = t.split('/')[1];
        const r = await call('GET', `${prefix}${t}`, null);
        if (pilot.PILOT_ALLOWED_SERVICES.includes(seg)) {
          check(`[1] PILOT ${prefix}${t} allowed -> passes`, r.status === 299, r);
        } else {
          const ok = r.status === 403 && r.body && ['PILOT_SERVICE_EXCLUDED', 'PILOT_FEATURE_DISABLED'].includes(r.body.code) && !r.body.reached;
          if (prefix === '/api/v1') excludedSeen.push(seg);
          check(`[1] PILOT ${prefix}${t} excluded -> 403 ${r.body && r.body.code}`, ok, r);
        }
      }
    }
    // R36B Step 2 (owner): rosca, events and governance are opened for the pilot (asserted in r36-9 [B]).
    for (const must of ['circles', 'business', 'credit', 'savings', 'vaults', 'family', 'marketplace', 'disputes', 'ussd', 'network', 'currency', 'referrals', 'projects', 'advanced', 'ai', 'marketing', 'social', 'r36-future-service']) {
      check(`[1] ${must} is excluded in pilot`, excludedSeen.includes(must));
    }
    const post = await call('POST', '/api/v1/circles/groups', null, {}); // R36B: was /rosca (now opened)
    check('[1] POST to an excluded service also refused (method-independent)', post.status === 403 && post.body.code === 'PILOT_SERVICE_EXCLUDED', post);
    delete process.env.PILOT_MODE;
    for (const t of targets) {
      const r = await call('GET', `/api/v1${t}`, null);
      check(`[1] not pilot: /api/v1${t} passes the gate`, r.status === 299, r);
    }
  }

  console.log('\n[2] background jobs');
  {
    const scheduled = [];
    const cronPath = require.resolve(h.path.join(h.ROOT, 'node_modules/node-cron'));
    require.cache[cronPath] = { id: cronPath, filename: cronPath, loaded: true, exports: { schedule: (spec, fn) => { scheduled.push(fn); return { stop() {} }; } } };
    const called = new Set();
    const stub = (rel, names) => {
      const p = require.resolve(h.path.join(h.ROOT, rel));
      const real = require(p);
      const ex = { ...real };
      for (const n of names) ex[n] = async () => { called.add(n); return { processed: 0, executed: 0, expired: 0, sampled: 0, delivered: 0, skipped: 0 }; };
      require.cache[p].exports = ex;
    };
    stub('src/services/roscaService', ['disburseDuePayouts']);
    stub('src/jobs/reconciliationCron', ['reconcilePendingDeposits']);
    stub('src/services/splitPaymentService', ['runDueSplitPayments']);
    stub('src/services/networkService', ['processDueScheduledPayments']);
    stub('src/services/yieldService', ['processYieldPayouts']);
    stub('src/services/dbMaintenanceService', ['runMaintenance']);
    stub('src/jobs/balanceReconciliation', ['runBalanceReconciliation']);
    stub('src/services/financialAutopilotService', ['runAutopilotPayouts']);
    stub('src/services/sellerVerificationService', ['recomputeAll']);
    stub('src/services/p2pMarketplaceService', ['runAutoInvestCycle']);
    stub('src/services/outboxService', ['dispatchOutbox']);
    stub('src/services/partitionService', ['ensureAll']);
    stub('src/services/saccosStandingOrderService', ['runDueStandingOrders']);
    stub('src/services/currencyService', ['snapshotRateHistory']);
    stub('src/services/projectService', ['expireUnfundedProjects']);
    delete require.cache[require.resolve(h.path.join(h.ROOT, 'src/jobs/runAll'))];
    require(h.path.join(h.ROOT, 'src/jobs/runAll')).startAllJobs();
    check('[2] 15 jobs scheduled', scheduled.length === 15, scheduled.length);
    process.env.PILOT_MODE = 'true';
    for (const fn of scheduled) await fn();
    // R36B Step 2 (owner): ROSCA is opened for the pilot, so its payout job runs too.
    const ALLOWED = ['reconcilePendingDeposits', 'runMaintenance', 'runBalanceReconciliation', 'dispatchOutbox', 'ensureAll', 'disburseDuePayouts'];
    check('[2] PILOT: exactly the 6 allowed jobs executed (5 housekeeping + ROSCA payout)', [...called].sort().join() === [...ALLOWED].sort().join(), [...called]);
    check('[2] PILOT: split, yield, autopilot, auto-invest, SACCOS standing orders, project expiry, scheduled payments did NOT run',
      ['runDueSplitPayments', 'processYieldPayouts', 'runAutopilotPayouts', 'runAutoInvestCycle', 'runDueStandingOrders', 'expireUnfundedProjects', 'processDueScheduledPayments'].every((n) => !called.has(n)));
    called.clear(); delete process.env.PILOT_MODE;
    for (const fn of scheduled) await fn();
    check('[2] not pilot: all 15 jobs executed (control)', called.size === 15, [...called]);
    check('[2] unclassified job name throws', !(await attempt(() => pilot.pilotJobAllowed('NEW_JOB'))).ok);
    const ssrc = fs.readFileSync(h.path.join(h.ROOT, 'src/server.js'), 'utf8');
    check('[2] server.js event reminders/series are pilot-guarded', ssrc.includes("pilotJob('EVENT_REMINDERS'") && ssrc.includes("pilotJob('EVENT_SERIES'"));
    check('[2] runAll: every cron.schedule is wrapped by pilotJob', (() => { const r = fs.readFileSync(h.path.join(h.ROOT, 'src/jobs/runAll.js'), 'utf8'); return (r.match(/cron\.schedule\(/g) || []).length === (r.match(/cron\.schedule\('[^']*', pilotJob\('/g) || []).length; })());
  }

  console.log('\n[3] executors');
  {
    let ran = 0;
    const exec = (code) => pilot.guardExecutor(code, async () => { ran++; return 'ran'; });
    process.env.PILOT_MODE = 'true';
    for (const code of ['CREDIT_LOAN_DISBURSE', 'BUSINESS_LOAN_DISBURSE', 'CARD_ADMIN_SETTLE', 'CARD_ADMIN_REFUND', 'LENDING_CIRCLE_DISBURSE', 'KILIMO_AGRI_LOAN_DISBURSE', 'AGENT_SETTLEMENT', 'ADMIN_LARGE_REFUND']) { // R36B: EVENT_WITHDRAWAL now allowed (events opened)
      ran = 0; const r = await attempt(() => exec(code)());
      check(`[3] PILOT executor ${code} -> 403, not executed`, !r.ok && r.status === 403 && r.code === 'PILOT_FEATURE_DISABLED' && ran === 0, r);
    }
    for (const code of pilot.PILOT_ALLOWED_EXECUTORS) { ran = 0; const r = await attempt(() => exec(code)()); check(`[3] PILOT executor ${code} allowed`, r.ok && ran === 1, r); }
    delete process.env.PILOT_MODE;
    ran = 0; check('[3] not pilot: CREDIT_LOAN_DISBURSE runs (control)', (await attempt(() => exec('CREDIT_LOAN_DISBURSE')())).ok && ran === 1);
    for (const f of ['src/services/fourEyesService.js', 'src/services/governanceService.js']) {
      check(`[3] ${f} wraps every executor at registration`, /executors\[action(Code|Type)\] = require\('\.\.\/config\/pilot'\)\.guardExecutor\(/.test(fs.readFileSync(h.path.join(h.ROOT, f), 'utf8')));
    }
  }

  console.log('\n[4] admin cross-border transfer refused in pilot');
  {
    const countryService = require(h.path.join(h.ROOT, 'src/services/countryService'));
    const u = await user('xborder', 100000);
    process.env.PILOT_MODE = 'true';
    const before = await snap();
    const r = await attempt(() => countryService.executeTransfer(u.id, 'KE', 5000, { name: 'x', phone: '254700000000' }));
    check('[4] executeTransfer -> 403 PILOT_FEATURE_DISABLED, no DB change', !r.ok && r.status === 403 && r.code === 'PILOT_FEATURE_DISABLED' && diffSnap(before, await snap()).length === 0, r);
    check('[4] route gate on /admin/countries/transfer', pilot.ROUTE_GATES.some(([m, p, f]) => m === 'post' && p === '/admin/countries/transfer' && f === 'remittance'));
    delete process.env.PILOT_MODE;
  }

  console.log('\n[5] environment: devOtp and stack traces are explicit dev/test only');
  {
    const app = h.express();
    app.use(h.express.json());
    app.use((req, res, next) => { res.t = (k) => k; next(); });
    app.use('/api/auth', require(h.path.join(h.ROOT, 'src/routes/authRoutes')));
    app.get('/boom500', (req, res, next) => next(new Error('secret internal detail r36')));
    app.get('/boom400', (req, res, next) => next(Object.assign(new Error('bad input'), { statusCode: 400, code: 'R36_BAD' })));
    app.use(require(h.path.join(h.ROOT, 'src/middleware/securityHardening')).secureErrorHandler);
    await h.listen(app);
    const prev = process.env.NODE_ENV;
    let n = 0;
    for (const env of ['test', 'development', undefined, 'staging', 'pilot', 'production']) {
      if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env;
      const dev = env === 'test' || env === 'development';
      const otp = await call('POST', '/api/auth/send-otp', null, { phoneNumber: `07150000${String(++n).padStart(2, '0')}` });
      const e5 = await call('GET', '/boom500', null);
      const e4 = await call('GET', '/boom400', null);
      check(`[5] NODE_ENV=${env}: devOtp ${dev ? 'present' : 'absent'}`, otp.status === 200 && (dev ? /^\d{4,8}$/.test(String(otp.body.devOtp)) : !('devOtp' in otp.body)), otp);
      check(`[5] NODE_ENV=${env}: stack ${dev ? 'present' : 'absent'} on 500 and 400`, dev ? (!!e5.body.stack && !!e4.body.stack) : (!('stack' in e5.body) && !('stack' in e4.body)), { e5: Object.keys(e5.body), e4: Object.keys(e4.body) });
      if (!dev) check(`[5] NODE_ENV=${env}: 500 message generic (internal detail not echoed)`, !JSON.stringify(e5.body).includes('secret internal detail'), e5.body);
    }
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  }

  console.log('\n[6] pilot process must be production-mode');
  {
    const prevN = process.env.NODE_ENV;
    const cases = [['true', 'test', false], ['true', undefined, false], ['true', 'staging', false], ['true', 'production', true], ['false', 'test', true], [undefined, undefined, true]];
    for (const [pm, ne, okExpected] of cases) {
      if (pm === undefined) delete process.env.PILOT_MODE; else process.env.PILOT_MODE = pm;
      if (ne === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ne;
      const r = await attempt(() => pilot.assertPilotEnvironment());
      check(`[6] PILOT_MODE=${pm} NODE_ENV=${ne} -> ${okExpected ? 'starts' : 'refused'}`, r.ok === okExpected, r);
    }
    delete process.env.PILOT_MODE; if (prevN === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevN;
    check('[6] server.js calls assertPilotEnvironment right after validateConfig', /config\.validateConfig\(\);\n\/\/[^\n]*\nrequire\('\.\/config\/pilot'\)\.assertPilotEnvironment\(\);/.test(fs.readFileSync(h.path.join(h.ROOT, 'src/server.js'), 'utf8')));
  }

  console.log('\n[7] Phase68 intent: social fund request rejects partial parses (corrected contract)');
  {
    const vicoba = require(h.path.join(h.ROOT, 'src/services/vicobaService'));
    const s = await group([['chair', 'MWENYEKITI'], ['member', 'MJUMBE']]);
    await h.pool.query(`INSERT INTO vicoba_social_fund (group_id, monthly_contribution, total_balance) VALUES ($1, 2000, 100000)`, [s.g]);
    for (const v of ['5000abc', '50 00', '5e3', '0x1388', ' 5000', '5000 ', '', '5000.00.1', '+5000', 'Infinity', '1e400']) {
      const before = await snap();
      const r = await attempt(() => vicoba.requestSocialFundDisbursement(s.g, s.member.id, { reasonType: 'MSIBA', reasonDetail: 'r36', requestedAmount: v }));
      check(`[7] requestedAmount ${JSON.stringify(v)} -> 400, no DB change`, !r.ok && r.status === 400 && diffSnap(before, await snap()).length === 0, r);
    }
    const ok = await attempt(() => vicoba.requestSocialFundDisbursement(s.g, s.member.id, { reasonType: 'MSIBA', reasonDetail: 'r36', requestedAmount: 5000 }));
    check('[7] requestedAmount 5000 (number) accepted (control)', ok.ok, ok);
    const src = fs.readFileSync(h.path.join(h.ROOT, 'src/services/vicobaService.js'), 'utf8');
    const start = src.indexOf('async function requestSocialFundDisbursement(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
    check('[7] static: uses strictAmount on requestedAmount', /strictAmount\(requestedAmount/.test(body));
    check('[7] static: no partial parse of the raw input (parseFloat / Number(requestedAmount / Number(amountText)', !/parseFloat\(|Number\(requestedAmount|Number\(amountText|Number\(rawAmount/.test(body));
  }

  await h.finish('R36 (7) pilot closure');
})().catch(h.fatal);
