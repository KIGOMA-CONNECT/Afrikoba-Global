'use strict';

/**
 * G2 — Resource-to-Group Binding.
 *
 * G1 answers "may this user act on this group?". This module answers the
 * second, independent question: "which group owns this resource?" — and it
 * answers it from the resource row, never from the request.
 *
 * Authoritative model
 *   * `req.governance` (produced by G1 from membership rows) is the ACTOR /
 *     GROUP CONTEXT the request is allowed to act as.
 *   * The resource row is the SOURCE OF TRUTH for which group owns it.
 *   * `req.body.group_id` / `req.query.group_id` / `group_type` are claims,
 *     never authority. They are only used by G1 to decide what to authorize.
 *
 * Denial ordering — every check runs BEFORE the handler, so a denial can never
 * leave a partial mutation behind:
 *   1. no group context            -> GOV_GROUP_REQUIRED            (403)
 *   2. conflicting group claim in
 *      another part of the same
 *      request                     -> GOV_RESOURCE_NOT_FOUND        (404)
 *   3. resource does not exist     -> GOV_RESOURCE_NOT_FOUND        (404)
 *   4. resource owned by another
 *      group, or by an unsupported
 *      group family                -> GOV_RESOURCE_NOT_FOUND        (404)
 *   5. execution row disagrees
 *      with its own resolution     -> GOV_EXECUTION_RESOLUTION_MISMATCH (403)
 *
 * Steps 3 and 4 are externally indistinguishable on purpose: the same status
 * and the same code for both, so ids and group memberships cannot be
 * enumerated. The distinction is preserved for operators as `err.internalCode`
 * plus a `GOV_BIND_DENIED` warn log.
 *
 * Group family comparison is strict (decision D3): only the aliases in
 * GROUP_TYPE_ALIASES are recognised, and an unrecognised family fails closed
 * rather than being mapped onto one that happens to be supported.
 *
 * Out of scope (unchanged by design): voting lifecycle, quorum, secret-ballot
 * design, resolution lineage, VICOBA 3-tier semantics, financial transaction
 * atomicity, confidentiality policy beyond ownership, analytics, UX.
 */

const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const logger = require('../utils/logger');

/**
 * Only these aliases exist. `COOPERATIVE`, `ASSOCIATION`, `ALUMNI`, ... are NOT
 * folded into VICOBA or SACCO — they resolve to null and therefore never
 * compare equal to anything (decision D3, strict fail-closed).
 */
const GROUP_TYPE_ALIASES = Object.freeze({
  VICOBA: 'VICOBA',
  SACCO: 'SACCO',
  SACCOS: 'SACCO',
});

/**
 * Canonical ownership lookup per resource type.
 *
 * Types whose row carries its own `group_type`/`group_id` are direct; types
 * that hang off a meeting inherit the meeting's ownership, because
 * governance_minutes / governance_transcripts / governance_agenda_items /
 * governance_attendees carry no group columns of their own (migration 060).
 */
const RESOLVERS = Object.freeze({
  MEETING: 'SELECT group_type, group_id FROM governance_meetings WHERE id = $1',
  CHANNEL: 'SELECT group_type, group_id FROM governance_channels WHERE id = $1',
  PROPOSAL: 'SELECT group_type, group_id FROM governance_proposals WHERE id = $1',
  RESOLUTION: 'SELECT group_type, group_id FROM governance_resolutions WHERE id = $1',
  ACTION_ITEM: 'SELECT group_type, group_id FROM governance_action_items WHERE id = $1',
  DOCUMENT: 'SELECT group_type, group_id FROM governance_documents WHERE id = $1',
  CONSTITUTION: 'SELECT group_type, group_id FROM governance_constitutions WHERE id = $1',
  MINUTES: 'SELECT m.group_type, m.group_id FROM governance_minutes c JOIN governance_meetings m ON m.id = c.meeting_id WHERE c.id = $1',
  TRANSCRIPT: 'SELECT m.group_type, m.group_id FROM governance_transcripts c JOIN governance_meetings m ON m.id = c.meeting_id WHERE c.id = $1',
  AGENDA_ITEM: 'SELECT m.group_type, m.group_id FROM governance_agenda_items c JOIN governance_meetings m ON m.id = c.meeting_id WHERE c.id = $1',
});

/**
 * `governance_access_grants.record_type` has no foreign keys (migration 062),
 * so a grant is resolved by dispatching its (record_type, record_id) pair back
 * into the same table above. Unknown record types resolve to nothing rather
 * than to a permissive default.
 */
const RECORD_TYPE_MAP = Object.freeze({
  DOCUMENT: 'DOCUMENT',
  TRANSCRIPT: 'TRANSCRIPT',
  MEETING: 'MEETING',
  RESOLUTION: 'RESOLUTION',
  ACTION: 'ACTION_ITEM',
  ACTION_ITEM: 'ACTION_ITEM',
});

/**
 * G3 — SACCOS governance surface.
 *
 * `/api/v1/saccos/:id/governance/*` and `/api/v1/saccos/:id/meetings/*` bind
 * to exactly the same invariant, but their rows carry `saccos_id` instead of
 * (`group_type`, `group_id`), so they get their own resolvers in a separate
 * table (RESOLVERS above stays a flat `type -> SQL` map for G2).
 *
 * `notFound` is the PUBLIC denial code. G3 consolidates the architecture, not
 * the error contract: an unknown or foreign SACCOS governance resource must
 * keep answering with the pre-existing SACCOS_* 404 so the live SACCOS suites
 * and every client that branches on those codes stay correct. "Missing" and
 * "owned by another SACCOS" deliberately share one code — the distinction is
 * preserved only as `err.internalCode`.
 */
const SACCOS_RESOLVERS = Object.freeze({
  SACCOS_RESOLUTION: Object.freeze({
    sql: 'SELECT saccos_id FROM saccos_resolutions WHERE id = $1',
    notFound: 'SACCOS_GOV_RESOLUTION_NOT_FOUND',
  }),
  SACCOS_MEETING: Object.freeze({
    sql: 'SELECT saccos_id FROM saccos_meetings WHERE id = $1',
    notFound: 'SACCOS_MEETING_NOT_FOUND',
  }),
  SACCOS_MEMBER: Object.freeze({
    sql: 'SELECT saccos_id FROM saccos_members WHERE id = $1',
    notFound: 'SACCOS_MEMBER_NOT_FOUND',
  }),
});

function toPositiveInt(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Strict family normalisation. Returns null for anything that is not a known
 * alias, and null never compares equal — unsupported families fail closed.
 */
function familyOf(raw) {
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(GROUP_TYPE_ALIASES, key)
    ? GROUP_TYPE_ALIASES[key]
    : null;
}

/**
 * Family AND id must both match. Comparing only the id would let a VICOBA group
 * 8 and a SACCO group 8 pass each other's binding.
 */
function sameGroup(canonical, context) {
  const a = familyOf(canonical && canonical.groupType);
  const b = familyOf(context && context.groupType);
  if (!a || !b || a !== b) return false;
  const x = canonical ? canonical.groupId : null;
  const y = context ? context.groupId : null;
  if (x === undefined || x === null || y === undefined || y === null) return false;
  return Number(x) === Number(y);
}

/**
 * Every spelling a family may legitimately appear under in a stored
 * `group_type` column. Used to scope SQL reads: filtering on group id alone is
 * not safe, because ids are only unique *within* a family.
 */
function familyAliases(groupType) {
  const family = familyOf(groupType);
  if (family === 'VICOBA') return ['VICOBA'];
  if (family === 'SACCO') return ['SACCO', 'SACCOS'];
  return null;
}

/**
 * Build the denial shape for "missing" and "wrong group".
 *
 * The PUBLIC code is the resource kind's own not-found code when it has one
 * (the SACCOS resolvers, so the pre-existing SACCOS error contract survives
 * the consolidation) and GOV_RESOURCE_NOT_FOUND otherwise.
 *
 * `internalCode` is observability only: it is logged and readable from a unit
 * test, and is deliberately not part of the HTTP body.
 */
function resourceDenied(resourceType, resourceId, internalCode, detail) {
  const saccosResolver = SACCOS_RESOLVERS[resourceType];
  const publicCode = (saccosResolver && saccosResolver.notFound) || 'GOV_RESOURCE_NOT_FOUND';
  const err = createAppError(publicCode);
  if (internalCode) err.internalCode = internalCode;
  logger.warn(
    'GOV_BIND_DENIED',
    `${resourceType}${resourceId === null || resourceId === undefined ? '' : `#${resourceId}`} -> ${internalCode || 'NOT_FOUND'}${detail ? ` ${detail}` : ''}`
  );
  return err;
}

function denyMissingResourceParam(resourceType, detail) {
  return resourceDenied(resourceType, null, 'MISSING_RESOURCE_PARAM', detail);
}

/**
 * Minimal precondition for anything that mutates: there must be a validated
 * group context to bind against. Exported so the financial service can fail
 * closed on its own instead of trusting that the HTTP layer already checked.
 */
function requireContext(governance) {
  if (!governance || governance.groupId === undefined || governance.groupId === null) {
    throw createAppError('GOV_GROUP_REQUIRED');
  }
  return governance;
}

async function resolveRecord(recordId, recordType) {
  const mapped = RECORD_TYPE_MAP[String(recordType === undefined || recordType === null ? '' : recordType).trim().toUpperCase()];
  if (!mapped) return null;
  return resolveResourceGroup(mapped, recordId);
}

/**
 * An execution has no group of its own that is authoritative — it has a
 * `group_id` column (migration 061) that is only a denormalised copy of its
 * resolution's group. Canonical ownership therefore comes from the resolution,
 * and the two are cross-checked separately as an integrity invariant rather
 * than folded into the ownership answer.
 */
async function resolveExecution(id) {
  const execution = (await pool.query(
    'SELECT id, group_id, resolution_id FROM governance_financial_executions WHERE id = $1',
    [id]
  )).rows[0];
  if (!execution) return null;
  const resolution = (await pool.query(
    'SELECT group_type, group_id FROM governance_resolutions WHERE id = $1',
    [execution.resolution_id]
  )).rows[0];
  if (!resolution) return null;
  return {
    groupType: resolution.group_type,
    groupId: resolution.group_id,
    executionGroupId: execution.group_id,
    resolutionId: execution.resolution_id,
    integrityMismatch: Number(execution.group_id) !== Number(resolution.group_id),
  };
}

async function resolveAccessGrant(id) {
  const grant = (await pool.query(
    'SELECT record_type, record_id FROM governance_access_grants WHERE id = $1',
    [id]
  )).rows[0];
  if (!grant) return null;
  return resolveRecord(grant.record_id, grant.record_type);
}

/**
 * Resolve the canonical owner of a resource.
 *
 * @returns {Promise<{groupType: *, groupId: *, integrityMismatch?: boolean,
 *   executionGroupId?: number, resolutionId?: number}|null>} null when the
 *   resource does not exist or cannot be described.
 * @throws  GOV_RESOURCE_UNREGISTERED when the caller names a resource type the
 *   binding table does not know — a wiring bug, never a data condition.
 */
async function resolveResourceGroup(resourceType, resourceId, options = {}) {
  const id = toPositiveInt(resourceId);
  if (id === null) return null;

  const type = String(resourceType === undefined || resourceType === null ? '' : resourceType).trim().toUpperCase();
  if (type === 'EXECUTION') return resolveExecution(id);
  if (type === 'ACCESS_GRANT') return resolveAccessGrant(id);
  if (type === 'RECORD') return resolveRecord(id, options.recordType);

  const saccosResolver = SACCOS_RESOLVERS[type];
  if (saccosResolver) {
    const row = (await pool.query(saccosResolver.sql, [id])).rows[0];
    if (!row) return null;
    // The row's own saccos_id is canonical; nothing in the request may name
    // a different one. 'SACCO' is the family alias every SACCOS context and
    // every SACCOS resolver reports, so sameGroup compares like for like.
    return { groupType: 'SACCO', groupId: row.saccos_id };
  }

  const sql = RESOLVERS[type];
  if (!sql) throw createAppError('GOV_RESOURCE_UNREGISTERED', { resourceType: type || null });
  const row = (await pool.query(sql, [id])).rows[0];
  if (!row) return null;
  return { groupType: row.group_type, groupId: row.group_id };
}

/**
 * The whole G2 invariant in one call.
 *
 * Throws before any handler runs, so "denial happens before mutation" holds
 * for every route that uses it, and again inside the financial service so it
 * still holds if the HTTP layer is bypassed.
 */
async function assertResourceInContext(resourceType, resourceId, governance, options = {}) {
  requireContext(governance);

  const canonical = await resolveResourceGroup(resourceType, resourceId, options);
  if (!canonical) {
    throw resourceDenied(resourceType, resourceId, null, 'missing');
  }

  if (!sameGroup(canonical, governance)) {
    throw resourceDenied(
      resourceType,
      resourceId,
      'GOV_RESOURCE_GROUP_MISMATCH',
      `canonical=${canonical.groupType}:${canonical.groupId} ctx=${governance.groupType}:${governance.groupId}`
    );
  }

  if (canonical.integrityMismatch) {
    logger.warn(
      'GOV_BIND_INTEGRITY',
      `execution=${resourceId} resolution=${canonical.resolutionId} exec.group=${canonical.executionGroupId} resolution.group=${canonical.groupId}`
    );
    const err = createAppError('GOV_EXECUTION_RESOLUTION_MISMATCH', {
      executionId: toPositiveInt(resourceId),
      resolutionId: canonical.resolutionId,
    });
    err.internalCode = 'GOV_EXECUTION_RESOLUTION_MISMATCH';
    throw err;
  }

  return canonical;
}

function collectClaims(source, keys) {
  const claims = [];
  if (!source || typeof source !== 'object') return claims;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') claims.push(value);
  }
  return claims;
}

/**
 * One request, one group context.
 *
 * G1 reads group id/type from body, then query, then params, taking the first
 * value it finds in each. A request that also carries a *different* group in a
 * later source would therefore be authorized as one group while the handler
 * reads the other. This closes that gap: every group claim anywhere in the
 * sources must agree with the context G1 actually validated, or the request is
 * treated as naming a resource it cannot see (404, not 403 — the response is
 * identical whether the claimed group exists or not).
 *
 * `options.idKeys` adds extra spellings of "which group" (G3 passes
 * `saccos_id` / `saccosId`), so a SACCOS id smuggled into the body is held to
 * the same rule. Default is none, so the G1/G2 surface is unchanged.
 */
function assertRequestGroupConsistent(governance, req, options = {}) {
  requireContext(governance);
  const ctxFamily = familyOf(governance.groupType);
  const ctxId = Number(governance.groupId);
  if (!ctxFamily) throw createAppError('GOV_GROUP_TYPE_UNSUPPORTED', { groupType: governance.groupType });

  const extraIdKeys = Array.isArray(options.idKeys) ? options.idKeys : [];
  const idKeys = ['group_id', 'groupId'].concat(extraIdKeys);

  const sources = ['body', 'query', 'params'].map((k) => req[k]);
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;

    for (const claim of collectClaims(source, idKeys)) {
      const id = Number(claim);
      if (!Number.isSafeInteger(id) || id <= 0 || id !== ctxId) {
        throw resourceDenied('GROUP', claim, 'GOV_CONTEXT_GROUP_MISMATCH', `ctx=${ctxFamily}:${ctxId}`);
      }
    }
    for (const claim of collectClaims(source, ['group_type', 'groupType'])) {
      const family = familyOf(claim);
      if (!family || family !== ctxFamily) {
        throw resourceDenied('GROUP', claim, 'GOV_CONTEXT_GROUP_TYPE_MISMATCH', `ctx=${ctxFamily}:${ctxId}`);
      }
    }
  }
}

/**
 * Match a route pattern against a request path and return the captured params,
 * or null.
 *
 * `router.use()` layers are matched by prefix and never populate `req.params`,
 * so both the G1 capability matrix and the G2/G3 binding matrices recover the
 * params from `req.path` — which is exactly what their matchers already read.
 *
 * Shared by governanceRoutes (G1/G2) and saccosRoutes (G3) so the two
 * surfaces can never drift on what "the same route" means.
 */
function matchRouteParams(pattern, path) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = String(path || '').split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i][0] === ':') {
      params[expected[i].slice(1)] = actual[i];
      continue;
    }
    if (expected[i] !== actual[i]) return null;
  }
  return params;
}

function patternMatches(pattern, path) {
  return matchRouteParams(pattern, path) !== null;
}

module.exports = {
  GROUP_TYPE_ALIASES,
  RESOLVERS,
  SACCOS_RESOLVERS,
  RECORD_TYPE_MAP,
  familyOf,
  familyAliases,
  sameGroup,
  matchRouteParams,
  patternMatches,
  resolveResourceGroup,
  assertResourceInContext,
  assertRequestGroupConsistent,
  denyMissingResourceParam,
  requireContext,
};
