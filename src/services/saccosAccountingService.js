/**
 * SACCOS Digital Core - Accounting (increment 6).
 * Entity-scoped bookkeeping + financial statements backed by the
 * shared double-entry core. OWNER/BOARD open an accounting period
 * (PER-*), book internal journals (ACC-*) through it (claim +
 * postJournal against per-entity ledger accounts), and close it
 * into an immutable CLOSED state with a statements snapshot
 * (reopen CLOSED -> OPEN is the only escape, audit-logged).
 * Statements (chart, trial balance, income statement, balance
 * sheet) are computed from `ledger_accounts`/`journal_entries`
 * scoped to `SACCOS<id>_*` codes. Members read, OWNER/BOARD
 * write; non-members and cross-entity access resolve to 404.
 */
const pool = require('../config/db');
const crypto = require('crypto');
const { createAppError } = require('../utils/errorCodes');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const saccosCore = require('./saccosService');

const DEFAULT_ACCOUNTING_CONFIG = {
  requirePeriodForBooking: true,
  defaultPeriodDays: 30,
};

const ACCOUNTING_DEFAULTS = {
  operatingCash: (id) => ({ code: `SACCOS${id}_OPERATING_CASH`, name: `SACCOS #${id} Operating Cash`, type: 'ASSET' }),
  generalExpense: (id) => ({ code: `SACCOS${id}_GENERAL_EXPENSE`, name: `SACCOS #${id} General Expense`, type: 'EXPENSE' }),
  otherIncome: (id) => ({ code: `SACCOS${id}_OTHER_INCOME`, name: `SACCOS #${id} Other Income`, type: 'REVENUE' }),
};

function accountingConfig(saccos) {
  const c = (saccos.config && saccos.config.accounting) || {};
  return { ...DEFAULT_ACCOUNTING_CONFIG, ...c };
}

function newRef(prefix) {
  return prefix + '-' + crypto.randomBytes(5).toString('hex').toUpperCase();
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

async function ensureAccount(client, saccosId, def) {
  await client.query(
    `INSERT INTO ledger_accounts (account_code, name, account_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_code) DO NOTHING`,
    [def.code, def.name, def.type]
  );
}

async function getOpenPeriod(saccosId) {
  const r = await pool.query(
    `SELECT * FROM saccos_accounting_periods WHERE saccos_id = $1 AND status = 'OPEN' ORDER BY id DESC`,
    [saccosId]
  );
  return r.rows[0] || null;
}

/** Debit/credit balance sign by account type: assets+expenses hold debit, rest hold credit. */
function accountBalance(accountType, drSum, crSum) {
  const normalDebit = ['ASSET', 'EXPENSE'].includes(accountType);
  const balance = normalDebit ? drSum - crSum : crSum - drSum;
  return Math.round(balance * 100) / 100;
}

async function ledgerBalance(client, saccosId) {
  const r = await client.query(
    `SELECT la.account_code, la.name, la.account_type,
            COALESCE(SUM(je.amount) FILTER (WHERE je.direction = 'DR'), 0)::numeric AS dr_sum,
            COALESCE(SUM(je.amount) FILTER (WHERE je.direction = 'CR'), 0)::numeric AS cr_sum
     FROM ledger_accounts la
     LEFT JOIN journal_entries je ON je.account_id = la.id
     WHERE la.account_code LIKE $1
     GROUP BY la.id, la.account_code, la.name, la.account_type
     ORDER BY la.account_type, la.account_code`,
    [`SACCOS${saccosId}\\_%`]
  );
  return r.rows.map((row) => ({
    account_code: row.account_code,
    name: row.name,
    account_type: row.account_type,
    dr_sum: Number(row.dr_sum),
    cr_sum: Number(row.cr_sum),
    balance: accountBalance(row.account_type, Number(row.dr_sum), Number(row.cr_sum)),
  }));
}

async function openPeriod(actorId, saccosId, { label, startDate, endDate, days }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = accountingConfig(saccos);

  let start = startDate ? new Date(startDate) : new Date();
  let end = endDate ? new Date(endDate) : new Date(start);
  if (!endDate) end.setDate(start.getDate() + (Number(days) || cfg.defaultPeriodDays));
  if (end < start) throw createAppError('SACCOS_ACC_PERIOD_RANGE');

  const existing = await getOpenPeriod(saccosId);
  if (existing) throw createAppError('SACCOS_ACC_PERIOD_ALREADY_OPEN');

  const r = await pool.query(
    `INSERT INTO saccos_accounting_periods (saccos_id, reference_id, label, start_date, end_date, opened_by)
     VALUES ($1, $2, $3, $4::date, $5::date, $6) RETURNING *`,
    [saccosId, newRef('PER'), label || null, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), actorId]
  );
  await logAudit(actorId, 'SACCOS_ACC_PERIOD_OPENED', { referenceId: saccosId, details: { periodId: r.rows[0].id, reference: r.rows[0].reference_id } }).catch(() => {});
  return r.rows[0];
}

async function bookEntry(actorId, saccosId, { kind, amount, description, accountCode, referenceId }) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const saccos = await fetchActiveOrg(actorId, saccosId);
  const cfg = accountingConfig(saccos);
  const kindN = String(kind || '').toUpperCase();
  if (!['EXPENSE', 'INCOME', 'MANUAL'].includes(kindN)) throw createAppError('SACCOS_ACC_ENTRY_KIND');
  const amountN = Number(amount);
  if (!(amountN > 0)) throw createAppError('SACCOS_ACC_AMOUNT');

  const period = await getOpenPeriod(saccosId);
  if (cfg.requirePeriodForBooking && !period) throw createAppError('SACCOS_ACC_PERIOD_OPEN');

  const defs = ACCOUNTING_DEFAULTS;
  const debit = kindN === 'INCOME' ? defs.operatingCash(saccosId) : defs.generalExpense(saccosId);
  const credit = kindN === 'EXPENSE' ? defs.operatingCash(saccosId) : defs.otherIncome(saccosId);
  if (accountCode) {
    const explicit = await pool.query('SELECT account_code, account_type FROM ledger_accounts WHERE account_code = $1', [accountCode]);
    if (!explicit.rows.length) throw createAppError('SACCOS_ACC_ACCOUNT_UNKNOWN');
  }
  const reference = referenceId || newRef('ACC');
  const groupRef = referenceId ? referenceId + '-J' : referenceId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAccount(client, saccosId, debit);
    await ensureAccount(client, saccosId, credit);
    const op = await fin.claimOperation({ client, operationType: 'SACCOS_ACCOUNTING_ENTRY', reference, userId: actorId, amount: amountN });
    if (!op.claimed) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    const groupId = await fin.postJournal({
      client,
      lines: [
        { accountCode: debit.code, direction: 'DR', amount: amountN },
        { accountCode: credit.code, direction: 'CR', amount: amountN },
      ],
      referenceId: groupRef || reference,
      description: description || `SACCOS ${kindN} entry`,
      postedBy: 'saccos-accounting',
    });
    const e = await client.query(
      `INSERT INTO saccos_accounting_entries
         (saccos_id, period_id, reference_id, kind, description, amount, debit_account_code, credit_account_code, journal_group, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [saccosId, period ? period.id : null, reference, kindN, description || null, amountN, debit.code, credit.code, groupId, actorId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_ACC_ENTRY_BOOKED', { referenceId: saccosId, details: { reference, kind: kindN, amount: amountN } }).catch(() => {});
    return { ...e.rows[0], amount: Number(e.rows[0].amount) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePeriod(actorId, saccosId, periodId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const period = await pool.query(
    'SELECT * FROM saccos_accounting_periods WHERE id = $1 AND saccos_id = $2',
    [periodId, saccosId]
  );
  if (!period.rows.length) throw createAppError('SACCOS_ACC_PERIOD_NOT_FOUND');
  if (period.rows[0].status !== 'OPEN') throw createAppError('SACCOS_ACC_PERIOD_STATE');

  const client = await pool.connect();
  try {
    const stmts = await computeStatements(client, saccosId);
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE saccos_accounting_periods SET status = 'CLOSED', snapshot = $1, closed_by = $2, closed_at = NOW() WHERE id = $3 RETURNING *`,
      [JSON.stringify(stmts), actorId, periodId]
    );
    await client.query('COMMIT');
    await logAudit(actorId, 'SACCOS_ACC_PERIOD_CLOSED', { referenceId: saccosId, details: { periodId, label: r.rows[0].reference_id } }).catch(() => {});
    return r.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function reopenPeriod(actorId, saccosId, periodId) {
  await saccosCore.assertActiveRole(actorId, saccosId, ['OWNER', 'BOARD']);
  const period = await pool.query(
    'SELECT * FROM saccos_accounting_periods WHERE id = $1 AND saccos_id = $2',
    [periodId, saccosId]
  );
  if (!period.rows.length) throw createAppError('SACCOS_ACC_PERIOD_NOT_FOUND');
  if (period.rows[0].status !== 'CLOSED') throw createAppError('SACCOS_ACC_PERIOD_STATE');
  const r = await pool.query(
    `UPDATE saccos_accounting_periods SET status = 'OPEN', snapshot = NULL, closed_by = NULL, closed_at = NULL WHERE id = $1 RETURNING *`,
    [periodId]
  );
  await logAudit(actorId, 'SACCOS_ACC_PERIOD_REOPENED', { referenceId: saccosId, details: { periodId, reference: r.rows[0].reference_id } }).catch(() => {});
  return r.rows[0];
}

async function computeStatements(client, saccosId) {
  const balances = await ledgerBalance(client, saccosId);
  const trial = { balances };
  const trialDebit = balances.reduce((s, b) => s + (b.dr_sum || 0), 0);
  const trialCredit = balances.reduce((s, b) => s + (b.cr_sum || 0), 0);
  trial.total_debit = Math.round(trialDebit * 100) / 100;
  trial.total_credit = Math.round(trialCredit * 100) / 100;
  trial.balanced = trial.total_debit === trial.total_credit;

  const revenue = balances.filter((b) => b.account_type === 'REVENUE').reduce((s, b) => s + b.balance, 0);
  const expense = balances.filter((b) => b.account_type === 'EXPENSE').reduce((s, b) => s + b.balance, 0);
  const incomeStatement = {
    revenue_items: balances.filter((b) => b.account_type === 'REVENUE'),
    expense_items: balances.filter((b) => b.account_type === 'EXPENSE'),
    total_revenue: Math.round(revenue * 100) / 100,
    total_expense: Math.round(expense * 100) / 100,
    net_income: Math.round((revenue - expense) * 100) / 100,
  };

  const assets = balances.filter((b) => b.account_type === 'ASSET').reduce((s, b) => s + b.balance, 0);
  const liabilities = balances.filter((b) => b.account_type === 'LIABILITY').reduce((s, b) => s + b.balance, 0);
  const equityAccounts = balances.filter((b) => b.account_type === 'EQUITY');
  const equity = equityAccounts.reduce((s, b) => s + b.balance, 0);
  const balanceSheet = {
    asset_items: balances.filter((b) => b.account_type === 'ASSET'),
    liability_items: balances.filter((b) => b.account_type === 'LIABILITY'),
    equity_items: equityAccounts,
    total_assets: Math.round(assets * 100) / 100,
    total_liabilities: Math.round(liabilities * 100) / 100,
    equity_before_net: equity,
    net_income: incomeStatement.net_income,
    total_equity: Math.round((equity + incomeStatement.net_income) * 100) / 100,
    balanced: Math.round((assets - (liabilities + equity + incomeStatement.net_income)) * 100) / 100 === 0,
  };
  return { trial, income_statement: incomeStatement, balance_sheet: balanceSheet };
}

async function trialBalance(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const client = await pool.connect();
  try { return (await computeStatements(client, saccosId)).trial; } finally { client.release(); }
}

async function incomeStatement(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const client = await pool.connect();
  try { return (await computeStatements(client, saccosId)).income_statement; } finally { client.release(); }
}

async function balanceSheet(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const client = await pool.connect();
  try { return (await computeStatements(client, saccosId)).balance_sheet; } finally { client.release(); }
}

async function chart(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const client = await pool.connect();
  try {
    const balances = await ledgerBalance(client, saccosId);
    const grouped = balances.reduce((acc, b) => {
      (acc[b.account_type] = acc[b.account_type] || []).push(b);
      return acc;
    }, {});
    return { accounts: balances, grouped };
  } finally {
    client.release();
  }
}

async function listPeriods(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    'SELECT * FROM saccos_accounting_periods WHERE saccos_id = $1 ORDER BY start_date DESC',
    [saccosId]
  );
  return r.rows;
}

async function listEntries(actorId, saccosId, periodId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT e.*, p.reference_id AS period_reference FROM saccos_accounting_entries e
     LEFT JOIN saccos_accounting_periods p ON p.id = e.period_id
     WHERE e.saccos_id = $1 AND ($2::int IS NULL OR e.period_id = $2)
     ORDER BY e.created_at DESC`,
    [saccosId, periodId || null]
  );
  return r.rows.map((e) => ({ ...e, amount: Number(e.amount) }));
}

async function accountingSummary(actorId, saccosId) {
  await requireAdminOrActive(actorId, saccosId);
  const r = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open_periods,
            COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed_periods,
            (SELECT COUNT(*)::int FROM saccos_accounting_entries WHERE saccos_id = $1) AS total_entries
     FROM saccos_accounting_periods WHERE saccos_id = $1`,
    [saccosId]
  );
  return r.rows[0];
}

module.exports = {
  openPeriod,
  bookEntry,
  closePeriod,
  reopenPeriod,
  trialBalance,
  incomeStatement,
  balanceSheet,
  chart,
  listPeriods,
  listEntries,
  accountingSummary,
};