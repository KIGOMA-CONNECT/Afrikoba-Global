/**
 * SACCOS Digital Core - Investments (increment 7, final).
 * Member term investments inside a SACCOS. OWNER/BOARD define
 * products (INVP-*); members subscribe (INV-*) and are
 * auto-approved or OWNER/BOARD-approved. Subscription moves funds
 * via `debitWallet`: DR CUSTOMER_WALLET / CR per-entity LIABILITY
 * `SACCOS<id>_INVESTMENTS_LIABILITY` + `SACCOS_INVESTMENT_
 * SUBSCRIPTION` txn. Redemption at maturity (flat interest =
 * principal * rate% * termMonths/12) is a 3-leg journal
 * (DR LIABILITY principal / DR `SACCOS<id>_INVESTMENT_INTEREST_
 * EXPENSE` interest / CR CUSTOMER_WALLET) idempotent on RED-*,
 * wallet FOR UPDATE guard. Rejects return funds via `creditWallet`
 * on a fresh -R reference (SUCCESS terminal). Cross-entity 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_INVEST_CONFIG = {
  autoApprove: true,
  minAmount: 0,
  maxAmount: null,
  defaultAnnualRatePercent: 10,
  defaultTermMonths: 12,
};

function investConfig(saccos) {
  const c = (saccos.config && saccos.config.investments) || {};
  return { ...DEFAULT_INVEST_CONFIG, ...c };
}

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function investmentLiabilityCode(saccosId) {
  return `SACCOS${saccosId}_INVESTMENTS_LIABILITY`;
}
function interestExpenseCode(saccosId) {
  return `SACCOS${saccosId}_INVESTMENT_INTEREST_EXPENSE`;
}
function interestFor(principal, ratePercent, termMonths) {
  return Math.round(principal * (ratePercent / 100) * (termMonths / 12) * 100) / 100;
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

async function requireAdminOrActive(actorId, saccosId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (isPlatformAdmin) return { membership: null };
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return { membership };
}

async function fetchProduct(saccosId, productId) {
  const r = await pool.query('SELECT * FROM saccos_investment_products WHERE id = $1 AND saccos_id = $2', [productId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_INV_PRODUCT_NOT_FOUND');
  return r.rows[0];
}

async function fetchInvestment(saccosId, investmentId) {
  const r = await pool.query('SELECT * FROM saccos_investments WHERE id = $1 AND saccos_id = $2', [investmentId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_INV_NOT_FOUND');
  return r.rows[0];
}

async function ensureInvestmentAccounts(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, 'LIABILITY'), ($3, $4, 'EXPENSE')
     ON CONFLICT (account_code) DO NOTHING`,
    [investmentLiabilityCode(saccosId), `SACCOS #${saccosId} Member Investments`,
     interestExpenseCode(saccosId), `SACCOS #${saccosId} Investment Interest Expense`]
  );
}

async function createProduct(actorId, saccosId, { name, minAmount, maxAmount, annualRatePercent, termMonths }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = investConfig(saccos);
  const clean = (name || '').trim();
  if (!clean) throw createAppError('SACCOS_INV_NAME_REQUIRED');
  const rate = annualRatePercent !== undefined ? Number(annualRatePercent) : cfg.defaultAnnualRatePercent;
  const term = termMonths !== undefined ? Number(termMonths) : cfg.defaultTermMonths;
  if (rate < 0 || term <= 0 || !(term >= 1)) throw createAppError('SACCOS_INV_RATE_OR_TERM');
  const r = await pool.query(
    `INSERT INTO saccos_investment_products (saccos_id, reference_id, name, min_amount, max_amount, annual_rate_percent, term_months, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [saccosId, newRef('INVP'), clean, Number(minAmount) || 0, maxAmount ? Number(maxAmount) : null, rate, term, actorId]
  );
  await logAudit(actorId, 'SACCOS_INV_PRODUCT_CREATED', { referenceId: saccosId, details: { productId: r.rows[0].id, reference: r.rows[0].reference_id } }).catch(() => {});
  return r.rows[0];
}

async function archiveProduct(actorId, saccosId, productId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  await fetchProduct(saccosId, productId);
  const r = await pool.query("UPDATE saccos_investment_products SET status = 'ARCHIVED' WHERE id = $1 AND saccos_id = $2 RETURNING *", [productId, saccosId]);
  await logAudit(actorId, 'SACCOS_INV_PRODUCT_ARCHIVED', { referenceId: saccosId, details: { productId } }).catch(() => {});
  return r.rows[0];
}

async function listProducts(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    'SELECT * FROM saccos_investment_products WHERE saccos_id = $1 ORDER BY created_at DESC',
    [saccosId]
  );
  return r.rows.map((p) => ({ ...p, min_amount: Number(p.min_amount), max_amount: p.max_amount === null ? null : Number(p.max_amount), annual_rate_percent: Number(p.annual_rate_percent) }));
}

async function applyInvestment(actorId, saccosId, { productId, amount, termMonths }) {
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = investConfig(saccos);
  const membership = await requireActiveMember(actorId, saccosId);
  const product = await fetchProduct(saccosId, Number(productId));
  if (product.status !== 'ACTIVE') throw createAppError('SACCOS_INV_PRODUCT_INACTIVE');

  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('SACCOS_INV_AMOUNT');
  if (amountN < Number(product.min_amount)) throw createAppError('SACCOS_INV_BELOW_MIN');
  if (product.max_amount !== null && amountN > Number(product.max_amount)) throw createAppError('SACCOS_INV_ABOVE_MAX');
  const term = termMonths !== undefined ? Number(termMonths) : Number(product.term_months);
  if (!(term >= 1)) throw createAppError('SACCOS_INV_RATE_OR_TERM');

  const reference = newRef('INV');
  const expectedInterest = interestFor(amountN, Number(product.annual_rate_percent), term);
  const maturity = new Date();
  maturity.setMonth(maturity.getMonth() + term);

  if (cfg.autoApprove) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ensureInvestmentAccounts(client, saccosId);
      const debit = await fin.debitWallet({
        client, userId: actorId, amount: amountN,
        toAccount: investmentLiabilityCode(saccosId),
        reference, description: `SACCOS #${saccosId} investment subscription`, actor: 'saccos-investments',
      });
      if (debit.dedup) {
        await client.query('ROLLBACK');
        return { dedup: true, reference };
      }
      const inv = await client.query(
        `INSERT INTO saccos_investments (saccos_id, product_id, member_id, reference_id, amount, annual_rate_percent, term_months, expected_interest, status, maturity_date, subscribed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9, NOW()) RETURNING *`,
        [saccosId, product.id, membership.id, reference, amountN, Number(product.annual_rate_percent), term, expectedInterest, maturity.toISOString().slice(0, 10)]
      );
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'SACCOS_INVESTMENT_SUBSCRIPTION', $4)`,
        [reference, actorId, amountN, JSON.stringify({ saccosId, investmentId: inv.rows[0].id, expectedInterest })]
      );
      await client.query('COMMIT');
      await logAudit(actorId, 'SACCOS_INV_SUBSCRIBED', { referenceId: saccosId, details: { reference, amount: amountN, interest: expectedInterest } }).catch(() => {});
      return { ...inv.rows[0], amount: Number(inv.rows[0].amount), expected_interest: Number(inv.rows[0].expected_interest) };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  const inv = await pool.query(
    `INSERT INTO saccos_investments (saccos_id, product_id, member_id, reference_id, amount, annual_rate_percent, term_months, expected_interest, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING') RETURNING *`,
    [saccosId, product.id, membership.id, reference, amountN, Number(product.annual_rate_percent), term, expectedInterest]
  );
  await logAudit(actorId, 'SACCOS_INV_APPLIED', { referenceId: saccosId, details: { reference, productId: product.id } }).catch(() => {});
  return { ...inv.rows[0], amount: Number(inv.rows[0].amount), expected_interest: Number(inv.rows[0].expected_interest) };
}

async function decideInvestment(actorId, saccosId, investmentId, approve) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const investment = await fetchInvestment(saccosId, investmentId);
  if (investment.status !== 'PENDING') throw createAppError('SACCOS_INV_STATE');

  if (!approve) {
    const r = await pool.query(
      `UPDATE saccos_investments SET status = 'REJECTED', decided_by = $1, decided_at = NOW() WHERE id = $2 RETURNING *`,
      [actorId, investmentId]
    );
    await logAudit(actorId, 'SACCOS_INV_REJECTED', { referenceId: saccosId, details: { investmentId } }).catch(() => {});
    return r.rows[0];
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureInvestmentAccounts(client, saccosId);
    const ref = newRef('INV');
    const member = await client.query('SELECT user_id FROM saccos_members WHERE id = $1', [investment.member_id]);
    await fin.debitWallet({
      client, userId: member.rows[0].user_id, amount: Number(investment.amount),
      toAccount: investmentLiabilityCode(saccosId), reference: ref,
      description: `SACCOS #${saccosId} investment subscription (approved)`, actor: 'saccos-investments',
    });
    const r = await client.query(
      `UPDATE saccos_investments SET status = 'ACTIVE', decided_by = $1, decided_at = NOW(), subscribed_at = NOW()
       WHERE id = $2 AND status = 'PENDING' RETURNING *`,
      [actorId, investmentId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_INV_APPROVED', { referenceId: saccosId, details: { investmentId, reference: ref } }).catch(() => {});
    return r.rows[0];
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function redeemInvestment(actorId, saccosId, investmentId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const investment = await fetchInvestment(saccosId, investmentId);
  if (investment.member_id !== membership.id) throw createAppError('SACCOS_RBAC');
  if (!['ACTIVE', 'MATURED'].includes(investment.status)) throw createAppError('SACCOS_INV_STATE');
  const principal = Number(investment.amount);
  const interest = Number(investment.expected_interest);
  const total = Math.round((principal + interest) * 100) / 100;
  const maturity = new Date(investment.maturity_date);
  maturity.setHours(23, 59, 59, 999);
  if (new Date() < maturity) throw createAppError('SACCOS_INV_NOT_MATURED');

  const reference = newRef('RED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureInvestmentAccounts(client, saccosId);
    const from = await client.query(`SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE`, [actorId]);
    const before = Number(from.rows[0].wallet_balance);
    const op = await fin.claimOperation({ client, operationType: 'SACCOS_INVESTMENT_REDEMPTION', reference, userId: actorId, amount: total });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    await fin.postJournal({
      client,
      lines: [
        { accountCode: investmentLiabilityCode(saccosId), direction: 'DR', amount: principal },
        { accountCode: interestExpenseCode(saccosId), direction: 'DR', amount: interest },
        { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: total },
      ],
      referenceId: reference, description: `SACCOS #${saccosId} investment redemption`, postedBy: 'saccos-investments',
    });
    await client.query(`UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`, [total, actorId]);
    await fin.auditBalance({ client, accountKind: 'USER_BALANCE', accountId: actorId, operation: 'investment_redemption', amount: total, balanceBefore: before, balanceAfter: before + total, reference, actor: 'saccos-investments' }).catch(() => {});
    const r = await client.query(
      `UPDATE saccos_investments SET status = 'CLOSED', redeemed_at = NOW() WHERE id = $1 AND status = 'ACTIVE' RETURNING *`,
      [investmentId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_INV_REDEEMED', { referenceId: saccosId, details: { investmentId, reference, principal, interest, total } }).catch(() => {});
    return { ...r.rows[0], principal, interest, total, reference };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listMine(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT i.*, p.name AS product_name FROM saccos_investments i
     JOIN saccos_investment_products p ON p.id = i.product_id
     WHERE i.member_id = $1 AND i.saccos_id = $2 ORDER BY i.created_at DESC`,
    [membership.id, saccosId]
  );
  return r.rows.map((i) => ({ ...i, amount: Number(i.amount), expected_interest: Number(i.expected_interest) }));
}

async function investmentsSummary(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
            COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
            COALESCE(SUM(amount) FILTER (WHERE status IN ('ACTIVE','PENDING')), 0)::numeric AS invested,
            (SELECT COUNT(*)::int FROM saccos_investment_products WHERE saccos_id = $1) AS products
     FROM saccos_investments WHERE saccos_id = $1`,
    [saccosId]
  );
  return { ...r.rows[0], invested: Number(r.rows[0].invested) };
}

module.exports = {
  createProduct,
  archiveProduct,
  listProducts,
  applyInvestment,
  decideInvestment,
  redeemInvestment,
  listMine,
  investmentsSummary,
};