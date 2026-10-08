'use strict';

/**
 * G1 — Governance Authentication & Authorization Boundary.
 *
 * Every /api/governance/* route must pass through this module. It answers a
 * single question: "may THIS authenticated user act on THIS group with THIS
 * capability?" — and it answers it from membership rows, never from
 * `req.user.role` standing in for group membership.
 *
 * Scope (G1):
 *   * group-scoped authorization only;
 *   * VICOBA  -> vicoba_members + vicoba_groups (membership row + role_in_group
 *                + group lifecycle status);
 *   * SACCOS   -> the existing saccosService assertions;
 *   * platform ADMIN is reported via `isPlatformAdmin` but is NEVER treated as
 *     a group member, voter, or holder of financial authority by default.
 *
 * Explicitly out of scope:
 *   * resource -> group binding (meeting_id, proposal_id, resolution_id,
 *     execution_id, document_id, transcript_id, minutes_id, action_item_id,
 *     channel_id). That is G2 Resource-to-Group Binding. This module therefore
 *     never looks a resource id up to discover its group; it only consumes the
 *     group context the request itself carries, and denies when it is absent.
 *   * voting logic, secret ballot, resolution lineage, financial execution,
 *     VICOBA loan workflow.
 */

const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const logger = require('../utils/logger');

const CAPABILITIES = Object.freeze({
  READ: 'READ',
  WRITE: 'WRITE',
  VOTE: 'VOTE',
  GOVERN: 'GOVERN',
  FINANCIAL: 'FINANCIAL',
});

const VICOBA_MEMBER_ROLES = Object.freeze(['MJUMBE', 'MWENYEKITI', 'MWEKAHAZINA', 'KATIBU']);
const VICOBA_OFFICER_ROLES = Object.freeze(['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU']);

const SACCOS_MEMBER_ROLES = Object.freeze(['OWNER', 'BOARD', 'MEMBER']);
const SACCOS_GOVERNING_ROLES = Object.freeze(['OWNER', 'BOARD']);

const VICOBA_GROUP_TYPES = Object.freeze(['VICOBA']);
const SACCOS_GROUP_TYPES = Object.freeze(['SACCO', 'SACCOS']);

/**
 * The ONLY platform-admin grants in Governance.
 *
 * Keyed "<family>:<capability>". A platform ADMIN who holds no membership row
 * gains nothing anywhere else: not READ, not WRITE, not VOTE (never a voter),
 * never FINANCIAL authority. The single entry below preserves the behaviour
 * `saccosService.assertMembershipCanAdminister()` already had before G1 —
 * platform ADMIN could always cross-administer a SACCOS for oversight — and
 * makes it explicit instead of incidental.
 *
 * Adding an entry here is a deliberate, reviewable security decision.
 */
const PLATFORM_ADMIN_OVERRIDES = Object.freeze({
  'SACCOS:GOVERN': true,
});

function allowsPlatformAdmin(family, capability) {
  return PLATFORM_ADMIN_OVERRIDES[`${family}:${capability}`] === true;
}

function normalizeGroupType(raw) {
  const value = String(raw === undefined || raw === null ? 'VICOBA' : raw).trim().toUpperCase();
  return value || 'VICOBA';
}

function resolveFamily(groupType) {
  if (VICOBA_GROUP_TYPES.includes(groupType)) return 'VICOBA';
  if (SACCOS_GROUP_TYPES.includes(groupType)) return 'SACCOS';
  return null;
}

function officerOnly(capability) {
  return capability === CAPABILITIES.GOVERN || capability === CAPABILITIES.FINANCIAL;
}

function buildContext(fields) {
  return Object.assign({ allowed: true }, fields);
}

/**
 * Pull group context off the request without ever trusting it as authority.
 *
 * The client may name any group it likes; membership is what grants access.
 * Both wire conventions in this codebase are accepted: snake_case from the
 * query-string routes (`group_id` / `group_type`) and camelCase from the body
 * routes (`groupId` / `groupType`).
 *
 * Returns `null` when the request carries no usable group id — the caller must
 * treat that as a denial, never as an implicit pass-through.
 */
function extractGroupContext(req) {
  const sources = [req.body, req.query, req.params].filter((s) => s && typeof s === 'object');
  let rawType;
  let rawId;
  for (const src of sources) {
    if (rawType === undefined && (src.group_type !== undefined || src.groupType !== undefined)) {
      rawType = src.group_type !== undefined ? src.group_type : src.groupType;
    }
    if (rawId === undefined && (src.group_id !== undefined || src.groupId !== undefined)) {
      rawId = src.group_id !== undefined ? src.group_id : src.groupId;
    }
  }
  if (rawId === undefined || rawId === null || rawId === '') return null;
  const groupId = Number(rawId);
  if (!Number.isInteger(groupId) || groupId <= 0) return null;
  return { groupType: normalizeGroupType(rawType), groupId };
}

/**
 * VICOBA authorization.
 *
 * `vicoba_members` carries no per-member status column, so membership is
 * "the row exists" (UNIQUE(group_id, user_id)); the lifecycle gate lives on
 * `vicoba_groups.status`, which must be ACTIVE.
 */
async function authorizeVicoba({ userId, userRole, groupId, capability }) {
  const membershipRes = await pool.query(
    'SELECT id, role_in_group FROM vicoba_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  const membership = membershipRes.rows[0] || null;
  const isPlatformAdmin = userRole === 'ADMIN';

  if (!membership) {
    if (isPlatformAdmin && allowsPlatformAdmin('VICOBA', capability)) {
      return buildContext({
        groupType: 'VICOBA',
        groupId,
        membershipId: null,
        role: null,
        status: null,
        groupStatus: null,
        isPlatformAdmin: true,
        capability,
        reason: 'platform_admin_override',
      });
    }
    throw createAppError('GOV_NOT_A_MEMBER');
  }

  const groupRes = await pool.query('SELECT status FROM vicoba_groups WHERE id = $1', [groupId]);
  const group = groupRes.rows[0];
  if (!group) throw createAppError('GOV_GROUP_NOT_FOUND');
  if (group.status !== 'ACTIVE') {
    throw createAppError('GOV_GROUP_INACTIVE', { status: group.status });
  }

  const role = membership.role_in_group;
  const requiredRoles = officerOnly(capability) ? VICOBA_OFFICER_ROLES : VICOBA_MEMBER_ROLES;
  if (!requiredRoles.includes(role)) {
    throw createAppError('GOV_ROLE_FORBIDDEN', { capability, role });
  }

  return buildContext({
    groupType: 'VICOBA',
    groupId,
    membershipId: membership.id,
    role,
    status: null,
    groupStatus: group.status,
    isPlatformAdmin,
    capability,
    reason: 'member',
  });
}

/**
 * SACCOS authorization — reuses the existing assertions so that Governance and
 * the SACCOS surface agree on what a member is:
 *   assertVisible              -> 404 for outsiders, no cross-SACCOS enumeration
 *   assertActiveRole           -> ACTIVE membership + role (no platform bypass)
 *   assertMembershipCanAdminister -> ACTIVE + OWNER/BOARD, platform ADMIN passes
 */
async function authorizeSaccos({ userId, groupId, capability, groupType }) {
  const saccosService = require('./saccosService');
  const family = 'SACCOS';

  if (capability === CAPABILITIES.GOVERN) {
    const governed = await saccosService.assertMembershipCanAdminister(userId, groupId);
    const member = governed.membership;
    return buildContext({
      groupType,
      groupId,
      membershipId: member ? member.id : null,
      role: member ? member.role : null,
      status: member ? member.status : null,
      groupStatus: null,
      isPlatformAdmin: !!governed.isPlatformAdmin,
      capability,
      reason: member ? 'member' : 'platform_admin_override',
    });
  }

  // Visibility first: outsiders get SACCOS_NOT_FOUND (404) rather than a hint
  // that the id exists.
  await saccosService.assertVisible(userId, groupId);

  const requiredRoles = capability === CAPABILITIES.FINANCIAL
    ? SACCOS_GOVERNING_ROLES
    : SACCOS_MEMBER_ROLES;
  const member = await saccosService.assertActiveRole(userId, groupId, requiredRoles);

  return buildContext({
    groupType,
    groupId,
    membershipId: member.id,
    role: member.role,
    status: member.status,
    groupStatus: null,
    isPlatformAdmin: false,
    capability,
    reason: 'member',
  });
}

/**
 * Authorize a group-scoped action. Resolves to the full governance context, or
 * throws an app error (never silently allows).
 *
 * @param {Object} p
 * @param {number} p.userId    authenticated user id
 * @param {string} p.userRole  platform role — used ONLY to flag isPlatformAdmin
 * @param {string} p.groupType normalized group type from the request
 * @param {number} p.groupId   group id claimed by the request
 * @param {string} p.capability one of CAPABILITIES
 * @returns {Promise<Object>} context
 */
async function authorizeGroupContext({ userId, userRole, groupType, groupId, capability }) {
  if (!CAPABILITIES[capability]) {
    throw createAppError('GOV_GROUP_TYPE_UNSUPPORTED', { capability });
  }
  const family = resolveFamily(normalizeGroupType(groupType));
  if (!family) {
    throw createAppError('GOV_GROUP_TYPE_UNSUPPORTED', { groupType });
  }

  const normalized = normalizeGroupType(groupType);
  const ctx = { userId, userRole, groupType: normalized, groupId, capability };

  const result = family === 'VICOBA'
    ? await authorizeVicoba(ctx)
    : await authorizeSaccos(ctx);

  logger.warn('GOV_AUTHZ', `cap=${capability} group=${normalized}:${groupId} user=${userId} -> ${result.reason}`);
  return result;
}

/**
 * Express middleware. Place it after `authRequired` on every governance route.
 *
 * Denies when the request carries no group context (G1 cannot bind a resource
 * id to a group — that is G2), denies when the user holds no membership, and
 * denies when the membership's role does not cover the capability.
 */
function requireGovernance(capability) {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'Unahitaji kuingia kwanza.' });
      }
      const context = extractGroupContext(req);
      if (!context) {
        throw createAppError('GOV_GROUP_REQUIRED', { capability });
      }
      req.governance = await authorizeGroupContext({
        userId: req.user.id,
        userRole: req.user.role,
        groupType: context.groupType,
        groupId: context.groupId,
        capability,
      });
      return next();
    } catch (err) {
      if (err && err.statusCode && err.code) {
        logger.warn('GOV_AUTHZ_DENIED', `cap=${capability} path=${req.path} code=${err.code} user=${req.user ? req.user.id : 'anon'}`);
        return res.status(err.statusCode).json({
          success: false,
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        });
      }
      return next(err);
    }
  };
}

module.exports = {
  CAPABILITIES,
  VICOBA_MEMBER_ROLES,
  VICOBA_OFFICER_ROLES,
  SACCOS_MEMBER_ROLES,
  SACCOS_GOVERNING_ROLES,
  PLATFORM_ADMIN_OVERRIDES,
  extractGroupContext,
  authorizeGroupContext,
  requireGovernance,
};
