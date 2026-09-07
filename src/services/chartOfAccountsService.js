/**
 * CHART OF ACCOUNTS SERVICE
 * Exposes the formal 1000/2000/3000/4000/5000 account-numbering hierarchy
 * mirrored onto named ledger_accounts (migration 093). Provides an ordered,
 * grouped view of the chart for Ops reporting and reconciliation tooling.
 *
 * The ledger_accounts.chart_number column is the numeric mirror; account_type
 * classifies each account into ASSET / LIABILITY / EQUITY / REVENUE / EXPENSE.
 */

const pool = require('../config/db');

const GROUP_LABELS = {
  ASSET: { range: '1000 - 1999', label: 'Assets' },
  LIABILITY: { range: '2000 - 2999', label: 'Liabilities' },
  EQUITY: { range: '3000 - 3999', label: 'Equity' },
  REVENUE: { range: '4000 - 4999', label: 'Revenue / Income' },
  EXPENSE: { range: '5000 - 5999', label: 'Expenses' },
};

/**
 * Return the full chart of accounts, grouped by account_type and ordered by
 * chart_number (unnumbered accounts sort last, by code). Each row includes
 * the account code, name, type, chart number, and a live journal balance
 * (net DR - CR) for the account.
 */
async function getChart() {
  const r = await pool.query(
    `SELECT la.account_code,
            la.name,
            la.account_type,
            la.chart_number,
            la.is_system,
            COALESCE(SUM(CASE WHEN j.direction = 'DR' THEN j.amount ELSE -j.amount END), 0)::numeric AS journal_balance
       FROM ledger_accounts la
       LEFT JOIN journal_entries j ON j.account_id = la.id
      GROUP BY la.id
      ORDER BY la.chart_number NULLS LAST, la.account_code`
  );

  const groups = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']
    .map((type) => ({
      account_type: type,
      range: GROUP_LABELS[type].range,
      label: GROUP_LABELS[type].label,
      accounts: r.rows
        .filter((row) => row.account_type === type)
        .map((row) => ({
          account_code: row.account_code,
          name: row.name,
          account_type: row.account_type,
          chart_number: row.chart_number,
          is_system: row.is_system,
          journal_balance: Number(row.journal_balance),
        })),
    }));

  return {
    generatedAt: new Date().toISOString(),
    groups,
    totals: {
      assetBalance: Number(totalByType(r.rows, 'ASSET')),
      liabilityBalance: Number(totalByType(r.rows, 'LIABILITY')),
      equityBalance: Number(totalByType(r.rows, 'EQUITY')),
      revenueBalance: Number(totalByType(r.rows, 'REVENUE')),
      expenseBalance: Number(totalByType(r.rows, 'EXPENSE')),
    },
  };
}

function totalByType(rows, type) {
  return rows
    .filter((row) => row.account_type === type)
    .reduce((s, row) => s + Number(row.journal_balance || 0), 0);
}

/**
 * Verify the numbering invariant for a given account set: every non-null
 * chart_number must sit in its account_type's formal range.
 * Returns { valid, violations }.
 */
function validateChartNumbering(chartNumber, accountType) {
  if (chartNumber == null) return { valid: true, violations: [] };
  const ranges = {
    ASSET: [1000, 2000],
    LIABILITY: [2000, 3000],
    EQUITY: [3000, 4000],
    REVENUE: [4000, 5000],
    EXPENSE: [5000, 6000],
  };
  const [lo, hi] = ranges[accountType] || [0, 0];
  const valid = Number(chartNumber) >= lo && Number(chartNumber) < hi;
  return { valid, violations: valid ? [] : [{ accountType, chartNumber, range: `${lo}–${hi}` }] };
}

module.exports = { getChart, validateChartNumbering };
