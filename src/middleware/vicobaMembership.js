'use strict';
/**
 * R36 Task 2 (F-R34-1): server-side group-membership isolation for VICOBA reads.
 *
 * Installed with router.param() on the VICOBA routers, so EVERY GET/HEAD route that names a
 * :groupId, :loanId or :meetingId resolves the owning group and requires the caller to be a member
 * of that group. A non-member gets 403 VICOBA_NOT_GROUP_MEMBER; an unknown id gets the same 403
 * (no existence oracle). Writes are not touched here: their services already check roles.
 */
const pool = require('../config/db');

const READ_METHODS = new Set(['GET', 'HEAD']);

function notMember() {
  return Object.assign(new Error('Huna ruhusa: si mwanachama wa kikundi hiki.'),
    { statusCode: 403, code: 'VICOBA_NOT_GROUP_MEMBER' });
}

function parseId(raw) {
  return /^[1-9][0-9]{0,9}$/.test(String(raw)) ? Number(raw) : null;
}

const LEADER_ROLES = new Set(['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU']);

async function memberRole(userId, groupId) {
  if (!userId || !groupId) return null;
  const r = await pool.query('SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return r.rows.length ? (r.rows[0].role_in_group || 'MJUMBE') : null;
}

async function isGroupMember(userId, groupId) {
  return (await memberRole(userId, groupId)) !== null;
}

// Data minimisation for non-leaders: another member's phone number and individual fund balances are
// removed from any object in the response that belongs to someone else (user_id / applicant_user_id /
// requester_id). The viewer's own rows and leaders' views are unchanged.
const PRIVATE_KEYS = ['phone_number', 'social_fund_balance', 'contribution_balance'];
const OWNER_KEYS = ['user_id', 'applicant_user_id', 'requester_id'];

function redactForViewer(value, viewerId, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactForViewer(v, viewerId, depth + 1));
  if (value instanceof Date) return value;
  const out = {};
  const ownerKey = OWNER_KEYS.find((k) => Object.prototype.hasOwnProperty.call(value, k));
  // Only per-person rows are redacted; group-level aggregates (no owner key) stay visible to members.
  const foreign = ownerKey ? Number(value[ownerKey]) !== Number(viewerId) : false;
  for (const [k, v] of Object.entries(value)) {
    if (PRIVATE_KEYS.includes(k) && foreign) continue;
    out[k] = redactForViewer(v, viewerId, depth + 1);
  }
  return out;
}

// lookupSql: returns group_id for the id, or no row.
function memberGuard(lookupSql) {
  return async (req, res, next, raw) => {
    if (!READ_METHODS.has(req.method)) return next();
    try {
      const id = parseId(raw);
      if (id === null) throw notMember();
      let groupId = id;
      if (lookupSql) {
        const r = await pool.query(lookupSql, [id]);
        groupId = r.rows[0] ? r.rows[0].group_id : null;
      }
      const role = await memberRole(req.user && req.user.id, groupId);
      if (!role) throw notMember();
      req.vicobaViewer = { groupId, role, leader: LEADER_ROLES.has(role) };
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function minimiseReadResponses(req, res, next) {
  if (!READ_METHODS.has(req.method)) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    const v = req.vicobaViewer;
    if (!v || v.leader || res.statusCode >= 400) return json(body);
    return json(redactForViewer(body, req.user.id));
  };
  return next();
}

// R36: leader-only VICOBA administrative writes (schedules, meetings, attendance -> fines).
function leaderRequired() {
  return Object.assign(new Error('Viongozi pekee (Mwenyekiti, Mwekahazina, Katibu) wanaweza kufanya hivi.'),
    { statusCode: 403, code: 'VICOBA_LEADER_REQUIRED' });
}
async function assertGroupLeader(groupId, userId, db = pool) {
  if (!userId || !groupId) throw leaderRequired();
  const r = await db.query('SELECT role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  if (!r.rows.length || !LEADER_ROLES.has(r.rows[0].role_in_group)) throw leaderRequired();
}

function installVicobaReadGuards(router) {
  router.use(minimiseReadResponses);
  router.param('groupId', memberGuard(null));
  router.param('loanId', memberGuard('SELECT group_id FROM vicoba_loan_requests WHERE id = $1'));
  router.param('meetingId', memberGuard('SELECT group_id FROM vicoba_meetings WHERE id = $1'));
}

module.exports = { assertGroupLeader, leaderRequired, installVicobaReadGuards, isGroupMember, memberRole, notMember, redactForViewer, LEADER_ROLES };
