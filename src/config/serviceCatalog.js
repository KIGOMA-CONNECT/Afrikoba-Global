'use strict';
/**
 * R36B — SERVICE CATALOG: the one configuration that says, for every Afrikoba service, its tier and
 * whether it may run. Server configuration only (no DB, no migration, no UI). Owner decisions R36B C
 * (2026-11-13) and Step 2 approval.
 *
 * Tiers
 *   PLATFORM  identity, administration, operations. Always on.
 *   A         pilot services. In the pilot a tier-A service runs only when its `pilot` state is 'ON'
 *             (owner opened it). Outside the pilot tier A runs.
 *   B         built, OFF by default (Market + Invest & Markets + P2P behind ONE gate, credit, business and
 *             project loans, field partners, SACCOS, external remittance, real-money payments, external
 *             bill/airtime/insurance providers, interest-bearing fixed deposits).
 *               - pilot: never (no configuration can enable tier B in a pilot process);
 *               - NODE_ENV test/development: on (the built code stays testable);
 *               - production: only when BOTH (a) AFRIKOBA_TIER_B_ENABLE names the service AND (b) the
 *                 committed, owner-approved activation record src/config/tier-b-activations.json holds a
 *                 valid entry for it and for 'production'. Anything else -> off. A process whose
 *                 environment names a tier-B service without a valid record refuses to start
 *                 (assertCatalogEnvironment). Three-level activation (lawyer/manager/owner) is S11.
 *               - any other NODE_ENV (unset, staging...): off.
 *   PENDING   owner decision outstanding (OD-10 network, OD-11 treasury, OD-P1 personal finance, OD-F1
 *             currency, ...). Pilot: off. Outside the pilot: unchanged behaviour.
 *
 * Every mounted router segment, every scheduled job and every four-eyes / approval-flow executor
 * registered in src/ must be classified here (tests/r36-9 enforces completeness). Mixed routers are
 * classified per route (ROUTE_RULES): POS vs business loans in /business, Market inside /social and
 * /admin, PIN reset inside /advanced, AI minutes inside /governance.
 *
 * Attestation header: every entry records the owner decision it rests on; tier-B entries also say what
 * activation needs (legal and accounting letter references go in the activation record).
 */
const fs = require('fs');
const path = require('path');

const DEC = 'R36B-C 2026-11-13';
const S2 = 'R36B Step 2 approval 2026-11-13';

// pilot: 'ON' | 'OFF' (tier A only; PLATFORM is always on, B and PENDING are always off in the pilot)
const SERVICES = Object.freeze({
  platform: { tier: 'PLATFORM', module: 'Administration & Governance', attestation: DEC,
    segments: ['auth', 'totp', 'devices', 'countries', 'services', 'features', 'cache', 'ops', 'outbox', 'fraud-ops', 'admin'],
    jobs: ['RECON_PENDING_DEPOSITS', 'DB_MAINTENANCE', 'BALANCE_RECONCILIATION', 'OUTBOX_DISPATCH', 'PARTITIONS'],
    executors: ['ADMIN_PROMOTE_ROLE', 'ADMIN_DEMOTE_ROLE'] },
  public_registration: { tier: 'A', pilot: 'OFF', module: 'Administration (public self-registration)', attestation: 'R36 pilot: closed pilot, no public self-registration',
    routes: [['post', '/auth/register']], features: ['publicRegistration'] },
  pin_reset: { tier: 'A', pilot: 'ON', module: 'Administration & Governance', attestation: S2,
    prefixes: ['/advanced/pin-reset'] },
  governance: { tier: 'A', pilot: 'ON', module: 'Administration & Governance', attestation: `${S2} (group governance; SACCOS family -> saccos gate; K-1..K-6 assessed, not fixed)`,
    segments: ['governance'] },
  messages: { tier: 'A', pilot: 'ON', module: 'Messages & Notifications', attestation: DEC, segments: ['notifications'] },
  wallet: { tier: 'A', pilot: 'ON', module: 'Payments & Transfers (internal, test money)', attestation: DEC,
    segments: ['wallet'], executors: ['WALLET_TRANSFER'] },
  vicoba: { tier: 'A', pilot: 'ON', module: 'Community Finance', attestation: DEC,
    segments: ['vicoba'], executors: ['VICOBA_LOAN_DISBURSE', 'VICOBA_SOCIAL_FUND_DISBURSE'] },
  vicoba_bonus: { tier: 'A', pilot: 'OFF', module: 'Community Finance', attestation: `${DEC} G-0a: OFF by default, own env flag VICOBA_ADD_BONUS_ENABLED`,
    routes: [['post', '/vicoba/groups/:groupId/bonus']], features: ['vicobaAddBonus'] },
  vicoba_dividends: { tier: 'A', pilot: 'OFF', module: 'Community Finance', attestation: `${S2} OD-6`,
    routes: [['post', '/vicoba/groups/:groupId/profits/calculate'], ['post', '/vicoba/profits/:distributionId/approve']], features: ['annualDividends'] },
  rosca: { tier: 'A', pilot: 'ON', module: 'Community Finance (ROSCA, Upatu)', attestation: S2,
    segments: ['rosca'], jobs: ['ROSCA_PAYOUT'] },
  events: { tier: 'A', pilot: 'ON', module: 'Community Finance (event contributions, internal and public)', attestation: `${S2} OD-7`,
    segments: ['events'], prefixes: ['/admin/events'], jobs: ['EVENT_REMINDERS', 'EVENT_SERIES'], executors: ['EVENT_WITHDRAWAL'] },
  social_fund: { tier: 'A', pilot: 'OFF', module: 'Community Finance (social fund cases)', attestation: `${DEC}; not yet opened for the pilot`,
    segments: ['social'] },
  business: { tier: 'A', pilot: 'OFF', module: 'Business Finance (incl. POS)', attestation: `${S2} OD-8 accepted; not yet opened for the pilot`,
    segments: ['business', 'merchant', 'payroll'] },
  cards: { tier: 'A', pilot: 'OFF', module: 'Payments & Transfers (virtual cards)', attestation: `${DEC}; not yet opened for the pilot; four-eyes locked in pilot (OD-3)`,
    segments: ['cards'], executors: ['CARD_ADMIN_SETTLE', 'CARD_ADMIN_REFUND'], features: ['cards'] },
  family: { tier: 'A', pilot: 'OFF', module: 'Family Finance', attestation: `${DEC}; not yet opened for the pilot (currency sub-routes: OD-F1)`,
    segments: ['family'] },
  messages_chat: { tier: 'A', pilot: 'OFF', module: 'Messages & Notifications (chat)', attestation: `${DEC}; not yet opened for the pilot`,
    prefixes: ['/eco/chat'] },
  ai: { tier: 'A', pilot: 'OFF', module: 'AI Secretary & Financial Intelligence', attestation: `${S2} OD-AI1 (no user consent mechanism yet, K-14)`,
    segments: ['ai'], routes: [['post', '/governance/meetings/:id/ai-minutes']], prefixes: ['/admin/ai/forecasts', '/admin/ai/anomalies'] },
  marketing: { tier: 'A', pilot: 'OFF', module: 'Messages & Notifications (marketing)', attestation: `${S2} OD-M1`, segments: ['marketing'] },
  ussd: { tier: 'A', pilot: 'OFF', module: 'Channel (USSD)', attestation: `${S2} OD-12`, segments: ['ussd'] },
  autopilot: { tier: 'PENDING', module: 'Personal Finance (autopilot savings)', attestation: `${S2} K-15 off in pilot`,
    prefixes: ['/passport/autopilot'], jobs: ['AUTOPILOT_SAVINGS'] },
  advanced: { tier: 'PENDING', module: 'mixed (receipts, credit score, bill splits, support, KYC, merchants)', attestation: `${S2}: only PIN reset opened`,
    segments: ['advanced'] },
  personal_finance: { tier: 'PENDING', module: 'Personal Finance', attestation: `${S2} OD-P1 (internal parts undecided)`,
    segments: ['savings', 'budget', 'vaults', 'smart', 'banking', 'passport', 'eco', 'analytics', 'referrals', 'stats'] },
  currency: { tier: 'PENDING', module: 'Personal/Family Finance (foreign currency)', attestation: 'OD-F1', segments: ['currency'], jobs: ['FX_HISTORY'] },
  disputes: { tier: 'PENDING', module: 'Administration & Governance (disputes)', attestation: 'not yet decided', segments: ['disputes'] },
  developer: { tier: 'PENDING', module: 'Developer API / BAP / experiments', attestation: 'not yet decided', segments: ['developer', 'bap', 'experiments'] },
  network: { tier: 'PENDING', module: 'Payments & Transfers (agents, bulk, loyalty, webhooks)', attestation: 'OD-10 (description delivered, decision pending)',
    segments: ['network'], executors: ['AGENT_SETTLEMENT'] },
  recurring_payments: { tier: 'PENDING', module: 'Payments & Transfers (scheduled / recurring)', attestation: 'OD-10',
    segments: ['recurrence'], prefixes: ['/network/scheduled'], jobs: ['SCHEDULED_PAYMENTS'], features: ['recurringPayments'] },
  treasury: { tier: 'PENDING', module: 'Administration (treasury multi-sig)', attestation: 'OD-11 (description delivered, decision pending)',
    prefixes: ['/admin/treasury'] },
  admin_large_refund: { tier: 'PENDING', module: 'Administration (large refund)', attestation: 'not yet decided', executors: ['ADMIN_LARGE_REFUND'] },

  // ---- Tier B: built, OFF by default ----
  market_invest_p2p: { tier: 'B', module: 'Market + Invest & Markets + P2P Investment (ONE gate)', attestation: `${DEC}; activation: owner record + legal/accounting refs`,
    segments: ['projects', 'investors', 'marketplace', 'procurement', 'secondary', 'p2p'],
    prefixes: ['/social/projects', '/admin/projects', '/admin/milestones', '/admin/ai/documents'],
    jobs: ['SPLIT_PAYMENTS', 'FUNDING_EXPIRY', 'SELLER_VERIFICATION', 'YIELD_PAYOUTS', 'AUTO_INVEST'], features: ['p2p'] },
  credit: { tier: 'B', module: 'Loans & Credit (platform-funded micro-credit)', attestation: `${S2} OD-1 = B`,
    segments: ['credit'], executors: ['CREDIT_LOAN_DISBURSE'] },
  business_loans: { tier: 'B', module: 'Loans & Credit (business loans)', attestation: DEC,
    routes: [['post', '/business/accounts/:id/loans'], ['get', '/business/loans'], ['get', '/business/admin/loans'],
      ['post', '/business/admin/loans/:id/approve'], ['post', '/business/admin/loans/:id/disburse'], ['post', '/business/loans/:id/repay']],
    executors: ['BUSINESS_LOAN_DISBURSE'] },
  project_loans: { tier: 'B', module: 'Loans & Credit (project loans: lending circles, agri)', attestation: DEC,
    segments: ['circles', 'kilimo'], executors: ['LENDING_CIRCLE_DISBURSE', 'KILIMO_AGRI_LOAN_DISBURSE'] },
  field_partners: { tier: 'B', module: 'Loans & Credit (field partners)', attestation: `${S2} OD-9`, segments: ['field-partners'] },
  saccos: { tier: 'B', module: 'Community Finance (SACCOS)', attestation: DEC, segments: ['saccos'], jobs: ['SACCOS_STANDING_ORDERS'], features: ['saccos'] },
  remittance: { tier: 'B', module: 'Payments & Transfers (external remittance)', attestation: DEC,
    prefixes: ['/network/remittance'], routes: [['post', '/admin/countries/transfer'], ['post', '/admin/countries/quote']], features: ['remittance'] },
  payments_real: { tier: 'B', module: 'Payments & Transfers (real money: AzamPay HOLDING)', attestation: DEC,
    segments: ['payments'], routes: [['post', '/wallet/deposit/initiate'], ['post', '/wallet/withdraw'], ['post', '/vicoba/groups/:groupId/topup/cross-network']],
    features: ['externalPayments'] },
  external_providers: { tier: 'B', module: 'Personal Finance (external bills, airtime, insurance)', attestation: `${S2} OD-P1 (B part)`,
    prefixes: ['/eco/bills', '/eco/airtime', '/eco/insurance'] },
  fixed_deposits: { tier: 'B', module: 'Personal Finance (interest-bearing fixed deposits)', attestation: `${S2} OD-P1 (B part)`,
    prefixes: ['/savings/deposits'] },
});

const TIERS = ['PLATFORM', 'A', 'B', 'PENDING'];
const DEV_TEST_ENVS = ['test', 'development'];

// ---------- indexes (built once; duplicates are a configuration error) ----------
function buildIndex(field) {
  const idx = {};
  for (const [key, s] of Object.entries(SERVICES)) {
    for (const v of s[field] || []) {
      if (idx[v]) throw new Error(`serviceCatalog: ${field} "${v}" claimed by ${idx[v]} and ${key}`);
      idx[v] = key;
    }
  }
  return Object.freeze(idx);
}
const SEGMENT_INDEX = buildIndex('segments');
const JOB_INDEX = buildIndex('jobs');
const EXECUTOR_INDEX = buildIndex('executors');
const FEATURE_INDEX = buildIndex('features');

// Route-level rules for mixed routers: exact routes first, then prefixes (longest first).
const ROUTE_RULES = Object.freeze((() => {
  const exact = []; const prefixes = [];
  for (const [key, s] of Object.entries(SERVICES)) {
    for (const [m, p] of s.routes || []) exact.push([m, p, key]);
    for (const p of s.prefixes || []) prefixes.push(['use', p, key]);
  }
  prefixes.sort((a, b) => b[1].length - a[1].length);
  return [...exact, ...prefixes];
})());

for (const [key, s] of Object.entries(SERVICES)) {
  if (!TIERS.includes(s.tier)) throw new Error(`serviceCatalog: ${key} has invalid tier ${s.tier}`);
  if (s.tier === 'A' && !['ON', 'OFF'].includes(s.pilot)) throw new Error(`serviceCatalog: tier-A ${key} needs pilot ON|OFF`);
  if (s.tier !== 'A' && s.pilot !== undefined) throw new Error(`serviceCatalog: only tier A has a pilot state (${key})`);
  if (!s.attestation || !s.module) throw new Error(`serviceCatalog: ${key} lacks attestation/module`);
}

// ---------- tier-B activation (owner record committed in git + environment) ----------
const ACTIVATIONS_FILE = path.join(__dirname, 'tier-b-activations.json');
const SHA256_RE = /^[0-9a-f]{64}$/;

function loadActivations() {
  const raw = JSON.parse(fs.readFileSync(ACTIVATIONS_FILE, 'utf8'));
  if (!raw || !Array.isArray(raw.activations)) throw new Error('tier-b-activations.json: { "activations": [] } expected');
  return Object.freeze(raw.activations.map((a) => Object.freeze({ ...a })));
}
let ACTIVATIONS = null;
function activations() { if (!ACTIVATIONS) ACTIVATIONS = loadActivations(); return ACTIVATIONS; }

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
function validActivation(a, key, env) {
  return !!a && a.service === key && SERVICES[key] && SERVICES[key].tier === 'B'
    && a.approved_by === 'OWNER'
    && typeof a.approval_ref === 'string' && a.approval_ref.trim().length >= 3
    && typeof a.legal_ref === 'string' && SHA256_RE.test(a.legal_ref)
    && typeof a.accounting_ref === 'string' && SHA256_RE.test(a.accounting_ref)
    && a.legal_ref.toLowerCase() !== a.accounting_ref.toLowerCase()
    && typeof a.approved_at === 'string' && ISO_DATE_RE.test(a.approved_at) && !Number.isNaN(Date.parse(a.approved_at))
    && Array.isArray(a.envs) && a.envs.includes(env);
}

function enableList(value) {
  return String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
}

// Pure decision (inputs injectable for tests).
function tierBDecision(key, { pilot, env, enable, records }) {
  if (pilot) return false;
  if (DEV_TEST_ENVS.includes(env)) return true;
  if (env !== 'production') return false;
  if (!enableList(enable).includes(key)) return false;
  return (records || []).some((a) => validActivation(a, key, 'production'));
}

function isPilotMode() { return process.env.PILOT_MODE === 'true'; }

function serviceDef(key) {
  const s = SERVICES[key];
  if (!s) throw new Error(`serviceCatalog: unknown service "${key}"`);
  return s;
}

function isServiceEnabled(key) {
  const s = serviceDef(key);
  if (isPilotMode()) return s.tier === 'PLATFORM' || (s.tier === 'A' && s.pilot === 'ON');
  if (s.tier === 'B') {
    return tierBDecision(key, { pilot: false, env: process.env.NODE_ENV, enable: process.env.AFRIKOBA_TIER_B_ENABLE, records: activations() });
  }
  return true;
}

// Pilot state is static (code), so the pilot allow-list of whole segments is a constant.
function enabledInPilot(key) { const s = serviceDef(key); return s.tier === 'PLATFORM' || (s.tier === 'A' && s.pilot === 'ON'); }

function disabledError(key) {
  const pilot = isPilotMode();
  return Object.assign(new Error(pilot ? 'Huduma hii haipatikani kwenye pilot.' : 'Huduma hii imezimwa (daraja B).'), {
    statusCode: 403,
    code: pilot ? 'PILOT_SERVICE_EXCLUDED' : 'TIER_B_DISABLED',
    details: { service: key, tier: SERVICES[key] ? SERVICES[key].tier : null, pilotMode: pilot },
  });
}

function assertServiceEnabled(key) {
  if (!isServiceEnabled(key)) throw disabledError(key);
}

// Startup check: an environment that names a tier-B service must be backed by a valid owner record, and a
// pilot process may not name any. Pure (inputs injectable for tests); returns the list of problems.
function catalogEnvironmentErrors({ pilot, env, enable, records }) {
  const names = enableList(enable);
  const errors = [];
  if (names.length === 0) return errors;
  if (pilot) errors.push('AFRIKOBA_TIER_B_ENABLE haiwezi kutumika kwenye pilot (daraja B halipo kwenye pilot).');
  if (!pilot && env !== 'production' && !DEV_TEST_ENVS.includes(env)) errors.push(`AFRIKOBA_TIER_B_ENABLE haiwezi kutumika kwenye NODE_ENV="${env || ''}" (production, test au development tu).`);
  for (const n of names) {
    if (!SERVICES[n] || SERVICES[n].tier !== 'B') { errors.push(`AFRIKOBA_TIER_B_ENABLE: "${n}" si huduma ya daraja B.`); continue; }
    if (env === 'production' && !(records || []).some((a) => validActivation(a, n, 'production'))) {
      errors.push(`AFRIKOBA_TIER_B_ENABLE: "${n}" haina rekodi halali ya idhini ya mmiliki (src/config/tier-b-activations.json).`);
    }
  }
  return errors;
}

function assertCatalogEnvironment() {
  const records = activations(); // throws when the record file is malformed
  const errors = catalogEnvironmentErrors({ pilot: isPilotMode(), env: process.env.NODE_ENV, enable: process.env.AFRIKOBA_TIER_B_ENABLE, records });
  if (errors.length) throw new Error(errors.join(' '));
}

function apiRest(pathname) {
  return String(pathname || '').split('?')[0].replace(/^\/api(?:\/v1)?(?=\/|$)/i, '');
}
function serviceSegment(originalUrl) {
  return apiRest(originalUrl).replace(/^\//, '').split('/')[0];
}
// R36B review #1: the segment comes from the parsed pathname (the same value Express routes on), so an
// absolute-form request target ("GET http://host/api/v1/x") cannot hide the segment.
const parseurl = require('parseurl');
function requestPath(req) {
  const u = parseurl.original(req);
  return (u && u.pathname) || '';
}

function refuse(res, key) {
  const e = disabledError(key);
  return res.status(403).json({ success: false, code: e.code, message: e.message, details: e.details });
}

// Mounted BEFORE the routers for one API prefix. Route rules are matched by Express itself (same
// case-insensitivity and parameter rules as the routers), the most specific rule tags the request,
// and the final gate decides for the tagged service or the segment's service.
function mountCatalogGates(app, prefix) {
  for (const [method, p, key] of ROUTE_RULES) {
    app[method](`${prefix}${p}`, (req, res, next) => { if (!req.catalogService) req.catalogService = key; next(); });
  }
  app.use(prefix, (req, res, next) => {
    const rest = apiRest(requestPath(req));
    const seg = rest.replace(/^\//, '').split('/')[0].toLowerCase();
    // R36B review #6: an empty segment is only the bare prefix ("/api", "/api/v1", "/api/v1/"), never "//x".
    if (seg === '' && (rest === '' || rest === '/')) return next();
    const key = req.catalogService || SEGMENT_INDEX[seg] || null;
    if (!key) {
      // R36B review #1/#4: unclassified paths fail closed everywhere except test/development.
      if (!isPilotMode() && DEV_TEST_ENVS.includes(process.env.NODE_ENV)) return next();
      const pilot = isPilotMode();
      return res.status(403).json({ success: false, code: pilot ? 'PILOT_SERVICE_EXCLUDED' : 'SERVICE_UNCLASSIFIED', message: pilot ? 'Huduma hii haipatikani kwenye pilot.' : 'Huduma hii haijaainishwa.', details: { service: seg, pilotMode: pilot } });
    }
    if (isServiceEnabled(key)) return next();
    return refuse(res, key);
  });
}

function describe() {
  const out = {};
  for (const [key, s] of Object.entries(SERVICES)) {
    out[key] = { tier: s.tier, module: s.module, pilot: s.tier === 'A' ? s.pilot : (s.tier === 'PLATFORM' ? 'ON' : 'OFF'), enabledNow: isServiceEnabled(key) };
  }
  return out;
}

module.exports = {
  SERVICES, TIERS, DEV_TEST_ENVS, SEGMENT_INDEX, JOB_INDEX, EXECUTOR_INDEX, FEATURE_INDEX, ROUTE_RULES,
  ACTIVATIONS_FILE, activations, validActivation, tierBDecision, isServiceEnabled, enabledInPilot,
  assertServiceEnabled, disabledError, catalogEnvironmentErrors, assertCatalogEnvironment, serviceSegment, mountCatalogGates, describe,
};
