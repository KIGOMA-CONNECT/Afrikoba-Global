/**
 * SACCOS Digital Core - Treasury & Liquidity Panel (increment 20).
 * A governing risk view computed LIVE from the shared double-entry
 * ledger (per-entity `SACCOS<id>_*` accounts) with no money
 * movement of its own:
 *
 * - liquid buckets: operating cash (from accounting entries),
 *   per-fund balances (`SACCOS<id>_FUND_<CODE>`) and the welfare kitty
 * - credit: gross loans receivable net of loan-loss reserves
 * - member deposits (savings + investments liabilities + funds +
 *   welfare) - the funding a SACCOS lends against
 * - ratios: funding ratio (gross loans / member deposits), LLR
 *   coverage (reserves / gross loans %), liquidity buffer ratio
 *   (liquid buckets / member deposits %)
 * - alerts drawn from `saccos.config.liquidity` thresholds (JSONB,
 *   optional; defaults below)
 *
 * Boards can persist a dated immutable snapshot (TRS-*) keyed
 * (saccos_id, as_of) so the same day refreshes the row - a running
 * audit/regulatory history. Members are denied (SACCOS_RBAC);
 * non-members and cross-entity reads resolve to 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const saccosCore = require('./saccosService');

const DEFAULT_LIQUIDITY_CONFIG = {
  maxFundingRatio: 1.0,
  minBufferRatio: 0.10,
  minLlrCoveragePercent: 5,
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

function code(id, name) { return `SACCOS${id}_${name}`; }

function liquidityConfig(saccos) {
  const c = (saccos.config && saccos.config.liquidity) || {};
  return { ...DEFAULT_LIQUIDITY_CONFIG, ...c };
}

function newRef() {
  return 'TRS-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

/** Entity wallet-agnostic ledger net balances keyed by account_code
 *  (credit-pos for LIABILITY/REVENUE/EQUITY, debit-pos for ASSET/EXPENSE). */
async function entityBalances(saccosId) {
  const r = await pool.query(
    `SELECT la.account_type, la.account_code,
            COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE -je.amount END), 0)::numeric AS cr_net,
            COALESCE(SUM(CASE WHEN je.direction = 'DR' THEN je.amount ELSE -je.amount END), 0)::numeric AS dr_net
     FROM journal_entries je
     JOIN ledger_accounts la ON la.id = je.account_id
     WHERE la.account_code LIKE $1
     GROUP BY la.account_type, la.account_code`,
    [`SACCOS${saccosId}_%`]
  );
  const creditPos = new Set(['LIABILITY', 'REVENUE', 'EQUITY']);
  const out = {};
  for (const row of r.rows) {
    out[row.account_code] = creditPos.has(row.account_type) ? Number(row.cr_net) : Number(row.dr_net);
  }
  return out;
}

async function fetchBalances(saccosId) {
  const bal = await entityBalances(saccosId);
  const get = (name) => round2(bal[code(saccosId, name)] || 0);
  const funds = Object.entries(bal)
    .filter(([c]) => c.startsWith(`SACCOS${saccosId}_FUND_`))
    .reduce((s, [, v]) => s + Number(v), 0);
  return { get, funds };
}

function liquidityAlerts(d, ratios, cfg) {
  const alerts = [];
  if (d.gross_loans > 0 && ratios.funding_ratio != null && ratios.funding_ratio > cfg.maxFundingRatio) {
    alerts.push({
      severity: 'CRITICAL',
      code: 'LIQUIDITY_FUNDING_RATIO_HIGH',
      message: 'Active loans exceed member deposits',
      value: ratios.funding_ratio,
      threshold: cfg.maxFundingRatio,
    });
  }
  if (d.member_deposits > 0 && ratios.buffer_percent != null && ratios.buffer_percent < cfg.minBufferRatio * 100) {
    alerts.push({
      severity: 'WARNING',
      code: 'LIQUIDITY_BUFFER_LOW',
      message: 'Liquid buffer below minimum',
      value: ratios.buffer_percent,
      threshold: round2(cfg.minBufferRatio * 100),
    });
  }
  if (d.gross_loans > 0 && (ratios.llr_coverage_percent == null || ratios.llr_coverage_percent < cfg.minLlrCoveragePercent)) {
    alerts.push({
      severity: 'WARNING',
      code: 'LIQUIDITY_LLR_LOW',
      message: 'Loan-loss reserves below target',
      value: ratios.llr_coverage_percent,
      threshold: cfg.minLlrCoveragePercent,
    });
  }
  return alerts;
}

async function computeTreasury(saccosId, saccos) {
  const cfg = liquidityConfig(saccos);
  const { get, funds } = await fetchBalances(saccosId);

  const grossLoans = get('LOANS_RECEIVABLE');
  const llr = get('LOAN_LOSS_RESERVES');
  const savings = get('SAVINGS_LIABILITY');
  const investments = get('INVESTMENTS_LIABILITY');
  const welfare = get('WELFARE_FUND');
  const operatingCash = get('OPERATING_CASH');
  const sharesCapital = get('SHARES_CAPITAL');

  const memberDeposits = savings + investments + funds + welfare;
  const liquidBuffer = operatingCash + funds + welfare;
  const netLoans = Math.max(grossLoans - llr, 0);

  const d = {
    gross_loans: round2(grossLoans),
    llr: round2(llr),
    net_loans: round2(netLoans),
    savings: round2(savings),
    investments: round2(investments),
    funds: round2(funds),
    welfare: round2(welfare),
    operating_cash: round2(operatingCash),
    liquid_buffer: round2(liquidBuffer),
    member_deposits: round2(memberDeposits),
    shares_capital: round2(sharesCapital),
  };

  const ratios = {
    funding_ratio: memberDeposits > 0 ? round3(grossLoans / memberDeposits) : null,
    llr_coverage_percent: grossLoans > 0 ? round2((llr / grossLoans) * 100) : null,
    buffer_percent: memberDeposits > 0 ? round2((liquidBuffer / memberDeposits) * 100) : null,
  };

  return {
    as_of: new Date().toISOString().slice(0, 10),
    cash_and_liquid: {
      operating_cash: d.operating_cash,
      funds: d.funds,
      welfare_fund: d.welfare,
      total: d.liquid_buffer,
    },
    credit: {
      gross_loans_receivable: d.gross_loans,
      loan_loss_reserves: d.llr,
      net_loans_receivable: d.net_loans,
    },
    member_deposits: {
      savings_liability: d.savings,
      investments_liability: d.investments,
      funds: d.funds,
      welfare_fund: d.welfare,
      total: d.member_deposits,
    },
    capital: {
      shares_capital: d.shares_capital,
    },
    ratios,
    config: {
      max_funding_ratio: cfg.maxFundingRatio,
      min_buffer_ratio: cfg.minBufferRatio,
      min_llr_coverage_percent: cfg.minLlrCoveragePercent,
    },
    alerts: liquidityAlerts(d, ratios, cfg),
  };
}

async function getTreasury(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  return computeTreasury(saccosId, org.rows[0]);
}

async function snapshotTreasury(actorId, saccosId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const org = await pool.query('SELECT * FROM saccos WHERE id = $1', [saccosId]);
  if (!org.rows.length) throw createAppError('SACCOS_NOT_FOUND');
  const tr = await computeTreasury(saccosId, org.rows[0]);
  const reference = newRef();
  const r = await pool.query(
    `INSERT INTO saccos_treasury_snapshots (saccos_id, as_of, reference_id, snapshot, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (saccos_id, as_of) DO UPDATE SET snapshot = EXCLUDED.snapshot, created_by = EXCLUDED.created_by, created_at = NOW()
     RETURNING id, to_char(as_of, 'YYYY-MM-DD') AS as_of, reference_id, created_by, created_at`,
    [saccosId, tr.as_of, reference, JSON.stringify(tr), actorId]
  );
  await logAudit(actorId, 'SACCOS_TREASURY_SNAPSHOT', { referenceId: saccosId, details: { snapshotId: r.rows[0].id, reference, as_of: tr.as_of } }).catch(() => {});
  return { ...r.rows[0], snapshot: tr };
}

async function treasuryHistory(actorId, saccosId) {
  await saccosCore.assertMembershipCanAdminister(actorId, saccosId);
  const r = await pool.query(
    `SELECT id, to_char(as_of, 'YYYY-MM-DD') AS as_of, reference_id, created_by, created_at
     FROM saccos_treasury_snapshots
     WHERE saccos_id = $1 ORDER BY as_of DESC, id DESC`,
    [saccosId]
  );
  return r.rows;
}

module.exports = {
  getTreasury,
  snapshotTreasury,
  treasuryHistory,
  computeTreasury,
  DEFAULT_LIQUIDITY_CONFIG,
};