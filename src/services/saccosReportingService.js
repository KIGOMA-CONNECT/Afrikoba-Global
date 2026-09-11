/**
 * SACCOS Digital Core - Member Statements & Regulatory Reports
 * (increment 11).
 * - myStatement: an ACTIVE or EXITED member reads their own consolidated
 *   position (savings, shares, loans, investments, funds contributions,
 *   dividends, exits) + wallet. BOARD/OWNER read any member's statement.
 * - regulatoryReport: computed from the shared double-entry ledger
 *   (per-entity `SACCOS<id>_*` codes aggregated by account type) +
 *   saccos tables, then UPSERTed into `saccos_regulatory_reports`
 *   keyed by (saccos_id, as_of) - a dated, immutable snapshot.
 * - managementReport: last N months of gross flows (deposits,
 *   withdrawals, disbursements, repayments, dividends, contributions,
 *   exit settlements) - computed, not persisted.
 * RBAC: self-only on mine (non-member 404), OWNER/BOARD/ADMIN on the rest;
 * cross-entity 404; everything audit-logged.
 */
const pool = require('../config/db');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const saccosCore = require('./saccosService');

const LIABILITY_TYPES = ['LIABILITY'];
const CREDIT_NET_TYPES = ['LIABILITY', 'REVENUE', 'EQUITY'];

function code(saccosId, name) { return `SACCOS${saccosId}_${name}`; }

async function ledgerBalances(saccosId) {
  const r = await pool.query(
    `SELECT la.account_type,
            COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE -je.amount END), 0)::numeric AS cr_net,
            COALESCE(SUM(CASE WHEN je.direction = 'DR' THEN je.amount ELSE -je.amount END), 0)::numeric AS dr_net,
            la.account_code
     FROM journal_entries je
     JOIN ledger_accounts la ON la.id = je.account_id
     WHERE la.account_code LIKE $1
     GROUP BY la.account_type, la.account_code`,
    [`SACCOS${saccosId}_%`]
  );
  const byCode = {};
  let revenue = 0, expense = 0;
  for (const row of r.rows) {
    const bal = CREDIT_NET_TYPES.includes(row.account_type) ? Number(row.cr_net) : Number(row.dr_net);
    byCode[row.account_code] = Math.round(bal * 100) / 100;
    if (row.account_type === 'REVENUE') revenue += bal;
    if (row.account_type === 'EXPENSE') expense += bal;
  }
  return { byCode, revenue: Math.round(revenue * 100) / 100, expense: Math.round(expense * 100) / 100 };
}

async function findMembershipRow(actorId, saccosId) {
  const { membership } = await saccosCore.assertVisible(actorId, saccosId);
  if (!membership || membership.user_id !== actorId) throw createAppError('SACCOS_NOT_MEMBER');
  return membership;
}

async function memberProfile(memberId, saccosId) {
  const [m, wallet, sav, sh, loans, inv, divs, exits] = await Promise.all([
    pool.query(
      `SELECT m.*, u.full_name FROM saccos_members m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND m.saccos_id = $2`,
      [memberId, saccosId]
    ),
    pool.query('SELECT u.id AS user_id, u.full_name, u.wallet_balance FROM saccos_members m JOIN users u ON u.id = m.user_id WHERE m.id = $1', [memberId]),
    pool.query(`SELECT balance, account_no FROM saccos_savings_accounts WHERE member_id = $1`, [memberId]),
    pool.query(`SELECT share_count, total_value, avg_price FROM saccos_share_holdings WHERE member_id = $1`, [memberId]),
    pool.query(`SELECT id, principal, total_repayable, amount_outstanding, interest_rate, term_months, status, disbursed_at FROM saccos_loans WHERE saccos_id = $1 AND member_id = $2 ORDER BY created_at DESC`, [saccosId, memberId]),
    pool.query(`SELECT i.id, i.amount, p.annual_rate_percent, i.term_months, i.maturity_date, i.status FROM saccos_investments i LEFT JOIN saccos_investment_products p ON p.id = i.product_id WHERE i.saccos_id = $1 AND i.member_id = $2 ORDER BY i.created_at DESC`, [saccosId, memberId]),
    pool.query(`SELECT d.run_id, d.amount, d.status, d.paid_at, r.title FROM saccos_dividend_payouts d JOIN saccos_dividend_runs r ON r.id = d.run_id WHERE d.saccos_id = $1 AND d.member_id = $2 ORDER BY d.id`, [saccosId, memberId]),
    pool.query(`SELECT reference_id, savings_settled, share_redemption_amount, dividend_settled, total_settlement, settled_at FROM saccos_member_exits WHERE member_id = $1`, [memberId]),
  ]);
  const row = m.rows[0];
  if (!row) return null;
  return {
    member: {
      member_number: row.member_number, role: row.role, status: row.status,
      member_number_full: row.member_number, joined_at: row.created_at,
      full_name: wallet.rows[0] ? wallet.rows[0].full_name : row.full_name,
      wallet_balance: wallet.rows[0] ? Number(wallet.rows[0].wallet_balance) : 0,
    },
    savings: sav.rows.length ? { account_no: sav.rows[0].account_no, balance: Number(sav.rows[0].balance) } : null,
    shares: sh.rows.length ? { share_count: Number(sh.rows[0].share_count), total_value: Number(sh.rows[0].total_value), avg_price: Number(sh.rows[0].avg_price) } : null,
    loans: loans.rows.map((l) => ({ id: l.id, principal: Number(l.principal), total_repayable: Number(l.total_repayable), amount_outstanding: Number(l.amount_outstanding), interest_rate: Number(l.interest_rate), term_months: l.term_months, status: l.status })),
    investments: inv.rows.map((i) => ({ id: i.id, amount: Number(i.amount), annual_rate_percent: Number(i.annual_rate_percent), term_months: i.term_months, maturity_date: i.maturity_date, status: i.status })),
    dividends: divs.rows.map((d) => ({ run_title: d.title, amount: Number(d.amount), status: d.status })),
    exit: exits.rows.length ? { reference_id: exits.rows[0].reference_id, total_settlement: Number(exits.rows[0].total_settlement), settled_at: exits.rows[0].settled_at } : null,
  };
}

async function myStatement(actorId, saccosId) {
  const membership = await findMembershipRow(actorId, saccosId);
  return memberProfile(membership.id, saccosId);
}

async function memberStatement(actorId, saccosId, memberId) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (!isPlatformAdmin && (!membership || !['OWNER', 'BOARD'].includes(membership.role))) {
    if (membership && membership.id === memberId) return memberProfile(memberId, saccosId);
    throw createAppError('SACCOS_RBAC');
  }
  return memberProfile(memberId, saccosId);
}

async function regulatoryReport(actorId, saccosId, asOfDate) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (!isPlatformAdmin && (!membership || !['OWNER', 'BOARD'].includes(membership.role))) throw createAppError('SACCOS_RBAC');
  const asOf = asOfDate || new Date().toISOString().slice(0, 10);

  const [ledger, members, holdings, exits, loans, llr, dividends] = await Promise.all([
    ledgerBalances(saccosId),
    pool.query(`SELECT status, COUNT(*)::int AS c FROM saccos_members WHERE saccos_id = $1 GROUP BY status`, [saccosId]),
    pool.query(`SELECT COALESCE(SUM(share_count), 0)::int AS sc, COALESCE(SUM(total_value), 0)::numeric AS tv FROM saccos_share_holdings WHERE saccos_id = $1`, [saccosId]),
    pool.query(`SELECT COUNT(*)::int AS c, COALESCE(SUM(total_settlement), 0)::numeric AS s FROM saccos_member_exits WHERE saccos_id = $1`, [saccosId]),
    pool.query(`SELECT COALESCE(SUM(amount_outstanding), 0)::numeric AS o, COUNT(*)::int AS c FROM saccos_loans WHERE saccos_id = $1 AND status = 'ACTIVE'`, [saccosId]),
    pool.query(`SELECT COALESCE(SUM(provision_amount), 0)::numeric AS p FROM saccos_loan_loss_reserves WHERE saccos_id = $1`, [saccosId]),
    pool.query(`SELECT COALESCE(SUM(amount), 0)::numeric AS a, COUNT(*)::int AS c FROM saccos_dividend_payouts WHERE saccos_id = $1 AND status = 'PAID'`, [saccosId]),
  ]);

  const memberCounts = { ACTIVE: 0, INVITED: 0, SUSPENDED: 0, EXITED: 0 };
  members.rows.forEach((r) => { memberCounts[r.status] = r.c; });

  let fund_balances = 0;
  Object.entries(ledger.byCode).forEach(([acc, bal]) => {
    const low = acc.slice(`SACCOS${saccosId}_`.length);
    if (low.startsWith('FUND_') && bal > 0) fund_balances += bal;
  });

  const snapshot = {
    saccos_id: saccosId,
    as_of: asOf,
    member_count_active: memberCounts.ACTIVE,
    member_count_invited: memberCounts.INVITED,
    member_count_suspended: memberCounts.SUSPENDED,
    member_count_exited: memberCounts.EXITED,
    share_count_total: holdings.rows[0].sc,
    share_value_total: Number(holdings.rows[0].tv),
    savings_liability: ledger.byCode[code(saccosId, 'SAVINGS_LIABILITY')] || 0,
    investment_liability: ledger.byCode[code(saccosId, 'INVESTMENTS_LIABILITY')] || 0,
    fund_balances: Math.round(fund_balances * 100) / 100,
    loan_principal_outstanding: Number(loans.rows[0].o),
    loan_loss_reserves: Number(llr.rows[0].p),
    dividend_distributed: ledger.byCode[code(saccosId, 'DIVIDEND_DISTRIBUTED')] || 0,
    total_revenue: ledger.revenue,
    total_expense: ledger.expense,
    net_income: Math.round((ledger.revenue - ledger.expense) * 100) / 100,
    total_exit_settlements: Number(exits.rows[0].s),
    generated_by: actorId,
  };

  const saved = await pool.query(
    `INSERT INTO saccos_regulatory_reports (saccos_id, as_of, period_id, member_count_active, member_count_invited, member_count_suspended, member_count_exited, share_count_total, share_value_total, savings_liability, investment_liability, fund_balances, loan_principal_outstanding, loan_loss_reserves, dividend_distributed, total_revenue, total_expense, net_income, total_exit_settlements, generated_by)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (saccos_id, as_of) DO UPDATE SET
       member_count_active = EXCLUDED.member_count_active,
       member_count_invited = EXCLUDED.member_count_invited,
       member_count_suspended = EXCLUDED.member_count_suspended,
       member_count_exited = EXCLUDED.member_count_exited,
       share_count_total = EXCLUDED.share_count_total,
       share_value_total = EXCLUDED.share_value_total,
       savings_liability = EXCLUDED.savings_liability,
       investment_liability = EXCLUDED.investment_liability,
       fund_balances = EXCLUDED.fund_balances,
       loan_principal_outstanding = EXCLUDED.loan_principal_outstanding,
       loan_loss_reserves = EXCLUDED.loan_loss_reserves,
       dividend_distributed = EXCLUDED.dividend_distributed,
       total_revenue = EXCLUDED.total_revenue,
       total_expense = EXCLUDED.total_expense,
       net_income = EXCLUDED.net_income,
       total_exit_settlements = EXCLUDED.total_exit_settlements,
       generated_by = EXCLUDED.generated_by,
       updated_at = NOW()
     RETURNING *`,
    [snapshot.saccos_id, snapshot.as_of, snapshot.member_count_active, snapshot.member_count_invited, snapshot.member_count_suspended, snapshot.member_count_exited, snapshot.share_count_total, snapshot.share_value_total, snapshot.savings_liability, snapshot.investment_liability, snapshot.fund_balances, snapshot.loan_principal_outstanding, snapshot.loan_loss_reserves, snapshot.dividend_distributed, snapshot.total_revenue, snapshot.total_expense, snapshot.net_income, snapshot.total_exit_settlements, snapshot.generated_by]
  );
  await logAudit(actorId, 'SACCOS_REGULATORY_REPORT', { referenceId: saccosId, details: { asOf, memberCount: snapshot.member_count_active, netIncome: snapshot.net_income } }).catch(() => {});
  const r = saved.rows[0];
  return {
    saccos_id: r.saccos_id, as_of: r.as_of.toLocaleDateString('en-CA'), period_id: r.period_id,
    members: { active: r.member_count_active, invited: r.member_count_invited, suspended: r.member_count_suspended, exited: r.member_count_exited },
    shares: { share_count_total: r.share_count_total, share_value_total: Number(r.share_value_total) },
    liabilities: { savings: Number(r.savings_liability), investments: Number(r.investment_liability), fund_balances: Number(r.fund_balances), loan_loss_reserves: Number(r.loan_loss_reserves) },
    loans: { principal_outstanding: Number(r.loan_principal_outstanding) },
    dividends: { distributed: Number(r.dividend_distributed) },
    income: { revenue: Number(r.total_revenue), expense: Number(r.total_expense), net_income: Number(r.net_income) },
    exit_settlements: Number(r.total_exit_settlements),
    generated_at: r.created_at,
  };
}

async function managementReport(actorId, saccosId, monthsBack) {
  const { membership, isPlatformAdmin } = await saccosCore.assertVisible(actorId, saccosId);
  if (!isPlatformAdmin && (!membership || !['OWNER', 'BOARD'].includes(membership.role))) throw createAppError('SACCOS_RBAC');
  const months = Math.max(1, Math.min(24, Number(monthsBack) || 6));

  const q = async (sql) => {
    const r = await pool.query(sql, [saccosId, months]);
    const map = {};
    r.rows.forEach((row) => { map[row.month] = Number(row.total); });
    return map;
  };
  const [deposits, withdrawals, disbursements, repayments, dividends, contributions, exits] = await Promise.all([
    q(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS total FROM saccos_savings_movements WHERE saccos_id = $1 AND type = 'DEPOSIT' AND status = 'APPROVED' AND created_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
    q(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS total FROM saccos_savings_movements WHERE saccos_id = $1 AND type = 'WITHDRAWAL' AND status = 'APPROVED' AND created_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
    q(`SELECT TO_CHAR(DATE_TRUNC('month', disbursed_at), 'YYYY-MM') AS month, COALESCE(SUM(principal),0)::numeric AS total FROM saccos_loans WHERE saccos_id = $1 AND disbursed_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
    q(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS total FROM saccos_loan_repayments WHERE saccos_id = $1 AND created_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
    q(`SELECT TO_CHAR(DATE_TRUNC('month', paid_at), 'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS total FROM saccos_dividend_payouts WHERE saccos_id = $1 AND status = 'PAID' AND paid_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
    q(`SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COALESCE(SUM(amount),0)::numeric AS total FROM saccos_fund_contributions WHERE saccos_id = $1 AND created_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
    q(`SELECT TO_CHAR(DATE_TRUNC('month', settled_at), 'YYYY-MM') AS month, COALESCE(SUM(total_settlement),0)::numeric AS total FROM saccos_member_exits WHERE saccos_id = $1 AND settled_at >= NOW() - make_interval(months => $2) GROUP BY 1`),
  ]);

  const monthsList = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(1); d.setMonth(d.getMonth() - i);
    const key = d.toISOString().slice(0, 7);
    monthsList.push({
      month: key,
      savings_deposits: deposits[key] || 0,
      savings_withdrawals: withdrawals[key] || 0,
      loan_disbursements: disbursements[key] || 0,
      loan_repayments: repayments[key] || 0,
      dividends_paid: dividends[key] || 0,
      fund_contributions: contributions[key] || 0,
      exit_settlements: exits[key] || 0,
    });
  }
  const current = monthsList[monthsList.length - 1];
  await logAudit(actorId, 'SACCOS_MANAGEMENT_REPORT', { referenceId: saccosId, details: { months, current } }).catch(() => {});
  return { months: monthsList, period_months: months };
}

module.exports = {
  myStatement,
  memberStatement,
  regulatoryReport,
  managementReport,
};