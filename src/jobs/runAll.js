const cron = require('node-cron');
const pool = require('../config/db');
const { disburseDuePayouts } = require('../services/roscaService');
const { reconcilePendingDeposits } = require('./reconciliationCron');
const { runDueSplitPayments } = require('../services/splitPaymentService');
const { processDueScheduledPayments } = require('../services/networkService');
const { processYieldPayouts } = require('../services/yieldService');
const { runMaintenance } = require('../services/dbMaintenanceService');
const { runBalanceReconciliation } = require('./balanceReconciliation');
const { runAutopilotPayouts } = require('../services/financialAutopilotService');
const { recomputeAll: recomputeSellerVerifications } = require('../services/sellerVerificationService');
const { runAutoInvestCycle } = require('../services/p2pMarketplaceService');
const logger = require('../utils/logger');

/**
 * RUN ALL CRON JOBS
 * - Kila dakika 5: Reconciliation ya PENDING deposits + withdrawal refunds
 * - Kila dakika 5: ROSCA Payout Engine (michango + payouts)
 * - Kila saa 6: Database maintenance (cleanup expired keys/OTPs)
 * - Kila mwezi (siku ya 1, saa 1 asubuhi): Split Payment Engine
 */
function startAllJobs() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await reconcilePendingDeposits();
    } catch (e) {
      logger.error('CRON-RECON', e.message);
    }
  });

  cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await disburseDuePayouts();
      if (result.processed > 0) logger.info('CRON-ROSCA', `Payouts zilizochakatwa: ${result.processed}`);
    } catch (e) {
      logger.error('CRON-ROSCA', e.message);
    }
  });

  cron.schedule('0 */6 * * *', async () => {
    try {
      await runMaintenance();
    } catch (e) {
      logger.error('CRON-DB-MAINT', e.message);
    }
  });

  cron.schedule('0 1 1 * *', async () => {
    try {
      await runDueSplitPayments();
    } catch (e) {
      logger.error('CRON-SPLIT', e.message);
    }
  });

  cron.schedule('0 0 * * *', async () => {
    try {
      await processYieldPayouts();
    } catch (e) {
      logger.error('CRON-YIELD', e.message);
    }
  });

  // Daily balance reconciliation - asserts ledger == projection (diff should be 0).
  cron.schedule('15 0 * * *', async () => {
    try {
      await runBalanceReconciliation('DAILY');
    } catch (e) {
      logger.error('CRON-BALANCE-RECON', e.message);
    }
  });

  cron.schedule('*/1 * * * *', async () => {
    try {
      const r = await processDueScheduledPayments();
      if (r.processed > 0) logger.info('CRON-SCHEDULED', `Malipo yaliyopangwa yamechakatwa: ${r.processed}`);
    } catch (e) {
      logger.error('CRON-SCHEDULED', e.message);
    }
  });

  // Daily autopilot auto-save execution - derives due ACTIVE plans, journals the
  // snapshotted monthly allocation into the savings goal if affordable & funded.
  cron.schedule('20 0 * * *', async () => {
    try {
      const r = await runAutopilotPayouts();
      if (r.processed > 0) logger.info('CRON-AUTOPILOT', `Autopilot savings: ${r.processed} executed, ${r.skipped} skipped`);
    } catch (e) {
      logger.error('CRON-AUTOPILOT', e.message);
    }
  });

  // Daily seller verification refresh - 24h badge cache (identity + behaviour).
  cron.schedule('30 0 * * *', async () => {
    try {
      await recomputeSellerVerifications();
    } catch (e) {
      logger.error('CRON-SELLER-VERIFY', e.message);
    }
  });

  // Auto-invest sweep - every 30 minutes, sweep enabled rules over ACTIVE P2P projects.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const projects = await runAutoInvestCycle();
      if (projects > 0) logger.info('CRON-AUTO-INVEST', `Auto-invest cycle done over ${projects} active project(s)`);
    } catch (e) {
      logger.error('CRON-AUTO-INVEST', e.message);
    }
  });

  logger.info('CRON', 'Cron Jobs zimeanzishwa (reconciliation, ROSCA payout, DB maintenance, split payment, scheduled payments, autopilot, seller verification, auto-invest)');
}

module.exports = { startAllJobs };
