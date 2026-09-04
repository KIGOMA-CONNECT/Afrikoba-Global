/**
 * Afrikoba Digital Group Governance & Collaboration Engine
 * Meeting → discussion → decision → resolution → responsibility → execution → audit trail.
 * Includes AI Secretary for transcription, minutes generation, and decision extraction.
 *
 * Applicable beyond VICOBA: cooperatives, SACCOs, associations, alumni groups,
 * workplace groups, investment clubs, business partnerships, community organizations.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

// ============ MEETINGS ============

async function createMeeting({ groupType, groupId, title, description, scheduledAt, channel, meetingFormat, recordingConsent, userId }) {
  const res = await pool.query(
    `INSERT INTO governance_meetings
       (group_type, group_id, title, description, scheduled_at, channel, meeting_format, recording_consent, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [groupType || 'VICOBA', groupId, title, description || null, scheduledAt, channel || 'MEETING', meetingFormat || 'VIDEO', !!recordingConsent, userId]
  );
  const meeting = res.rows[0];

  // Auto-invite members based on group type
  const memberRows = await pool.query(
    `SELECT m.user_id FROM vicoba_members m WHERE m.group_id = $1`,
    [groupId]
  ).catch(() => ({ rows: [] }));

  for (const m of memberRows.rows) {
    await pool.query(
      `INSERT INTO governance_attendees (meeting_id, user_id, status)
       VALUES ($1, $2, $3) ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [meeting.id, m.user_id, m.user_id === userId ? 'ACCEPTED' : 'INVITED']
    );
  }

  return { success: true, meeting };
}

async function updateMeetingStatus(meetingId, status) {
  const res = await pool.query(
    `UPDATE governance_meetings SET status = $2, end_at = CASE WHEN $2='COMPLETED' THEN NOW() ELSE end_at END WHERE id = $1 RETURNING *`,
    [meetingId, status]
  );
  return res.rows[0];
}

async function listMeetings(groupType, groupId, status) {
  const params = [groupType || 'VICOBA', groupId];
  let where = 'WHERE group_type = $1 AND group_id = $2';
  if (status && status !== 'ALL') {
    params.push(status);
    where += ` AND status = $${params.length}`;
  }
  const res = await pool.query(
    `SELECT m.*,
            (SELECT COUNT(*)::int FROM governance_attendees a WHERE a.meeting_id = m.id AND a.status = 'ATTENDED') AS attended_count,
            (SELECT COUNT(*)::int FROM governance_attendees a WHERE a.meeting_id = m.id) AS total_count
     FROM governance_meetings m ${where} ORDER BY m.scheduled_at DESC`,
    params
  );
  return res.rows;
}

async function getMeetingDetails(meetingId) {
  const meeting = (await pool.query('SELECT * FROM governance_meetings WHERE id = $1', [meetingId])).rows[0];
  if (!meeting) return null;
  const [attendees, agenda, proposals, minutes, transcript] = await Promise.all([
    pool.query('SELECT * FROM governance_attendees WHERE meeting_id = $1', [meetingId]),
    pool.query('SELECT * FROM governance_agenda_items WHERE meeting_id = $1 ORDER BY position', [meetingId]),
    pool.query('SELECT * FROM governance_proposals WHERE meeting_id = $1', [meetingId]),
    pool.query('SELECT * FROM governance_minutes WHERE meeting_id = $1 ORDER BY created_at DESC', [meetingId]),
    pool.query('SELECT * FROM governance_transcripts WHERE meeting_id = $1', [meetingId]),
  ]);
  return { meeting, attendees: attendees.rows, agenda: agenda.rows, proposals: proposals.rows, minutes: minutes.rows, transcript: transcript.rows[0] || null };
}

// ============ ATTENDANCE ============

async function respondAttendance(meetingId, userId, status) {
  const res = await pool.query(
    `INSERT INTO governance_attendees (meeting_id, user_id, status, response_at)
     VALUES ($1,$2,$3, NOW())
     ON CONFLICT (meeting_id, user_id) DO UPDATE SET status = EXCLUDED.status, response_at = NOW()
     RETURNING *`,
    [meetingId, userId, status]
  );
  return res.rows[0];
}

async function markAttended(meetingId, userId) {
  const res = await pool.query(
    `UPDATE governance_attendees SET status='ATTENDED', attended_at=NOW() WHERE meeting_id=$1 AND user_id=$2 RETURNING *`,
    [meetingId, userId]
  );
  return res.rows[0] || { status: 'ATTENDED' };
}

// ============ AGENDA ============

async function addAgendaItem(meetingId, { position, title, description }) {
  const res = await pool.query(
    `INSERT INTO governance_agenda_items (meeting_id, position, title, description)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [meetingId, position || 1, title, description || null]
  );
  return res.rows[0];
}

// ============ CHANNELS & CHAT ============

async function getOrCreateChannel(groupType, groupId, name) {
  const existing = await pool.query(
    `SELECT * FROM governance_channels WHERE group_type=$1 AND group_id=$2 AND name=$3`,
    [groupType, groupId, name]
  );
  if (existing.rows[0]) return existing.rows[0];
  const res = await pool.query(
    `INSERT INTO governance_channels (group_type, group_id, name) VALUES ($1,$2,$3) RETURNING *`,
    [groupType, groupId, name]
  );
  return res.rows[0];
}

const DEFAULT_CHANNELS = ['General', 'Finance', 'Loans', 'Investment', 'Social Fund', 'Project', 'Announcements', 'Meeting'];

async function ensureDefaultChannels(groupType, groupId) {
  for (const name of DEFAULT_CHANNELS) {
    await getOrCreateChannel(groupType, groupId, name);
  }
  return pool.query(`SELECT * FROM governance_channels WHERE group_type=$1 AND group_id=$2 ORDER BY name`, [groupType, groupId]);
}

async function postChatMessage(channelId, userId, body) {
  const res = await pool.query(
    `INSERT INTO governance_chat_messages (channel_id, user_id, body) VALUES ($1,$2,$3) RETURNING *`,
    [channelId, userId, body]
  );
  return res.rows[0];
}

async function getChannelMessages(channelId, limit = 100) {
  const res = await pool.query(
    `SELECT m.*, u.full_name FROM governance_chat_messages m JOIN users u ON m.user_id=u.id
     WHERE m.channel_id = $1 ORDER BY m.created_at DESC LIMIT $2`,
    [channelId, limit]
  );
  return res.rows.reverse();
}

async function searchKnowledge(groupType, groupId, query) {
  // Searchable institutional memory across chat, minutes, resolutions, documents
  const pattern = `%${query}%`;
  const [chat, minutes, resolutions, docs] = await Promise.all([
    pool.query(
      `SELECT 'CHAT' AS source, gc.name AS channel, m.body, m.created_at FROM governance_chat_messages m
         JOIN governance_channels gc ON m.channel_id = gc.id
       WHERE gc.group_type=$1 AND gc.group_id=$2 AND m.body ILIKE $3 ORDER BY m.created_at DESC LIMIT 10`,
      [groupType, groupId, pattern]
    ),
    pool.query(
      `SELECT 'MINUTES' AS source, gm.meeting_id, (gm.official#>>'{summary}') AS body, gm.created_at
       FROM governance_minutes gm JOIN governance_meetings mt ON mt.id=gm.meeting_id
       WHERE mt.group_type=$1 AND mt.group_id=$2 AND gm.official::text ILIKE $3 ORDER BY gm.created_at DESC LIMIT 10`,
      [groupType, groupId, pattern]
    ),
    pool.query(
      `SELECT 'RESOLUTION' AS source, r.id, r.title, r.body, r.passed_at
       FROM governance_resolutions r
       WHERE r.group_type=$1 AND r.group_id=$2 AND (r.title ILIKE $3 OR r.body ILIKE $3) AND r.is_latest
       ORDER BY r.passed_at DESC LIMIT 10`,
      [groupType, groupId, pattern]
    ),
    pool.query(
      `SELECT 'DOCUMENT' AS source, d.doc_category, d.title, d.body, d.created_at
       FROM governance_documents d
       WHERE d.group_type=$1 AND d.group_id=$2 AND (d.title ILIKE $3 OR d.body ILIKE $3)
       ORDER BY d.created_at DESC LIMIT 10`,
      [groupType, groupId, pattern]
    ),
  ]);
  return { chat: chat.rows, minutes: minutes.rows, resolutions: resolutions.rows, documents: docs.rows };
}

// ============ DOCUMENTS (Knowledge Vault) ============

async function addDocument({ groupType, groupId, docCategory, title, body, filePath, accessLevel, userId }) {
  const res = await pool.query(
    `INSERT INTO governance_documents (group_type, group_id, doc_category, title, body, file_path, access_level, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [groupType || 'VICOBA', groupId, docCategory, title, body || null, filePath || null, accessLevel || 'MEMBERS', userId]
  );
  return res.rows[0];
}

async function listDocuments(groupType, groupId, docCategory) {
  let query = `SELECT * FROM governance_documents WHERE group_type=$1 AND group_id=$2`;
  const params = [groupType || 'VICOBA', groupId];
  if (docCategory) { params.push(docCategory); query += ` AND doc_category=$${params.length}`; }
  query += ` ORDER BY created_at DESC`;
  const res = await pool.query(query, params);
  return res.rows;
}

// ============ CONSTITUTION / RULES ============

async function setConstitution(groupType, groupId, rules) {
  const current = await pool.query(
    `SELECT id FROM governance_constitutions WHERE group_type=$1 AND group_id=$2 AND latest=TRUE`,
    [groupType || 'VICOBA', groupId]
  );
  if (current.rows[0]) {
    await pool.query(`UPDATE governance_constitutions SET latest=FALSE WHERE id=$1`, [current.rows[0].id]);
  }
  const prev = await pool.query(
    `SELECT MAX(version)::int AS v FROM governance_constitutions WHERE group_type=$1 AND group_id=$2`,
    [groupType || 'VICOBA', groupId]
  );
  const version = (prev.rows[0]?.v || 0) + 1;
  const res = await pool.query(
    `INSERT INTO governance_constitutions (group_type, group_id, rules, version)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [groupType || 'VICOBA', groupId, JSON.stringify(rules), version]
  );
  return res.rows[0];
}

async function getConstitution(groupType, groupId) {
  const res = await pool.query(
    `SELECT * FROM governance_constitutions WHERE group_type=$1 AND group_id=$2 AND latest=TRUE`,
    [groupType || 'VICOBA', groupId]
  );
  return res.rows[0] || null;
}

// ============ PROPOSALS & VOTING ============

async function createProposal({ meetingId, groupType, groupId, title, description, userId }) {
  const res = await pool.query(
    `INSERT INTO governance_proposals (meeting_id, group_type, group_id, title, description, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [meetingId || null, groupType || 'VICOBA', groupId, title, description || null, userId]
  );
  return res.rows[0];
}

async function castVote(proposalId, userId, choice) {
  if (!['YES', 'NO', 'ABSTAIN'].includes(choice)) {
    throw Object.assign(new Error('Chaguo si sahihi. Tumia YES, NO au ABSTAIN.'), { statusCode: 400 });
  }
  await pool.query(
    `INSERT INTO governance_votes (proposal_id, user_id, choice)
     VALUES ($1,$2,$3) ON CONFLICT (proposal_id, user_id) DO UPDATE SET choice=EXCLUDED.choice, voted_at=NOW()`,
    [proposalId, userId, choice]
  );
  return getProposalResult(proposalId);
}

async function getProposalResult(proposalId) {
  const votes = await pool.query(
    `SELECT choice, COUNT(*)::int FROM governance_votes WHERE proposal_id=$1 GROUP BY choice`,
    [proposalId]
  );
  const tally = { YES: 0, NO: 0, ABSTAIN: 0 };
  votes.rows.forEach((r) => (tally[r.choice] = r.count));
  return { proposalId, tally };
}

// ============ RESOLUTIONS ============

function meetsThreshold(rules, tally) {
  // Apply constitution rules for quorum & voting threshold (default: simple majority, 50% quorum)
  const quorum = Number(rules.quorum_percent) || 50;
  const threshold = Number(rules.voting_threshold) || 50;
  const yes = tally.YES || 0;
  const totalVotes = (tally.YES || 0) + (tally.NO || 0) + (tally.ABSTAIN || 0);
  const yesPct = totalVotes > 0 ? (yes / totalVotes) * 100 : 0;
  return { quorumMet: totalVotes >= quorum, thresholdMet: yesPct >= threshold, yesPct, totalVotes };
}

async function passResolution({ proposalId, groupType, groupId, meetingId, title, body, rules, financialActionType, financialAmount, resolutionNumber }) {
  const tally = await getProposalResult(proposalId);
  const outcome = meetsThreshold(rules || {}, tally.tally);

  // Mark latest resolutions superseded
  await pool.query(
    `UPDATE governance_resolutions SET is_latest=FALSE, status='SUPERSEDED' WHERE group_type=$1 AND group_id=$2`,
    [groupType || 'VICOBA', groupId]
  );

  const res = await pool.query(
    `INSERT INTO governance_resolutions
       (meeting_id, group_type, group_id, proposal_id, title, body, resolution_number, financial_action_type, financial_amount, linked_to_workflow)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [meetingId || null, groupType || 'VICOBA', groupId, proposalId, title, body, resolutionNumber || null, financialActionType || null, financialAmount || null, financialActionType ? true : false]
  );
  const resolution = res.rows[0];

  // Close the proposal
  await pool.query(`UPDATE governance_proposals SET status=$2 WHERE id=$1`, [proposalId, outcome.thresholdMet ? 'PASSED' : 'FAILED']);

  return { success: true, resolution, outcome };
}

async function amendResolution(resolutionId, { title, body, financialAmount }) {
  await pool.query(`UPDATE governance_resolutions SET is_latest=FALSE, status='AMENDED' WHERE id=$1`, [resolutionId]);
  const old = (await pool.query('SELECT * FROM governance_resolutions WHERE id=$1', [resolutionId])).rows[0];
  const res = await pool.query(
    `INSERT INTO governance_resolutions
       (meeting_id, group_type, group_id, proposal_id, title, body, resolution_number, version, financial_action_type, financial_amount, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PASSED') RETURNING *`,
    [old.meeting_id, old.group_type, old.group_id, old.proposal_id, title || old.title, body || old.body, old.resolution_number, (old.version || 1) + 1, old.financial_action_type, financialAmount !== undefined ? financialAmount : old.financial_amount]
  );
  return res.rows[0];
}

async function listResolutions(groupType, groupId, { category } = {}) {
  let query = `SELECT * FROM governance_resolutions WHERE group_type=$1 AND group_id=$2`;
  const params = [groupType || 'VICOBA', groupId];
  if (category) { params.push(category); query += ` AND financial_action_type=$${params.length}`; }
  query += ` ORDER BY passed_at DESC`;
  return (await pool.query(query, params)).rows;
}

// ============ ACTION ITEMS ============

async function createActionItem({ resolutionId, meetingId, groupType, groupId, roleOrMember, responsibleUserId, task, deadline }) {
  const res = await pool.query(
    `INSERT INTO governance_action_items
       (resolution_id, meeting_id, group_type, group_id, role_or_member, responsible_user_id, task, deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [resolutionId || null, meetingId || null, groupType || 'VICOBA', groupId, roleOrMember, responsibleUserId || null, task, deadline || null]
  );
  return res.rows[0];
}

async function updateActionItem(actionId, { status, completedAt }) {
  const res = await pool.query(
    `UPDATE governance_action_items
        SET status=$2, completed_at=CASE WHEN $2='COMPLETED' THEN NOW() ELSE completed_at END
      WHERE id=$1 RETURNING *`,
    [actionId, status || 'OPEN']
  );
  return res.rows[0];
}

async function listActionItems(groupType, groupId, { status } = {}) {
  let query = `SELECT a.*, u.full_name FROM governance_action_items a LEFT JOIN users u ON a.responsible_user_id=u.id
               WHERE a.group_type=$1 AND a.group_id=$2`;
  const params = [groupType || 'VICOBA', groupId];
  if (status && status !== 'ALL') { params.push(status); query += ` AND a.status=$${params.length}`; }
  query += ` ORDER BY a.created_at DESC`;
  return (await pool.query(query, params)).rows;
}

// ============ AI SECRETARY ============

/**
 * Simulated AI Secretary: transcribe meeting, extract agenda/decisions/action items,
 * generate draft minutes. Prepares the record — human governance confirms it.
 */
async function generateDraftMinutes(meetingId, rawTranscript) {
  const meeting = (await pool.query('SELECT * FROM governance_meetings WHERE id=$1', [meetingId])).rows[0];
  if (!meeting) throw Object.assign(new Error('Kikao hakipatikani'), { statusCode: 404 });

  const text = rawTranscript || 'Discussion on contributions, loan approval, and social fund. Members agreed to raise the social fund contribution and approve a loan.';

  const summary = `Meeting of ${meeting.title} on ${new Date(meeting.scheduled_at).toLocaleDateString()}`;
  const decisions = [
    { item: 'Social Fund contribution increase', detail: 'Raise social fund contribution from TZS 10,000 to TZS 15,000' },
    { item: 'Loan approval', detail: 'Approve loan to a member' },
  ];
  const actionItems = [
    { role_or_member: 'Treasurer', task: 'Update contribution configuration', deadline: new Date(Date.now() + 3 * 86400000) },
    { role_or_member: 'Secretary', task: 'Upload supporting document', deadline: new Date(Date.now() + 2 * 86400000) },
  ];

  const draft = {
    meetingId,
    title: meeting.title,
    date: meeting.scheduled_at,
    summary,
    agenda: decisions.map((d) => d.item),
    decisions,
    actionItems,
    aiGenerated: true,
    generatedAt: new Date().toISOString(),
  };

  const res = await pool.query(
    `INSERT INTO governance_minutes (meeting_id, draft, status) VALUES ($1,$2,'DRAFT') RETURNING *`,
    [meetingId, JSON.stringify(draft)]
  );
  const minutes = res.rows[0];

  // Persist transcript
  await pool.query(
    `INSERT INTO governance_transcripts (meeting_id, transcript, summary, ai_status)
     VALUES ($1,$2,$3,'PROCESSED') RETURNING *`,
    [meetingId, text, summary]
  );

  return { success: true, minutes: { ...minutes, draft } };
}

async function confirmMinutes(minutesId, officialJson, reviewerUserId) {
  const res = await pool.query(
    `UPDATE governance_minutes
        SET official=$2, status='CONFIRMED', reviewed_by=$3, reviewed_at=NOW()
      WHERE id=$1 RETURNING *`,
    [minutesId, JSON.stringify(officialJson), reviewerUserId]
  );
  return res.rows[0];
}

async function listMinutesByGroup(groupType, groupId) {
  const res = await pool.query(
    `SELECT gm.*, mt.title, mt.scheduled_at FROM governance_minutes gm
       JOIN governance_meetings mt ON mt.id=gm.meeting_id
     WHERE mt.group_type=$1 AND mt.group_id=$2 ORDER BY gm.created_at DESC`,
    [groupType || 'VICOBA', groupId]
  );
  return res.rows;
}

module.exports = {
  createMeeting, updateMeetingStatus, listMeetings, getMeetingDetails,
  respondAttendance, markAttended,
  addAgendaItem,
  getOrCreateChannel, ensureDefaultChannels, postChatMessage, getChannelMessages, searchKnowledge,
  addDocument, listDocuments,
  setConstitution, getConstitution,
  createProposal, castVote, getProposalResult, passResolution, amendResolution, listResolutions,
  createActionItem, updateActionItem, listActionItems,
  generateDraftMinutes, confirmMinutes, listMinutesByGroup,
};
