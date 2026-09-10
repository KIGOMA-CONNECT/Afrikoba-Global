/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - FOUNDATION
 * Increment 1 regression: organization registration
 * (config-driven, unique code/name, founder OWNER "0001"),
 * compliance boundary (TECH_INFRA default), membership
 * lifecycle (invite by existing identity phone / accept /
 * suspend / exit), RBAC (OWNER/BOARD/MEMBER) and cross-entity
 * isolation (non-member 404, no enumeration, admin oversight).
 * Covers /api/saccos + /api/v1/saccos when SACCOS_ENABLED=true.
 * Suite 45.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const crypto = require('crypto');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++; failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label); else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method, headers,
    body: !isGet && body !== undefined ? JSON.stringify(body) : undefined,
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
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg, depth = 0) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (depth < 1) {
    const backup = await register('255699' + nowSuffix(), 'Saccos Admin Backup');
    return makeAdmin(backup, depth + 1);
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (101_saccos_foundation)');
  const saccosCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos'`);
  await expect(saccosCols.rows.length >= 9, 'saccos table has core columns', 'got ' + saccosCols.rows.length);
  const configHas = saccosCols.rows.some((c) => c.column_name === 'config') 
    && saccosCols.rows.some((c) => c.column_name === 'code')
    && saccosCols.rows.some((c) => c.column_name === 'status');
  await expect(configHas, 'saccos exposes code/status/config (config-driven setup)');

  const compCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_compliance'`);
  const compOk = compCols.rows.some((c) => c.column_name === 'regulatory_status')
    && compCols.rows.some((c) => c.column_name === 'legal_entity')
    && compCols.rows.some((c) => c.column_name === 'product_restrictions');
  await expect(compOk, 'saccos_compliance has boundary fields (regulatory_status/product_restrictions)');

  const memCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_members'`);
  const memOk = ['saccos_id', 'user_id', 'role', 'member_number', 'status', 'admission_date']
    .every((c) => memCols.rows.some((r) => r.column_name === c));
  await expect(memOk, 'saccos_members has membership lifecycle columns');

  const memIdx = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'saccos_members'`);
  const hasUnique = memIdx.rows.filter((i) => /UNIQUE/i.test(i.indexdef)).length >= 2;
  await expect(hasUnique, 'saccos_members has >=2 unique indexes (member_number, user per saccos)', JSON.stringify(memIdx.rows));

  const flag = await pool.query(`SELECT enabled FROM feature_flags WHERE flag_key = 'SACCOS_ENABLED'`);
  await expect(flag.rows.length === 1 && flag.rows[0].enabled === false, 'SACCOS_ENABLED feature flag seeded, disabled by default');

  // ---------- 2. Anonymous guard ----------
  await section('Auth guard');
  const anon = await api('GET', '/api/saccos');
  await expect(anon.status === 401 && anon.data.success === false, 'anonymous GET /saccos -> 401', `${anon.status}`);

  // ---------- 3. Organization registration ----------
  await section('Organization registration');
  const ownerReg = await register(phone(1001), 'Saccos Haya');
  const ownerTok = ownerReg.data.token;
  const orgName = 'Wanachi Savings ' + suffix;
  const create = await api('POST', '/api/v1/saccos', ownerTok, {
    name: orgName, registrationNumber: 'TZ-REG-88', countryCode: 'TZ', legalEntity: 'Cooperative Society', config: { membershipMin: 1 },
  });
  await expect(create.status === 201 && create.data.success, 'owner creates SACCOS (org + founder)', `${create.status}/${create.data.code || ''}`);
  const orgId = create.data.result.saccos.id;
  const founderMemberId = create.data.result.membership.id;
  await expect(String(create.data.result.saccos.code).startsWith('SAC-'), 'generated unique code SAC-*', create.data.result.saccos.code);
  await expect(create.data.result.saccos.status === 'DRAFT', 'org saved as DRAFT');
  await expect(create.data.result.membership.role === 'OWNER' && create.data.result.membership.status === 'ACTIVE'
    && create.data.result.membership.member_number === '0001', 'founder membership OWNER/ACTIVE "0001"',
    JSON.stringify(create.data.result.membership));

  const dup = await api('POST', '/api/saccos', ownerTok, { name: orgName });
  await expect(dup.status === 409 && dup.data.code === 'SACCOS_NAME_TAKEN', 'duplicate name -> 409 SACCOS_NAME_TAKEN');

  const mine = await api('GET', '/api/saccos', ownerTok);
  await expect(mine.status === 200 && mine.data.result.length === 1 && mine.data.result[0].membership_role === 'OWNER',
    'owner lists exactly 1 SACCOS', `len=${mine.data.result && mine.data.result.length}`);

  const comp = await api('GET', `/api/saccos/${orgId}/compliance`, ownerTok);
  await expect(comp.status === 200 && comp.data.result.regulatory_status === 'TECH_INFRA' && comp.data.result.legal_entity === 'Cooperative Society',
    'compliance boundary row seeded (TECH_INFRA, legal_entity)');

  // ---------- 4. Membership lifecycle ----------
  await section('Membership lifecycle');
  const invitee = await register(phone(1002), 'S Kaduda');
  const inviteeTok = invitee.data.token;
  const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(1002) });
  await expect(inv.status === 201 && inv.data.success && inv.data.result.status === 'INVITED'
    && inv.data.result.member_number === '0002' && inv.data.result.role === 'MEMBER', 'owner invites member by phone -> 0002 INVITED', JSON.stringify(inv.data.result));

  const missing = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(9999) });
  await expect(missing.status === 404 && missing.data.code === 'SACCOS_PHONE_NOT_FOUND', 'unknown phone -> 404 SACCOS_PHONE_NOT_FOUND');

  const again = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(1002) });
  await expect(again.status === 409 && again.data.code === 'SACCOS_ALREADY_MEMBER', 'duplicate invite -> 409 SACCOS_ALREADY_MEMBER');

  const outsider = await register(phone(1003), 'C Kando');
  const outsiderTok = outsider.data.token;
  const peep = await api('GET', `/api/saccos/${orgId}`, outsiderTok);
  await expect(peep.status === 404 && peep.data.code === 'SACCOS_NOT_FOUND', 'non-member reads SACCOS -> 404 (isolation, no enumeration)');

  const accept = await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, inviteeTok);
  await expect(accept.status === 200 && accept.data.result.status === 'ACTIVE' && accept.data.result.admission_date,
    'invitee accepts -> ACTIVE + admission_date', JSON.stringify(accept.data.result));

  const steal = await api('POST', `/api/saccos/${orgId}/members/${founderMemberId}/accept`, outsiderTok);
  await expect(steal.status === 403 && steal.data.code === 'SACCOS_MEMBER_FORBIDDEN', 'cannot accept someone elses membership -> 403', `${steal.status}/${steal.data.code || ''}`);

  const membersList = await api('GET', `/api/saccos/${orgId}/members`, ownerTok);
  const row2 = membersList.data.result.find((m) => m.member_number === '0002');
  await expect(membersList.status === 200 && membersList.data.result.length === 2 && row2 && row2.full_name === 'S Kaduda' && row2.phone_number === phone(1002),
    'owner lists members (2) with identity data');

  const memberList = await api('GET', `/api/saccos/${orgId}/members`, inviteeTok);
  await expect(memberList.status === 403 && memberList.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot list members -> 403');

  const badInvite = await api('POST', `/api/saccos/${orgId}/members`, inviteeTok, { phoneNumber: phone(1003) });
  await expect(badInvite.status === 403 && badInvite.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot invite -> 403');

  // ---------- 5. Board role + governance RBAC ----------
  await section('Governance RBAC');
  const boardReg = await register(phone(1004), 'D Bodi');
  const boardTok = boardReg.data.token;
  const boardInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(1004), role: 'BOARD' });
  await expect(boardInv.status === 201 && boardInv.data.result.role === 'BOARD', 'owner invites BOARD member');
  await api('POST', `/api/saccos/${orgId}/members/${boardInv.data.result.id}/accept`, boardTok);
  await register(phone(1005), 'E Mwanachama');
  const boardInvites = await api('POST', `/api/saccos/${orgId}/members`, boardTok, { phoneNumber: phone(1005) });
  await expect(boardInvites.status === 201 && boardInvites.data.result.role === 'MEMBER', 'BOARD can invite members');
  const boardActivate = await api('POST', `/api/saccos/${orgId}/activate`, boardTok);
  await expect(boardActivate.status === 403 && boardActivate.data.code === 'SACCOS_RBAC', 'BOARD cannot activate org (OWNER only)');

  const activate = await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  await expect(activate.status === 200 && activate.data.result.status === 'ACTIVE', 'owner activates org -> ACTIVE');

  const eInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(1005), role: 'BOARD' });
  await expect(eInv.status >= 409, 'BOARD upsert of existing phone conflicts (only EXITED re-invitable)', `${eInv.status}/${eInv.data.code || ''}`);

  // ---------- 6. Suspension / exit ----------
  await section('Suspension and exit');
  const susp = await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/suspend`, ownerTok);
  await expect(susp.status === 200 && susp.data.result.status === 'SUSPENDED', 'owner suspends member');

  const suspByMember = await api('POST', `/api/saccos/${orgId}/members/${boardInv.data.result.id}/suspend`, boardTok);
  await expect(suspByMember.status === 403 && suspByMember.data.code === 'SACCOS_RBAC', 'BOARD cannot suspend (OWNER only)');

  const cComp = await api('GET', `/api/saccos/${orgId}/compliance`, outsiderTok);
  await expect(cComp.status === 404, 'non-member compliance read -> 404');

  const bComp = await api('GET', `/api/saccos/${orgId}/compliance`, boardTok);
  await expect(bComp.status === 200, 'BOARD can read compliance');

  // ---------- 7. Exit + re-invite ----------
  await section('Exit and re-invite');
  const exitReg = await register(phone(1006), 'F Toka');
  const exitTok = exitReg.data.token;
  const fInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(1006) });
  await api('POST', `/api/saccos/${orgId}/members/${fInv.data.result.id}/accept`, exitTok);
  const exit = await api('POST', `/api/saccos/${orgId}/members/${fInv.data.result.id}/exit`, exitTok);
  await expect(exit.status === 200 && exit.data.result.status === 'EXITED', 'member exits self -> EXITED');

  const fMine = await api('GET', '/api/saccos', exitTok);
  await expect(fMine.status === 200 && fMine.data.result.length === 0, 'exited member no longer lists org');

  const reInv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(1006) });
  await expect(reInv.status === 201 && reInv.data.result.status === 'INVITED' && reInv.data.result.member_number === fInv.data.result.member_number,
    'exited member can be re-invited on same member_number', `${reInv.status}/${reInv.data.code || ''}`);

  const missingMember = await api('POST', `/api/saccos/${orgId}/members/999999/accept`, inviteeTok);
  await expect(missingMember.status === 404 && missingMember.data.code === 'SACCOS_MEMBER_NOT_FOUND', 'accept unknown member -> 404 SACCOS_MEMBER_NOT_FOUND');

  // ---------- 8. Cross-entity isolation (S2 by outsider) ----------
  await section('Cross-entity isolation');
  const s2 = await api('POST', '/api/v1/saccos', outsiderTok, { name: 'Vijijini Savings ' + suffix });
  const s2Id = s2.data.result.saccos.id;
  const ownerFromS1 = await api('GET', `/api/saccos/${s2Id}`, ownerTok);
  await expect(ownerFromS1.status === 404, 'S1 member cannot see S2 org -> 404');
  const s2CompFromS1 = await api('GET', `/api/saccos/${s2Id}/compliance`, ownerTok);
  await expect(s2CompFromS1.status === 404, 'S1 member cannot read S2 compliance -> 404');

  // ---------- 9. Platform ADMIN oversight ----------
  await section('Platform ADMIN oversight');
  const adminTok = await makeAdmin(await register(phone(1007), 'O Oversight'));
  const adminList = await api('GET', `/api/saccos/${orgId}/members`, adminTok);
  await expect(adminTok && adminList.status === 200 && adminList.data.result.length >= 2, 'platform ADMIN can cross-read members', `${adminList.status}`);

  console.log(`\nSACCOS FOUNDATION: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });