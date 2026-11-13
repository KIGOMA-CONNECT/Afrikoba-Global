#!/usr/bin/env node
'use strict';
/* R36B Step 2 — service catalog, pilot opening, tier-B lock, four-eyes environment lock.
 *  [A] completeness: every router segment mounted in src/server.js, every scheduled job (runAll + server.js),
 *      every executor registered in src/, every PILOT_DISABLED feature is classified in the catalog;
 *      Market + Invest & Markets + P2P share ONE gate; every entry carries an attestation.
 *  [B] pilot HTTP (PILOT_MODE=true): ROSCA, events (incl. public), group governance and PIN reset pass;
 *      the rest of /advanced, AI (incl. governance AI minutes and /admin/ai), marketing, USSD, credit,
 *      field partners, autopilot, bills/airtime/insurance, fixed deposits, VICOBA dividends, business
 *      (POS and loans), social (cases and Market projects), Market admin, treasury and cards are refused
 *      403 on /api/v1 and /api, any method, before any handler.
 *  [C] production, not pilot: every tier-B route (incl. mixed-router routes) -> 403 TIER_B_DISABLED, while
 *      tier-A neighbours (POS, business accounts, social cases, wallet transfer, savings goals) pass;
 *      test/development: tier B passes (control). Activation: env without record refused at startup;
 *      record validation; pilot can never enable tier B.
 *  [D] jobs, [E] executors, [F] PILOT_DISABLED features follow the catalog (pilot and production).
 *  [G] four-eyes environment lock (DB): in the pilot the direct-route gate requires four-eyes even with
 *      the FOUR_EYES flag off and the policy disabled; the four-eyes routes work without the flag; a policy
 *      cannot be weakened (allow_self_approve / disable); self-approval is refused even when the stored
 *      policy allows it; a second admin approves (positive); four-eyes thresholds cannot be changed by a
 *      single admin. Every refusal leaves the business tables unchanged.
 *  [I] review fixes: absolute-form request target and "//" cannot skip the gate; unclassified paths fail
 *      closed outside test/development; stricter activation records; ADMIN threshold exemption removed in the
 *      pilot (wallet + events); event contributions TZS-only in the pilot; approver_roles locked in the pilot.
 *  [J] every ROUTE_RULE matches a real route in the router mounted for it (router.stack walk).
 *  [H] governance in the pilot: VICOBA member reaches group governance; non-member refused (F-R34-1);
 *      SACCOS-family governance refused (tier B) before any lookup.
 */
const h = require('./r36-harness');
const fs = require('fs');
const { check, call, attempt, user, group, q1, pool } = h;
const R = (rel) => h.path.join(h.ROOT, rel);
const catalog = require(R('src/config/serviceCatalog'));
const pilot = require(R('src/config/pilot'));

const ENV0 = { NODE_ENV: process.env.NODE_ENV };
function setEnv(o) { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
const PILOT = () => setEnv({ PILOT_MODE: 'true', NODE_ENV: 'production', AFRIKOBA_TIER_B_ENABLE: undefined });
const PROD = () => setEnv({ PILOT_MODE: 'false', NODE_ENV: 'production', AFRIKOBA_TIER_B_ENABLE: undefined });
const TEST = () => setEnv({ PILOT_MODE: undefined, NODE_ENV: ENV0.NODE_ENV || 'test', AFRIKOBA_TIER_B_ENABLE: undefined });

const EXTRA = ['four_eyes_policies', 'four_eyes_requests', 'four_eyes_approvals', 'config_settings', 'users', 'governance_meetings', 'vicoba_members'];
async function snap2() {
  const out = await h.snap();
  for (const t of EXTRA) {
    const r = await q1(`SELECT count(*)::int n, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) h FROM ${t} t`);
    out[`x_${t}`] = `${r.n}:${r.h}`;
  }
  return out;
}

(async () => {
  console.log('\n[A] catalog completeness');
  {
    const ssrc = fs.readFileSync(R('src/server.js'), 'utf8');
    const segs = [...new Set([...ssrc.matchAll(/app\.use\(`\$\{prefix\}\/([a-z0-9-]+)/g)].map((m) => m[1]))];
    const projectSegs = [...new Set([...fs.readFileSync(R('src/routes/projectRoutes.js'), 'utf8').matchAll(/router\.(?:get|post|put|patch|delete)\(\s*'\/([a-z0-9-]+)/g)].map((m) => m[1]))];
    check('[A] parsed server.js segments (>= 50)', segs.length >= 50, segs.length);
    check('[A] parsed projectRoutes root segments', projectSegs.includes('projects') && projectSegs.includes('investors'), projectSegs);
    const unclassified = [...segs, ...projectSegs].filter((s) => !catalog.SEGMENT_INDEX[s]);
    check('[A] every mounted segment classified', unclassified.length === 0, unclassified);
    const jobs = new Set();
    for (const f of ['src/jobs/runAll.js', 'src/server.js']) for (const m of fs.readFileSync(R(f), 'utf8').matchAll(/pilotJob\('([A-Z_]+)'/g)) jobs.add(m[1]);
    check('[A] parsed jobs (>= 17)', jobs.size >= 17, jobs.size);
    check('[A] every job classified', [...jobs].every((j) => catalog.JOB_INDEX[j]), [...jobs].filter((j) => !catalog.JOB_INDEX[j]));
    const execs = new Set();
    const walk = (d) => { for (const e of fs.readdirSync(R(d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) for (const m of fs.readFileSync(R(p), 'utf8').matchAll(/registerExecutor\('([A-Z_]+)'/g)) execs.add(m[1]); } };
    walk('src');
    check('[A] parsed executors (>= 14)', execs.size >= 14, [...execs]);
    check('[A] every executor classified', [...execs].every((c) => catalog.EXECUTOR_INDEX[c]), [...execs].filter((c) => !catalog.EXECUTOR_INDEX[c]));
    check('[A] every PILOT_DISABLED feature classified', Object.keys(pilot.PILOT_DISABLED).every((f) => catalog.FEATURE_INDEX[f]), Object.keys(pilot.PILOT_DISABLED).filter((f) => !catalog.FEATURE_INDEX[f]));
    const one = catalog.SERVICES.market_invest_p2p;
    check('[A] Market, Invest & Markets and P2P share ONE tier-B gate',
      one && one.tier === 'B' && ['projects', 'investors', 'marketplace', 'procurement', 'secondary', 'p2p'].every((s) => catalog.SEGMENT_INDEX[s] === 'market_invest_p2p')
      && ['AUTO_INVEST', 'YIELD_PAYOUTS', 'SPLIT_PAYMENTS', 'FUNDING_EXPIRY', 'SELLER_VERIFICATION'].every((j) => catalog.JOB_INDEX[j] === 'market_invest_p2p'));
    check('[A] every entry has a valid tier, module and attestation', Object.values(catalog.SERVICES).every((s) => catalog.TIERS.includes(s.tier) && s.module && s.attestation));
    for (const [k, t] of [['credit', 'B'], ['field_partners', 'B'], ['business_loans', 'B'], ['project_loans', 'B'], ['saccos', 'B'], ['remittance', 'B'], ['payments_real', 'B'], ['external_providers', 'B'], ['fixed_deposits', 'B'],
      ['rosca', 'A'], ['events', 'A'], ['governance', 'A'], ['pin_reset', 'A'], ['business', 'A'], ['cards', 'A'], ['family', 'A'], ['ai', 'A']]) {
      check(`[A] ${k} is tier ${t}`, catalog.SERVICES[k] && catalog.SERVICES[k].tier === t);
    }
    check('[A] committed activation record is empty (no tier-B service may run in production)', catalog.activations().length === 0, catalog.activations());
  }

  const app = h.express();
  for (const prefix of ['/api/v1', '/api']) pilot.mountPilotGates(app, prefix);
  app.use((req, res) => res.status(299).json({ reached: true }));
  await h.listen(app);
  const refused = (r, code) => r.status === 403 && r.body && !r.body.reached && (code ? r.body.code === code : /^(PILOT_SERVICE_EXCLUDED|PILOT_FEATURE_DISABLED|TIER_B_DISABLED)$/.test(r.body.code));

  const http = require('http');
  const rawSrv = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const rawCall = (method, target) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: rawSrv.address().port, method, path: target, headers: { 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    rq.on('error', reject); rq.end(method === 'GET' ? undefined : '{}');
  });

  console.log('\n[B] pilot HTTP');
  {
    PILOT();
    const OPEN = [['GET', '/rosca/pools'], ['POST', '/rosca/pools'], ['GET', '/rosca/pools/7/constitution'], ['GET', '/events'], ['POST', '/events/9/contributions'],
      ['GET', '/events/public/tok123'], ['POST', '/events/public/tok123/join'], ['POST', '/events/9/withdrawals'], ['GET', '/governance/meetings'], ['POST', '/governance/proposals/3/vote'],
      ['POST', '/governance/resolutions'], ['POST', '/advanced/pin-reset/request'], ['POST', '/advanced/pin-reset/verify'], ['POST', '/advanced/pin-reset/complete'],
      ['GET', '/admin/events/withdrawals'], ['GET', '/vicoba/groups'], ['POST', '/wallet/transfer'], ['GET', '/notifications'], ['GET', '/ROSCA/pools'], ['POST', '/Advanced/Pin-Reset/request']];
    const CLOSED = [['GET', '/advanced/credit-score'], ['POST', '/advanced/bill-splits'], ['POST', '/advanced/merchants/pay'], ['GET', '/advanced/pin-resetx'],
      ['POST', '/governance/meetings/4/ai-minutes'], ['GET', '/ai/insights'], ['POST', '/ai/risk/evaluate'], ['GET', '/admin/ai/forecasts'], ['POST', '/admin/ai/anomalies/detect'], ['POST', '/admin/ai/documents/parse'],
      ['GET', '/marketing/offers'], ['POST', '/ussd'], ['POST', '/credit/loans'], ['POST', '/credit/admin/loans/1/disburse'], ['GET', '/field-partners'], ['POST', '/field-partners/loans/1/disburse'],
      ['POST', '/passport/autopilot/plans'], ['GET', '/passport'], ['POST', '/eco/bills/pay'], ['POST', '/eco/airtime/purchase'], ['POST', '/eco/insurance/purchase'], ['POST', '/savings/deposits'],
      ['POST', '/vicoba/groups/1/profits/calculate'], ['POST', '/vicoba/profits/1/approve'], ['POST', '/vicoba/groups/1/bonus'],
      ['POST', '/business/accounts/1/pos/open'], ['POST', '/business/pos/1/close'], ['POST', '/business/accounts/1/loans'], ['POST', '/business/admin/loans/1/disburse'],
      ['GET', '/social/cases'], ['POST', '/social/projects/1/waterfall'], ['POST', '/social/projects/1/decompose'], ['GET', '/admin/projects/pending'], ['POST', '/admin/milestones/1/release'],
      ['POST', '/admin/projects/1/revenue'], ['POST', '/admin/treasury/proposals'], ['POST', '/admin/treasury/proposals/1/sign'], ['GET', '/cards'], ['POST', '/cards/admin/settle'],
      ['GET', '/family/family'], ['GET', '/eco/chat'], ['POST', '/p2p/projects/1/invest'], ['GET', '/projects/mine'], ['GET', '/marketplace/listings'], ['POST', '/secondary/listings/1/buy'],
      ['POST', '/admin/countries/transfer'], ['POST', '/admin/countries/quote'], ['POST', '/network/remittance/send'], ['POST', '/network/agents/cash-in'], ['POST', '/wallet/deposit/initiate'],
      ['POST', '/wallet/withdraw'], ['GET', '/currency/rates'], ['GET', '/disputes'], ['GET', '/r36b-future-service/x']];
    for (const prefix of ['/api/v1', '/api']) {
      for (const [m, p] of OPEN) { const r = await call(m, `${prefix}${p}`, null, {}); check(`[B] PILOT ${m} ${prefix}${p} passes`, r.status === 299, r); }
      for (const [m, p] of CLOSED) { const r = await call(m, `${prefix}${p}`, null, {}); check(`[B] PILOT ${m} ${prefix}${p} refused (${r.body && r.body.code})`, refused(r), r); }
    }
    for (const m of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH']) {
      const r = await call(m, '/api/v1/advanced/credit-score', null, {});
      check(`[B] PILOT ${m} /advanced/credit-score refused (method-independent)`, r.status === 403);
    }
    check('[B] PILOT_ALLOWED_SERVICES now includes rosca, events, governance (not advanced)', ['rosca', 'events', 'governance'].every((s) => pilot.PILOT_ALLOWED_SERVICES.includes(s)) && !pilot.PILOT_ALLOWED_SERVICES.includes('advanced'), pilot.PILOT_ALLOWED_SERVICES);
  }

  console.log('\n[C] production (not pilot): tier B locked');
  {
    PROD();
    const B = [['POST', '/p2p/projects/1/invest'], ['GET', '/projects/mine'], ['GET', '/investors/platform-summary'], ['GET', '/marketplace/listings'], ['POST', '/procurement/requests'],
      ['POST', '/secondary/listings/1/buy'], ['GET', '/saccos/groups'], ['POST', '/credit/loans'], ['POST', '/circles/campaigns/1/contribute'], ['POST', '/kilimo/x'], ['GET', '/field-partners'],
      ['POST', '/business/accounts/1/loans'], ['GET', '/business/loans'], ['GET', '/business/admin/loans'], ['POST', '/business/admin/loans/1/approve'], ['POST', '/business/admin/loans/1/disburse'],
      ['POST', '/business/loans/1/repay'], ['POST', '/social/projects/1/waterfall'], ['POST', '/social/projects/1/decompose'], ['GET', '/admin/projects/pending'], ['POST', '/admin/milestones/1/release'],
      ['POST', '/admin/projects/1/split'], ['POST', '/admin/ai/documents/parse'], ['POST', '/wallet/deposit/initiate'], ['POST', '/wallet/withdraw'], ['POST', '/payments/azampay-callback'],
      ['POST', '/network/remittance/send'], ['POST', '/admin/countries/transfer'], ['POST', '/admin/countries/quote'], ['POST', '/eco/bills/pay'], ['POST', '/eco/airtime/purchase'],
      ['POST', '/eco/insurance/purchase'], ['POST', '/savings/deposits'], ['POST', '/savings/deposits/1/withdraw'], ['POST', '/vicoba/groups/1/topup/cross-network'],
      ['POST', '/Business/Accounts/1/LOANS'], ['GET', '/P2P/projects']];
    const A = [['POST', '/business/accounts/1/pos/open'], ['POST', '/business/pos/1/close'], ['POST', '/business/accounts'], ['POST', '/business/accounts/1/invoices'], ['GET', '/social/cases'],
      ['POST', '/social/cases/1/contribute'], ['POST', '/wallet/transfer'], ['POST', '/savings/goals'], ['GET', '/eco/qr'], ['GET', '/rosca/pools'], ['GET', '/admin/projects-r36b'], ['GET', '/cards']];
    for (const prefix of ['/api/v1', '/api']) {
      for (const [m, p] of B) { const r = await call(m, `${prefix}${p}`, null, {}); check(`[C] PROD ${m} ${prefix}${p} -> 403 TIER_B_DISABLED`, refused(r, 'TIER_B_DISABLED'), r); }
      for (const [m, p] of A) { const r = await call(m, `${prefix}${p}`, null, {}); check(`[C] PROD ${m} ${prefix}${p} (tier A/PENDING) passes`, r.status === 299, r); }
    }
    for (const env of ['test', 'development']) {
      setEnv({ NODE_ENV: env });
      const r1 = await call('POST', '/api/v1/business/accounts/1/loans', null, {}); const r2 = await call('GET', '/api/v1/projects/mine', null, {});
      check(`[C] NODE_ENV=${env}: tier B passes (built code stays testable)`, r1.status === 299 && r2.status === 299, [r1, r2]);
    }
    for (const env of ['staging', undefined]) {
      setEnv({ NODE_ENV: env });
      const r = await call('GET', '/api/v1/projects/mine', null, {});
      check(`[C] NODE_ENV=${env}: tier B refused`, refused(r, 'TIER_B_DISABLED'), r);
    }
    // Activation
    PROD();
    setEnv({ AFRIKOBA_TIER_B_ENABLE: 'market_invest_p2p' });
    check('[C] PROD + env names tier B without record: startup refused', !(await attempt(() => catalog.assertCatalogEnvironment())).ok);
    check('[C] PROD + env names tier B without record: service still off', catalog.isServiceEnabled('market_invest_p2p') === false);
    const r0 = await call('GET', '/api/v1/projects/mine', null, {});
    check('[C] PROD + env only: route still 403', refused(r0, 'TIER_B_DISABLED'), r0);
    setEnv({ AFRIKOBA_TIER_B_ENABLE: 'rosca' });
    check('[C] env naming a non-tier-B service: startup refused', !(await attempt(() => catalog.assertCatalogEnvironment())).ok);
    setEnv({ AFRIKOBA_TIER_B_ENABLE: undefined });
    check('[C] PROD without env: startup accepted', (await attempt(() => catalog.assertCatalogEnvironment())).ok);
    PILOT(); setEnv({ AFRIKOBA_TIER_B_ENABLE: 'saccos' });
    check('[C] PILOT + env naming tier B: startup refused', !(await attempt(() => catalog.assertCatalogEnvironment())).ok);
    const sha = 'a'.repeat(64);
    const good = { service: 'market_invest_p2p', approved_by: 'OWNER', approval_ref: 'OWNER-2027-01', legal_ref: sha, accounting_ref: 'b'.repeat(64), approved_at: '2027-01-01', envs: ['production'] };
    const E = (o) => catalog.catalogEnvironmentErrors({ pilot: false, env: 'production', enable: 'market_invest_p2p', records: [good], ...o });
    check('[C] startup: production + env + valid record -> accepted', E({}).length === 0, E({}));
    check('[C] startup: PILOT + env + valid record -> still refused (pilot never runs tier B)', E({ pilot: true }).length > 0);
    check('[C] startup: production + env without record -> refused', E({ records: [] }).length > 0);
    check('[C] startup: test env + env naming tier B without record -> accepted (tier B already on in test)', E({ env: 'test', records: [] }).length === 0);
    for (const env of ['staging', undefined, '']) check(`[C] startup: NODE_ENV=${JSON.stringify(env)} + AFRIKOBA_TIER_B_ENABLE -> refused (review #8)`, E({ env, records: [good] }).length > 0, E({ env, records: [good] }));
    const D = (o) => catalog.tierBDecision('market_invest_p2p', { pilot: false, env: 'production', enable: 'market_invest_p2p', records: [], ...o });
    check('[C] decision: env + valid record -> on', D({ records: [good] }) === true);
    check('[C] decision: valid record with ISO datetime -> on', D({ records: [{ ...good, approved_at: '2027-01-01T09:30:00Z' }] }) === true);
    check('[C] decision: record without env -> off', D({ enable: '', records: [good] }) === false);
    check('[C] decision: pilot -> off even with env + record', D({ pilot: true, records: [good] }) === false);
    for (const [why, bad] of [['approved_by not OWNER', { approved_by: 'ADMIN' }], ['legal_ref not sha256', { legal_ref: 'x' }], ['accounting_ref missing', { accounting_ref: undefined }],
      ['envs without production', { envs: ['staging'] }], ['other service', { service: 'saccos' }], ['no approval_ref', { approval_ref: '' }], ['bad date', { approved_at: 'soon' }],
      ['non-ISO date (Date.parse accepts it)', { approved_at: 'January 1, 2027' }], ['numeric date', { approved_at: '1' }], ['legal_ref == accounting_ref', { accounting_ref: sha }]]) {
      check(`[C] decision: record ${why} -> off`, D({ records: [{ ...good, ...bad }] }) === false);
    }
    check('[C] decision: tier-A key can never be "activated"', catalog.tierBDecision('rosca', { pilot: false, env: 'production', enable: 'rosca', records: [{ ...good, service: 'rosca' }] }) === false
      || catalog.SERVICES.rosca.tier !== 'B');
  }

  console.log('\n[D] jobs');
  {
    PILOT();
    for (const j of ['ROSCA_PAYOUT', 'EVENT_REMINDERS', 'EVENT_SERIES', 'OUTBOX_DISPATCH', 'BALANCE_RECONCILIATION']) check(`[D] PILOT job ${j} runs`, pilot.pilotJobAllowed(j) === true);
    for (const j of ['AUTOPILOT_SAVINGS', 'AUTO_INVEST', 'YIELD_PAYOUTS', 'SPLIT_PAYMENTS', 'FUNDING_EXPIRY', 'SELLER_VERIFICATION', 'SACCOS_STANDING_ORDERS', 'SCHEDULED_PAYMENTS', 'FX_HISTORY']) check(`[D] PILOT job ${j} skipped`, pilot.pilotJobAllowed(j) === false);
    PROD();
    for (const j of ['AUTO_INVEST', 'YIELD_PAYOUTS', 'SPLIT_PAYMENTS', 'FUNDING_EXPIRY', 'SELLER_VERIFICATION', 'SACCOS_STANDING_ORDERS']) check(`[D] PROD tier-B job ${j} skipped`, pilot.pilotJobAllowed(j) === false);
    for (const j of ['ROSCA_PAYOUT', 'AUTOPILOT_SAVINGS', 'SCHEDULED_PAYMENTS', 'OUTBOX_DISPATCH']) check(`[D] PROD job ${j} runs (A/PENDING/platform)`, pilot.pilotJobAllowed(j) === true);
    let ran = 0; const wrapped = pilot.pilotJob('AUTO_INVEST', async () => { ran++; });
    const out = await wrapped();
    check('[D] PROD wrapped tier-B job does not run its body', ran === 0 && out && out.skipped, out);
    TEST();
    check('[D] test env: tier-B job runs (control)', pilot.pilotJobAllowed('AUTO_INVEST') === true);
  }

  console.log('\n[E] executors');
  {
    let ran = 0; const exec = (code) => pilot.guardExecutor(code, async () => { ran++; return 'ran'; });
    PILOT();
    for (const code of ['EVENT_WITHDRAWAL', 'WALLET_TRANSFER', 'VICOBA_LOAN_DISBURSE', 'ADMIN_PROMOTE_ROLE']) { ran = 0; const r = await attempt(() => exec(code)()); check(`[E] PILOT ${code} runs`, r.ok && ran === 1, r); }
    for (const code of ['CARD_ADMIN_SETTLE', 'CARD_ADMIN_REFUND', 'CREDIT_LOAN_DISBURSE', 'BUSINESS_LOAN_DISBURSE', 'LENDING_CIRCLE_DISBURSE', 'KILIMO_AGRI_LOAN_DISBURSE', 'AGENT_SETTLEMENT', 'ADMIN_LARGE_REFUND', 'R36B_UNKNOWN']) {
      ran = 0; const r = await attempt(() => exec(code)()); check(`[E] PILOT ${code} refused, not run`, !r.ok && r.status === 403 && ran === 0, r);
    }
    PROD();
    for (const code of ['CREDIT_LOAN_DISBURSE', 'BUSINESS_LOAN_DISBURSE', 'LENDING_CIRCLE_DISBURSE', 'KILIMO_AGRI_LOAN_DISBURSE']) {
      ran = 0; const r = await attempt(() => exec(code)()); check(`[E] PROD tier-B ${code} refused 403 TIER_B_DISABLED`, !r.ok && r.status === 403 && r.code === 'TIER_B_DISABLED' && ran === 0, r);
    }
    for (const code of ['CARD_ADMIN_SETTLE', 'EVENT_WITHDRAWAL', 'AGENT_SETTLEMENT']) { ran = 0; const r = await attempt(() => exec(code)()); check(`[E] PROD ${code} runs`, r.ok && ran === 1, r); }
    TEST();
    ran = 0; check('[E] test env: CREDIT_LOAN_DISBURSE runs (control)', (await attempt(() => exec('CREDIT_LOAN_DISBURSE')())).ok && ran === 1);
    ran = 0; check('[E] test env: unclassified test executor runs (control)', (await attempt(() => exec('R36B_UNKNOWN')())).ok && ran === 1);
  }

  console.log('\n[F] PILOT_DISABLED features');
  {
    PROD();
    for (const f of ['p2p', 'saccos', 'remittance', 'externalPayments']) check(`[F] PROD tier-B feature ${f} disabled`, pilot.isFeatureEnabled(f) === false);
    for (const f of ['cards', 'recurringPayments', 'annualDividends']) check(`[F] PROD non-B feature ${f} unchanged (enabled)`, pilot.isFeatureEnabled(f) === true);
    check('[F] PROD addBonus still OFF by default (G-0a)', pilot.isFeatureEnabled('vicobaAddBonus') === false);
    PILOT();
    check('[F] PILOT every PILOT_DISABLED feature off', Object.keys(pilot.PILOT_DISABLED).every((f) => pilot.isFeatureEnabled(f) === false));
    TEST();
    for (const f of ['p2p', 'saccos', 'remittance', 'externalPayments']) check(`[F] test env feature ${f} enabled (control)`, pilot.isFeatureEnabled(f) === true);
    setEnv({ VICOBA_ADD_BONUS_ENABLED: 'true' }); check('[F] test env addBonus only with its own flag', pilot.isFeatureEnabled('vicobaAddBonus') === true); setEnv({ VICOBA_ADD_BONUS_ENABLED: undefined });
  }

  console.log('\n[G] four-eyes environment lock');
  {
    TEST();
    const fe = require(R('src/services/fourEyesService'));
    const { isFourEyesRequired, fourEyesGate } = require(R('src/middleware/fourEyesGate'));
    const mkAdmin = async (label) => { const u = await user(label, 0); await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [u.id]); const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]); return { id: r.id, token: require(R('src/middleware/auth')).signToken(r), role: 'ADMIN' }; };
    const a1 = await mkAdmin('fe-a1'); const a2 = await mkAdmin('fe-a2'); const target = await user('fe-target', 0);
    await pool.query(`INSERT INTO feature_flags (flag_key, label, enabled) VALUES ('FOUR_EYES','four eyes',FALSE) ON CONFLICT (flag_key) DO UPDATE SET enabled=FALSE`);
    for (const code of ['CARD_ADMIN_SETTLE', 'ADMIN_PROMOTE_ROLE']) {
      await pool.query(`INSERT INTO four_eyes_policies (action_code, description, required_approvers, approver_roles, enabled, allow_self_approve) VALUES ($1,'r36b',1,ARRAY['ADMIN'],TRUE,FALSE)
        ON CONFLICT (action_code) DO UPDATE SET enabled=TRUE, allow_self_approve=FALSE, required_approvers=1, approver_roles=ARRAY['ADMIN']`, [code]);
    }
    await pool.query("UPDATE four_eyes_policies SET enabled=FALSE WHERE action_code='CARD_ADMIN_SETTLE'");
    check('[G] test env, flag off: direct route not four-eyes (control, existing behaviour)', (await isFourEyesRequired('CARD_ADMIN_SETTLE', a1)) === false);
    PILOT();
    check('[G] PILOT, flag off + policy disabled: direct route REQUIRES four-eyes', (await isFourEyesRequired('CARD_ADMIN_SETTLE', a1)) === true);
    const gapp = h.express(); gapp.use(h.express.json());
    gapp.post('/api/v1/cards/admin/settle', (req, res, next) => { req.user = { id: a1.id, role: 'ADMIN' }; next(); }, fourEyesGate('CARD_ADMIN_SETTLE', (req) => ({ authReference: 'r36b' })), (req, res) => res.status(299).json({ reached: true }));
    // four-eyes routes without the FOUR_EYES flag
    gapp.use('/api/v1/admin/four-eyes', require(R('src/routes/fourEyesRoutes')));
    // eslint-disable-next-line no-unused-vars
    gapp.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, code: err.code, message: err.message }));
    await h.listen(gapp);
    const g1 = await call('POST', '/api/v1/cards/admin/settle', null, {});
    check('[G] PILOT direct card settle -> 403 FOUR_EYES_REQUIRED, handler not reached', g1.status === 403 && g1.body.code === 'FOUR_EYES_REQUIRED' && !g1.body.reached, g1);
    const list = await call('GET', '/api/v1/admin/four-eyes/policies', a1);
    check('[G] PILOT four-eyes routes usable with FOUR_EYES flag off', list.status === 200, list);
    await pool.query("UPDATE four_eyes_policies SET enabled=TRUE WHERE action_code='CARD_ADMIN_SETTLE'");
    await pool.query("UPDATE four_eyes_policies SET required_approvers=2 WHERE action_code='ADMIN_PROMOTE_ROLE'");
    const s1b = await snap2();
    for (const [why, body] of [['allow_self_approve=true', { allowSelfApprove: true }], ['enabled=false', { enabled: false }], ['required_approvers 2 -> 1', { requiredApprovers: 1 }]]) {
      const r = await call('PUT', '/api/v1/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', a1, body);
      check(`[G] PILOT policy weakening (${why}) -> 403 FOUR_EYES_LOCKED`, r.status === 403 && r.body.code === 'FOUR_EYES_LOCKED', r);
    }
    check('[G] PILOT refused policy changes: no DB change', h.diffSnap(s1b, await snap2()).length === 0, h.diffSnap(s1b, await snap2()));
    const snake = await call('PUT', '/api/v1/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', a1, { allow_self_approve: true });
    check('[G] PILOT snake-case allow_self_approve cannot weaken the policy', (await q1("SELECT allow_self_approve FROM four_eyes_policies WHERE action_code='ADMIN_PROMOTE_ROLE'")).allow_self_approve === false, snake);
    const okp = await call('PUT', '/api/v1/admin/four-eyes/policies/ADMIN_PROMOTE_ROLE', a1, { description: 'r36b strengthened', requiredApprovers: 2 });
    check('[G] PILOT non-weakening policy change still allowed', okp.status === 200, okp);
    // stored policy already allows self-approval (pre-existing row): the lock still refuses it
    await pool.query("UPDATE four_eyes_policies SET allow_self_approve=TRUE, required_approvers=1 WHERE action_code='ADMIN_PROMOTE_ROLE'");
    const reqr = await call('POST', '/api/v1/admin/four-eyes/requests', a1, { action_code: 'ADMIN_PROMOTE_ROLE', payload: { userId: target.id, role: 'SUPPORT' } });
    check('[G] PILOT request created', reqr.status === 201, reqr);
    const rid = reqr.body && reqr.body.request && reqr.body.request.id;
    const s2 = await snap2();
    const self = await call('POST', `/api/v1/admin/four-eyes/requests/${rid}/approve`, a1, {});
    check('[G] PILOT self-approval refused even though stored policy allows it', self.status === 403, self);
    check('[G] PILOT self-approval: no approval row, request PENDING, target role unchanged',
      h.diffSnap(s2, await snap2()).length === 0 && ((await q1('SELECT status FROM four_eyes_requests WHERE id=$1', [rid || 0])) || {}).status === 'PENDING' && (await q1('SELECT role FROM users WHERE id=$1', [target.id])).role !== 'SUPPORT');
    const other = await call('POST', `/api/v1/admin/four-eyes/requests/${rid}/approve`, a2, {});
    check('[G] PILOT second admin approves -> executed (positive)', other.status === 200 && (await q1('SELECT role FROM users WHERE id=$1', [target.id])).role === 'SUPPORT', other);
    // thresholds
    const aapp = h.express(); aapp.use(h.express.json()); aapp.use('/api/v1/admin', require(R('src/routes/adminRoutes')));
    // eslint-disable-next-line no-unused-vars
    aapp.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, code: err.code, message: err.message }));
    await h.listen(aapp);
    const s3 = await snap2();
    for (const key of ['HIGH_VALUE_TRANSFER_THRESHOLD', 'EVENT_WITHDRAWAL_THRESHOLD']) {
      const r = await call('PUT', `/api/v1/admin/config/${key}`, a1, { value: '999999999999' });
      check(`[G] PILOT single admin cannot change ${key} -> 403 PILOT_CONFIG_LOCKED`, r.status === 403 && r.body.code === 'PILOT_CONFIG_LOCKED', r);
    }
    check('[G] PILOT threshold refusals: no DB change', h.diffSnap(s3, await snap2()).length === 0);
    const other2 = await call('PUT', '/api/v1/admin/config/R36B_NOTE', a1, { value: 'x' });
    check('[G] PILOT non-threshold setting still allowed', other2.status === 200, other2);
    TEST();
    const t1 = await call('PUT', '/api/v1/admin/config/HIGH_VALUE_TRANSFER_THRESHOLD', a1, { value: '6000000' });
    check('[G] test env threshold change works (control)', t1.status === 200, t1);
    await pool.query("UPDATE four_eyes_policies SET allow_self_approve=TRUE WHERE action_code='ADMIN_PROMOTE_ROLE'");
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      check('[G] test env policy upsert with allow_self_approve not locked (control)', (await attempt(() => fe.upsertPolicy({ actionCode: 'ADMIN_PROMOTE_ROLE', allowSelfApprove: true, client: c }))).ok);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  }

  console.log('\n[I] review fixes');
  {
    PILOT();
    for (const host of ['http://evil.example', 'http://127.0.0.1', 'HTTP://x']) {
      for (const p of ['/api/v1/credit/loans', '/api/projects/mine', '/api/v1/advanced/credit-score', '/api/v1/vicoba/groups/1/bonus']) {
        const r = await rawCall('POST', `${host}${p}`);
        check(`[I] PILOT absolute-form target ${host}${p} refused`, refused(r), r);
      }
    }
    const okAbs = await rawCall('GET', 'http://evil.example/api/v1/rosca/pools');
    check('[I] PILOT absolute-form target to an open service still passes (control)', okAbs.status === 299, okAbs);
    for (const p of ['/api/v1//credit/loans', '/api//projects/mine', '/api/v1//', '/api/v1///advanced/credit-score']) {
      const r = await rawCall('POST', p);
      check(`[I] PILOT double slash ${p} refused (empty segment only for the bare prefix)`, refused(r), r);
    }
    for (const p of ['/api/v1', '/api/v1/', '/api']) { const r = await rawCall('GET', p); check(`[I] PILOT bare prefix ${p} passes (control)`, r.status === 299, r); }
    PROD();
    for (const target of ['http://evil.example/api/v1/projects/mine', 'http://evil.example/api/credit/loans', '/api/v1//projects/mine']) {
      const r = await rawCall('POST', target);
      check(`[I] PROD ${target} -> refused`, r.status === 403 && !r.body.reached, r);
    }
    for (const p of ['/api/v1/r36b-future-service/x', '/api/zzz']) {
      const r = await rawCall('GET', p);
      check(`[I] PROD unclassified ${p} -> 403 SERVICE_UNCLASSIFIED (fail closed)`, r.status === 403 && r.body.code === 'SERVICE_UNCLASSIFIED', r);
    }
    setEnv({ NODE_ENV: 'staging' });
    const st = await rawCall('GET', '/api/v1/r36b-future-service/x');
    check('[I] staging unclassified -> 403 SERVICE_UNCLASSIFIED', st.status === 403 && st.body.code === 'SERVICE_UNCLASSIFIED', st);
    TEST();
    const tu = await rawCall('GET', '/api/v1/r36b-future-service/x');
    check('[I] test env unclassified passes to the routers (control)', tu.status === 299, tu);
    check('[I] harness runs with NODE_ENV=test (review #3)', process.env.NODE_ENV === 'test');
    check('[I] pilot.pilotServiceGate removed (review #7)', pilot.pilotServiceGate === undefined);

    // ADMIN high-value exemption (review #2)
    const mkAdmin = async (label, bal) => { const u = await user(label, bal); await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [u.id]); const r = await q1('SELECT id, role, phone_number, auth_version FROM users WHERE id=$1', [u.id]); return { id: r.id, phone: r.phone_number, token: require(R('src/middleware/auth')).signToken(r) }; };
    const admin = await mkAdmin('hv-admin', 100000); const rcpt = await user('hv-rcpt', 0);
    const prevT = await q1("SELECT value FROM config_settings WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'");
    await pool.query("INSERT INTO config_settings (key, value) VALUES ('HIGH_VALUE_TRANSFER_THRESHOLD','1000') ON CONFLICT (key) DO UPDATE SET value='1000'");
    const wapp = h.buildApp(); await h.listen(wapp);
    PILOT();
    const wb0 = await q1('SELECT wallet_balance FROM users WHERE id=$1', [admin.id]);
    const tr = await call('POST', '/api/v1/wallet/transfer', admin, { toPhoneNumber: rcpt.phone, amount: 5000, note: 'r36b-hv' });
    check('[I] PILOT admin transfer above threshold -> PENDING_APPROVAL (no admin exemption)', tr.status === 200 && tr.body && tr.body.requiresApproval === true, tr);
    check('[I] PILOT admin transfer: wallet unchanged until approved', String((await q1('SELECT wallet_balance FROM users WHERE id=$1', [admin.id])).wallet_balance) === String(wb0.wallet_balance));
    TEST();
    const tr2 = await call('POST', '/api/v1/wallet/transfer', admin, { toPhoneNumber: rcpt.phone, amount: 5000, note: 'r36b-hv2' });
    check('[I] test env admin transfer keeps the existing exemption (control)', tr2.status === 200 && tr2.body && !tr2.body.requiresApproval, tr2);
    await pool.query("UPDATE config_settings SET value=$1 WHERE key='HIGH_VALUE_TRANSFER_THRESHOLD'", [prevT ? prevT.value : '5000000']);

    const eventService = require(R('src/services/eventService'));
    require(R('src/routes/eventRoutes'));
    const prevE = await q1("SELECT value FROM config_settings WHERE key='EVENT_WITHDRAWAL_THRESHOLD'");
    await pool.query("INSERT INTO config_settings (key, value) VALUES ('EVENT_WITHDRAWAL_THRESHOLD','1000') ON CONFLICT (key) DO UPDATE SET value='1000'");
    const evAdmin = await mkAdmin('ev-admin', 0);
    const ev = (await q1("INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R36B ev',$1,10000000,50000) RETURNING id", [evAdmin.id])).id;
    await pool.query("INSERT INTO event_members (event_id, user_id, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING", [ev, evAdmin.id]);
    PILOT();
    const ew = await attempt(() => eventService.requestEventWithdrawal(evAdmin.id, ev, { amount: 5000, mode: 'FUNDRAISING' }));
    const ewRow = await q1('SELECT requires_approval, status FROM event_withdrawals WHERE event_id=$1 ORDER BY id DESC LIMIT 1', [ev]);
    check('[I] PILOT admin event withdrawal above threshold -> requires four-eyes approval', ew.ok && ewRow && ewRow.requires_approval === true && ewRow.status === 'PENDING', { ew, ewRow });
    TEST();
    const ev2 = (await q1("INSERT INTO social_events (name, owner_user_id, target_amount, collected_amount) VALUES ('R36B ev2',$1,10000000,50000) RETURNING id", [evAdmin.id])).id;
    await pool.query("INSERT INTO event_members (event_id, user_id, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING", [ev2, evAdmin.id]);
    const ew2 = await attempt(() => eventService.requestEventWithdrawal(evAdmin.id, ev2, { amount: 5000, mode: 'FUNDRAISING' }));
    const ewRow2 = await q1('SELECT requires_approval FROM event_withdrawals WHERE event_id=$1 ORDER BY id DESC LIMIT 1', [ev2]);
    check('[I] test env admin event withdrawal keeps the existing exemption (control)', ew2.ok && ewRow2 && ewRow2.requires_approval !== true, { ew2, ewRow2 });
    await pool.query("UPDATE config_settings SET value=$1 WHERE key='EVENT_WITHDRAWAL_THRESHOLD'", [prevE ? prevE.value : '5000000']);

    // event contributions: TZS only in the pilot (review #5 / OD-F1)
    const payer = await user('ev-payer', 100000);
    await pool.query("INSERT INTO event_members (event_id, user_id, status) VALUES ($1,$2,'ACTIVE') ON CONFLICT DO NOTHING", [ev2, payer.id]);
    PILOT();
    const sF = await snap2();
    const usd = await attempt(() => eventService.contribute(payer.id, ev2, { amount: 10, currency: 'USD' }));
    check('[I] PILOT event contribution in USD -> 403 PILOT_SERVICE_EXCLUDED', !usd.ok && usd.status === 403 && usd.code === 'PILOT_SERVICE_EXCLUDED', usd);
    check('[I] PILOT USD refusal: no DB change', h.diffSnap(sF, await snap2()).length === 0, h.diffSnap(sF, await snap2()));
    const tzs = await attempt(() => eventService.contribute(payer.id, ev2, { amount: 100, currency: 'TZS' }));
    check('[I] PILOT event contribution in TZS still works (control)', tzs.ok, tzs);
    TEST();
    const usd2 = await attempt(() => eventService.contribute(payer.id, ev2, { amount: 10, currency: 'USD' }));
    check('[I] test env USD contribution not refused by the pilot rule (control)', usd2.ok || usd2.code !== 'PILOT_SERVICE_EXCLUDED', usd2);

    // approver_roles lock (review #9)
    const fe = require(R('src/services/fourEyesService'));
    await pool.query("UPDATE four_eyes_policies SET approver_roles=ARRAY['ADMIN'], allow_self_approve=FALSE, enabled=TRUE, required_approvers=1 WHERE action_code='ADMIN_PROMOTE_ROLE'");
    const upsert = async (o) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await attempt(() => fe.upsertPolicy({ actionCode: 'ADMIN_PROMOTE_ROLE', client: c, ...o })); await c.query('ROLLBACK'); return r; } finally { c.release(); } };
    PILOT();
    for (const roles of [['SUPPORT'], ['ADMIN', 'SUPPORT'], ['USER']]) {
      const r = await upsert({ approverRoles: roles });
      check(`[I] PILOT approver_roles -> ${roles} refused 403 FOUR_EYES_LOCKED`, !r.ok && r.status === 403 && r.code === 'FOUR_EYES_LOCKED', r);
    }
    check('[I] PILOT same approver_roles accepted (control)', (await upsert({ approverRoles: ['ADMIN'], description: 'same' })).ok);
    check('[I] PILOT omitted approver_roles accepted (control)', (await upsert({ description: 'none' })).ok);
    TEST();
    check('[I] test env approver_roles change not locked (control)', (await upsert({ approverRoles: ['ADMIN', 'SUPPORT'] })).ok);
    await h.listen(app);
  }

  console.log('\n[J] route rules match real routes (router.stack walk)');
  {
    const ssrc = fs.readFileSync(R('src/server.js'), 'utf8');
    const reqMap = {};
    for (const m of ssrc.matchAll(/const (\w+) = require\('\.\/routes\/(\w+)'\)/g)) reqMap[m[1]] = m[2];
    const mounts = [];
    for (const m of ssrc.matchAll(/app\.use\(`\$\{prefix\}(\/[a-z0-9/-]+)`,([^;]*?)(\w+)\);/g)) if (reqMap[m[3]]) mounts.push([m[1], m[3]]);
    check('[J] parsed router mounts (>= 50)', mounts.length >= 50, mounts.length);
    const concrete = (p) => p.replace(/:[A-Za-z]+/g, '1');
    function hasRoute(stack, p, method) {
      for (const layer of stack) {
        if (layer.route) {
          if (layer.match(p) && (layer.route.methods[method] || layer.route.methods._all)) return true;
        } else if (layer.handle && Array.isArray(layer.handle.stack) && layer.match(p)) {
          const rest = p.slice(layer.path.length) || '/';
          if (hasRoute(layer.handle.stack, rest.startsWith('/') ? rest : `/${rest}`, method)) return true;
        }
      }
      return false;
    }
    function hasUnder(stack, prefix) {
      for (const layer of stack) {
        if (layer.route && typeof layer.route.path === 'string' && (layer.route.path === prefix || layer.route.path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`))) return true;
        if (!layer.route && layer.handle && Array.isArray(layer.handle.stack)) {
          if (layer.match(prefix) || layer.match(`${prefix}/x`)) return true;
        }
      }
      return false;
    }
    for (const [method, rule, key] of catalog.ROUTE_RULES) {
      const cands = mounts.filter(([mp]) => rule.toLowerCase() === mp || rule.toLowerCase().startsWith(`${mp}/`));
      let found = false;
      for (const [mp, ident] of cands) {
        const router = require(R(`src/routes/${reqMap[ident]}`));
        const rest = rule.slice(mp.length) || '/';
        if (method === 'use' ? hasUnder(router.stack, rest) : hasRoute(router.stack, concrete(rest), method)) { found = true; break; }
      }
      check(`[J] ${method.toUpperCase()} ${rule} (${key}) matches a real route`, found, cands.map((c) => c[0]));
    }
  }

  console.log('\n[H] governance in the pilot');
  {
    const gapp = h.express(); gapp.use(h.express.json());
    for (const prefix of ['/api/v1']) { pilot.mountPilotGates(gapp, prefix); gapp.use(`${prefix}/governance`, require(R('src/routes/governanceRoutes'))); }
    // eslint-disable-next-line no-unused-vars
    gapp.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ success: false, code: err.code, message: err.message }));
    await h.listen(gapp);
    const s = await group([['chair', 'MWENYEKITI'], ['m1', 'MJUMBE']]);
    const outsider = await user('gov-outsider', 0);
    PILOT();
    const s0 = await snap2();
    const mem = await call('GET', `/api/v1/governance/meetings?group_type=VICOBA&group_id=${s.g}`, s.m1);
    check('[H] PILOT VICOBA member reaches group governance', mem.status === 200, mem);
    const out = await call('GET', `/api/v1/governance/meetings?group_type=VICOBA&group_id=${s.g}`, outsider);
    check('[H] PILOT non-member refused (F-R34-1)', out.status === 403 || out.status === 404, out);
    const sac = await call('GET', '/api/v1/governance/meetings?group_type=SACCOS&group_id=1', s.m1);
    check('[H] PILOT SACCOS-family governance refused (tier B)', sac.status === 403 && /PILOT_SERVICE_EXCLUDED|TIER_B_DISABLED/.test(sac.body && sac.body.code), sac);
    const ai = await call('POST', `/api/v1/governance/meetings/1/ai-minutes`, s.chair, { group_type: 'VICOBA', group_id: s.g, transcript: 'x' });
    check('[H] PILOT governance AI minutes refused (OD-AI1)', ai.status === 403 && ai.body.code === 'PILOT_SERVICE_EXCLUDED', ai);
    check('[H] PILOT governance refusals/reads: no DB change', h.diffSnap(s0, await snap2()).length === 0, h.diffSnap(s0, await snap2()));
    PROD();
    const sac2 = await call('GET', '/api/v1/governance/meetings?group_type=SACCO&group_id=1', s.m1);
    check('[H] PROD SACCOS-family governance refused 403 TIER_B_DISABLED', sac2.status === 403 && sac2.body.code === 'TIER_B_DISABLED', sac2);
    TEST();
    const sac3 = await call('GET', '/api/v1/governance/meetings?group_type=SACCOS&group_id=1', s.m1);
    check('[H] test env SACCOS governance reaches authorization (control)', !(sac3.body && /PILOT_|TIER_B/.test(sac3.body.code || '')), sac3);
  }
  TEST();
  rawSrv.close();
  await h.finish('R36B-9 service catalog');
})().catch(h.fatal);
