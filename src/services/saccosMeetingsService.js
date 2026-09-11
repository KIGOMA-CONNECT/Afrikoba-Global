/**
 * SACCOS Digital Core - Meetings, Attendance & Minutes (increment 14).
 * Entity-scoped meeting lifecycle on top of the governance module:
 *
 *   DRAFT -> OPEN -> CLOSED -> MINUTES_PUBLISHED
 *
 * - Agenda items are structured, positioned rows completed when the
 *   board publishes minutes.
 * - Attendance is per-member (UNIQUE(meeting_id, member_id)): members
 *   self check-in (PRESENT) while the meeting is OPEN; OWNER/BOARD can
 *   mark any member PRESENT/ABSENT/EXCUSED.
 * - Closing records quorum_met = (PRESENT + EXCUSED) >= ACTIVE members
 *   * quorum_pct / 100 (meeting's own quorum_pct, default 50).
 * All ACTIVE members can list/view meetings and check in; only
 * OWNER/BOARD create/open/close/publish. Cross-entity reads 404.
 */
const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const saccosCore = require('./saccosService');

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function fetchMeeting(saccosId, meetingId) {
  const r = await pool.query('SELECT * FROM saccos_meetings WHERE id = $1 AND saccos_id = $2', [meetingId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_MEETING_NOT_FOUND');
  return r.rows[0];
}

/** Create a meeting (DRAFT) with structured agenda. OWNER/BOARD only. */
async function createMeeting(actorId, saccosId, body) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const title = (body && body.title || '').trim();
  if (!title) throw createAppError('SACCOS_MEETING_TITLE');
  const scheduled = body.scheduledAt ? new Date(body.scheduledAt) : null;
  if (!scheduled || Number.isNaN(scheduled.getTime())) throw createAppError('SACCOS_MEETING_DATES');
  const quorumPct = body.quorumPct === undefined ? 50 : Number(body.quorumPct);
  if (!Number.isFinite(quorumPct) || quorumPct < 1 || quorumPct > 100) throw createAppError('SACCOS_MEETING_QUORUM');
  const agenda = Array.isArray(body.agenda) ? body.agenda.map((a) => ({
    title: String((a && a.title) || '').trim(),
    notes: a && a.notes ? String(a.notes) : null,
  })).filter((a) => a.title) : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const m = await client.query(
      `INSERT INTO saccos_meetings (saccos_id, title, scheduled_at, location, quorum_pct, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [saccosId, title, scheduled, body.location ? String(body.location) : null, quorumPct, actorId]
    );
    const items = [];
    for (let i = 0; i < agenda.length; i += 1) {
      const a = await client.query(
        `INSERT INTO saccos_meeting_agenda_items (meeting_id, position, title, notes)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [m.rows[0].id, i + 1, agenda[i].title, agenda[i].notes]
      );
      items.push(a.rows[0]);
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_MEETING_CREATE', {
      referenceId: saccosId,
      details: { meetingId: m.rows[0].id, title, scheduled: scheduled.toISOString(), agenda: items.length },
    }).catch(() => {});
    return { meeting: m.rows[0], agenda: items };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** DRAFT -> OPEN. OWNER/BOARD only. */
async function openMeeting(actorId, saccosId, meetingId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const meeting = await fetchMeeting(saccosId, meetingId);
  if (meeting.status !== 'DRAFT') throw createAppError('SACCOS_MEETING_STATE');
  await pool.query(`UPDATE saccos_meetings SET status = 'OPEN', updated_at = NOW() WHERE id = $1`, [meetingId]);
  await logAudit(actorId, 'SACCOS_MEETING_OPEN', { referenceId: saccosId, details: { meetingId } }).catch(() => {});
  return { meetingId, status: 'OPEN' };
}

/** Member self check-in (PRESENT). Requires an OPEN meeting. */
async function checkIn(actorId, saccosId, meetingId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const meeting = await fetchMeeting(saccosId, meetingId);
  if (meeting.status !== 'OPEN') throw createAppError('SACCOS_MEETING_STATE');
  const r = await pool.query(
    `INSERT INTO saccos_meeting_attendance (meeting_id, member_id, status, marked_by)
     VALUES ($1, $2, 'PRESENT', $3)
     ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = 'PRESENT', marked_by = $3
     RETURNING id, member_id, status`,
    [meetingId, membership.id, actorId]
  );
  await logAudit(actorId, 'SACCOS_MEETING_ATTENDANCE', {
    referenceId: saccosId,
    details: { meetingId, memberId: membership.id, status: 'PRESENT' },
  }).catch(() => {});
  return r.rows[0];
}

/** Board marks attendance for any member. OWNER/BOARD only. */
async function markAttendance(actorId, saccosId, meetingId, memberId, statusN) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const meeting = await fetchMeeting(saccosId, meetingId);
  if (meeting.status !== 'OPEN') throw createAppError('SACCOS_MEETING_STATE');
  if (!['PRESENT', 'ABSENT', 'EXCUSED'].includes(statusN)) throw createAppError('SACCOS_MEETING_ATTENDANCE_STATE');
  const member = await pool.query('SELECT id FROM saccos_members WHERE id = $1 AND saccos_id = $2', [memberId, saccosId]);
  if (!member.rows.length) throw createAppError('SACCOS_MEMBER_NOT_FOUND');
  const r = await pool.query(
    `INSERT INTO saccos_meeting_attendance (meeting_id, member_id, status, marked_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = $3, marked_by = $4
     RETURNING id, member_id, status`,
    [meetingId, memberId, statusN, actorId]
  );
  await logAudit(actorId, 'SACCOS_MEETING_ATTENDANCE', {
    referenceId: saccosId,
    details: { meetingId, memberId, status: statusN },
  }).catch(() => {});
  return r.rows[0];
}

/** OPEN -> CLOSED and record quorum_met. OWNER/BOARD only. */
async function closeMeeting(actorId, saccosId, meetingId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const meeting = await fetchMeeting(saccosId, meetingId);
  if (meeting.status !== 'OPEN') throw createAppError('SACCOS_MEETING_STATE');
  const active = await pool.query(
    `SELECT COUNT(*)::int AS c FROM saccos_members WHERE saccos_id = $1 AND status = 'ACTIVE'`, [saccosId]
  );
  const present = await pool.query(
    `SELECT COUNT(*)::int AS c FROM saccos_meeting_attendance WHERE meeting_id = $1 AND status IN ('PRESENT', 'EXCUSED')`, [meetingId]
  );
  const activeCount = active.rows[0].c;
  const presentCount = present.rows[0].c;
  const quorum = activeCount > 0 ? Math.ceil((activeCount * meeting.quorum_pct) / 100) : 0;
  const quorumMet = presentCount >= quorum;
  await pool.query(
    `UPDATE saccos_meetings SET status = 'CLOSED', quorum_met = $1, updated_at = NOW() WHERE id = $2`,
    [quorumMet, meetingId]
  );
  await logAudit(actorId, 'SACCOS_MEETING_CLOSE', {
    referenceId: saccosId,
    details: { meetingId, active: activeCount, present: presentCount, required: quorum, quorumMet },
  }).catch(() => {});
  return { meetingId, status: 'CLOSED', active: activeCount, present: presentCount, required: quorum, quorum_met: quorumMet };
}

/** CLOSED -> MINUTES_PUBLISHED with agenda completion. OWNER/BOARD only. */
async function publishMinutes(actorId, saccosId, meetingId, body) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const meeting = await fetchMeeting(saccosId, meetingId);
  if (meeting.status !== 'CLOSED') throw createAppError('SACCOS_MEETING_STATE');
  const minutes = (body && body.minutes || '').trim();
  if (!minutes) throw createAppError('SACCOS_MEETING_MINUTES_REQUIRED');
  const completed = new Set(Array.isArray(body.agenda) ? body.agenda.map(Number).filter(Number.isFinite) : []);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (completed.size) {
      await client.query(
        `UPDATE saccos_meeting_agenda_items SET is_complete = (id = ANY($1)) WHERE meeting_id = $2`,
        [[...completed], meetingId]
      );
    }
    const m = await client.query(
      `UPDATE saccos_meetings SET status = 'MINUTES_PUBLISHED', minutes = $1, published_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [minutes, meetingId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_MEETING_MINUTES', { referenceId: saccosId, details: { meetingId } }).catch(() => {});
    return m.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** All ACTIVE members may list meetings with my attendance + counts. */
async function listMeetings(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT m.*,
            (SELECT COUNT(*)::int FROM saccos_meeting_attendance a WHERE a.meeting_id = m.id AND a.status = 'PRESENT') AS present_count,
            (SELECT status FROM saccos_meeting_attendance a WHERE a.meeting_id = m.id AND a.member_id = $2) AS my_status
     FROM saccos_meetings m WHERE m.saccos_id = $1 ORDER BY m.scheduled_at DESC`,
    [saccosId, membership.id]
  );
  return r.rows;
}

/** Member may view a meeting with agenda + attendance roster. */
async function meetingDetail(actorId, saccosId, meetingId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const meeting = await fetchMeeting(saccosId, meetingId);
  const agenda = await pool.query(
    `SELECT id, position, title, notes, is_complete FROM saccos_meeting_agenda_items WHERE meeting_id = $1 ORDER BY position`,
    [meetingId]
  );
  const attendance = await pool.query(
    `SELECT a.member_id, mem.member_number, u.full_name AS name, a.status,
            (a.member_id = $2) AS is_me
     FROM saccos_meeting_attendance a
     JOIN saccos_members mem ON mem.id = a.member_id
     JOIN users u ON u.id = mem.user_id
     WHERE a.meeting_id = $1 ORDER BY u.full_name`,
    [meetingId, membership.id]
  );
  return { meeting, agenda: agenda.rows, attendance: attendance.rows };
}

/** Meeting health per SACCOS. OWNER/BOARD only. */
async function meetingsSummary(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'DRAFT')::int AS drafts,
            COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
            COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
            COUNT(*) FILTER (WHERE status = 'MINUTES_PUBLISHED')::int AS published,
            MIN(scheduled_at) FILTER (WHERE status IN ('DRAFT', 'OPEN')) AS next
     FROM saccos_meetings WHERE saccos_id = $1`,
    [saccosId]
  );
  return r.rows[0];
}

module.exports = {
  createMeeting,
  openMeeting,
  checkIn,
  markAttendance,
  closeMeeting,
  publishMinutes,
  listMeetings,
  meetingDetail,
  meetingsSummary,
  fetchMeeting,
};