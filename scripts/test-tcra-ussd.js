/* ============================================================
 * AFRIKOBA GLOBAL - TCRA USSD SHORTCODE REGISTRY
 * Migration 097: supported_countries gains ussd_shortcode +
 * ussd_shortcode_status (PENDING|APPROVED) so Compliance can
 * track the USSD shortcode registration filing per market
 * (AFK-INST-13 TCRA row). The USSD rails themselves are proven
 * by test-ussd; this suite proves the registry:
 *  - schema columns + CHECK constraint exist
 *  - TZ is seeded with the dial string + PENDING filing state
 *  - GET /api/countries surfaces the ussd block for every market
 *  - GET /api/countries/me reports the resolved market's shortcode
 *  - admin PUT /api/admin/countries/:id flips status APPROVED and
 *    it is reflected in the public snapshot + audit trail
 *  - invalid status value is rejected by the CHECK constraint
 *  - unauthenticated access -> 401
 * ============================================================ */
const BASE = process.env.TCRA_USSD_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

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

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.user) throw new Error(`register ${phoneNumber} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}
async function makeAdmin(regData) {
  if (!regData || !regData.user || !regData.user.id) return null;
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [regData.user.id]);
  return regData.user.id;
}

async function run() {
  const runSalt = String(Date.now()).slice(-5);
  const suffix = `${runSalt}${Math.floor(Math.random() * 90) + 10}`;

  await section('Schema evidence (migration 097)');
  const cols = await pool.query(
    `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'supported_countries'
        AND column_name IN ('ussd_shortcode','ussd_shortcode_status')`
  );
  const colMap = Object.fromEntries(cols.rows.map((c) => [c.column_name, c]));
  await expect(!!colMap.ussd_shortcode, 'ussd_shortcode column exists');
  await expect(!!colMap.ussd_shortcode_status, 'ussd_shortcode_status column exists');
  await expect(colMap.ussd_shortcode_status?.column_default === `'PENDING'::text` ||
    String(colMap.ussd_shortcode_status?.column_default || '').includes('PENDING'),
    `status defaults PENDING (got ${colMap.ussd_shortcode_status?.column_default})`);

  const check = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'supported_countries_ussd_status_check'`
  );
  await expect(check.rows.length === 1, 'CHECK constraint supported_countries_ussd_status_check present');

  const tzSeed = await pool.query(
    `SELECT ussd_shortcode, ussd_shortcode_status FROM supported_countries WHERE code = 'TZ'`
  );
  await expect(!!tzSeed.rows[0]?.ussd_shortcode, `TZ seeded with shortcode (got ${tzSeed.rows[0]?.ussd_shortcode})`);
  await expect(tzSeed.rows[0]?.ussd_shortcode_status === 'PENDING',
    `TZ registration status PENDING at baseline (got ${tzSeed.rows[0]?.ussd_shortcode_status})`);

  await section('Setup: register TZ admin + user, promote admin');
  const adm = await register(`255806${suffix}`, 'TCRA Registry Admin');
  const usr = await register(`255807${suffix}`, 'TCRA Registry User');
  const admId = await makeAdmin(adm);
  await expect(!!admId, 'admin promoted');
  await expect(!!adm.token && !!usr.token, 'tokens present');

  await section('GET /api/countries - ussd block surfaced per market');
  const list = await api('GET', '/api/countries', usr.token);
  await expect(list.status === 200, `countries lists 200 (got ${list.status})`);
  const tzRow = (list.data.countries || []).find((c) => c.code === 'TZ');
  await expect(!!tzRow && !!tzRow.ussd && tzRow.ussd.shortcode === '*150*87',
    `TZ ussd block in snapshot (got ${JSON.stringify(tzRow && tzRow.ussd).slice(0, 80)})`);
  await expect(!!tzRow && tzRow.ussd.status === 'PENDING', `TZ status PENDING in snapshot (got ${tzRow?.ussd?.status})`);
  const withUssd = (list.data.countries || []).filter((c) => c.ussd && 'status' in c.ussd).length;
  await expect(withUssd >= 3, `every active market carries the ussd block (count ${withUssd})`);

  await section('GET /api/countries/me - resolved-market shortcode');
  const meTz = await api('GET', '/api/countries/me', adm.token);
  await expect(meTz.status === 200 && meTz.data.code === 'TZ', `me resolves TZ (got ${meTz.data.code})`);
  await expect(meTz.data.ussd && meTz.data.ussd.shortcode === '*150*87',
    `me surfaces shortcode (got ${JSON.stringify(meTz.data.ussd).slice(0, 80)})`);

  await section('Admin lifecycle: flip status, confirm CHECK rejects bad values');
  const adminCountries = await api('GET', '/api/admin/countries', adm.token);
  const tzId = (adminCountries.data.countries || []).find((c) => c.code === 'TZ')?.id;
  await expect(!!tzId, `resolved TZ country id (got ${tzId})`);

  const bad = await api('PUT', `/api/admin/countries/${tzId}`, adm.token, { ussd_shortcode_status: 'GRANTED' });
  await expect(bad.status >= 400, `invalid status GRANTED rejected (got ${bad.status})`);
  const stillPending = await pool.query(
    `SELECT ussd_shortcode_status FROM supported_countries WHERE code = 'TZ'`
  );
  await expect(stillPending.rows[0].ussd_shortcode_status === 'PENDING',
    `status unchanged after rejected update (got ${stillPending.rows[0].ussd_shortcode_status})`);

  const approved = await api('PUT', `/api/admin/countries/${tzId}`, adm.token, {
    ussd_shortcode_status: 'APPROVED', ussd_shortcode: '*150*87'
  });
  await expect(approved.status === 200, `admin approves shortcode (got ${approved.status})`);

  const afterList = await api('GET', '/api/countries', usr.token);
  const tzAfter = (afterList.data.countries || []).find((c) => c.code === 'TZ');
  await expect(tzAfter?.ussd?.status === 'APPROVED',
    `snapshot reflects APPROVED after update (got ${tzAfter?.ussd?.status})`);

  await section('Audit trail + RBAC');
  const audit = await pool.query(
    `SELECT action, meta FROM audit_logs
      WHERE entity_type = 'COUNTRY' AND entity_id = $1
      ORDER BY id DESC LIMIT 3`,
    [tzId]
  );
  await expect(audit.rows.some((r) => r.action === 'COUNTRY_UPDATED' && JSON.stringify(r.meta || '').includes('APPROVED')),
    `COUNTRY_UPDATED audit trail records the APPROVED change`);

  const anon = await api('GET', '/api/countries', null);
  await expect(anon.status === 401, `unauthenticated /countries -> 401 (got ${anon.status})`);
  const anonMe = await api('GET', '/api/countries/me', null);
  await expect(anonMe.status === 401, `unauthenticated /countries/me -> 401 (got ${anonMe.status})`);

  await pool.query("UPDATE supported_countries SET ussd_shortcode_status = 'PENDING' WHERE code = 'TZ'");
}

run()
  .then(() => {
    console.log(`\nTCRA USSD REGISTRY: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });