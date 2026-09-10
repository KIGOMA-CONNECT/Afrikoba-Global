/**
 * SACCOS Digital Core - Shares (increment 2).
 * Share subscription and holdings, ledgered through the shared
 * double-entry core (financialEngine) so SACCOS money is not
 * off-ledger:
 *   purchase  -> debitWallet(user)   DR CUSTOMER_WALLET / CR SACCOS<id>_SHARES_CAPITAL
 *   reject    -> creditWallet(user)  DR SACCOS<id>_SHARES_CAPITAL / CR CUSTOMER_WALLET
 * Isolation: per-SACCOS EQUITY account codes; non-member reads 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_SHARE_CONFIG = { shareValue: 10000, minShares: 1, maxShares: 100000, autoApprove: true };

function shareConfig(saccos) {
  const c = (saccos.config && saccos.config.shareStructure) || {};
  return { ...DEFAULT_SHARE_CONFIG, ...c };
}

function sharesAccountCode(saccosId) {
  return `SACCOS${saccosId}_SHARES_CAPITAL`;
}

async function ensureSharesAccount(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, 'EQUITY')
     ON CONFLICT (account_code) DO NOTHING`,
    [sharesAccountCode(saccosId), `SACCOS #${saccosId} Shares Capital`]
  );
}

function newSolarRef() {
  return 'SCS-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function fetchPurchase(saccosId, purchaseId) {
  const r = await pool.query(
    'SELECT * FROM saccos_share_purchases WHERE id = $1 AND saccos_id = $2',
    [purchaseId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_SHARE_PURCHASE_NOT_FOUND');
  return r.rows[0];
}

async function purchaseShares(actorId, saccosId, { shares }) {
  const count = Number(shares);
  if (!Number.isInteger(count) || count <= 0) throw createAppError('SACCOS_SHARES_INVALID');

  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  const saccos = org.rows[0];
  if (saccos.status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');

  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');

  const cfg = shareConfig(saccos);
  if (count < cfg.minShares) throw createAppError('SACCOS_SHARES_BELOW_MIN');
  if (count > cfg.maxShares) throw createAppError('SACCOS_SHARES_ABOVE_MAX');

  const sharePrice = Number(cfg.shareValue);
  const total = Number((count * sharePrice).toFixed(2));
  const requiresApproval = cfg.autoApprove === false;
  const status = requiresApproval ? 'PENDING' : 'APPROVED';
  const ref = newSolarRef();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSharesAccount(client, saccosId);
    await fin.debitWallet({
      client,
      userId: actorId,
      amount: total,
      reference: ref,
      toAccount: sharesAccountCode(saccosId),
      description: `Hisa SACCOS #${saccosId}`,
      actor: 'saccos:shares:purchase',
    });
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_SHARE_PURCHASE', $4)`,
      [ref, actorId, total, JSON.stringify({ saccosId, shares: count, sharePrice, total, purchaseStatus: status })]
    );
    const purchase = await client.query(
      `INSERT INTO saccos_share_purchases
         (saccos_id, member_id, reference_id, shares, share_price, total_amount, status, requires_approval, decided_by, decision_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [saccosId, membership.id, ref, count, sharePrice, total, status, requiresApproval, requiresApproval ? null : actorId, requiresApproval ? null : new Date()]
    );
    if (!requiresApproval) {
      await client.query(
        `INSERT INTO saccos_share_holdings (saccos_id, member_id, share_count, total_value, avg_price)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id) DO UPDATE
         SET share_count = saccos_share_holdings.share_count + EXCLUDED.share_count,
             total_value = saccos_share_holdings.total_value + EXCLUDED.total_value,
             avg_price = (saccos_share_holdings.total_value + EXCLUDED.total_value) /
                         NULLIF(saccos_share_holdings.share_count + EXCLUDED.share_count, 0),
             updated_at = NOW()`,
        [saccosId, membership.id, count, total, sharePrice]
      );
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_SHARE_PURCHASE', { referenceId: saccosId, details: { purchaseId: purchase.rows[0].id, shares: count } }).catch(() => {});
    return purchase.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listMyShares(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership) throw createAppError('SACCOS_NOT_FOUND');
  const [hold, purchases] = await Promise.all([
    pool.query('SELECT share_count, total_value, avg_price, updated_at FROM saccos_share_holdings WHERE member_id = $1', [membership.id]),
    pool.query(`SELECT p.id, p.reference_id, p.shares, p.share_price, p.total_amount, p.status, p.requires_approval, p.created_at
                FROM saccos_share_purchases p WHERE p.saccos_id = $1 AND p.member_id = $2 ORDER BY p.created_at DESC`,
      [saccosId, membership.id]),
  ]);
  return { holdings: hold.rows[0] || { share_count: 0, total_value: 0, avg_price: 0 }, purchases: purchases.rows };
}

async function listPurchases(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT p.id, p.reference_id, p.shares, p.share_price, p.total_amount, p.status, p.requires_approval, p.decided_by, p.decision_at, p.created_at,
            m.member_number, u.full_name, u.phone_number
     FROM saccos_share_purchases p
     JOIN saccos_members m ON m.id = p.member_id
     JOIN users u ON u.id = m.user_id
     WHERE p.saccos_id = $1
     ORDER BY p.created_at DESC`,
    [saccosId]
  );
  return r.rows;
}

async function decidePurchase(actorId, saccosId, purchaseId, decision) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const purchase = await fetchPurchase(saccosId, purchaseId);
  if (purchase.status !== 'PENDING') throw createAppError('SACCOS_SHARE_DECIDED');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (decision === 'APPROVE') {
      await client.query(
        `UPDATE saccos_share_purchases SET status = 'APPROVED', decided_by = $1, decision_at = NOW() WHERE id = $2`,
        [actorId, purchaseId]
      );
      await client.query(
        `INSERT INTO saccos_share_holdings (saccos_id, member_id, share_count, total_value, avg_price)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_id) DO UPDATE
         SET share_count = saccos_share_holdings.share_count + EXCLUDED.share_count,
             total_value = saccos_share_holdings.total_value + EXCLUDED.total_value,
             avg_price = (saccos_share_holdings.total_value + EXCLUDED.total_value) /
                         NULLIF(saccos_share_holdings.share_count + EXCLUDED.share_count, 0),
             updated_at = NOW()`,
        [saccosId, purchase.member_id, purchase.shares, Number(purchase.total_amount), Number(purchase.share_price)]
      );
    } else {
      await ensureSharesAccount(client, purchase.saccos_id);
      const refundRef = purchase.reference_id + '-R';
      const member = await client.query('SELECT user_id FROM saccos_members WHERE id = $1', [purchase.member_id]);
      if (!member.rows.length) throw createAppError('SACCOS_MEMBER_NOT_FOUND');
      await fin.creditWallet({
        client,
        userId: member.rows[0].user_id,
        amount: Number(purchase.total_amount),
        reference: refundRef,
        fromAccount: sharesAccountCode(purchase.saccos_id),
        description: `Rudisho la hisa SACCOS #${purchase.saccos_id}`,
        actor: 'saccos:shares:reject',
      });
      await client.query(
        `UPDATE transactions SET reversed_at = NOW(), reversed_ref = $1 WHERE reference_id = $2`,
        [refundRef, purchase.reference_id]
      );
      await client.query(
        `UPDATE saccos_share_purchases SET status = 'REJECTED', decided_by = $1, decision_at = NOW() WHERE id = $2`,
        [actorId, purchaseId]
      );
    }
    await client.query('COMMIT');
    await logAudit(actorId, decision === 'APPROVE' ? 'SACCOS_SHARE_APPROVED' : 'SACCOS_SHARE_REJECTED', { referenceId: saccosId, details: { purchaseId } }).catch(() => {});
    return { success: true, purchaseId, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function sharesSummary(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const org = await pool.query('SELECT config FROM saccos WHERE id = $1', [saccosId]);
  const cfg = shareConfig(org.rows[0] || { config: {} });
  const r = await pool.query(
    `SELECT COALESCE(SUM(share_count),0)::int AS total_shares,
            COALESCE(SUM(total_value),0) AS total_value,
            COUNT(*)::int AS holders
     FROM saccos_share_holdings WHERE saccos_id = $1`,
    [saccosId]
  );
  return { ...r.rows[0], shareValue: cfg.shareValue, currency: 'TZS' };
}

module.exports = {
  purchaseShares,
  listMyShares,
  listPurchases,
  decidePurchase,
  sharesSummary,
  sharesAccountCode,
};