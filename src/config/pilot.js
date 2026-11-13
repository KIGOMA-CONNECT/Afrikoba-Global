'use strict';
/**
 * R36 — closed, non-real-money pilot: the ONE configuration boundary for what the pilot may do.
 *
 * PILOT_MODE
 *   'true'  -> pilot boundary enforced: every feature in PILOT_DISABLED is refused server-side
 *              (403 PILOT_FEATURE_DISABLED), whatever its own flag says.
 *   'false' -> not a pilot build; features follow their own flags (existing behaviour).
 *   unset   -> 'false' outside production. In production config.validateConfig() refuses to start
 *              until PILOT_MODE is set explicitly ('true' or 'false'): no silent default.
 *
 * Enabled in the pilot (not gated here): VICOBA shares, contributions, the three-stage loan chain,
 * fines (penalties), community/social fund, internal test wallet.
 *
 * VICOBA addBonus is OFF by default everywhere (not only in the pilot). It runs only when
 * VICOBA_ADD_BONUS_ENABLED === 'true' AND the pilot boundary is not enforced.
 *
 * Flags are read from process.env at call time, so a running process cannot be switched by code
 * paths other than its environment, and tests can set the environment explicitly.
 */

const PILOT_DISABLED = Object.freeze({
  vicobaAddBonus: 'VICOBA addBonus (bonus / interest income posting)',
  annualDividends: 'Annual dividends / profit distribution (VICOBA gawio, SACCOS dividends)',
  p2p: 'P2P (peer-to-peer payments, splits, requests)',
  saccos: 'SACCOS',
  remittance: 'Remittance (cross-border send / pickup)',
  recurringPayments: 'Recurring / scheduled payments and recurrence automation',
  cards: 'Cards',
  externalPayments: 'AzamPay / live external payments (MNO deposit, withdrawal, payout)',
  publicRegistration: 'Public self-registration',
});

const PILOT_ENABLED = Object.freeze([
  'VICOBA shares', 'VICOBA contributions', 'VICOBA three-stage loans', 'VICOBA fines (penalties)',
  'VICOBA community/social fund', 'internal test wallet',
]);

function isPilotMode() {
  return process.env.PILOT_MODE === 'true';
}

function pilotModeExplicit() {
  return process.env.PILOT_MODE === 'true' || process.env.PILOT_MODE === 'false';
}

// Feature-specific switches outside the pilot. Only addBonus defaults OFF; the others keep their
// existing behaviour when the pilot boundary is not enforced.
function featureOwnFlag(feature) {
  if (feature === 'vicobaAddBonus') return process.env.VICOBA_ADD_BONUS_ENABLED === 'true';
  return true;
}

function isFeatureEnabled(feature) {
  if (!Object.prototype.hasOwnProperty.call(PILOT_DISABLED, feature)) {
    throw new Error(`pilot: unknown feature "${feature}"`);
  }
  if (isPilotMode()) return false;
  return featureOwnFlag(feature);
}

function featureDisabledError(feature) {
  return Object.assign(
    new Error(`Huduma hii imezimwa kwa sasa (${PILOT_DISABLED[feature]}).`),
    { statusCode: 403, code: 'PILOT_FEATURE_DISABLED', details: { feature, pilotMode: isPilotMode() } }
  );
}

// Throws before any read or write when the feature is disabled.
function assertFeatureEnabled(feature) {
  if (!isFeatureEnabled(feature)) throw featureDisabledError(feature);
}

// Express gate for a whole router or route. Responds itself (does not depend on the app's error handler).
function requireFeature(feature) {
  if (!Object.prototype.hasOwnProperty.call(PILOT_DISABLED, feature)) {
    throw new Error(`pilot: unknown feature "${feature}"`);
  }
  return (req, res, next) => {
    if (isFeatureEnabled(feature)) return next();
    const err = featureDisabledError(feature);
    return res.status(403).json({ success: false, code: err.code, message: err.message, details: err.details });
  };
}

// Route-level gates mounted BEFORE the feature routers for one API prefix (server.js). The service-level
// assertFeatureEnabled() calls remain the authority; these make the HTTP boundary explicit and refuse
// before validation, rate-limit state or body parsing reach the feature's handlers.
const ROUTE_GATES = Object.freeze([
  ['use', '/p2p', 'p2p'],
  ['use', '/saccos', 'saccos'],
  ['use', '/cards', 'cards'],
  ['use', '/recurrence', 'recurringPayments'],
  ['use', '/network/scheduled', 'recurringPayments'],
  ['use', '/network/remittance', 'remittance'],
  ['use', '/payments', 'externalPayments'],
  ['post', '/vicoba/groups/:groupId/topup/cross-network', 'externalPayments'],
  ['post', '/admin/countries/transfer', 'remittance'],
  ['post', '/auth/register', 'publicRegistration'],
  ['post', '/vicoba/groups/:groupId/bonus', 'vicobaAddBonus'],
  ['post', '/vicoba/groups/:groupId/profits/calculate', 'annualDividends'],
  ['post', '/vicoba/profits/:distributionId/approve', 'annualDividends'],
]);

// R36 closure: in pilot mode the API is an ALLOW-LIST. Only these first path segments (after /api or
// /api/v1) are served; every other service -- ROSCA, circles, business, credit, savings, vaults, family,
// events, marketplace, governance, crowdfunding projects, and any route added later -- answers
// 403 PILOT_SERVICE_EXCLUDED. Fail-closed by construction.
const PILOT_ALLOWED_SERVICES = Object.freeze([
  'auth', 'totp', 'wallet', 'vicoba', 'services', 'countries', 'devices', 'notifications',
  'admin', 'ops', 'cache', 'features', 'fraud-ops', 'outbox',
]);

function serviceSegment(originalUrl) {
  const p = String(originalUrl || '').split('?')[0];
  const rest = p.replace(/^\/api(?:\/v1)?(?=\/|$)/, '');
  return rest.replace(/^\//, '').split('/')[0];
}

function pilotServiceGate(req, res, next) {
  if (!isPilotMode()) return next();
  const seg = serviceSegment(req.originalUrl);
  if (seg === '' || PILOT_ALLOWED_SERVICES.includes(seg)) return next();
  return res.status(403).json({
    success: false, code: 'PILOT_SERVICE_EXCLUDED',
    message: 'Huduma hii haipatikani kwenye pilot.', details: { service: seg, pilotMode: true },
  });
}

function mountPilotGates(app, prefix) {
  for (const [method, path, feature] of ROUTE_GATES) app[method](`${prefix}${path}`, requireFeature(feature));
  app.use(prefix, pilotServiceGate);
}

// Background jobs: every scheduled job is classified; only these run in pilot mode.
const PILOT_JOBS = Object.freeze({
  RECON_PENDING_DEPOSITS: true, DB_MAINTENANCE: true, BALANCE_RECONCILIATION: true, OUTBOX_DISPATCH: true, PARTITIONS: true,
  ROSCA_PAYOUT: false, SPLIT_PAYMENTS: false, YIELD_PAYOUTS: false, SCHEDULED_PAYMENTS: false, AUTOPILOT_SAVINGS: false,
  SELLER_VERIFICATION: false, AUTO_INVEST: false, SACCOS_STANDING_ORDERS: false, FX_HISTORY: false, FUNDING_EXPIRY: false,
  EVENT_REMINDERS: false, EVENT_SERIES: false,
});
function pilotJobAllowed(name) {
  if (!Object.prototype.hasOwnProperty.call(PILOT_JOBS, name)) throw new Error(`pilot: unclassified job "${name}"`);
  return !isPilotMode() || PILOT_JOBS[name] === true;
}
function pilotJob(name, fn) {
  pilotJobAllowed(name); // classification check at registration time
  return async (...args) => { if (!pilotJobAllowed(name)) return { skipped: 'PILOT_JOB_DISABLED', job: name }; return fn(...args); };
}

// Four-eyes / approval-flow executors: only these may execute in pilot mode.
const PILOT_ALLOWED_EXECUTORS = Object.freeze([
  'ADMIN_PROMOTE_ROLE', 'ADMIN_DEMOTE_ROLE', 'WALLET_TRANSFER', 'VICOBA_LOAN_DISBURSE', 'VICOBA_SOCIAL_FUND_DISBURSE',
]);
function guardExecutor(code, fn) {
  return async (...args) => {
    if (isPilotMode() && !PILOT_ALLOWED_EXECUTORS.includes(code)) {
      throw Object.assign(new Error('Kitendo hiki hakiruhusiwi kwenye pilot.'),
        { statusCode: 403, code: 'PILOT_FEATURE_DISABLED', details: { executor: code, pilotMode: true } });
    }
    return fn(...args);
  };
}

// The pilot runs only as a production-mode process: non-production NODE_ENV enables dev-only behaviour
// (devOtp in /auth/send-otp, stack traces, simulated SMS, webhook/USSD secret bypass, API docs).
function assertPilotEnvironment() {
  if (isPilotMode() && process.env.NODE_ENV !== 'production') {
    throw new Error("PILOT_MODE=true inahitaji NODE_ENV=production (src/config/pilot.js)");
  }
}

function describe() {
  const disabled = {};
  for (const k of Object.keys(PILOT_DISABLED)) disabled[k] = !isFeatureEnabled(k);
  return { pilotMode: isPilotMode(), enabledInPilot: PILOT_ENABLED, disabledNow: disabled, allowedServicesInPilot: PILOT_ALLOWED_SERVICES };
}

module.exports = {
  PILOT_DISABLED, PILOT_ENABLED, isPilotMode, pilotModeExplicit, isFeatureEnabled, assertFeatureEnabled,
  requireFeature, featureDisabledError, describe, ROUTE_GATES, mountPilotGates,
  PILOT_ALLOWED_SERVICES, serviceSegment, pilotServiceGate, PILOT_JOBS, pilotJobAllowed, pilotJob,
  PILOT_ALLOWED_EXECUTORS, guardExecutor, assertPilotEnvironment,
};
