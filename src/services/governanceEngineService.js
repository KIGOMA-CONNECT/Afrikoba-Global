const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');

/**
 * Simulated AI Secretary: transcribe meeting, extract agenda/decisions/action items,
 * generate draft minutes. Prepares the record — human governance confirms it.
 */
// Regex-based transcript parser: detects agenda topics, decisions, disagreements,
// speakers, responsible members, amounts, and deadlines from a raw text transcript.
function parseTranscript(text) {
  const lower = text.toLowerCase();
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const topics = [
    { word: 'contribution', label: 'Contribution' },
    { word: 'loan', label: 'Loan' },
    { word: 'social fund', label: 'Social Fund' },
    { word: 'investment', label: 'Investment' },
    { word: 'budget', label: 'Budget' },
    { word: 'projects', label: 'Project' },
    { word: 'membership', label: 'Membership' },
    { word: 'emergency', label: 'Emergency fund' },
  ];

  const agenda = topics.filter((t) => lower.includes(t.word)).map((t) => t.label);

  const decisions = lines
    .filter((l) => /\b(agree|decide|approve|adopt|pass|agreed|kukubali|tuliamua|kupitisha|idhinishwa)\b/i.test(l))
    .slice(0, 12)
    .map((l) => {
      const amountMatch = l.match(/(TZS|TSH|SH|K)\s*([\d,]+(?:\.\d+)?)/i) || l.match(/([\d,]{4,})(?:\s*\/\s*)?(TZS|TSH)/i);
      return {
        detail: l.slice(0, 200),
        amount: amountMatch ? (amountMatch[1].replace ? amountMatch[1].replace(/,/g, '') : amountMatch[1]) : null,
      };
    });

  const disagreements = lines
    .filter((l) => /\b(but|however|disagree|object|against|oppose|lakini|sikubaliani|kupinga)\b/i.test(l))
    .slice(0, 6)
    .map((l) => ({ detail: l.slice(0, 200) }));

  const actionItems = lines
    .filter((l) => /\b(treasurer|secretary|chair|chairman|mwekahazina|katibu|mwenyekiti|to |wewe|you)\b/i.test(l))
    .map((l) => {
      const roleMatch = l.match(/\b(treasurer|secretary|chairman|mwenyekiti|mwekahazina|katibu)\b/i);
      const deadlineMatch = l.match(/\b(before|by|kabla ya|tarehe)\s*([\d]{1,2}[\/\-][\d]{1,2}(?:[\/\-][\d]{2,4})?)/i);
      let deadline = null;
      if (deadlineMatch) {
        const parts = deadlineMatch[2].split(/[\/\-]/);
        if (parts.length >= 2) deadline = new Date(parts[1] + '/' + parts[0] + '/' + (parts[2] || new Date().getFullYear())).toISOString();
      }
      return {
        role_or_member: roleMatch ? roleMatch[1].replace(/^./, function(c) { return c.toUpperCase(); }) : 'Member',
        task: l.slice(0, 180),
        deadline: deadline || new Date(Date.now() + 7 * 86400000).toISOString(),
      };
    })
    .slice(0, 12);

  return { agenda: agenda, decisions: decisions, disagreements: disagreements, actionItems: actionItems };
}

async function generateDraftMinutes(meetingId, rawTranscript) {
  const meetingRes = await pool.query('SELECT * FROM governance_meetings WHERE id=$1', [meetingId]);
  const meeting = meetingRes.rows[0];
  if (!meeting) throw Object.assign(new Error('Kikao hakipatikani'), { statusCode: 404 });

  const text = rawTranscript || 'Discussion on contributions, loan approval, and social fund. Members agreed to raise the social fund contribution to TZS 15,000. Treasurer, update the configuration by 7/9/2026. Secretary, upload the supporting document by 6/9/2026.';

  const parsed = parseTranscript(text);
  const summary = 'Meeting of ' + meeting.title + ' on ' + new Date(meeting.scheduled_at).toLocaleDateString();

  const draft = {
    meetingId: meetingId,
    title: meeting.title,
    date: meeting.scheduled_at,
    summary: summary,
    agenda: parsed.agenda,
    decisions: parsed.decisions,
    disagreements: parsed.disagreements,
    actionItems: parsed.actionItems,
    aiGenerated: true,
    generatedAt: new Date().toISOString(),
  };
  const structured = { agenda: parsed.agenda, decisions: parsed.decisions, disagreements: parsed.disagreements, actionItems: parsed.actionItems };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      "INSERT INTO governance_minutes (meeting_id, draft, ai_structured, status) VALUES ($1,$2,$3,'DRAFT') RETURNING *",
      [meetingId, JSON.stringify(draft), JSON.stringify(structured)]
    );
    const minutes = res.rows[0];

    for (var i = 0; i < parsed.actionItems.length; i++) {
      var ai = parsed.actionItems[i];
      try {
        await client.query(
          "INSERT INTO governance_action_items (meeting_id, group_type, group_id, role_or_member, task, deadline, status) VALUES ($1,$2,$3,$4,$5,$6,'OPEN')",
          [meetingId, meeting.group_type, meeting.group_id, ai.role_or_member, ai.task, ai.deadline ? new Date(ai.deadline) : null]
        );
      } catch (e) { /* skip malformed */ }
    }

    await client.query(
      "INSERT INTO governance_transcripts (meeting_id, transcript, summary, ai_status) VALUES ($1,$2,$3,'PROCESSED') RETURNING *",
      [meetingId, text, summary]
    );
    await client.query('COMMIT');
    return { success: true, minutes: Object.assign({}, minutes, { draft: draft, structured: structured }) };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    throw e;
  } finally {
    client.release();
  }
}

async function confirmMinutes(minutesId, officialJson, reviewerUserId) {
  const res = await pool.query(
    "UPDATE governance_minutes SET official=$2, status='CONFIRMED', reviewed_by=$3, reviewed_at=NOW() WHERE id=$1 RETURNING *",
    [minutesId, JSON.stringify(officialJson), reviewerUserId]
  );
  return res.rows[0];
}

async function listMinutesByGroup(groupType, groupId) {
  const res = await pool.query(
    "SELECT gm.*, mt.title, mt.scheduled_at FROM governance_minutes gm JOIN governance_meetings mt ON mt.id=gm.meeting_id WHERE mt.group_type=$1 AND mt.group_id=$2 ORDER BY gm.created_at DESC",
    [groupType || 'VICOBA', groupId]
  );
  return res.rows;
}
