/* ============================================================
 * AFRIKOBA GLOBAL - FIU SAR FILING FORMALISATION
 * Migration 095: sar_filings trail + latest-filing mirror on
 * aml_cases. This suite proves:
 *  - admin can file a SAR against an AML case (trail row created)
 *  - the latest filing mirrors onto aml_cases (reference, agency,
 *    filed_at, disposition defaults REFERRED_TO_LRA)
 *  - getAmlCase + filings endpoint surface the trail with names
 *  - multiple filings are allowed per case (audit-friendly)
 *  - missing reference -> 400 validation error
 *  - RBAC: non-admin is refused on file-sar (403)
 *  - SAR_FILED audit entry is written
 * ============================================================ */
const BASE = process.env.SAR_TEST_BASE || 'http://127.0.0.1:3000';
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

async function run() {
  const suffix = `${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90) + 10}`;

  await section('Setup: admin + subject user');
  const adm = await register(`255801${suffix}`, 'SAR Admin');
  await expect(!!adm, 'admin registered');
  await pool.query("UPDATE users SET role = 'ADMIN', updated_at = NOW() WHERE id = $1", [adm.user.id]);
  const subject = await register(`255802${suffix}`, 'SAR Subject');
  await expect(!!subject, 'subject user registered');

  await section('Open AML case + file SAR');
  const opened = await api('POST', '/api/admin/aml/cases', adm.token, {
    userId: subject.user.id, caseType: 'SUSPICIOUS_ACTIVITY', riskLevel: 'HIGH',
    summary: 'Structured deposits below reporting threshold (SAR test).',
  });
  await expect(opened.status === 200 && opened.data.case && opened.data.case.id, `AML case opened (got ${opened.status})`);
  const caseId = opened.data.case.id;

  const ref1 = `FIU-SAR-${suffix}-A`;
  const filed = await api('POST', `/api/admin/aml/cases/${caseId}/file-sar`, adm.token, {
    reference: ref1, agency: 'FIU', summary: 'First filing for regression suite.',
  });
  await expect(filed.status === 200 && filed.data.success === true, `file-sar -> 200 (got ${filed.status})`);
  await expect(filed.data.filing && filed.data.filing.reference === ref1 && filed.data.filing.agency === 'FIU',
    `filing row returned with reference ${ref1}`);
  const c = filed.data.case;
  await expect(c.sar_reference === ref1 && c.sar_agency === 'FIU', `case mirrors sar_reference`);
  await expect(c.disposition === 'REFERRED_TO_LRA', `disposition defaults to REFERRED_TO_LRA (got ${c.disposition})`);
  await expect(!!c.sar_filed_at, `sar_filed_at set`);
  await expect(c.status === 'INVESTIGATING', `case moves to INVESTIGATING (got ${c.status})`);

  await section('DB-level trail');
  const trail = (await pool.query('SELECT * FROM sar_filings WHERE case_id = $1', [caseId])).rows;
  await expect(trail.length === 1, `exactly 1 sar_filings row (got ${trail.length})`);
  await expect(trail[0].reference === ref1 && trail[0].filed_by === adm.user.id, `trail stores ref + filer`);

  await section('Surface: case detail + filings endpoint');
  const detail = await api('GET', `/api/admin/aml/cases/${caseId}`, adm.token);
  await expect(detail.status === 200 && Array.isArray(detail.data.filings) && detail.data.filings.length === 1,
    `getAmlCase surfaces filings (got ${detail.status})`);
  await expect(detail.data.filings[0].filed_name === 'SAR Admin', `filing lists filer name`);
  const filingsList = await api('GET', `/api/admin/aml/cases/${caseId}/filings`, adm.token);
  await expect(filingsList.status === 200 && filingsList.data.filings.length === 1, `filings endpoint lists trail`);

  await section('Second filing allowed');
  const ref2 = `FIU-SAR-${suffix}-B`;
  const filed2 = await api('POST', `/api/admin/aml/cases/${caseId}/file-sar`, adm.token, {
    reference: ref2, agency: 'FIU', summary: 'Follow-up filing.',
  });
  await expect(filed2.status === 200 && filed2.data.filing.reference === ref2, `second filing stored`);
  const trail2 = (await pool.query('SELECT * FROM sar_filings WHERE case_id = $1', [caseId])).rows;
  await expect(trail2.length === 2, `trail keeps both filings (got ${trail2.length})`);

  await section('Validation + RBAC');
  const noRef = await api('POST', `/api/admin/aml/cases/${caseId}/file-sar`, adm.token, { agency: 'FIU' });
  await expect(noRef.status === 400, `missing reference -> 400 (got ${noRef.status})`);

  const outsider = await register(`255803${suffix}`, 'SAR Outsider');
  const denied = await api('POST', `/api/admin/aml/cases/${caseId}/file-sar`, outsider.token, {
    reference: `FIU-SAR-${suffix}-X`, agency: 'FIU',
  });
  await expect(denied.status === 403, `non-admin refused on file-sar (got ${denied.status})`);
  const anon = await api('POST', `/api/admin/aml/cases/${caseId}/file-sar`, null, { reference: 'X', agency: 'FIU' });
  await expect(anon.status === 401, `unauthenticated -> 401 (got ${anon.status})`);

  await section('Audit trail');
  const audit = (await pool.query(
    `SELECT * FROM audit_logs WHERE action = 'SAR_FILED' AND entity_type = 'AML_CASE' AND entity_id = $1`,
    [caseId]
  )).rows;
  await expect(audit.length === 2, `SAR_FILED audit entries written for both filings (got ${audit.length})`);
}

run()
  .then(() => {
    console.log(`\nSAR FILING: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });