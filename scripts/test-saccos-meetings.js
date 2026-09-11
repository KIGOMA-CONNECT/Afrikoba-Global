/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - MEETINGS, ATTENDANCE
 * & MINUTES (increment 14, suite 58)
 *
 * Entity-scoped meeting lifecycle (migration 114) layered over
 * governance: DRAFT -> OPEN -> CLOSED -> MINUTES_PUBLISHED.
 * - OWNER/BOARD create meetings with structured agenda, open,
 *   mark any member's attendance, close (quorum = PRESENT+EXCUSED
 *   vs ACTIVE * quorum_pct/100) and publish minutes (agenda items
 *   marked complete).
 * - ACTIVE members list/view meetings and self check-in (PRESENT)
 *   while OPEN; check-in/marking are idempotent upserts.
 * - Cross-entity access 404/403; platform ADMIN without membership
 *   is treated as a non-member.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0, failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) { failed++; failures.push(label); console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET';
  const res = await fetch(BASE + path, { method, headers, body: !isGet && body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { data = {}; }
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
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }
const futureIso = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (114_saccos_meetings)');
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name IN ('saccos_meetings', 'saccos_meeting_agenda_items', 'saccos_meeting_attendance')`
  );
  await expect(new Set(tables.rows.map((r) => r.table_name)).size === 3,
    '3 meeting tables exist', JSON.stringify(tables.rows));
  const mcols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_meetings' AND column_name IN ('status', 'quorum_pct', 'quorum_met', 'minutes', 'published_at')`
  );
  await expect(mcols.rows.length === 5, 'saccos_meetings lifecycle + quorum columns present');
  const uq = await pool.query(
    `SELECT contype FROM pg_constraint WHERE conname = 'saccos_meeting_attendance_meeting_id_member_id_key'`
  );
  await expect(uq.rows.length === 1, 'attendance UNIQUE(meeting_id, member_id) exists');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + 3 members');
  const ownerReg = await register(phone(9901), 'Mkutano Mwenyekiti');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Mkutano Yetu ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    const mid = inv.data.result.id;
    await api('POST', `/api/saccos/${orgId}/members/${mid}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id, memberId: mid };
  }
  const m1 = await member(9902, 'Mkutano 1');
  const m2 = await member(9903, 'Mkutano 2');
  const m3 = await member(9904, 'Mkutano 3');

  // ---------- 3. Create meeting (OWNER/BOARD) ----------
  await section('Create: agenda + validation + RBAC');
  const rbacCreate = await api('POST', `/api/saccos/${orgId}/meetings`, m1.tok, { title: 'Haram' });
  await expect(rbacCreate.status === 403 && rbacCreate.data.code === 'SACCOS_RBAC', 'member create -> 403 RBAC');
  const noTitle = await api('POST', `/api/saccos/${orgId}/meetings`, ownerTok, { title: '   ' });
  await expect(noTitle.status === 400 && noTitle.data.code === 'SACCOS_MEETING_TITLE', 'empty title -> 400 TITLE');
  const badDate = await api('POST', `/api/saccos/${orgId}/meetings`, ownerTok, { title: 'X', scheduledAt: 'not-a-date' });
  await expect(badDate.status === 400 && badDate.data.code === 'SACCOS_MEETING_DATES', 'bad scheduledAt -> 400 DATES');
  const badQuorum = await api('POST', `/api/saccos/${orgId}/meetings`, ownerTok, { title: 'X', scheduledAt: futureIso(), quorumPct: 150 });
  await expect(badQuorum.status === 400 && badQuorum.data.code === 'SACCOS_MEETING_QUORUM', 'quorum 150 -> 400 QUORUM');

  const made = await api('POST', `/api/saccos/${orgId}/meetings`, ownerTok, {
    title: 'Mkutano Mkuu wa Wanachama',
    scheduledAt: futureIso(),
    location: 'SACCOS Office',
    agenda: [
      { title: 'Taarifa ya Mwenyekiti' },
      { title: 'Bajeti ya Mwaka', notes: 'kupitishwa' },
    ],
  });
  await expect(made.status === 201, 'owner creates meeting (201)');
  const mset = made.data.result.meeting;
  const items = made.data.result.agenda;
  await expect(mset.status === 'DRAFT' && mset.quorum_pct === 50 && items.length === 2
    && items[0].position === 1 && items[0].title === 'Taarifa ya Mwenyekiti',
    'meeting DRAFT, quorum 50%, 2 positioned agenda items', JSON.stringify(mset));
  const meetingId = mset.id;
  const itemA = items[0].id;
  const itemB = items[1].id;

  // ---------- 4. Open + check-in ----------
  await section('Open + member self check-in (idempotent)');
  const open = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/open`, ownerTok);
  await expect(open.status === 200 && open.data.result.status === 'OPEN', 'owner opens meeting -> OPEN');
  const mOpenMeet2 = await api('POST', `/api/saccos/${orgId}/meetings`, ownerTok, { title: 'Mkutano wa Pili', scheduledAt: futureIso() });
  const meet2Id = mOpenMeet2.data.result.meeting.id;
  const earlyCheckin = await api('POST', `/api/saccos/${orgId}/meetings/${meet2Id}/checkin`, m1.tok);
  await expect(earlyCheckin.status === 400 && earlyCheckin.data.code === 'SACCOS_MEETING_STATE', 'check-in on DRAFT meeting -> 400 STATE');

  const c1 = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/checkin`, m1.tok);
  await expect(c1.status === 200 && c1.data.result.member_id === m1.memberId && c1.data.result.status === 'PRESENT',
    'm1 self check-in -> PRESENT');
  const c1b = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/checkin`, m1.tok);
  const dupCount = await pool.query(
    `SELECT COUNT(*)::int AS c FROM saccos_meeting_attendance WHERE meeting_id = $1 AND member_id = $2`, [meetingId, m1.memberId]
  );
  await expect(c1b.status === 200 && dupCount.rows[0].c === 1, 'duplicate check-in stays single row (idempotent)');

  // ---------- 5. Board attendance marking ----------
  await section('Board marks attendance + validation');
  const badStatus = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/attendance`, ownerTok, { memberId: m2.memberId, status: 'LATE' });
  await expect(badStatus.status === 400 && badStatus.data.code === 'SACCOS_MEETING_ATTENDANCE_STATE', 'invalid status -> 400 ATTENDANCE_STATE');
  const badMember = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/attendance`, ownerTok, { memberId: 999999, status: 'EXCUSED' });
  await expect(badMember.status === 404 && badMember.data.code === 'SACCOS_MEMBER_NOT_FOUND', 'unknown member -> 404 MEMBER_NOT_FOUND');
  const markExc = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/attendance`, ownerTok, { memberId: m2.memberId, status: 'EXCUSED' });
  await expect(markExc.status === 200 && markExc.data.result.status === 'EXCUSED', 'owner marks m2 EXCUSED');
  const boardSelf = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/attendance`, m1.tok, { memberId: m3.memberId, status: 'PRESENT' });
  await expect(boardSelf.status === 403 && boardSelf.data.code === 'SACCOS_RBAC', 'member marking others -> 403 RBAC');
  const c2 = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/checkin`, m2.tok);
  await expect(c2.status === 200 && c2.data.result.status === 'PRESENT', 'm2 self check-in overrides EXCUSED (upsert)');
  const c3 = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/checkin`, m3.tok);
  await expect(c3.status === 200 && c3.data.result.status === 'PRESENT', 'm3 self check-in -> PRESENT');

  // ---------- 6. Close + quorum ----------
  await section('Close computes quorum (3 ACTIVE @ 50% -> need 2)');
  const open2 = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/open`, ownerTok);
  await expect(open2.status === 400 && open2.data.code === 'SACCOS_MEETING_STATE', 're-open OPEN meeting -> 400 STATE');
  const mClose = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/close`, m1.tok);
  await expect(mClose.status === 403 && mClose.data.code === 'SACCOS_RBAC', 'member close -> 403 RBAC');
  const close = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/close`, ownerTok);
  await expect(close.status === 200 && close.data.result.status === 'CLOSED' && close.data.result.required === 2
    && close.data.result.present === 3 && close.data.result.quorum_met === true,
    'meeting CLOSED, quorum required 2, present 3, met', JSON.stringify(close.data.result));

  // Empty meeting -> quorum NOT met
  const openE = await api('POST', `/api/saccos/${orgId}/meetings/${meet2Id}/open`, ownerTok);
  const closeE = await api('POST', `/api/saccos/${orgId}/meetings/${meet2Id}/close`, ownerTok);
  await expect(openE.status === 200 && closeE.status === 200 && closeE.data.result.quorum_met === false,
    'empty meeting closes with quorum NOT met');

  // ---------- 7. Publish minutes ----------
  await section('Publish minutes (CLOSED -> MINUTES_PUBLISHED)');
  const noMin = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/minutes`, ownerTok, { minutes: '  ' });
  await expect(noMin.status === 400 && noMin.data.code === 'SACCOS_MEETING_MINUTES_REQUIRED', 'empty minutes -> 400 MINUTES_REQUIRED');
  const mMin = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/minutes`, m1.tok, { minutes: 'Yote' });
  await expect(mMin.status === 403 && mMin.data.code === 'SACCOS_RBAC', 'member publish -> 403 RBAC');
  const pub = await api('POST', `/api/saccos/${orgId}/meetings/${meetingId}/minutes`, ownerTok, {
    minutes: 'Taarifa zilisomwa na kupitishwa. Bajeti ya mwaka imepitishwa.',
    agenda: [itemA],
  });
  await expect(pub.status === 200 && pub.data.result.status === 'MINUTES_PUBLISHED' && pub.data.result.published_at,
    'minutes published -> MINUTES_PUBLISHED + published_at');
  const agendaAfter = await pool.query(
    `SELECT id, is_complete FROM saccos_meeting_agenda_items WHERE meeting_id = $1 ORDER BY position`, [meetingId]
  );
  await expect(agendaAfter.rows[0].is_complete === true && agendaAfter.rows[1].is_complete === false,
    'agenda item 1 complete, item 2 not');

  // ---------- 8. Member visibility ----------
  await section('Member list + detail (roster + my status)');
  const list = await api('GET', `/api/saccos/${orgId}/meetings`, m1.tok);
  await expect(list.status === 200 && list.data.result.length === 2, 'member lists 2 meetings');
  const pubRow = list.data.result.find((r) => r.id === meetingId);
  await expect(pubRow.status === 'MINUTES_PUBLISHED' && pubRow.present_count === 3 && pubRow.my_status === 'PRESENT',
    'list row carries present_count + my_status', JSON.stringify(pubRow));
  const detail = await api('GET', `/api/saccos/${orgId}/meetings/${meetingId}`, m2.tok);
  await expect(detail.status === 200 && detail.data.result.agenda.length === 2
    && detail.data.result.attendance.length === 3
    && detail.data.result.attendance.every((a) => a.name && a.member_number)
    && detail.data.result.meeting.minutes.includes('Bajeti'),
    'detail: agenda, 3-name roster, minutes visible to member');
  const notFound = await api('GET', `/api/saccos/${orgId}/meetings/999999`, m1.tok);
  await expect(notFound.status === 404 && notFound.data.code === 'SACCOS_MEETING_NOT_FOUND', 'unknown meeting -> 404 NOT_FOUND');

  // ---------- 9. Summary + audit ----------
  await section('Owner summary + audit trail');
  const summ = await api('GET', `/api/saccos/${orgId}/meetings/summary`, ownerTok);
  await expect(summ.status === 200 && summ.data.result.total === 2 && summ.data.result.drafts === 0
    && summ.data.result.closed === 1 && summ.data.result.published === 1 && summ.data.result.open === 0,
    'summary: total 2 (1 closed, 1 published)', JSON.stringify(summ.data.result));
  const mSumm = await api('GET', `/api/saccos/${orgId}/meetings/summary`, m1.tok);
  await expect(mSumm.status === 403 && mSumm.data.code === 'SACCOS_RBAC', 'member summary -> 403 RBAC');
  const audit = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE action IN ('SACCOS_MEETING_CREATE', 'SACCOS_MEETING_OPEN', 'SACCOS_MEETING_ATTENDANCE', 'SACCOS_MEETING_CLOSE', 'SACCOS_MEETING_MINUTES')`
  );
  await expect(audit.rows.length === 5, 'all 5 meeting audit actions recorded', audit.rows.map((r) => r.action).join(','));

  // ---------- 10. Isolation + platform admin ----------
  await section('Cross-entity isolation + platform ADMIN');
  const s2Owner = await register(phone(9905), 'Mkutano Pili Org');
  const s2Tok = s2Owner.data.token;
  const org2 = await api('POST', '/api/v1/saccos', s2Tok, { name: 'Mkutano Pili Org ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);
  const crossList = await api('GET', `/api/saccos/${orgId}/meetings`, s2Tok);
  await expect(crossList.status === 404 && crossList.data.code === 'SACCOS_NOT_FOUND', 'S2 owner lists S1 meetings -> 404 NOT_FOUND');
  const crossDetail = await api('GET', `/api/saccos/${orgId}/meetings/${meetingId}`, s2Tok);
  await expect(crossDetail.status === 404 && crossDetail.data.code === 'SACCOS_NOT_FOUND', 'S2 owner detail -> 404 NOT_FOUND');
  const adminTok = await makeAdmin(await register(phone(9906), 'Ododo Mkutano'));
  const adminList = await api('GET', `/api/saccos/${orgId}/meetings`, adminTok);
  await expect(adminTok && adminList.status === 403 && adminList.data.code === 'SACCOS_NOT_MEMBER', 'platform ADMIN no membership -> 403 NOT_MEMBER');
  const adminCreate = await api('POST', `/api/saccos/${orgId}/meetings`, adminTok, { title: 'X', scheduledAt: futureIso() });
  await expect(adminCreate.status === 403 && adminCreate.data.code === 'SACCOS_NOT_MEMBER', 'platform ADMIN no membership create -> 403');

  console.log(`\nSACCOS MEETINGS: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });