/**
 * SACCOS Digital Core - Credit (increment 4).
 * Member loan life-cycle ledgered on the shared double-entry core
 * (financialEngine) so SACCOS credit is not off-ledger:
 *   disburse -> DR SACCOS<id>_LOANS_RECEIVABLE (ASSET) / CR CUSTOMER_WALLET
 *   repay    -> DR CUSTOMER_WALLET / CR SACCOS<id>_LOANS_RECEIVABLE (principal)
 *                             / CR SACCOS<id>_INTEREST_INCOME (REVENUE, interest)
 * Flat interest: total_repayable = principal * (1 + rate%/100 * termMonths/12).
 * Repayments split principal/interest proportionally to the loan mix
 * (deterministic, always balanced); the loan closes at zero outstanding.
 * Config (saccos.config.lending): {interestRate, minAmount, maxAmount,
 * maxTermMonths, maxActiveLoans, autoDisburse}. Isolation: per-SACCOS
 * ASSET/REVENUE codes; non-member reads 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_LENDING_CONFIG = {
  interestRate: 12,
  minAmount: 10000,
  maxAmount: null,
  maxTermMonths: 12,
  maxActiveLoans: 1,
  autoDisburse: true,
  graceDays: 0,
  lateFeePercent: 2,
  savingsBackingEnabled: false,
  savingsBackingMultiple: 3,
  guaranteesRequired: 0,
  maxExposureAmount: null,
  maxExposureMultiple: null,
  maxConcentrationPercent: null,
};

function lendingConfig(saccos) {
  const c = (saccos.config && saccos.config.lending) || {};
  return { ...DEFAULT_LENDING_CONFIG, ...c };
}

function loansReceivableCode(saccosId) {
  return `SACCOS${saccosId}_LOANS_RECEIVABLE`;
}
function interestIncomeCode(saccosId) {
  return `SACCOS${saccosId}_INTEREST_INCOME`;
}
function lateFeeIncomeCode(saccosId) {
  return `SACCOS${saccosId}_LATE_FEE_INCOME`;
}

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function requireActiveMember(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.status !== 'ACTIVE') throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function fetchActiveOrg(actorId, saccosId) {
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  if (org.rows[0].status !== 'ACTIVE') throw createAppError('SACCOS_SHARES_NOT_ACTIVE');
  return org.rows[0];
}

async function ensureCreditAccounts(client, saccosId) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type) VALUES ($1, $2, 'ASSET')
     ON CONFLICT (account_code) DO NOTHING`,
    [loansReceivableCode(saccosId), `SACCOS #${saccosId} Loans Receivable`]
  );
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type) VALUES ($1, $2, 'REVENUE')
     ON CONFLICT (account_code) DO NOTHING`,
    [interestIncomeCode(saccosId), `SACCOS #${saccosId} Interest Income`]
  );
}

/** Credit a member wallet from a SACCOS account: DR <fromAccount> / CR CUSTOMER_WALLET. */
async function creditFromSaccos({ client, userId, amount, reference, fromAccount, description, actor, txnType }) {
  const amountN = Number(amount);
  const op = await fin.claimOperation({ client, operationType: 'CREDIT', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };
  const before = Number((await client.query('SELECT wallet_balance FROM users WHERE id = $1', [userId])).rows[0].wallet_balance);
  await fin.postJournal({
    client,
    lines: [
      { accountCode: fromAccount, direction: 'DR', amount: amountN },
      { accountCode: 'CUSTOMER_WALLET', direction: 'CR', amount: amountN },
    ],
    referenceId: reference, description, postedBy: actor,
  });
  await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amountN, userId]);
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [reference, userId, amountN, txnType, JSON.stringify({ description })]
  );
  return { success: true, reference, amount: amountN, balanceBefore: before, balanceAfter: before + amountN };
}

/** Debit a member wallet into a SACCOS account: DR CUSTOMER_WALLET / CR <toAccount> (multi-credit allowed). */
async function debitToSaccos({ client, userId, amount, reference, toAccounts, description, actor, txnType }) {
  const amountN = Number(amount);
  const op = await fin.claimOperation({ client, operationType: 'DEBIT', reference, userId, amount: amountN });
  if (!op.claimed) return { dedup: true, reference };
  const before = Number((await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0].wallet_balance);
  if (before < amountN) throw createAppError('WALLET_INSUFFICIENT_FUNDS');
  await fin.postJournal({
    client,
    lines: [
      { accountCode: 'CUSTOMER_WALLET', direction: 'DR', amount: amountN },
      ...toAccounts.map((a) => ({ accountCode: a.code, direction: 'CR', amount: a.amount })),
    ],
    referenceId: reference, description, postedBy: actor,
  });
  await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountN, userId]);
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [reference, userId, amountN, txnType, JSON.stringify({ description })]
  );
  return { success: true, reference, amount: amountN, balanceBefore: before, balanceAfter: before - amountN };
}

/** Flat-interest math: principal, rate %, termMonths -> {interest, total}. */
function repaymentMath(principal, rate, termMonths, amount) {
  const interest = round2((Number(principal) * Number(rate) / 100) * Number(termMonths) / 12);
  const total = round2(Number(principal) + interest);
  const pay = Math.min(Number(amount), total);
  const principalPart = round2(pay * (total > 0 ? Number(principal) / total : 0));
  const interestPart = round2(pay - principalPart);
  return { interest, total, pay, principalPart, interestPart };
}

async function fetchApplication(saccosId, applicationId) {
  const r = await pool.query(
    'SELECT * FROM saccos_loan_applications WHERE id = $1 AND saccos_id = $2',
    [applicationId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_APPLICATION_NOT_FOUND');
  return r.rows[0];
}

async function fetchLoan(saccosId, loanId) {
  const r = await pool.query('SELECT * FROM saccos_loans WHERE id = $1 AND saccos_id = $2', [loanId, saccosId]);
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_NOT_FOUND');
  return r.rows[0];
}

/* ============================================================
 * Lending products (increment 19) - OWNER/BOARD-defined loan
 * schemes: a named product carries its own flat interest rate,
 * amount band and max tenor; applications reference it via
 * productId and the loan snapshots the product rate at approval.
 * ============================================================ */

function productShape(p) {
  return {
    id: Number(p.id),
    saccos_id: Number(p.saccos_id),
    code: p.code,
    name: p.name,
    description: p.description,
    interest_rate_percent: Number(p.interest_rate_percent),
    min_amount: Number(p.min_amount),
    max_amount: p.max_amount === null ? null : Number(p.max_amount),
    max_term_months: Number(p.max_term_months),
    status: p.status,
    created_at: p.created_at,
  };
}

async function fetchProduct(saccosId, productId) {
  const r = await pool.query(
    'SELECT * FROM saccos_lending_products WHERE id = $1 AND saccos_id = $2',
    [productId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_PRODUCT_NOT_FOUND');
  return r.rows[0];
}

/** Active product required at application time (ARCHIVED rejected). */
async function fetchActiveProduct(saccosId, productId) {
  const product = await fetchProduct(saccosId, productId);
  if (product.status !== 'ACTIVE') throw createAppError('SACCOS_LOAN_PRODUCT_ARCHIVED');
  return product;
}

async function createProduct(actorId, saccosId, { code, name, description, interestRatePercent, minAmount, maxAmount, maxTermMonths }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '_').slice(0, 32);
  const n = String(name || '').trim();
  const rate = Number(interestRatePercent);
  const min = Number(minAmount) || 0;
  const max = maxAmount === null || maxAmount === undefined || maxAmount === '' ? null : Number(maxAmount);
  const term = Number(maxTermMonths);
  if (!c || !n) throw createAppError('SACCOS_LOAN_PRODUCT_INVALID');
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw createAppError('SACCOS_LOAN_PRODUCT_INVALID');
  if (!Number.isFinite(min) || min < 0) throw createAppError('SACCOS_LOAN_PRODUCT_INVALID');
  if (max !== null && (!Number.isFinite(max) || max <= 0 || max < min)) throw createAppError('SACCOS_LOAN_PRODUCT_INVALID');
  if (!Number.isInteger(term) || term < 1 || term > 120) throw createAppError('SACCOS_LOAN_PRODUCT_INVALID');
  const dup = await pool.query('SELECT 1 FROM saccos_lending_products WHERE saccos_id = $1 AND code = $2', [saccosId, c]);
  if (dup.rows.length) throw createAppError('SACCOS_LOAN_PRODUCT_CODE_TAKEN');
  const r = await pool.query(
    `INSERT INTO saccos_lending_products
       (saccos_id, code, name, description, interest_rate_percent, min_amount, max_amount, max_term_months, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [saccosId, c, n, description || null, rate, min, max, term, actorId]
  );
  await logAudit(actorId, 'SACCOS_LOAN_PRODUCT_CREATED', { referenceId: saccosId, details: { productId: r.rows[0].id, code: c } }).catch(() => {});
  return productShape(r.rows[0]);
}

async function listProducts(actorId, saccosId) {
  await saccosCore.assertVisible(actorId, saccosId);
  const r = await pool.query(
    `SELECT * FROM saccos_lending_products WHERE saccos_id = $1 ORDER BY (status = 'ARCHIVED'), created_at, id`,
    [saccosId]
  );
  return r.rows.map(productShape);
}

async function archiveProduct(actorId, saccosId, productId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const product = await fetchProduct(saccosId, productId);
  if (product.status === 'ARCHIVED') throw createAppError('SACCOS_LOAN_PRODUCT_ARCHIVED');
  const r = await pool.query(
    `UPDATE saccos_lending_products SET status = 'ARCHIVED', updated_at = NOW() WHERE id = $1 RETURNING *`,
    [productId]
  );
  await logAudit(actorId, 'SACCOS_LOAN_PRODUCT_ARCHIVED', { referenceId: saccosId, details: { productId, code: product.code } }).catch(() => {});
  return productShape(r.rows[0]);
}

async function countActiveLoans(saccosId, memberId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM saccos_loans WHERE saccos_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
    [saccosId, memberId]
  );
  return r.rows[0].c;
}

/** Collateral backing = member savings balance + share holdings book value. */
async function memberBacking(saccosId, memberId, multiple, db = pool) {
  const r = await db.query(
    `SELECT COALESCE((SELECT SUM(balance) FROM saccos_savings_accounts WHERE saccos_id = $1 AND member_id = $2), 0)::numeric AS savings_balance,
            COALESCE((SELECT total_value FROM saccos_share_holdings WHERE saccos_id = $1 AND member_id = $2), 0)::numeric AS share_value`,
    [saccosId, memberId]
  );
  const savings_balance = Number(r.rows[0].savings_balance);
  const share_value = Number(r.rows[0].share_value);
  const backing_balance = round2(savings_balance + share_value);
  const multipleN = Number(multiple) || 0;
  return {
    savings_balance: round2(savings_balance),
    share_value: round2(share_value),
    backing_balance,
    multiple: multipleN,
    enabled: multipleN > 0,
    backing_limit: multipleN > 0 ? round2(backing_balance * multipleN) : 0,
  };
}

/* ============================================================
 * Loan guarantors / co-signers (increment 17)
 * ============================================================ */

async function fetchGuarantee(saccosId, guaranteeId, db = pool) {
  const r = await db.query(
    'SELECT * FROM saccos_loan_guarantees WHERE id = $1 AND saccos_id = $2',
    [guaranteeId, saccosId]
  );
  if (!r.rows.length) throw createAppError('SACCOS_LOAN_GUARANTOR_NOT_FOUND');
  return r.rows[0];
}

/** A guarantor's own backing limit (0 when savings backing is off). */
async function guarantorCover(saccosId, memberId, cfg, db = pool) {
  const b = await memberBacking(saccosId, memberId, cfg.savingsBackingEnabled ? cfg.savingsBackingMultiple : 0, db);
  return b.backing_limit;
}

/** Accepted-guarantee aggregate for an application. */
async function acceptedCover(saccosId, applicationId, db = pool) {
  const r = await db.query(
    `SELECT COALESCE(SUM(cover_amount), 0)::numeric AS cover, COUNT(*)::int AS accepted
       FROM saccos_loan_guarantees
      WHERE saccos_id = $1 AND application_id = $2 AND status = 'ACCEPTED'`,
    [saccosId, applicationId]
  );
  return { cover: round2(r.rows[0].cover), accepted: Number(r.rows[0].accepted) };
}

/** Nominate a co-signer (borrower or OWNER/BOARD) while the application is PENDING. */
async function addGuarantor(actorId, saccosId, applicationId, { guarantorMemberId }) {
  const app = await fetchApplication(saccosId, applicationId);
  if (app.status !== 'PENDING') throw createAppError('SACCOS_LOAN_GUARANTOR_APP_CLOSED');
  const membership = await requireActiveMember(actorId, saccosId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  if (app.member_id !== membership.id && !governing) throw createAppError('SACCOS_RBAC');
  const gid = Number(guarantorMemberId);
  if (!Number.isInteger(gid) || gid <= 0) throw createAppError('SACCOS_LOAN_GUARANTOR_NOT_MEMBER');
  if (gid === app.member_id) throw createAppError('SACCOS_LOAN_GUARANTOR_SELF');
  const gm = await pool.query(
    `SELECT id FROM saccos_members WHERE id = $1 AND saccos_id = $2 AND status = 'ACTIVE'`,
    [gid, saccosId]
  );
  if (!gm.rows.length) throw createAppError('SACCOS_LOAN_GUARANTOR_NOT_MEMBER');
  const dup = await pool.query(
    'SELECT 1 FROM saccos_loan_guarantees WHERE application_id = $1 AND guarantor_member_id = $2',
    [applicationId, gid]
  );
  if (dup.rows.length) throw createAppError('SACCOS_LOAN_GUARANTOR_EXISTS');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = lendingConfig(saccos);
  const cover = await guarantorCover(saccosId, gid, cfg);
  const r = await pool.query(
    `INSERT INTO saccos_loan_guarantees
       (saccos_id, application_id, guarantor_member_id, reference_id, cover_amount, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [saccosId, applicationId, gid, newRef('GNT'), cover, actorId]
  );
  await logAudit(actorId, 'SACCOS_GUARANTOR_ADDED', {
    referenceId: saccosId, details: { applicationId, guaranteeId: r.rows[0].id, guarantorMemberId: gid, cover },
  }).catch(() => {});
  return { ...r.rows[0], cover_amount: Number(r.rows[0].cover_amount), paid_amount: Number(r.rows[0].paid_amount) };
}

/** The nominated member accepts the guarantee (PENDING -> ACCEPTED). */
async function acceptGuarantee(actorId, saccosId, guaranteeId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const g = await fetchGuarantee(saccosId, guaranteeId);
  if (g.guarantor_member_id !== membership.id) throw createAppError('SACCOS_RBAC');
  if (g.status !== 'PENDING') throw createAppError('SACCOS_LOAN_GUARANTOR_STATE');
  const app = await fetchApplication(saccosId, g.application_id);
  if (app.status !== 'PENDING') throw createAppError('SACCOS_LOAN_GUARANTOR_APP_CLOSED');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = lendingConfig(saccos);
  const cover = await guarantorCover(saccosId, membership.id, cfg);
  const r = await pool.query(
    `UPDATE saccos_loan_guarantees
        SET status = 'ACCEPTED', cover_amount = $1, accepted_at = NOW()
      WHERE id = $2 RETURNING *`,
    [cover, guaranteeId]
  );
  await logAudit(actorId, 'SACCOS_GUARANTOR_ACCEPTED', {
    referenceId: saccosId, details: { guaranteeId, applicationId: g.application_id, cover },
  }).catch(() => {});
  return { ...r.rows[0], cover_amount: Number(r.rows[0].cover_amount), paid_amount: Number(r.rows[0].paid_amount) };
}

/** Withdraw a guarantee before the loan is disbursed (borrower, guarantor or OWNER/BOARD). */
async function removeGuarantee(actorId, saccosId, guaranteeId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  const g = await fetchGuarantee(saccosId, guaranteeId);
  if (!['PENDING', 'ACCEPTED'].includes(g.status)) throw createAppError('SACCOS_LOAN_GUARANTOR_STATE');
  const app = await fetchApplication(saccosId, g.application_id);
  const allowed = app.member_id === membership.id || g.guarantor_member_id === membership.id || governing;
  if (!allowed) throw createAppError('SACCOS_RBAC');
  const r = await pool.query(
    `UPDATE saccos_loan_guarantees SET status = 'RELEASED', released_at = NOW() WHERE id = $1 RETURNING *`,
    [guaranteeId]
  );
  await logAudit(actorId, 'SACCOS_GUARANTOR_RELEASED', {
    referenceId: saccosId, details: { guaranteeId, applicationId: g.application_id },
  }).catch(() => {});
  return { ...r.rows[0], cover_amount: Number(r.rows[0].cover_amount), paid_amount: Number(r.rows[0].paid_amount) };
}

/** Guarantees on one application (borrower or OWNER/BOARD). */
async function listGuarantees(actorId, saccosId, applicationId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const governing = ['OWNER', 'BOARD'].includes(membership.role);
  const app = await fetchApplication(saccosId, applicationId);
  if (app.member_id !== membership.id && !governing) throw createAppError('SACCOS_RBAC');
  const r = await pool.query(
    `SELECT g.*, m.member_number, u.full_name, u.phone_number
       FROM saccos_loan_guarantees g
       JOIN saccos_members m ON m.id = g.guarantor_member_id
       JOIN users u ON u.id = m.user_id
      WHERE g.saccos_id = $1 AND g.application_id = $2
      ORDER BY g.created_at`,
    [saccosId, applicationId]
  );
  return r.rows.map((x) => ({ ...x, cover_amount: Number(x.cover_amount), paid_amount: Number(x.paid_amount) }));
}

/** Guarantees this member has given (where they are the co-signer). */
async function myGuarantees(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const r = await pool.query(
    `SELECT g.*, a.reference_id AS application_reference, a.requested_amount, a.status AS application_status,
            u.full_name AS borrower_name
       FROM saccos_loan_guarantees g
       JOIN saccos_loan_applications a ON a.id = g.application_id
       JOIN saccos_members bm ON bm.id = a.member_id
       JOIN users u ON u.id = bm.user_id
      WHERE g.saccos_id = $1 AND g.guarantor_member_id = $2
      ORDER BY g.created_at DESC`,
    [saccosId, membership.id]
  );
  return r.rows.map((x) => ({ ...x, cover_amount: Number(x.cover_amount), paid_amount: Number(x.paid_amount), requested_amount: Number(x.requested_amount) }));
}

/** Activate ACCEPTED guarantees when the loan disburses. */
async function activateGuarantees(client, saccosId, applicationId, loanId) {
  await client.query(
    `UPDATE saccos_loan_guarantees SET status = 'ACTIVE', loan_id = $1
      WHERE saccos_id = $2 AND application_id = $3 AND status = 'ACCEPTED'`,
    [loanId, saccosId, applicationId]
  );
}

/** Release not-yet-active guarantees when an application is rejected/withdrawn. */
async function releaseGuaranteesForApplication(client, saccosId, applicationId) {
  await client.query(
    `UPDATE saccos_loan_guarantees SET status = 'RELEASED', released_at = NOW()
      WHERE saccos_id = $1 AND application_id = $2 AND status IN ('PENDING', 'ACCEPTED')`,
    [saccosId, applicationId]
  );
}

/** Release ACTIVE guarantees when a loan is repaid, written off or restructured. */
async function releaseGuaranteesForLoan(client, saccosId, loanId) {
  await client.query(
    `UPDATE saccos_loan_guarantees SET status = 'RELEASED', released_at = NOW()
      WHERE saccos_id = $1 AND loan_id = $2 AND status = 'ACTIVE'`,
    [saccosId, loanId]
  );
}

/* ============================================================
 * Risk-limit helpers (increment 21b)
 * ============================================================ */

async function memberExposure(saccosId, memberId, db = pool) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount_outstanding), 0)::numeric AS exposure
       FROM saccos_loans WHERE saccos_id = $1 AND member_id = $2 AND status = 'ACTIVE'`,
    [saccosId, memberId]
  );
  return Number(r.rows[0].exposure);
}

async function assertMemberExposure(saccosId, memberId, value, cfg, db = pool) {
  const exposure = await memberExposure(saccosId, memberId, db);
  const after = round2(exposure + Number(value));
  if (cfg.maxExposureAmount != null && Number(cfg.maxExposureAmount) > 0 && after > Number(cfg.maxExposureAmount)) {
    throw createAppError('SACCOS_LOAN_EXPOSURE_EXCEEDED');
  }
  if (cfg.maxExposureMultiple != null && Number(cfg.maxExposureMultiple) > 0) {
    const b = await memberBacking(saccosId, memberId, 1, db);
    const cap = round2(b.backing_balance * Number(cfg.maxExposureMultiple));
    if (b.backing_balance > 0 && after > cap) throw createAppError('SACCOS_LOAN_EXPOSURE_EXCEEDED');
  }
}

/** Forward-looking single-borrower concentration = (borrower_exposure + new_principal) / (gross_loans + new_principal). */
async function assertConcentration(saccosId, memberId, principal, cfg, db = pool) {
  if (cfg.maxConcentrationPercent == null || !(Number(cfg.maxConcentrationPercent) > 0)) return;
  const saccos = await db.query('SELECT * FROM saccos WHERE id = $1', [saccosId]).then((r) => r.rows[0]);
  if (!saccos) return;
  const treasury = await require('./saccosTreasuryService').computeTreasury(saccosId, saccos);
  const grossLoans = Number(treasury.credit.gross_loans_receivable) || 0;
  if (grossLoans <= 0) return;
  const borrowerExposure = await memberExposure(saccosId, memberId, db);
  const newGross = grossLoans + Number(principal);
  if (newGross <= 0) return;
  const percent = ((borrowerExposure + Number(principal)) / newGross) * 100;
  if (percent > Number(cfg.maxConcentrationPercent)) {
    throw createAppError('SACCOS_LOAN_CONCENTRATION_EXCEEDED');
  }
}

function riskLimits(saccos) {
  const cfg = lendingConfig(saccos);
  return {
    maxActiveLoans: Number(cfg.maxActiveLoans) || 1,
    maxExposureAmount: cfg.maxExposureAmount != null ? Number(cfg.maxExposureAmount) : null,
    maxExposureMultiple: cfg.maxExposureMultiple != null ? Number(cfg.maxExposureMultiple) : null,
    maxConcentrationPercent: cfg.maxConcentrationPercent != null ? Number(cfg.maxConcentrationPercent) : null,
  };
}

const RISK_LIMITS_SCHEMA = {
  maxActiveLoans: (v) => v == null ? 1 : Math.max(1, Math.round(Number(v))),
  maxExposureAmount: (v) => v == null ? null : Math.max(0, Number(v)) || null,
  maxExposureMultiple: (v) => v == null ? null : Math.max(0, Number(v)) || null,
  maxConcentrationPercent: (v) => v == null ? null : Math.min(100, Math.max(0, Number(v))) || null,
};

async function updateRiskLimits(actorId, saccosId, patch) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const orgRow = await pool.query('SELECT config FROM saccos WHERE id = $1', [saccosId]).then((r) => r.rows[0]);
  if (!orgRow) throw createAppError('SACCOS_NOT_FOUND');
  const validated = {};
  for (const [k, fn] of Object.entries(RISK_LIMITS_SCHEMA)) {
    if (patch[k] !== undefined) validated[k] = fn(patch[k]);
  }
  if (!Object.keys(validated).length) throw createAppError('SACCOS_RISK_LIMITS_INVALID');
  const lending = { ...((orgRow.config && orgRow.config.lending) || {}), ...validated };
  const config = { ...((orgRow.config) || {}), lending };
  await pool.query('UPDATE saccos SET config = $1::jsonb, updated_at = NOW() WHERE id = $2', [JSON.stringify(config), saccosId]);
  await logAudit(actorId, 'SACCOS_RISK_LIMITS_UPDATED', { referenceId: saccosId, details: validated }).catch(() => {});
  return riskLimits({ config });
}

async function getMemberRiskSummary(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const limits = riskLimits(saccos);
  const treasury = await require('./saccosTreasuryService').computeTreasury(saccosId, saccos);
  const topRows = await pool.query(
    `SELECT sm.user_id, u.full_name, u.phone_number,
            COALESCE(SUM(sl.amount_outstanding), 0)::numeric AS exposure,
            COUNT(*)::int AS active_loans
       FROM saccos_loans sl
       JOIN saccos_members sm ON sm.id = sl.member_id AND sm.saccos_id = $1
       LEFT JOIN users u ON u.id = sm.user_id
      WHERE sl.saccos_id = $1 AND sl.status = 'ACTIVE'
      GROUP BY sm.user_id, u.full_name, u.phone_number
      ORDER BY exposure DESC
      LIMIT 20`, [saccosId]
  );
  return {
    limits,
    portfolio: {
      gross_loans: treasury.credit.gross_loans_receivable,
      member_deposits: treasury.member_deposits.total,
      funding_ratio: treasury.ratios.funding_ratio,
    },
    borrowers: topRows.rows.map((r) => ({
      user_id: r.user_id,
      full_name: r.full_name,
      phone_number: r.phone_number,
      exposure: Number(r.exposure),
      active_loans: r.active_loans,
      utilization_pct: limits.maxExposureAmount ? round2((Number(r.exposure) / limits.maxExposureAmount) * 100) : null,
    })),
  };
}

async function applyLoan(actorId, saccosId, { amount, termMonths, purpose, productId }) {
  const value = Number(amount);
  const term = Number(termMonths);
  if (!Number.isFinite(value) || value <= 0) throw createAppError('SACCOS_LOAN_AMOUNT_INVALID');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const membership = await requireActiveMember(actorId, saccosId);
  const cfg = lendingConfig(saccos);

  // Product (if supplied) overrides the flat saccos-wide lending bounds.
  let product = null;
  let rate = cfg.interestRate;
  let minAmount = cfg.minAmount;
  let maxAmount = cfg.maxAmount;
  let maxTermMonths = cfg.maxTermMonths;
  if (productId !== null && productId !== undefined && productId !== '') {
    product = await fetchActiveProduct(saccosId, Number(productId));
    rate = Number(product.interest_rate_percent);
    minAmount = Number(product.min_amount);
    maxAmount = product.max_amount === null ? null : Number(product.max_amount);
    maxTermMonths = Number(product.max_term_months);
  }

  if (value < minAmount) throw createAppError('SACCOS_LOAN_BELOW_MIN');
  if (maxAmount !== null && value > maxAmount) throw createAppError('SACCOS_LOAN_ABOVE_MAX');
  if (!Number.isInteger(term) || term < 1 || term > maxTermMonths) throw createAppError('SACCOS_LOAN_TERM_TOO_LONG');
  if (await countActiveLoans(saccosId, membership.id) >= cfg.maxActiveLoans) throw createAppError('SACCOS_LOANS_AT_LIMIT');

  const backing = cfg.savingsBackingEnabled ? await memberBacking(saccosId, membership.id, cfg.savingsBackingMultiple) : null;
  if (backing && value > backing.backing_limit) throw createAppError('SACCOS_LOAN_BACKING_INSUFFICIENT');
  await assertMemberExposure(saccosId, membership.id, value, cfg);

  const ref = newRef('SCL');
  const app = await pool.query(
    `INSERT INTO saccos_loan_applications
       (saccos_id, member_id, reference_id, requested_amount, purpose, term_months, status, requires_approval,
        backing_enabled, backing_multiple, backing_balance, backing_limit, product_id, rate_percent)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', TRUE, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [saccosId, membership.id, ref, value, purpose || null, term,
      backing ? backing.enabled : false, backing ? backing.multiple : 0, backing ? backing.backing_balance : 0, backing ? backing.backing_limit : 0,
      product ? product.id : null, rate]
  );
  await logAudit(actorId, 'SACCOS_LOAN_APPLICATION', { referenceId: saccosId, details: { applicationId: app.rows[0].id, amount: value, productId: product ? product.id : null } }).catch(() => {});
  return app.rows[0];
}

async function disburseInClient({ client, saccos, loan, actorId }) {
  const cfg = lendingConfig(saccos);
  const ref = loan.reference_id;
  const member = await client.query('SELECT user_id FROM saccos_members WHERE id = $1', [loan.member_id]);
  if (!member.rows.length) throw createAppError('SACCOS_MEMBER_NOT_FOUND');
  const userId = member.rows[0].user_id;
  await ensureCreditAccounts(client, saccos.id);
  await creditFromSaccos({
    client, userId, amount: Number(loan.principal), reference: ref,
    fromAccount: loansReceivableCode(saccos.id),
    description: `Mkopo SACCOS #${saccos.id}`, actor: 'saccos:credit:disburse',
    txnType: 'SACCOS_LOAN_DISBURSEMENT',
  });
  await client.query(
    `UPDATE saccos_loans SET status = 'ACTIVE', disbursed_at = NOW() WHERE id = $1`,
    [loan.id]
  );
  await client.query(
    `UPDATE saccos_loan_applications SET status = 'DISBURSED', disbursed_at = NOW() WHERE id = $1`,
    [loan.application_id]
  );
  return { userId, cfg };
}

async function decideApplication(actorId, saccosId, applicationId, decision) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const app = await fetchApplication(saccosId, applicationId);
  if (app.status !== 'PENDING') throw createAppError('SACCOS_LOAN_APPLICATION_DECIDED');
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = lendingConfig(saccos);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (decision === 'REJECT') {
      await client.query(
        `UPDATE saccos_loan_applications SET status = 'REJECTED', decided_by = $1, decision_at = NOW() WHERE id = $2`,
        [actorId, applicationId]
      );
      await releaseGuaranteesForApplication(client, saccosId, applicationId);
    } else {
      const co = await acceptedCover(saccosId, applicationId, client);
      if (Number(cfg.guaranteesRequired) > 0 && co.accepted < Number(cfg.guaranteesRequired)) {
        throw createAppError('SACCOS_LOAN_GUARANTOR_REQUIRED');
      }
      if (cfg.savingsBackingEnabled) {
        const live = await memberBacking(saccosId, app.member_id, cfg.savingsBackingMultiple, client);
        const totalLimit = round2(live.backing_limit + co.cover);
        if (Number(app.requested_amount) > totalLimit) throw createAppError('SACCOS_LOAN_BACKING_INSUFFICIENT');
        await client.query(
          `UPDATE saccos_loan_applications SET backing_balance = $1, backing_limit = $2, guaranteed_cover = $3 WHERE id = $4`,
          [live.backing_balance, live.backing_limit, co.cover, applicationId]
        );
      } else if (co.cover > 0) {
        await client.query(
          `UPDATE saccos_loan_applications SET guaranteed_cover = $1 WHERE id = $2`,
          [co.cover, applicationId]
        );
      }
      await assertMemberExposure(saccosId, app.member_id, Number(app.requested_amount), cfg, client);
      await assertConcentration(saccosId, app.member_id, Number(app.requested_amount), cfg, client);
      const rate = app.rate_percent != null ? Number(app.rate_percent) : cfg.interestRate;
      const { total } = repaymentMath(app.requested_amount, rate, app.term_months, app.requested_amount);
      const loan = await client.query(
        `INSERT INTO saccos_loans
           (saccos_id, member_id, application_id, reference_id, principal, interest_rate, total_repayable, amount_outstanding, term_months, status, product_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', $10)
         RETURNING *`,
        [saccosId, app.member_id, app.id, newRef('LNS'), app.requested_amount, rate, total, total, app.term_months, app.product_id]
      );
      await client.query(
        `UPDATE saccos_loan_applications SET status = 'APPROVED', decided_by = $1, decision_at = NOW(), loan_id = $2 WHERE id = $3`,
        [actorId, loan.rows[0].id, applicationId]
      );
      await activateGuarantees(client, saccosId, applicationId, loan.rows[0].id);
      if (cfg.autoDisburse) {
        await disburseInClient({ client, saccos, loan: loan.rows[0], actorId });
      }
    }
    await client.query('COMMIT');
    await logAudit(actorId, decision === 'APPROVE' ? 'SACCOS_LOAN_APPROVED' : 'SACCOS_LOAN_REJECTED', { referenceId: saccosId, details: { applicationId } }).catch(() => {});
    return { success: true, applicationId, decision, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function disburseLoan(actorId, saccosId, loanId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const loan = await fetchLoan(saccosId, loanId);
  if (loan.status !== 'PENDING') throw createAppError('SACCOS_LOAN_NOT_DISBURSABLE');
  const saccos = await fetchActiveOrg(actorId, saccosId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await disburseInClient({ client, saccos, loan, actorId });
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_DISBURSED', { referenceId: saccosId, details: { loanId } }).catch(() => {});
    return { success: true, loanId, status: 'ACTIVE' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function repayLoan(actorId, saccosId, loanId, { amount }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) throw createAppError('SACCOS_LOAN_AMOUNT_INVALID');
  const membership = await requireActiveMember(actorId, saccosId);
  const loan = await fetchLoan(saccosId, loanId);
  if (loan.status === 'CLOSED') throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');
  if (loan.status === 'WRITTEN_OFF') throw createAppError('SACCOS_LOAN_WRITTEN_OFF');
  if (loan.member_id !== membership.id) throw createAppError('SACCOS_RBAC');
  if (Number(loan.amount_outstanding) <= 0) throw createAppError('SACCOS_LOAN_ALREADY_CLOSED');

  const { pay, principalPart, interestPart } = repaymentMath(
    loan.principal, loan.interest_rate, loan.term_months, value
  );
  if (value > Number(loan.amount_outstanding)) throw createAppError('SACCOS_LOAN_REPAY_EXCEEDS');

  const ref = newRef('REP');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureCreditAccounts(client, saccosId);
    await debitToSaccos({
      client, userId: actorId, amount: pay, reference: ref,
      toAccounts: [
        { code: loansReceivableCode(saccosId), amount: principalPart },
        { code: interestIncomeCode(saccosId), amount: interestPart },
      ],
      description: `Rejesho la mkopo SACCOS #${saccosId}`, actor: 'saccos:credit:repay',
      txnType: 'SACCOS_LOAN_REPAYMENT',
    });
    const outstanding = round2(Number(loan.amount_outstanding) - pay);
    await client.query(
      `UPDATE saccos_loans SET amount_outstanding = $1::numeric, status = CASE WHEN $2::numeric <= 0 THEN 'CLOSED' ELSE status END, repaid_at = CASE WHEN $2::numeric <= 0 THEN NOW() ELSE repaid_at END WHERE id = $3`,
      [outstanding, outstanding, loanId]
    );
    await client.query(
      `INSERT INTO saccos_loan_repayments (saccos_id, loan_id, member_id, reference_id, amount, principal_part, interest_part, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED')`,
      [saccosId, loanId, membership.id, ref, pay, principalPart, interestPart]
    );
    if (outstanding <= 0) {
      await client.query(`UPDATE saccos_loan_applications SET status = 'REPAID', repaid_at = NOW() WHERE id = $1`, [loan.application_id]);
      await releaseGuaranteesForLoan(client, saccosId, loanId);
    }
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_LOAN_REPAYMENT', { referenceId: saccosId, details: { loanId, amount: pay } }).catch(() => {});
    return {
      reference: ref, amount: pay, principalPart, interestPart,
      outstanding, closed: outstanding <= 0,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function listMyLoans(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const app = await pool.query(
    `SELECT a.id, a.reference_id, a.requested_amount, a.purpose, a.term_months, a.status, a.created_at,
            a.backing_enabled, a.backing_multiple, a.backing_balance, a.backing_limit,
            p.code AS product_code, p.name AS product_name
     FROM saccos_loan_applications a
     LEFT JOIN saccos_lending_products p ON p.id = a.product_id
     WHERE a.saccos_id = $1 AND a.member_id = $2 ORDER BY a.created_at DESC`,
    [saccosId, membership.id]
  );
  const loans = await pool.query(
    `SELECT l.id, l.reference_id, l.principal, l.interest_rate, l.total_repayable, l.amount_outstanding, l.term_months, l.status, l.disbursed_at,
            p.code AS product_code, p.name AS product_name
     FROM saccos_loans l
     LEFT JOIN saccos_lending_products p ON p.id = l.product_id
     WHERE l.saccos_id = $1 AND l.member_id = $2 ORDER BY l.created_at DESC`,
    [saccosId, membership.id]
  );
  return { applications: app.rows, loans: loans.rows };
}

/** Member reads their current lending capacity (savings + shares backing). */
async function myBacking(actorId, saccosId) {
  const membership = await requireActiveMember(actorId, saccosId);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = lendingConfig(saccos);
  const backing = await memberBacking(saccosId, membership.id, cfg.savingsBackingEnabled ? cfg.savingsBackingMultiple : 0);
  return { enabled: cfg.savingsBackingEnabled, savings_backing_multiple: backing.multiple, ...backing };
}

async function listApplications(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT a.id, a.reference_id, a.requested_amount, a.purpose, a.term_months, a.status, a.requires_approval, a.decided_by, a.decision_at, a.disbursed_at, a.repaid_at, a.created_at,
            m.member_number, u.full_name, u.phone_number, p.code AS product_code, p.name AS product_name
     FROM saccos_loan_applications a
     JOIN saccos_members m ON m.id = a.member_id
     JOIN users u ON u.id = m.user_id
     LEFT JOIN saccos_lending_products p ON p.id = a.product_id
     WHERE a.saccos_id = $1
     ORDER BY a.created_at DESC`,
    [saccosId]
  );
  return r.rows;
}

async function listLoanRepayments(actorId, saccosId, loanId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const loan = await fetchLoan(saccosId, loanId);
  const r = await pool.query(
    `SELECT id, reference_id, amount, principal_part, interest_part, status, created_at
     FROM saccos_loan_repayments WHERE loan_id = $1 ORDER BY created_at DESC`,
    [loan.id]
  );
  return r.rows.map((row) => ({ ...row, amount: Number(row.amount), principal_part: Number(row.principal_part), interest_part: Number(row.interest_part) }));
}

async function creditSummary(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const org = await pool.query('SELECT config FROM saccos WHERE id = $1', [saccosId]);
  const cfg = lendingConfig(org.rows[0] || { config: {} });
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_loans,
            COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN amount_outstanding ELSE 0 END), 0) AS outstanding,
            COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN principal ELSE 0 END), 0) AS principal_outstanding
     FROM saccos_loans WHERE saccos_id = $1`,
    [saccosId]
  );
  const repaid = await pool.query(
    `SELECT COALESCE(SUM(principal_part), 0) AS principal_repaid, COALESCE(SUM(interest_part), 0) AS interest_earned
     FROM saccos_loan_repayments WHERE saccos_id = $1`,
    [saccosId]
  );
  const out = { ...r.rows[0], ...repaid.rows[0] };
  return {
    active_loans: Number(out.active_loans),
    outstanding: Number(out.outstanding),
    principal_outstanding: Number(out.principal_outstanding),
    principal_repaid: Number(out.principal_repaid),
    interest_earned: Number(out.interest_earned),
    interestRate: cfg.interestRate,
    savingsBackingEnabled: cfg.savingsBackingEnabled,
    savingsBackingMultiple: cfg.savingsBackingMultiple,
    currency: 'TZS',
  };
}

module.exports = {
  applyLoan,
  myBacking,
  memberBacking,
  decideApplication,
  disburseLoan,
  repayLoan,
  listMyLoans,
  listApplications,
  listLoanRepayments,
  creditSummary,
  loansReceivableCode,
  interestIncomeCode,
  lateFeeIncomeCode,
  lendingConfig,
  repaymentMath,
  ensureCreditAccounts,
  // guarantor APIs (increment 17)
  addGuarantor,
  acceptGuarantee,
  removeGuarantee,
  listGuarantees,
  myGuarantees,
  releaseGuaranteesForLoan,
  releaseGuaranteesForApplication,
  // lending products (increment 19)
  createProduct,
  listProducts,
  archiveProduct,
  fetchActiveProduct,
  // lending risk limits (increment 21b)
  memberExposure,
  assertMemberExposure,
  assertConcentration,
  riskLimits,
  updateRiskLimits,
  getMemberRiskSummary,
};