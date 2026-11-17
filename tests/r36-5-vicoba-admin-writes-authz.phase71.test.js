#!/usr/bin/env node
'use strict';
/* R36 (owner finding) — VICOBA administrative writes that can create fines are leader-only.
 * Before R36: POST /groups/:g/schedules, POST /groups/:g/meetings, POST /meetings/:m/attendance and
 * POST /meetings/:m/attendance/bulk had no authorization; any authenticated VICOBA user (even a non-member)
 * could mark a member ABSENT and create a vicoba_penalties fine (fines are ENABLED in the pilot).
 *  [1] non-member (a leader of ANOTHER group): every endpoint -> 403 VICOBA_LEADER_REQUIRED, no DB change.
 *  [2] ordinary member (MJUMBE): every endpoint -> 403, no DB change; in particular marking another
 *      member ABSENT creates NO fine.
 *  [3] bulk by a non-leader writes nothing, not even the first row.
 *  [4] service level: recordAttendance / bulkRecordAttendance / scheduleMeeting without an actor -> 403.
 *  [5] positive control: each leader role (MWENYEKITI, MWEKAHAZINA, KATIBU) succeeds; ABSENT by a leader
 *      creates exactly one 5000.00 fine (proves [1]-[3] are not vacuous).
 */
const h = require('./r36-harness');
const { check, call, group, q1, attempt } = h;
const mk = require(h.path.join(h.ROOT, 'src/services/mkobaService'));

const TABLES = ['vicoba_contribution_schedules', 'vicoba_meetings', 'vicoba_meeting_attendance', 'vicoba_penalties', 'vicoba_members'];
async function snapA() {
  const out = {};
  for (const t of TABLES) { const r = await q1(`SELECT count(*)::int n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`); out[t] = `${r.n}:${r.h}`; }
  return out;
}
const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);
const leaderRefused = (r) => r.status === 403 && r.body && r.body.code === 'VICOBA_LEADER_REQUIRED';

(async () => {
  await h.listen(h.buildApp());
  const s = await group([['chair', 'MWENYEKITI'], ['treasurer', 'MWEKAHAZINA'], ['katibu', 'KATIBU'], ['member', 'MJUMBE'], ['victim', 'MJUMBE']]);
  const o = await group([['chair', 'MWENYEKITI']]);
  await h.pool.query('INSERT INTO vicoba_group_constitutions (group_id, fine_per_absence, fine_per_late_arrival) VALUES ($1, 5000, 2000)', [s.g]);
  const meeting = (await q1(`INSERT INTO vicoba_meetings (group_id, meeting_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [s.g])).id;
  const ENDPOINTS = (n) => [
    ['schedules', `/api/v1/vicoba/groups/${s.g}/schedules`, { cycleNumber: 50 + n, dueDate: '2027-01-15' }],
    ['meetings', `/api/v1/vicoba/groups/${s.g}/meetings`, { meetingDate: `2027-02-${String(10 + n).padStart(2, '0')}` }],
    ['attendance ABSENT', `/api/v1/vicoba/meetings/${meeting}/attendance`, { userId: s.victim.id, status: 'ABSENT' }],
    ['attendance bulk', `/api/v1/vicoba/meetings/${meeting}/attendance/bulk`, { attendance: [{ userId: s.victim.id, status: 'ABSENT' }, { userId: s.member.id, status: 'LATE' }] }],
  ];

  for (const [tag, who, n] of [['[1] non-member', o.chair, 1], ['[2] MJUMBE', s.member, 2]]) {
    console.log(`\n${tag}`);
    for (const [label, url, body] of ENDPOINTS(n)) {
      const before = await snapA();
      const r = await call('POST', url, who, body);
      const d = diff(before, await snapA());
      check(`${tag} POST ${label} -> 403 VICOBA_LEADER_REQUIRED, no DB change`, leaderRefused(r) && d.length === 0, { status: r.status, body: r.body, d });
    }
  }
  check('[2] no fine exists for the victim', Number((await q1('SELECT count(*) n FROM vicoba_penalties WHERE user_id=$1', [s.victim.id])).n) === 0);

  console.log('\n[3] bulk by a non-leader writes nothing');
  {
    const before = await snapA();
    const r = await attempt(() => mk.bulkRecordAttendance(meeting, [{ userId: s.victim.id, status: 'ABSENT' }], s.member.id));
    check('[3] bulkRecordAttendance(MJUMBE) -> 403, no row', !r.ok && r.code === 'VICOBA_LEADER_REQUIRED' && diff(before, await snapA()).length === 0, r);
  }

  console.log('\n[4] service level without an actor');
  for (const [name, fn] of [
    ['recordAttendance', () => mk.recordAttendance(meeting, s.victim.id, 'ABSENT')],
    ['bulkRecordAttendance', () => mk.bulkRecordAttendance(meeting, [{ userId: s.victim.id, status: 'ABSENT' }])],
    ['scheduleMeeting', () => mk.scheduleMeeting(s.g, '2027-03-01')],
  ]) {
    const before = await snapA();
    const r = await attempt(fn);
    check(`[4] ${name}() with no actor -> 403, no DB change`, !r.ok && r.status === 403 && r.code === 'VICOBA_LEADER_REQUIRED' && diff(before, await snapA()).length === 0, r);
  }

  console.log('\n[5] positive control: leaders');
  {
    const sc = await call('POST', `/api/v1/vicoba/groups/${s.g}/schedules`, s.treasurer, { cycleNumber: 90, dueDate: '2027-01-15' });
    check('[5] MWEKAHAZINA creates a schedule -> 201', sc.status === 201, sc.body);
    const mt = await call('POST', `/api/v1/vicoba/groups/${s.g}/meetings`, s.chair, { meetingDate: '2027-04-01' });
    check('[5] MWENYEKITI schedules a meeting -> 201', mt.status === 201, mt.body);
    const at = await call('POST', `/api/v1/vicoba/meetings/${meeting}/attendance`, s.katibu, { userId: s.victim.id, status: 'ABSENT' });
    const fines = (await h.pool.query('SELECT amount FROM vicoba_penalties WHERE user_id=$1', [s.victim.id])).rows;
    check('[5] KATIBU records ABSENT -> 200 and exactly one 5000.00 fine', at.status === 200 && fines.length === 1 && String(fines[0].amount) === '5000.00', { at: at.body, fines });
  }

  await h.finish('R36 (5) VICOBA administrative writes are leader-only');
})().catch(h.fatal);
