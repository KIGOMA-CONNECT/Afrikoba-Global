const cron = require('node-cron');
const pool = require('../config/db');
const { disburseDuePayouts } = require('../services/roscaService');
const { reconcilePendingDeposits } = require('./reconciliationCron');
const { runDueSplitPayments } = require('../services/splitPaymentService');
const { processDueScheduledPayments } = require('../services/networkService');
const { runMaintenance } = require('../services/dbMaintenanceService');
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

  cron.schedule('*/1 * * * *', async () => {
    try {
      const r = await processDueScheduledPayments();
      if (r.processed > 0) logger.info('CRON-SCHEDULED', `Malipo yaliyopangwa yamechakatwa: ${r.processed}`);
    } catch (e) {
      logger.error('CRON-SCHEDULED', e.message);
    }
  });

  logger.info('CRON', 'Cron Jobs zimeanzishwa (reconciliation, ROSCA payout, DB maintenance, split payment, scheduled payments)');
}

module.exports = { startAllJobs };
