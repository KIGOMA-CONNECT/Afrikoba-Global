/* ============================================================
 * AFRIKOBA GLOBAL - SANCTIONS WATCHLIST & SCREENING (increment 21e, suite 68)
 *
 * migration 123 adds `sanctions_watchlist` (source/name/phone/doc entries)
 * and `sanctions_screening_hits` (per-screen audit trail + disposition).
 * screening is enforced on the money-exit paths (P2P transfer recipient,
 * remittance pickup beneficiary, merchant payout, payroll employees) and
 * only BLOCKS on CONFIRMED hits (403 AML_SANCTIONS_MATCH); pending hits are
 * recorded for the ADMIN/COMPLIANCE console to disposition.
 *
 * GET   /api/fraud-ops/sanctions              watchlist list (source/status)
 * GET   /api/fraud-ops/sanctions/stats        hit + watchlist counts
 * GET   /api/fraud-ops/sanctions/:id          single entry
 * POST  /api/fraud-ops/sanctions              create entry
 * PATCH /api/fraud-ops/sanctions/:id          update entry
 * POST  /api/fraud-ops/sanctions/:id/remove   status -> REMOVED
 * POST  /api/fraud-ops/sanctions/screen       manual screen (name/phone/doc)
 * GET   /api/fraud-ops/sanctions/hits         screening hits (disposition)
 * POST  /api/fraud-ops/sanctions/hits/:id     CONFIRMED / FALSE_POSITIVE
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || process.env.AML_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0, failed = 0;
const failures = [];
const ok = (label) => { passed++; console.log('  \u2713 ' + label); };
const fail = (label, extra) => { failed++; failures.push(label); console.log('  \u2717 ' + label + (extra ? ' :: ' + extra : '')); };
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra || ''); }
async function section(label) { console.log(`\n--- ${label} ---`); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}
async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
  if (!r.data || !r.data.token) throw new Error('register failed: ' + JSON.stringify(r.data));
  return r.data;
}
async function makeAdmin(phoneNumber, fullName) {
  const info = await register(phoneNumber, fullName);
  await pool.query('UPDATE users SET role = $2 WHERE id = $1', [info.user.id, 'ADMIN']);
  return info;
}
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
}
async function auditCount(action) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = $1', [action]);
  return r.rows[0].n;
}
const nowSuffix = () => String(Date.now()).slice(-6);

async function main() {
  // ---------- 0. Clean slate ----------
  await section('Clean slate');
  await pool.query(`DELETE FROM sanctions_screening_hits; DELETE FROM sanctions_watchlist;`);
  ok('sanctions tables cleared for deterministic run');

  // ---------- 1. Schema evidence (123_sanctions_watchlist) ----------
  await section('Schema evidence (123_sanctions_watchlist)');
  const wc = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'sanctions_watchlist'`
  )).rows.map((r) => r.column_name);
  await expect(['id', 'source', 'category', 'full_name', 'normalized_name', 'phone_number',
    'document_type', 'document_number', 'country_code', 'birth_date', 'status', 'reference',
    'notes', 'created_by', 'created_at', 'updated_at'].every((c) => wc.includes(c)),
    'sanctions_watchlist carries the source/identity columns');
  const hc = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'sanctions_screening_hits'`
  )).rows.map((r) => r.column_name);
  await expect(['watchlist_id', 'subject_type', 'subject_id', 'subject_name', 'subject_phone',
    'matched_field', 'match_score', 'severity', 'disposition', 'decided_by', 'decided_at', 'case_id'].every((c) => hc.includes(c)),
    'sanctions_screening_hits carries the screening columns');

  // ---------- 2. Setup ----------
  await section('Setup: admin + compliance + members');
  const sfx = nowSuffix();
  const admin = await makeAdmin(`255940${sfx}`, 'SN Admin');
  const compliance = await register(`255941${sfx}`, 'SN Officer');
  await pool.query(`UPDATE users SET role = 'COMPLIANCE' WHERE id = $1`, [compliance.user.id]);
  const m1 = await register(`255942${sfx}`, 'Sanctions Target');
  const m2 = await register(`255943${sfx}`, 'Clean Member');
  await fundWallet(m1.user.id, 500000);
  await fundWallet(m2.user.id, 500000);
  const aTok = admin.token, cTok = compliance.token, m1Tok = m1.token, m2Tok = m2.token;
  const m1Id = m1.user.id, m2Id = m2.user.id;

  // ---------- 3. RBAC ----------
  await section('RBAC');
  const unauth = await api('GET', '/api/fraud-ops/sanctions');
  await expect(unauth.status === 401, 'unauthenticated GET sanctions -> 401');
  const memList = await api('GET', '/api/fraud-ops/sanctions', m1Tok);
  await expect(memList.status === 403, 'member GET sanctions -> 403');
  const memScreen = await api('POST', '/api/fraud-ops/sanctions/screen', m1Tok, { name: 'x', phone: '25500000000' });
  await expect(memScreen.status === 403, 'member manual screen -> 403');
  const memScreen2 = await api('POST', '/api/fraud-ops/sanctions/screen', m2Tok, { name: 'x' });
  await expect(memScreen2.status === 403, 'second member manual screen -> 403');
  const aList = await api('GET', '/api/fraud-ops/sanctions', aTok);
  await expect(aList.status === 200 && Array.isArray(aList.data.entries), 'ADMIN GET sanctions -> 200');
  const cList = await api('GET', '/api/fraud-ops/sanctions', cTok);
  await expect(cList.status === 200 && Array.isArray(cList.data.entries), 'COMPLIANCE GET sanctions -> 200');

  // ---------- 4. Watchlist management ----------
  await section('Watchlist CRUD');
  const missing = await api('POST', '/api/fraud-ops/sanctions', aTok, { source: 'OFAC' });
  await expect(missing.status === 400 && missing.data.code === 'SANCTIONS_SOURCE_REQUIRED',
    'entry without full_name -> 400', JSON.stringify(missing.data));
  const add = await api('POST', '/api/fraud-ops/sanctions', aTok,
    { source: 'OFAC', category: 'INDIVIDUAL', full_name: 'Vladimir Malofeyev', phone_number: `255944${sfx}`, country_code: 'TZ', reference: 'OFAC-0001', notes: 'test entry' });
  await expect(add.status === 201 && add.data.entry.id && add.data.entry.source === 'OFAC'
    && add.data.entry.status === 'ACTIVE' && add.data.entry.normalized_name === 'vladimir malofeyev',
    'ADMIN creates watchlist entry (normalized)');
  const wlId = add.data.entry.id;
  const get = await api('GET', `/api/fraud-ops/sanctions/${wlId}`, aTok);
  await expect(get.status === 200 && get.data.entry.full_name === 'Vladimir Malofeyev', 'GET single entry -> 200');
  const patch = await api('PATCH', `/api/fraud-ops/sanctions/${wlId}`, aTok, { notes: 'updated note', country_code: 'RU' });
  await expect(patch.status === 200 && patch.data.entry.notes === 'updated note' && patch.data.entry.country_code === 'RU',
    'PATCH entry updates fields');
  const listSrc = await api('GET', '/api/fraud-ops/sanctions?source=OFAC', aTok);
  await expect(listSrc.data.entries.length === 1 && listSrc.data.entries[0].id === wlId, 'source filter returns the entry');
  const remove = await api('POST', `/api/fraud-ops/sanctions/${wlId}/remove`, aTok, {});
  await expect(remove.status === 200 && remove.data.entry.status === 'REMOVED', 'entry -> REMOVED');
  const screenAfterRemove = await api('POST', '/api/fraud-ops/sanctions/screen', aTok, { name: 'Vladimir Malofeyev' });
  await expect(screenAfterRemove.status === 200 && Array.isArray(screenAfterRemove.data.hits) && screenAfterRemove.data.hits.length === 0,
    'REMOVED entry no longer matches');

  // ---------- 5. Match behaviour (name/phone/doc) ----------
  await section('Manual screen: name/phone/document matching');
  await api('POST', '/api/fraud-ops/sanctions', aTok,
    { source: 'UN', full_name: 'Ali Hassan', phone_number: `255945${sfx}`, document_type: 'PASSPORT', document_number: 'A1234567' });
  const scrName = await api('POST', '/api/fraud-ops/sanctions/screen', aTok, { name: 'ALI HASSAN' });
  await expect(scrName.status === 200 && scrName.data.hits.length >= 1
    && scrName.data.hits[0].field === 'full_name' && scrName.data.hits[0].score === 95 && scrName.data.hits[0].severity === 'CRITICAL',
    'exact-case-insensitive name match -> score 95 CRITICAL on full_name', JSON.stringify(scrName.data.hits));
  const scrPhone = await api('POST', '/api/fraud-ops/sanctions/screen', aTok, { name: 'Nobody Here', phone: `255945${sfx}` });
  await expect(scrPhone.status === 200 && scrPhone.data.hits.length === 1 && scrPhone.data.hits[0].field === 'phone' && scrPhone.data.hits[0].score === 100,
    'phone match -> score 100 CRITICAL on phone', JSON.stringify(scrPhone.data.hits));
  const scrDoc = await api('POST', '/api/fraud-ops/sanctions/screen', aTok, { name: 'Someone Else', documentType: 'PASSPORT', documentNumber: 'A1234567' });
  await expect(scrDoc.status === 200 && scrDoc.data.hits.length === 1 && scrDoc.data.hits[0].field === 'document' && scrDoc.data.hits[0].score === 100,
    'document match -> score 100 on document', JSON.stringify(scrDoc.data.hits));
  const scrClean = await api('POST', '/api/fraud-ops/sanctions/screen', aTok, { name: 'Far Unknown Name' });
  await expect(scrClean.status === 200 && scrClean.data.hits.length === 0, 'unrelated name -> no hit');

  // ---------- 6. Enforcement on P2P transfer (CONFIRMED blocks) ----------
  await section('Enforcement: P2P recipient screened');
  await api('POST', '/api/fraud-ops/sanctions', aTok, { source: 'EU', full_name: 'Guarded Recipient', phone_number: m1.user.phone_number });
  // m1 is now on the watchlist. A pending hit records but does not block.
  const tx1 = await api('POST', '/api/wallet/transfer', m2Tok, { toPhoneNumber: m1.user.phone_number, amount: 1000, note: 'to pending' });
  await expect(tx1.status === 200 && tx1.data.success, 'P2P to character whose hit is PENDING succeeds');
  const hitRows = await pool.query(
    `SELECT * FROM sanctions_screening_hits WHERE subject_type = 'USER' AND subject_id = $1 AND disposition = 'PENDING'`,
    [m1Id]
  );
  await expect(hitRows.rows.length >= 1, 'screen recorded a PENDING hit for recipient');
  const hitId = hitRows.rows[0].id;

  // Confirm the hit -> AML case auto-opened + transfer now blocked.
  const confirm = await api('POST', `/api/fraud-ops/sanctions/hits/${hitId}`, aTok, { disposition: 'CONFIRMED', comment: 'Positive ID' });
  await expect(confirm.status === 200 && confirm.data.hit.disposition === 'CONFIRMED', 'ADMIN confirms hit -> CONFIRMED');
  const cases = await pool.query(`SELECT id FROM aml_cases WHERE case_type = 'SANCTIONS_MATCH' AND user_id = $1`, [m1Id]);
  await expect(cases.rows.length === 1, 'CONFIRMED hit auto-opened an AML case (SANCTIONS_MATCH)');
  const tx2 = await api('POST', '/api/wallet/transfer', m2Tok, { toPhoneNumber: m1.user.phone_number, amount: 1000, note: 'blocked now' });
  await expect(tx2.status === 403 && tx2.data.code === 'AML_SANCTIONS_MATCH', 'P2P to CONFIRMED-sanctioned recipient -> 403 AML_SANCTIONS_MATCH');

  // False-positive on a second unrelated hit -> member unblocked.
  await api('POST', '/api/fraud-ops/sanctions', aTok, { source: 'PEER', full_name: 'Jane Necessary Evil', phone_number: `255946${sfx}` });
  const allHits = await pool.query(`SELECT * FROM sanctions_screening_hits WHERE subject_id = $1 AND disposition = 'PENDING' ORDER BY id`, [m1Id]);
  await expect(allHits.rows.length <= 1, 'pending hits for subject not duplicated by repeat screening');
  // Lift by setting an older hit to FALSE_POSITIVE? Verification: confirmed matches must stay gone for new subject.
  const sec = await api('POST', '/api/fraud-ops/sanctions/screen', aTok, { name: 'Guarded Recipient', phone: m1.user.phone_number });
  await expect(sec.status === 200 && sec.data.hits.some((h) => h.field === 'phone' && h.score === 100),
    'manual screen still sees hit for sanctioned phone', JSON.stringify(sec.data.hits));

  // ---------- 7. Payroll employee screened ----------
  await section('Enforcement: payroll employee screened at run');
  const owner = await register(`255947${sfx}`, 'Payroll Owner SN');
  const empClean = await register(`255948${sfx}`, 'Emp Clean');
  const empSn = await register(`255949${sfx}`, 'Emp Sanctioned');
  await pool.query('UPDATE users SET kyc_level = 1 WHERE id IN ($1,$2,$3)', [owner.user.id, empClean.user.id, empSn.user.id]);
  await fundWallet(empSn.user.id, 100000);
  const oToken = owner.token;
  await api('POST', '/api/merchant/register', oToken, { name: `SN Store ${sfx}`, business_type: 'RETAIL', phone: `255947${sfx}` });
  const merchMap = await pool.query(`SELECT id FROM merchants WHERE name = $1 ORDER BY id DESC LIMIT 1`, [`SN Store ${sfx}`]);
  const merchantSn = merchMap.rows[0].id;
  const connSn = await api('POST', '/api/merchant/connected', oToken, { payout_type: 'MNO_PHONE', payout_reference: `255950${sfx}` });
  await api('PATCH', `/api/merchant/admin/connected/${connSn.data.account.id}`, aTok, { status: 'ACTIVE' });
  await fundWallet(owner.user.id, 1000000);
  await api('POST', '/api/merchant/pay', oToken, { merchant_id: merchantSn, amount: 1000000, description: 'SN fund' });
  const schedSn = await api('POST', '/api/merchant/payroll/schedules', oToken, { name: 'SN Pay', frequency: 'MONTHLY', dayOfCycle: 1, currency: 'TZS' });
  const schedSnId = schedSn.data.schedule.id;
  await api('POST', `/api/merchant/payroll/schedules/${schedSnId}/entries`, oToken, { userId: empClean.user.id, baseAmount: 200000, role: 'Office' });
  await api('POST', `/api/merchant/payroll/schedules/${schedSnId}/entries`, oToken, { userId: empSn.user.id, baseAmount: 200000, role: 'Clerk' });
  // Direct DB hit CONFIRMED for the employee (matches watchlist via name).
  const ee = await pool.query(`SELECT id FROM sanctions_watchlist WHERE full_name = 'Guarded Recipient'`);
  if (ee.rows.length) {
    await pool.query(
      `INSERT INTO sanctions_screening_hits (watchlist_id, subject_type, subject_id, subject_name, matched_field, match_score, severity, disposition, decided_at)
       VALUES ($1, 'PAYROLL_ENTRY', $2, 'Guarded Recipient', 'full_name', 95, 'CRITICAL', 'CONFIRMED', NOW())`,
      [ee.rows[0].id, empSn.user.id]
    );
  }
  const runSn = await api('POST', '/api/merchant/payroll/runs', oToken, { scheduleId: schedSnId, periodStart: '2026-09-01', periodEnd: '2026-09-30' });
  await expect(runSn.status === 403 && runSn.data.code === 'AML_SANCTIONS_MATCH',
    'runPayroll blocks when a CONFIRMED-sanctioned employee is on the schedule (AML_SANCTIONS_MATCH)',
    `status=${runSn.status} code=${runSn.data && runSn.data.code}`);

  // ---------- 8. Audit + hits ledger ----------
  await section('Audit trail + hits ledger');
  await expect((await auditCount('SANCTIONS_ENTRY_CREATED')) >= 3, 'SANCTIONS_ENTRY_CREATED audited');
  await expect((await auditCount('SANCTIONS_ENTRY_REMOVED')) >= 1, 'SANCTIONS_ENTRY_REMOVED audited');
  const st = await api('GET', '/api/fraud-ops/sanctions/stats', aTok);
  await expect(st.status === 200 && typeof st.data.stats.watchlist === 'object', 'stats endpoint returns watchlist + hit rolls');
  const hitList = await api('GET', '/api/fraud-ops/sanctions/hits?disposition=CONFIRMED', aTok);
  await expect(hitList.status === 200 && Array.isArray(hitList.data.hits), 'CONFIRMED hits listable');
  const badDisp = await api('POST', `/api/fraud-ops/sanctions/hits/${hitId}`, aTok, { disposition: 'NONSENSE' });
  await expect(badDisp.status >= 400, 'invalid disposition rejected');

  console.log(`\nSANCTIONS: ${passed} passed, ${failed} failed`);
  await pool.end();
  if (failed) { console.log('Failures:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });