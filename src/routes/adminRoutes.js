const express = require('express');
const pool = require('../config/db');
const p2pService = require('../services/p2pService');
const { requireRoles, authRequired } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../validations/schemas');

const router = express.Router();

router.use(authRequired);
router.use(requireRoles('ADMIN'));

// Picha ya jumla ya mfumo (Super Admin Dashboard)
router.get('/dashboard', async (req, res, next) => {
  try {
    const [users, revenue, txs, pools, projects, groups, subscriptions] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM users'),
      pool.query('SELECT * FROM company_revenue WHERE id = 1'),
      pool.query(`SELECT COUNT(*)::int AS total,
                         COALESCE(SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END), 0)::int AS pending
                  FROM transactions`),
      pool.query('SELECT COUNT(*)::int AS total FROM rosca_pools'),
      pool.query('SELECT COUNT(*)::int AS total FROM investment_projects'),
      pool.query('SELECT COUNT(*)::int AS total FROM vicoba_groups'),
      pool.query(
        `SELECT service_key, COUNT(*)::int AS subscribers
         FROM user_service_subscriptions WHERE status = 'ACTIVE'
         GROUP BY service_key`
      ),
    ]);
    res.json({
      success: true,
      stats: {
        users: users.rows[0].total,
        transactions: txs.rows[0],
        roscaPools: pools.rows[0].total,
        projects: projects.rows[0].total,
        vicobaGroups: groups.rows[0].total,
        revenue: revenue.rows[0],
        serviceSubscriptions: subscriptions.rows,
      },
    });
  } catch (error) {
    next(error);
  }
});

// TAINFUND: Orodha ya miradi inayosubiri ukaguzi
router.get('/projects/pending', async (req, res, next) => {
  try {
    const projects = await p2pService.listPendingProjects();
    res.json({ success: true, projects });
  } catch (error) {
    next(error);
  }
});

// TAINFUND: Weka mradi chini ya ukaguzi (SUBMITTED → UNDER_REVIEW)
router.post('/projects/:projectId/review/start', async (req, res, next) => {
  try {
    const result = await p2pService.markUnderReview(req.user.id, parseInt(req.params.projectId, 10));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// TAINFUND: Kagua mradi (APPROVED / REJECTED)
router.post('/projects/:projectId/review', validate(schemas.p2p.review), async (req, res, next) => {
  try {
    const { decision, reason } = req.body;
    const result = await p2pService.reviewProject(req.user.id, parseInt(req.params.projectId, 10), decision, reason);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Uhakiki wa mradi - hatua moja ya Due Diligence
router.post('/projects/:projectId/audit', validate(schemas.p2p.audit), async (req, res, next) => {
  try {
    const { stepName, passed, notes } = req.body;
    const result = await p2pService.verifyAuditStep(req.user.id, parseInt(req.params.projectId, 10), stepName, passed, notes);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Tengeneza Escrow Milestones za mradi
router.post('/projects/:projectId/milestones', validate(schemas.p2p.milestones), async (req, res, next) => {
  try {
    const { milestones } = req.body;
    const result = await p2pService.createEscrowMilestones(req.user.id, parseInt(req.params.projectId, 10), milestones);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Toa Milestone (Escrow Release) kwenda mjasiriamali
router.post('/milestones/:milestoneId/release', async (req, res, next) => {
  try {
    const result = await p2pService.releaseMilestone(req.user.id, parseInt(req.params.milestoneId, 10));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Ingiza mapato ya mradi (Project Revenue)
router.post('/projects/:projectId/revenue', validate(schemas.p2p.revenue), async (req, res, next) => {
  try {
    const { amount, description } = req.body;
    const { recordProjectRevenue } = require('../services/splitPaymentService');
    const wallet = await recordProjectRevenue(parseInt(req.params.projectId, 10), amount, description);
    res.json({ success: true, wallet });
  } catch (error) {
    next(error);
  }
});

// Orodha ya watumiaji wote
router.get('/users', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, phone_number, email, role, kyc_level, wallet_balance,
              locked_balance, trust_score, is_active, created_at
       FROM users ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ success: true, users: result.rows });
  } catch (error) {
    next(error);
  }
});

// Orodha ya miamala yote (Admin)
router.get('/transactions', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const result = await pool.query(
      `SELECT t.*, u.full_name, u.phone_number
       FROM transactions t JOIN users u ON u.id = t.user_id
       ORDER BY t.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, transactions: result.rows });
  } catch (error) {
    next(error);
  }
});

// Endesha Split Payment Engine kwa mradi
router.post('/projects/:projectId/split', async (req, res, next) => {
  try {
    const { runSplitPayment } = require('../services/splitPaymentService');
    const now = new Date();
    const result = await runSplitPayment(
      parseInt(req.params.projectId, 10),
      now.getMonth() + 1,
      now.getFullYear()
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Database maintenance
router.post('/maintenance/run', async (req, res, next) => {
  try {
    const { runMaintenance } = require('../services/dbMaintenanceService');
    const result = await runMaintenance();
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/maintenance/stats', async (req, res, next) => {
  try {
    const { getTableStats, getHealthMetrics } = require('../services/dbMaintenanceService');
    const [stats, metrics] = await Promise.all([getTableStats(), getHealthMetrics()]);
    res.json({ success: true, metrics, tables: stats });
  } catch (error) {
    next(error);
  }
});

// H18: Database backup management
router.post('/backup/create', async (req, res, next) => {
  try {
    const { createBackup } = require('../services/backupService');
    const result = createBackup();
    res.json({ success: result.success, ...result });
  } catch (error) {
    next(error);
  }
});

router.get('/backup/status', async (req, res, next) => {
  try {
    const { getBackupStatus } = require('../services/backupService');
    const status = getBackupStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    next(error);
  }
});

router.post('/backup/cleanup', async (req, res, next) => {
  try {
    const { cleanupOldBackups } = require('../services/backupService');
    const result = cleanupOldBackups();
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// H15: API key management
router.get('/api-keys', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, permissions, rate_limit, is_active, created_at
       FROM api_keys ORDER BY created_at DESC`
    );
    res.json({ success: true, apiKeys: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/api-keys', async (req, res, next) => {
  try {
    const { name, permissions, rate_limit } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: 'Jina la API key linahitajika.' });
    }
    const { generateApiKey } = require('../middleware/apiKeyAuth');
    const { plainKey, hash } = generateApiKey();
    const result = await pool.query(
      `INSERT INTO api_keys (name, key_hash, permissions, rate_limit)
       VALUES ($1, $2, $3, $4) RETURNING id, name, permissions, rate_limit, created_at`,
      [name, hash, permissions || ['read'], rate_limit || 1000]
    );
    res.json({
      success: true,
      apiKey: result.rows[0],
      plainKey,
      message: 'Muhtasari: Kwenye API key hii mara moja tu. Hiiwezi tena kuonekana.',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
