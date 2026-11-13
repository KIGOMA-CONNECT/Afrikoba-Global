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
]); // R36B: services opened later (ROSCA/Upatu, events, group governance, PIN reset) are in serviceCatalog.js

// Lazy: serviceCatalog has no dependency on this module, but keeping the require lazy avoids load-order traps.
const catalog = () => require('./serviceCatalog');

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
  // R36B: the feature's catalog service must be enabled too (tier B is off in production unless the
  // owner activated it; see serviceCatalog.js).
  const svc = catalog().FEATURE_INDEX[feature];
  if (!svc || !catalog().isServiceEnabled(svc)) return false;
  return featureOwnFlag(feature);
}

function featureDisabledError(feature) {
  // Outside the pilot a feature is off only because its catalog service is off (tier B without owner
  // activation) or its own flag is off (addBonus): name the tier-B case explicitly.
  const svc = catalog().FEATURE_INDEX[feature];
  const tierB = !isPilotMode() && svc && catalog().SERVICES[svc].tier === 'B' && !catalog().isServiceEnabled(svc);
  return Object.assign(
    new Error(`Huduma hii imezimwa kwa sasa (${PILOT_DISABLED[feature]}).`),
    { statusCode: 403, code: tierB ? 'TIER_B_DISABLED' : 'PILOT_FEATURE_DISABLED', details: { feature, service: svc || null, pilotMode: isPilotMode() } }
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

// R36 closure / R36B: in pilot mode the API is an ALLOW-LIST derived from the service catalog
// (src/config/serviceCatalog.js). Whole segments listed here are those whose catalog service runs in the
// pilot; route-level rules (PIN reset inside /advanced, AI minutes inside /governance, Market inside
// /social and /admin, ...) are applied by catalog.mountCatalogGates. Everything else -- including any
// route added later -- answers 403 PILOT_SERVICE_EXCLUDED. Fail-closed by construction.
const PILOT_ALLOWED_SERVICES = Object.freeze(
  Object.entries(catalog().SEGMENT_INDEX).filter(([, key]) => catalog().enabledInPilot(key)).map(([seg]) => seg).sort()
);


function mountPilotGates(app, prefix) {
  for (const [method, path, feature] of ROUTE_GATES) app[method](`${prefix}${path}`, requireFeature(feature));
  catalog().mountCatalogGates(app, prefix);
}

// Background jobs: every scheduled job is classified in the catalog. Pilot: only jobs of services that run
// in the pilot. Outside the pilot: tier-B jobs run only where tier B is enabled (never in production
// without an owner activation record).
const PILOT_JOBS = Object.freeze(Object.fromEntries(
  Object.entries(catalog().JOB_INDEX).map(([name, key]) => [name, catalog().enabledInPilot(key)])
));
function pilotJobAllowed(name) {
  const key = catalog().JOB_INDEX[name];
  if (!key) throw new Error(`pilot: unclassified job "${name}"`);
  return catalog().isServiceEnabled(key);
}
function pilotJob(name, fn) {
  pilotJobAllowed(name); // classification check at registration time
  return async (...args) => { if (!pilotJobAllowed(name)) return { skipped: isPilotMode() ? 'PILOT_JOB_DISABLED' : 'TIER_B_JOB_DISABLED', job: name }; return fn(...args); };
}

// Four-eyes / approval-flow executors: classified in the catalog. An executor runs only while its service
// is enabled (pilot: services opened for the pilot; production: tier B needs owner activation). An
// unclassified executor code is refused in the pilot (fail-closed) and runs elsewhere (test registries).
const PILOT_ALLOWED_EXECUTORS = Object.freeze(
  Object.entries(catalog().EXECUTOR_INDEX).filter(([, key]) => catalog().enabledInPilot(key)).map(([code]) => code).sort()
);
function guardExecutor(code, fn) {
  return async (...args) => {
    const key = catalog().EXECUTOR_INDEX[code];
    const allowed = key ? catalog().isServiceEnabled(key) : !isPilotMode();
    if (!allowed) {
      const pilot = isPilotMode();
      throw Object.assign(new Error(pilot ? 'Kitendo hiki hakiruhusiwi kwenye pilot.' : 'Kitendo hiki kimezimwa (daraja B).'),
        { statusCode: 403, code: pilot ? 'PILOT_FEATURE_DISABLED' : 'TIER_B_DISABLED', details: { executor: code, service: key || null, pilotMode: pilot } });
    }
    return fn(...args);
  };
}

// R36B OD-3: in the pilot, four-eyes cannot be switched off or self-approved by one admin. The lock is the
// environment (PILOT_MODE), not a DB flag or a policy row: the direct-route gate always requires four-eyes,
// the four-eyes routes do not depend on the FOUR_EYES flag, policies cannot be weakened
// (allow_self_approve / enabled=false), self-approval is refused whatever the stored policy says, and the
// four-eyes amount thresholds cannot be changed by a single admin.
function isFourEyesLocked() {
  return isPilotMode();
}
function fourEyesLockedError(what) {
  return Object.assign(new Error(`Four-eyes imefungwa kwa mazingira ya pilot (${what}).`), { statusCode: 403, status: 403, code: 'FOUR_EYES_LOCKED' });
}

// The pilot runs only as a production-mode process: non-production NODE_ENV enables dev-only behaviour
// (devOtp in /auth/send-otp, stack traces, simulated SMS, webhook/USSD secret bypass, API docs).
function assertPilotEnvironment() {
  if (isPilotMode() && process.env.NODE_ENV !== 'production') {
    throw new Error("PILOT_MODE=true inahitaji NODE_ENV=production (src/config/pilot.js)");
  }
  // R36B: tier-B activation must be backed by the owner record; never in a pilot.
  catalog().assertCatalogEnvironment();
}

function describe() {
  const disabled = {};
  for (const k of Object.keys(PILOT_DISABLED)) disabled[k] = !isFeatureEnabled(k);
  return { pilotMode: isPilotMode(), enabledInPilot: PILOT_ENABLED, disabledNow: disabled, allowedServicesInPilot: PILOT_ALLOWED_SERVICES, catalog: catalog().describe() };
}

module.exports = {
  PILOT_DISABLED, PILOT_ENABLED, isPilotMode, pilotModeExplicit, isFeatureEnabled, assertFeatureEnabled,
  requireFeature, featureDisabledError, describe, ROUTE_GATES, mountPilotGates,
  PILOT_ALLOWED_SERVICES, PILOT_JOBS, pilotJobAllowed, pilotJob,
  PILOT_ALLOWED_EXECUTORS, guardExecutor, assertPilotEnvironment, isFourEyesLocked, fourEyesLockedError,
};
