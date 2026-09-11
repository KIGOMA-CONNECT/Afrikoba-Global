/**
 * SACCOS Digital Core - Member Welfare / Social Fund (increment 16).
 * A pooled welfare kitty over the shared double-entry core:
 *
 *   create scheme  (OWNER/BOARD) : name, contribution, fixed payout.
 *   join/contribute (ACTIVE member, once per scheme WLC-*):
 *       DR CUSTOMER_WALLET / CR `SACCOS<id>_WELFARE_FUND` (LIABILITY)
 *   claim            (ACTIVE member)  : SUBMITTED with event/details,
 *       amount capped by scheme payout, one active claim per member-scheme.
 *   review           (OWNER/BOARD)    : SUBMITTED -> APPROVED / REJECTED.
 *   pay              (OWNER/BOARD)    : idempotent on WLF-* claim op,
 *       DR `SACCOS<id>_WELFARE_FUND` / CR CUSTOMER_WALLET; fund balance =
 *       contributions - payouts and can never go negative.
 * Reads: members own schemes/contributions/claims + summaries, OWNER/BOARD
 * see everyone + fund summary, platform ADMIN oversight, non-member 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

function welfareFundCode(saccosId) {
  return `SACCOS${saccosId}_WELFARE_FUND`;
}
function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function fetchActiveOrg(actorId, saccosId) {
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');
  return org.rows[0];
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function ensureFundAccount(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, 'LIABILITY') ON CONFLICT (account_code) DO NOTHING`,
    [welfareFundCode(saccosId), `SACCOS #${saccosId} Member Welfare Fund`]
  );
}

async function fundBalance(db, saccosId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE -amount END), 0)::numeric AS balance
     FROM journal_entries je
     JOIN ledger_accounts la ON la.id = je.account_id
     WHERE la.account_code = $1`,
    [welfareFundCode(saccosId)]
  );
  return Number(r.rows[0].balance);
}

async function fetchScheme(saccosId, schemeId) {
  const r = await pool.query('SELECT * FROM saccos_welfare_schemes WHERE id = $1 AND saccos_id = $2', [schemeId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_WELFARE_SCHEME_NOT_FOUND');
  return r.rows[0];
}

async function fetchClaim(saccosId, claimId) {
  const r = await pool.query(
    `SELECT c.*, s.name AS scheme_name FROM saccos_welfare_claims c
     JOIN saccos_welfare_schemes s ON s.id = c.scheme_id
     WHERE c.id = $1 AND c.saccos_id = $2`,
    [claimId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_WELFARE_CLAIM_NOT_FOUND');
  return r.rows[0];
}

async function createScheme(actorId, saccosId, { name, contribution, payout }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const clean = (name || '').trim();
  const contrib = Number(contribution);
  const pay = Number(payout);
  if (!clean) throw createAppError('SACCOS_WELFARE_SCHEME_AMOUNT');
  if (!(contrib > 0) || !(pay > 0)) throw createAppError('SACCOS_WELFARE_SCHEME_AMOUNT');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT id FROM saccos_welfare_schemes WHERE saccos_id = $1 AND name = $2', [saccosId, clean]);
    if (dup.rows.length) throw createAppError('SACCOS_WELFARE_SCHEME_EXISTS');
    const r = await client.query(
      `INSERT INTO saccos_welfare_schemes (saccos_id, name, contribution, payout, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [saccosId, clean, contrib, pay, actorId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_WELFARE_SCHEME_CREATED', { referenceId: saccosId, details: { schemeId: r.rows[0].id, name: clean } }).catch(() => {});
    return { ...r.rows[0], contribution: Number(r.rows[0].contribution), payout: Number(r.rows[0].payout) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listSchemes(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT s.*, COUNT(DISTINCT c.member_id)::int AS members_joined,
            CASE WHEN EXISTS (SELECT 1 FROM saccos_welfare_contributions mine WHERE mine.scheme_id = s.id AND mine.member_id = $2) THEN TRUE ELSE FALSE END AS joined
     FROM saccos_welfare_schemes s
     LEFT JOIN saccos_welfare_contributions c ON c.scheme_id = s.id
     WHERE s.saccos_id = $1
     GROUP BY s.id ORDER BY s.created_at ASC`,
    [saccosId, membership.id]
  );
  return r.rows.map((row) => ({ ...row, contribution: Number(row.contribution), payout: Number(row.payout) }));
}

/** ACTIVE member joins a scheme by contributing (once per scheme, WLC-*). */
async function contribute(actorId, saccosId, { schemeId, amount }) {
  const membership = await requireActiveMember(actorId, saccosId);
  const scheme = await fetchScheme(saccosId, schemeId);
  if (scheme.status !== 'ACTIVE') throw createAppError('SACCOS_WELFARE_SCHEME_ARCHIVED');
  const value = round2(Number(amount));
  if (!(value > 0)) throw createAppError('SACCOS_WELFARE_CONTRIBUTION_LOW');
  if (value < Number(scheme.contribution)) throw createAppError('SACCOS_WELFARE_CONTRIBUTION_LOW');

  const ref = newRef('WLC');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureFundAccount(client, saccosId);
    const dup = await client.query(
      'SELECT id FROM saccos_welfare_contributions WHERE scheme_id = $1 AND member_id = $2 FOR UPDATE',
      [schemeId, membership.id]
    );
    if (dup.rows.length) throw createAppError('SACCOS_WELFARE_ALREADY_JOINED');
    const wallet = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [actorId]);
    if (Number(wallet.rows[0].wallet_balance) < value) throw createAppError('WALLET_INSUFFICIENT_FUNDS');
    await fin.debitWallet({
      client, userId: actorId, amount: value, reference: ref,
      toAccount: welfareFundCode(saccosId),
      description: `Mchango ustawi SACCOS #${saccosId}`, actor: 'saccos:welfare:contribute',
    });
    await client.query(
      `INSERT INTO saccos_welfare_contributions (saccos_id, scheme_id, member_id, reference_id, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [saccosId, schemeId, membership.id, ref, value]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_WELFARE_CONTRIBUTION', { referenceId: saccosId, details: { schemeId, amount: value, reference: ref } }).catch(() => {});
    return { reference: ref, schemeId, amount: value, contributed: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** ACTIVE member submits a claim against a scheme they joined. */
async function submitClaim(actorId, saccosId, { schemeId, event, details, amount }) {
  const membership = await requireActiveMember(actorId, saccosId);
  const scheme = await fetchScheme(saccosId, schemeId);
  if (scheme.status !== 'ACTIVE') throw createAppError('SACCOS_WELFARE_SCHEME_ARCHIVED');
  const value = round2(Number(amount));
  const cleanEvent = (event || '').trim();
  if (!cleanEvent) throw createAppError('SACCOS_WELFARE_CLAIM_AMOUNT');
  if (!(value > 0)) throw createAppError('SACCOS_WELFARE_CLAIM_AMOUNT');
  if (value > Number(scheme.payout)) throw createAppError('SACCOS_WELFARE_CLAIM_AMOUNT');
  const joined = await pool.query('SELECT 1 FROM saccos_welfare_contributions WHERE scheme_id = $1 AND member_id = $2', [schemeId, membership.id]);
  if (!joined.rows.length) throw createAppError('SACCOS_WELFARE_SCHEME_ARCHIVED');
  const active = await pool.query(
    `SELECT 1 FROM saccos_welfare_claims WHERE scheme_id = $1 AND member_id = $2 AND status IN ('SUBMITTED', 'APPROVED')`,
    [schemeId, membership.id]
  );
  if (active.rows.length) throw createAppError('SACCOS_WELFARE_CLAIM_ACTIVE');

  const ref = newRef('WLF');
  const r = await pool.query(
    `INSERT INTO saccos_welfare_claims (saccos_id, scheme_id, member_id, reference_id, event, details, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [saccosId, schemeId, membership.id, ref, cleanEvent, details || null, value]
  );
  await logAudit(actorId, 'SACCOS_WELFARE_CLAIM_SUBMITTED', { referenceId: saccosId, details: { claimId: r.rows[0].id, schemeId, amount: value } }).catch(() => {});
  return { ...r.rows[0], amount: Number(r.rows[0].amount) };
}

/** OWNER/BOARD approve or reject a SUBMITTED claim. */
async function reviewClaim(actorId, saccosId, claimId, decision) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const claim = await fetchClaim(saccosId, claimId);
  if (claim.status !== 'SUBMITTED') throw createAppError('SACCOS_WELFARE_CLAIM_STATE');
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await pool.query(
    `UPDATE saccos_welfare_claims SET status = $1, approved_by = $2, reviewed_at = NOW() WHERE id = $3`,
    [status, actorId, claimId]
  );
  await logAudit(actorId, decision === 'APPROVE' ? 'SACCOS_WELFARE_CLAIM_APPROVED' : 'SACCOS_WELFARE_CLAIM_REJECTED', { referenceId: saccosId, details: { claimId } }).catch(() => {});
  return { success: true, claimId, status, reference: claim.reference_id };
}

/** OWNER/BOARD pay an APPROVED claim out of the welfare fund (idempotent WLF-*). */
async function payClaim(actorId, saccosId, claimId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const claim = await fetchClaim(saccosId, claimId);
  if (claim.status !== 'APPROVED') throw createAppError('SACCOS_WELFARE_CLAIM_STATE');
  const member = await pool.query('SELECT user_id FROM saccos_members WHERE id = $1', [claim.member_id]);
  if (!member.rows.length) throw createAppError('SACCOS_MEMBER_NOT_FOUND');
  const userId = member.rows[0].user_id;
  const value = Number(claim.amount);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureFundAccount(client, saccosId);
    const balance = await fundBalance(client, saccosId);
    if (balance < value) throw createAppError('SACCOS_WELFARE_FUND_INSUFFICIENT');
    const payout = await fin.creditWallet({
      client, userId, amount: value, reference: claim.reference_id,
      fromAccount: welfareFundCode(saccosId),
      description: `Malipo ya ustawi SACCOS #${saccosId}`, actor: 'saccos:welfare:pay',
    });
    if (payout.dedup) throw createAppError('SACCOS_WELFARE_PAID');
    await client.query(
      `UPDATE saccos_welfare_claims SET status = 'PAID', paid_at = NOW(), txn_reference = $1 WHERE id = $2`,
      [claim.reference_id, claimId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_WELFARE_CLAIM_PAID', { referenceId: saccosId, details: { claimId, amount: value, reference: claim.reference_id } }).catch(() => {});
    return { success: true, claimId, status: 'PAID', reference: claim.reference_id, amount: value };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Members see own claims; OWNER/BOARD/ADMIN see all. */
async function listClaims(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  const governing = !!(membership && (membership.role === 'OWNER' || membership.role === 'BOARD'));
  if (!isPlatformAdmin && (!membership || membership.status !== 'ACTIVE')) throw createAppError('SACCOS_NOT_MEMBER');
  const all = isPlatformAdmin || governing;
  const r = all
    ? await pool.query(
      `SELECT c.*, s.name AS scheme_name, m.member_number, u.full_name FROM saccos_welfare_claims c
       JOIN saccos_welfare_schemes s ON s.id = c.scheme_id
       JOIN saccos_members m ON m.id = c.member_id
       JOIN users u ON u.id = m.user_id
       WHERE c.saccos_id = $1 ORDER BY c.created_at DESC`,
      [saccosId]
    )
    : await pool.query(
      `SELECT c.*, s.name AS scheme_name FROM saccos_welfare_claims c
       JOIN saccos_welfare_schemes s ON s.id = c.scheme_id
       WHERE c.saccos_id = $1 AND c.member_id = $2 ORDER BY c.created_at DESC`,
      [saccosId, membership.id]
    );
  return r.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

/** Member sees own contributions. */
async function myContributions(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT c.id, c.reference_id, c.amount, c.created_at, s.name AS scheme_name
     FROM saccos_welfare_contributions c
     JOIN saccos_welfare_schemes s ON s.id = c.scheme_id
     WHERE c.saccos_id = $1 AND c.member_id = $2 ORDER BY c.created_at DESC`,
    [saccosId, membership.id]
  );
  return r.rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

/** OWNER/BOARD welfare summary: fund balance + scheme stats. */
async function welfareSummary(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const balance = await fundBalance(pool, saccosId);
  const contrib = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total, COUNT(DISTINCT member_id)::int AS members_joined
     FROM saccos_welfare_contributions WHERE saccos_id = $1`,
    [saccosId]
  );
  const claims = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('SUBMITTED', 'APPROVED'))::int AS pending_count,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('SUBMITTED', 'APPROVED')), 0)::numeric AS pending_amount,
            COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0)::numeric AS paid_amount
     FROM saccos_welfare_claims WHERE saccos_id = $1`,
    [saccosId]
  );
  const schemes = await pool.query('SELECT COUNT(*)::int AS c FROM saccos_welfare_schemes WHERE saccos_id = $1', [saccosId]);
  return {
    fund_balance: round2(balance),
    total_contributions: Number(contrib.rows[0].total),
    contribution_count: contrib.rows[0].count,
    members_joined: contrib.rows[0].members_joined,
    pending_claims: claims.rows[0].pending_count,
    pending_amount: round2(Number(claims.rows[0].pending_amount)),
    paid_claims: claims.rows[0].paid_count,
    paid_amount: round2(Number(claims.rows[0].paid_amount)),
    schemes: schemes.rows[0].c,
  };
}

module.exports = {
  welfareFundCode,
  createScheme,
  listSchemes,
  contribute,
  submitClaim,
  reviewClaim,
  payClaim,
  listClaims,
  myContributions,
  welfareSummary,
};