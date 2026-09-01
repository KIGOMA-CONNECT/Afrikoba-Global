const pool = require('../config/db');
const config = require('../config');
const { generateReference, formatMoney } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const logger = require('../utils/logger');
const fin = require('../services/financialEngine');

/**
 * AUTOMATED SPLIT PAYMENT ENGINE
 * Mapato ya mradi yanapoingia kwenye Project Business Account:
 *   - Operational Bucket (70%) -> mjasiriamali
 *   - Investor Returns (28%)   -> wawekezaji kulingana na hisa
 *   - Platform Commission (2%) -> company_revenue
 */
async function runSplitPayment(projectId, periodMonth, periodYear) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const projectRes = await client.query(
      `SELECT p.*, u.phone_number, u.full_name
       FROM investment_projects p JOIN users u ON u.id = p.owner_user_id
       WHERE p.id = $1 FOR UPDATE OF p`,
      [projectId]
    );
    const project = projectRes.rows[0];
    if (!project) throw new Error('Mradi haujapatikana.');

    const duplicate = await client.query(
      'SELECT 1 FROM revenue_split_runs WHERE project_id = $1 AND period_month = $2 AND period_year = $3',
      [projectId, periodMonth, periodYear]
    );
    if (duplicate.rows.length > 0) {
      return { success: false, duplicate: true, message: 'Split ya mwezi huu tayari imefanyika.' };
    }

    const rulesRes = await client.query(
      'SELECT * FROM project_settlement_rules WHERE project_id = $1',
      [projectId]
    );
    const rules = rulesRes.rows[0] || {};

    const walletRes = await client.query(
      'SELECT * FROM project_business_wallets WHERE project_id = $1 FOR UPDATE',
      [projectId]
    );
    const wallet = walletRes.rows[0];
    if (!wallet || Number(wallet.total_revenue_collected) <= 0) {
      throw new Error('Hakuna mapato ya kugawa.');
    }

    const totalRevenue = Number(wallet.total_revenue_collected);
    const opPct = parseFloat(rules.reinvestment_percentage ?? config.fees.operationalPercent) / 100;
    const invPct = parseFloat(rules.investor_payout_percentage ?? config.fees.investorPayoutPercent) / 100;
    const commPct = parseFloat(rules.platform_comm_percentage ?? config.fees.platformCommPercent) / 100;

    const operationalShare = Math.round(totalRevenue * opPct * 100) / 100;
    const investorShare = Math.round(totalRevenue * invPct * 100) / 100;
    const platformShare = Math.round((totalRevenue - operationalShare - investorShare) * 100) / 100;

    // 1. Operational -> wallet ya mjasiriamali
    await fin.creditWallet({
      client,
      userId: project.owner_user_id,
      amount: Number(operationalShare),
      reference: `SPLIT:${projectId}:${periodYear}-${periodMonth}:OP`,
      fromAccount: 'SUSPENSE',
      description: 'Operational share split payout',
    });

    // 2. Investor Returns -> kwa wawekezaji kulingana na hisa zao
    const investors = await client.query(
      `SELECT i.investor_user_id, i.shares_bought, u.full_name, u.phone_number,
              p.raised_amount AS total_raised
       FROM investments i
       JOIN users u ON u.id = i.investor_user_id
       JOIN investment_projects p ON p.id = i.project_id
       WHERE i.project_id = $1 AND i.status = 'ACTIVE'`,
      [projectId]
    );
    const totalShares = investors.rows.reduce((sum, inv) => sum + inv.shares_bought, 0);

    for (const inv of investors.rows) {
      if (totalShares === 0) break;
      const shareOfInvestor = Math.round((inv.shares_bought / totalShares) * investorShare * 100) / 100;
      if (shareOfInvestor <= 0) continue;

      await fin.creditWallet({
        client,
        userId: inv.investor_user_id,
        amount: Number(shareOfInvestor),
        reference: `SPLIT:${projectId}:${periodYear}-${periodMonth}:INV:${inv.investor_user_id}`,
        fromAccount: 'SUSPENSE',
        description: 'Investor return split payout',
      });
      await client.query(
        `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
         VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'INVESTMENT_PAYOUT', $4)`,
        [generateReference('ROI'), inv.investor_user_id, shareOfInvestor, JSON.stringify({ project_id: projectId, period: `${periodYear}-${periodMonth}` })]
      );
      await sendSMS(
        inv.phone_number,
        `Habari ${inv.full_name}, umepokea faida ya ${formatMoney(shareOfInvestor)} kutoka ${project.title} (${periodMonth}/${periodYear}).`
      );
    }

    // 3. Platform Commission -> company_revenue
    await client.query(
      `UPDATE company_revenue SET total_platform_fees = total_platform_fees + $1, updated_at = NOW() WHERE id = 1`,
      [platformShare]
    );

    // 4. Rekodi ya split
    await client.query(
      `INSERT INTO revenue_split_runs
        (project_id, period_month, period_year, total_revenue, operational_share, investor_share, platform_share)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [projectId, periodMonth, periodYear, totalRevenue, operationalShare, investorShare, platformShare]
    );

    // 5. Reset Project Business Wallet (mapato yamegawanywa)
    await client.query(
      `UPDATE project_business_wallets
       SET total_revenue_collected = 0,
           operational_balance = operational_balance + $1,
           investor_reserved_balance = investor_reserved_balance + $2,
           platform_commission_balance = platform_commission_balance + $3
       WHERE project_id = $4`,
      [operationalShare, investorShare, platformShare, projectId]
    );

    await client.query('COMMIT');

    const sms = `Habari ${project.full_name}, mapato ya ${formatMoney(totalRevenue)} yamegawanywa: Wewe ${formatMoney(operationalShare)}, Wawekezaji ${formatMoney(investorShare)}, Jukwaa ${formatMoney(platformShare)}.`;
    await sendSMS(project.phone_number, sms);

    logger.info('SPLIT', `Project ${projectId}: ${formatMoney(totalRevenue)} imegawanywa`, {
      operationalShare,
      investorShare,
      platformShare,
    });
    return { success: true, operationalShare, investorShare, platformShare };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Ingiza mapato ya mradi kwenye Project Business Wallet
 */
async function recordProjectRevenue(projectId, amount, description) {
  const amountNum = parseFloat(amount);
  if (!amountNum || amountNum <= 0) {
    throw Object.assign(new Error('Kiasi cha mapato si sahihi.'), { statusCode: 400 });
  }
  const result = await pool.query(
    `UPDATE project_business_wallets
     SET total_revenue_collected = total_revenue_collected + $1
     WHERE project_id = $2 RETURNING *`,
    [amountNum, projectId]
  );
  if (result.rows.length === 0) throw new Error('Project Business Wallet haijapatikana.');
  logger.info('REVENUE', `Project ${projectId} mapato +${amountNum}`, { description });
  return result.rows[0];
}

/**
 * Run split payments kwa miradi yote iliyo na mapato (inayoitwa na Cron ya kila mwezi)
 */
async function runDueSplitPayments() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const result = await pool.query(
    `SELECT pw.project_id FROM project_business_wallets pw
     WHERE pw.total_revenue_collected > 0`
  );
  const processed = [];
  for (const row of result.rows) {
    try {
      const res = await runSplitPayment(row.project_id, month, year);
      if (res.success) processed.push(row.project_id);
    } catch (e) {
      logger.error('SPLIT-CRON', `Project ${row.project_id}: ${e.message}`);
    }
  }
  return { processed };
}

module.exports = { runSplitPayment, recordProjectRevenue, runDueSplitPayments };
