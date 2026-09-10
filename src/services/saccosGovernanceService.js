/**
 * SACCOS Digital Core - Governance (increment 5).
 * Entity-scoped collective decisioning on the SACCOS membership
 * model. OWNER/BOARD propose + open + close + cancel resolutions;
 * ACTIVE members vote FOR/AGAINST/ABSTAIN while OPEN (one vote per
 * member per resolution). Closing tallies:
 *   quorum     = cast votes / ACTIVE members >= quorumPercent%
 *   decision   = FOR votes / cast votes >= decisionThresholdPercent%
 * No money flows here, so no journal is posted; every transition
 * and vote is written to audit_logs. Non-members and cross-entity
 * access resolve to 404; plain MEMBER proposal/closure is 403.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const saccosCore = require('./saccosService');

const DEFAULT_GOV_CONFIG = {
  allowMemberVoting: true,
  quorumPercent: 50,
  decisionThresholdPercent: 60,
  votingDays: 3,
};

function govConfig(saccos) {
  const c = (saccos.config && saccos.config.governance) || {};
  return { ...DEFAULT_GOV_CONFIG, ...c };
}

function newRef() {
  return 'RES-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

const OPEN_ADMIN_STATES = ['DRAFT', 'OPEN'];
const TERMINAL_STATES = ['PASSED', 'REJECTED', 'CANCELLED'];

async function fetchActiveOrg(actorId, saccosId) {
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');
  return org.rows[0];
}

async function requireActiveMember(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (isPlatformAdmin) return { membership: null, isPlatformAdmin };
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return { membership, isPlatformAdmin: false };
}

async function fetchResolution(saccosId, resolutionId) {
  const r = await pool.query(
    `SELECT r.*, (SELECT COUNT(*)::int FROM saccos_members m WHERE m.saccos_id = r.saccos_id AND m.status = 'ACTIVE') AS eligible_members
     FROM saccos_resolutions r WHERE r.id = $1 AND r.saccos_id = $2`,
    [resolutionId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_GOV_RESOLUTION_NOT_FOUND');
  return r.rows[0];
}

async function tally(client, resolution) {
  const r = await client.query(
    `SELECT COALESCE(COUNT(*) FILTER (WHERE choice = 'FOR'), 0)::int AS for_votes,
            COALESCE(COUNT(*) FILTER (WHERE choice = 'AGAINST'), 0)::int AS against_votes,
            COALESCE(COUNT(*) FILTER (WHERE choice = 'ABSTAIN'), 0)::int AS abstain_votes,
            COUNT(*)::int AS cast_votes
     FROM saccos_resolution_votes WHERE resolution_id = $1`,
    [resolution.id]
  );
  const cast = r.rows[0].cast_votes;
  const eligible = Number(resolution.eligible_members);
  const quorumMet = eligible > 0 && cast / eligible >= Number(resolution.quorum_percent) / 100;
  const passed = quorumMet && cast > 0 && r.rows[0].for_votes / cast >= Number(resolution.decision_threshold_percent) / 100;
  return {
    for_votes: r.rows[0].for_votes,
    against_votes: r.rows[0].against_votes,
    abstain_votes: r.rows[0].abstain_votes,
    cast_votes: cast,
    eligible_members: eligible,
    quorum_percent: Number(resolution.quorum_percent),
    decision_threshold_percent: Number(resolution.decision_threshold_percent),
    quorum_met: quorumMet,
    passed,
  };
}

async function createResolution(actorId, saccosId, { title, description, category, votingDays }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = govConfig(saccos);
  const days = votingDays !== undefined ? Number(votingDays) : cfg.votingDays;
  const r = await pool.query(
    `INSERT INTO saccos_resolutions
       (saccos_id, reference_id, created_by, title, description, category, status,
        quorum_percent, decision_threshold_percent)
     VALUES ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $8)
     RETURNING *`,
    [saccosId, newRef(), actorId, title, description || null, category || 'GENERAL',
     cfg.quorumPercent, cfg.decisionThresholdPercent]
  );
  await logAudit(actorId, 'SACCOS_GOV_RESOLUTION_CREATED', { referenceId: saccosId, details: { resolutionId: r.rows[0].id, votingDays: days } }).catch(() => {});
  return r.rows[0];
}

async function openResolution(actorId, saccosId, resolutionId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = govConfig(saccos);
  const resolution = await fetchResolution(saccosId, resolutionId);
  if (resolution.status !== 'DRAFT') throw createAppError('SACCOS_GOV_RESOLUTION_STATE');
  const deadline = new Date(Date.now() + (cfg.votingDays * 24 * 60 * 60 * 1000));
  const r = await pool.query(
    `UPDATE saccos_resolutions SET status = 'OPEN', voting_deadline = $1, opened_by = $2, opened_at = NOW() WHERE id = $3 RETURNING *`,
    [deadline, actorId, resolutionId]
  );
  await logAudit(actorId, 'SACCOS_GOV_RESOLUTION_OPENED', { referenceId: saccosId, details: { resolutionId, votingDeadline: deadline.toISOString() } }).catch(() => {});
  return r.rows[0];
}

async function castVote(actorId, saccosId, resolutionId, { choice }) {
  const choiceN = String(choice || '').toUpperCase();
  if (!['FOR', 'AGAINST', 'ABSTAIN'].includes(choiceN)) throw createAppError('SACCOS_GOV_VOTE_INVALID');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = govConfig(saccos);
  const { membership } = await requireActiveMember(actorId, saccosId);
  const resolution = await fetchResolution(saccosId, resolutionId);
  if (resolution.status !== 'OPEN') throw createAppError('SACCOS_GOV_RESOLUTION_STATE');
  if (cfg.allowMemberVoting === false && !['OWNER', 'BOARD'].includes(membership.role)) throw createAppError('SACCOS_RBAC');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id FROM saccos_resolution_votes WHERE resolution_id = $1 AND member_id = $2',
      [resolutionId, membership.id]
    );
    if (existing.rows.length) throw createAppError('SACCOS_GOV_VOTE_ALREADY');
    const v = await client.query(
      `INSERT INTO saccos_resolution_votes (saccos_id, resolution_id, member_id, choice)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [saccosId, resolutionId, membership.id, choiceN]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_GOV_VOTE_CAST', { referenceId: saccosId, details: { resolutionId, choice: choiceN } }).catch(() => {});
    return { success: true, voteId: v.rows[0].id, choice: choiceN };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function closeResolution(actorId, saccosId, resolutionId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const resolution = await fetchResolution(saccosId, resolutionId);
  if (resolution.status !== 'OPEN') throw createAppError('SACCOS_GOV_RESOLUTION_STATE');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await tally(client, resolution);
    const final = t.passed ? 'PASSED' : 'REJECTED';
    const r = await client.query(
      `UPDATE saccos_resolutions SET status = $1, closed_by = $2, closed_at = NOW() WHERE id = $3 RETURNING *`,
      [final, actorId, resolutionId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_GOV_RESOLUTION_CLOSED', { referenceId: saccosId, details: { resolutionId, outcome: final, ...t } }).catch(() => {});
    return { resolution: r.rows[0], tally: t, outcome: final };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function cancelResolution(actorId, saccosId, resolutionId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const resolution = await fetchResolution(saccosId, resolutionId);
  if (!OPEN_ADMIN_STATES.includes(resolution.status)) throw createAppError('SACCOS_GOV_RESOLUTION_STATE');
  const r = await pool.query(
    `UPDATE saccos_resolutions SET status = 'CANCELLED', closed_by = $1, closed_at = NOW() WHERE id = $2 RETURNING *`,
    [actorId, resolutionId]
  );
  await logAudit(actorId, 'SACCOS_GOV_RESOLUTION_CANCELLED', { referenceId: saccosId, details: { resolutionId } }).catch(() => {});
  return r.rows[0];
}

async function listResolutions(actorId, saccosId) {
  const { membership } = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT id, reference_id, title, description, category, status, voting_deadline, opened_at, closed_at, created_at
     FROM saccos_resolutions WHERE saccos_id = $1 ORDER BY created_at DESC`,
    [saccosId]
  );
  return { resolutions: r.rows, myMemberId: membership ? membership.id : null };
}

async function resolutionDetail(actorId, saccosId, resolutionId) {
  const { membership } = await requireActiveMember(actorId, saccosId);
  const resolution = await fetchResolution(saccosId, resolutionId);
  const client = await pool.connect();
  try {
    const votes = await client.query(
      `SELECT v.choice, v.voted_at, m.member_number, u.full_name
       FROM saccos_resolution_votes v
       JOIN saccos_members m ON m.id = v.member_id
       JOIN users u ON u.id = m.user_id
       WHERE v.resolution_id = $1 ORDER BY v.voted_at`,
      [resolutionId]
    );
    const t = await tally(client, resolution);
    const mine = membership
      ? await client.query(
          `SELECT choice FROM saccos_resolution_votes WHERE resolution_id = $1 AND member_id = $2`,
          [resolutionId, membership.id]
        )
      : { rows: [] };
    return { resolution, tally: t, votes: votes.rows, myVote: mine.rows[0]?.choice || null };
  } finally {
    client.release();
  }
}

async function governanceSummary(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
            COUNT(*) FILTER (WHERE status = 'PASSED')::int AS passed,
            COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected,
            COUNT(*)::int AS total
     FROM saccos_resolutions WHERE saccos_id = $1`,
    [saccosId]
  );
  const votes = await pool.query(
    `SELECT COUNT(*)::int AS votes FROM saccos_resolution_votes WHERE saccos_id = $1`,
    [saccosId]
  );
  return { ...r.rows[0], votes: votes.rows[0].votes };
}

module.exports = {
  createResolution,
  openResolution,
  castVote,
  closeResolution,
  cancelResolution,
  listResolutions,
  resolutionDetail,
  governanceSummary,
};