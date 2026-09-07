/* ============================================================
 * AFRIKOBA GLOBAL - OPENAPI / SWAGGER DOCUMENTATION
 * Code-first OpenAPI (AFK-INST-08): the swagger-jsdoc spec in
 * src/config/swagger.js + src/docs/openapi.js is published at
 * /api/v1/docs (swagger-ui) and /api/v1/docs.json (raw) in
 * non-production. This suite proves:
 *  - both endpoints are served (200) in non-prod
 *  - the doc is valid OpenAPI 3.0.3 with info + servers
 *  - every module in the AFK-INST-08 representative surface
 *    has at least one documented path
 *  - the three C4 contracts are captured (register -> phone_number,
 *    transfer -> no balance, dismiss -> { dismissed: { id } })
 *  - components (bearerAuth, hmacAuth, User, Error, refs) exist
 * ============================================================ */
const BASE = process.env.OPENAPI_TEST_BASE || 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path) {
  const res = await fetch(BASE + path, { method, headers: { Accept: 'application/json' } });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

const REQUIRED_PATHS = [
  '/api/auth/send-otp', '/api/auth/register',
  '/api/wallet/balance', '/api/wallet/transfer',
  '/api/ai/insights', '/api/vicoba/groups', '/api/rosca/pools',
  '/api/p2p/projects', '/api/merchant/payment-links', '/api/business/invoices',
  '/api/payroll/runs', '/api/procurement/rfqs', '/api/field-partners',
  '/api/ops/chart-of-accounts', '/api/ops/tracing/{traceId}',
  '/api/admin/aml/cases', '/api/countries', '/api/countries/me',
  '/api/devices', '/api/ussd', '/health', '/health/db', '/api/v1',
];

async function run() {
  await section('OpenAPI endpoints served (non-prod)');
  const docsJson = await api('GET', '/api/v1/docs.json');
  await expect(docsJson.status === 200, `GET /api/v1/docs.json -> 200 (got ${docsJson.status})`);

  const ui = await fetch(BASE + '/api/v1/docs', { method: 'GET' });
  await expect(ui.status === 200, `GET /api/v1/docs (swagger-ui) -> 200 (got ${ui.status})`);
  const uiText = await ui.text();
  await expect(/swagger-ui/i.test(uiText), `swagger-ui served as HTML`);

  const doc = docsJson.data;
  await expect(doc && doc.openapi === '3.0.3', `openapi: 3.0.3 (got ${doc && doc.openapi})`);
  await expect(doc && doc.info && doc.info.title === 'Afrikoba Global API', `info.title present`);
  await expect(doc && Array.isArray(doc.servers) && doc.servers.length > 0, `servers list present`);

  await section('Representative module surface documented (AFK-INST-08 §3)');
  const paths = doc && doc.paths ? doc.paths : {};
  for (const p of REQUIRED_PATHS) {
    await expect(!!paths[p], `path ${p}`);
  }

  await section('C4 contracts captured (AFK-INST-08 §4)');
  const register = paths['/api/auth/register'];
  await expect(register && register.post, `register is a POST`);
  const regRef = JSON.stringify(register);
  await expect(regRef.includes('phone_number') && !regRef.includes('res.description: phone'),
    `register documents user.phone_number`);
  const transfer = paths['/api/wallet/transfer'];
  const txStr = JSON.stringify(transfer);
  await expect(transfer && transfer.post, `transfer is a POST`);
  await expect(!txStr.match(/"balance"/) && txStr.includes('referenceId'), `transfer response has referenceId and no balance`);
  const dismiss = paths['/api/ai/insights/{id}/dismiss'];
  const disStr = JSON.stringify(dismiss);
  await expect(dismiss && dismiss.post, `dismiss is a POST`);
  await expect(disStr.includes('dismissed') && disStr.includes('"id"'), `dismiss returns { dismissed: { id } }`);

  await section('Components + security schemes');
  const comps = doc && doc.components ? doc.components : {};
  await expect(comps.securitySchemes && comps.securitySchemes.bearerAuth, `bearerAuth scheme`);
  await expect(comps.securitySchemes && comps.securitySchemes.hmacAuth, `hmacAuth scheme (USSD/webhooks)`);
  await expect(comps.schemas && comps.schemas.User, `User schema`);
  await expect(comps.schemas && comps.schemas.Error, `Error schema`);
  await expect(comps.responses && comps.responses.Unauthorized && comps.responses.Forbidden,
    `Unauthorized/Forbidden response refs`);
  await expect(comps.parameters && comps.parameters.IdempotencyKey, `IdempotencyKey header param`);
  await expect(doc.security && doc.security.some((s) => s.bearerAuth), `global bearerAuth security`);
}

run()
  .then(() => {
    console.log(`\nOPENAPI: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });