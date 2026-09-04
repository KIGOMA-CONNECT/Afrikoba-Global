const express = require('express');
const pool = require('../config/db');
const p2pService = require('../services/p2pService');
const { requireRoles, authRequired } = require('../middleware/auth');
const { requireStepUp } = require('../services/stepUpAuthService');
const { validate } = require('../middleware/validate');
const schemas = require('../validations/schemas');
const { logAction } = require('../services/auditService');
const governanceService = require('../services/governanceService');
const observabilityService = require('../services/observabilityService');
const countryService = require('../services/countryService');
const fraudService = require('../services/fraudDetectionService');

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
    await logAction(req.user.id, 'PROJECT_REVIEWED', 'PROJECT', parseInt(req.params.projectId, 10), { decision, reason }, req);
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
    await logAction(req.user.id, 'BACKUP_CREATED', 'SYSTEM', null, { success: result.success }, req);
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

// ===== FINANCIAL RECONCILIATION ENDPOINTS (Phase 5) =====
const { runBalanceReconciliation, recentRuns } = require('../jobs/balanceReconciliation');
const { financialHealthSnapshot } = require('../services/financialMonitoring');

// Orodha ya reconciliation runs zilizopita
router.get('/reconciliation/runs', async (req, res, next) => {
  try {
    const runs = await recentRuns(Number(req.query.limit) || 20);
    res.json({ success: true, runs });
  } catch (error) {
    next(error);
  }
});

// Maelezo ya run moja ikiwa ni pamoja na line items
router.get('/reconciliation/runs/:id', async (req, res, next) => {
  try {
    const run = await pool.query(
      `SELECT * FROM reconciliation_runs WHERE id = $1`, [req.params.id]
    );
    if (run.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Run haipatikani.' });
    }
    const items = await pool.query(
      `SELECT account_code, balance_name, state, journal_balance, expected_balance,
              difference, detail
       FROM reconciliation_line_items WHERE run_id = $1 ORDER BY id`, [req.params.id]
    );
    res.json({ success: true, run: run.rows[0], items: items.rows });
  } catch (error) {
    next(error);
  }
});

// Kuanzisha reconciliation manually (ops/ad-hoc)
router.post('/reconciliation/run', async (req, res, next) => {
  try {
    const summary = await runBalanceReconciliation('MANUAL');
    res.json({ success: true, summary });
  } catch (error) {
    next(error);
  }
});

// ===== FINANCIAL HEALTH / MONITORING (Phase 6) =====
// Muhtasari wa afya ya kifedha: recon difference, open exceptions, aging.
router.get('/financial/monitoring', async (req, res, next) => {
  try {
    const snapshot = await financialHealthSnapshot();
    res.json({ success: true, ...snapshot });
  } catch (error) {
    next(error);
  }
});

// ===== FOUR-EYES RBAC (maker-checker approvals) =====
router.get('/approvals', async (req, res, next) => {
  try {
    const status = req.query.status || null;
    res.json({ success: true, flows: await governanceService.listApprovalFlows(status) });
  } catch (error) { next(error); }
});

router.get('/approvals/requester', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM approval_flows WHERE requester_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ success: true, flows: result.rows });
  } catch (error) { next(error); }
});

router.post('/approvals', async (req, res, next) => {
  try {
    const flow = await governanceService.createApprovalFlow({ requesterId: req.user.id, ...req.body });
    await logAction(req.user.id, 'APPROVAL_REQUESTED', flow.ref_type || 'GENERIC', flow.ref_id, { action_type: flow.action_type }, req);
    res.json({ success: true, flow });
  } catch (error) { next(error); }
});

router.post('/approvals/:id/decide', async (req, res, next) => {
  try {
    const { action, comment } = req.body;
    const outcome = await governanceService.decideApprovalFlow(parseInt(req.params.id, 10), req.user.id, action, comment);
    await logAction(req.user.id, 'APPROVAL_DECIDED', 'APPROVAL_FLOW', outcome.flow.id, { action }, req);
    res.json({ success: true, flow: outcome.flow, execution: outcome.execution });
  } catch (error) { next(error); }
});

// ===== AML CASE MANAGEMENT =====
router.get('/aml/cases', async (req, res, next) => {
  try {
    res.json({ success: true, cases: await governanceService.listAmlCases(req.query.status || null) });
  } catch (error) { next(error); }
});

router.get('/aml/cases/:id', async (req, res, next) => {
  try {
    res.json({ success: true, ...(await governanceService.getAmlCase(parseInt(req.params.id, 10))) });
  } catch (error) { next(error); }
});

router.post('/aml/cases', async (req, res, next) => {
  try {
    const c = await governanceService.openAmlCase({ ...req.body, authorId: req.user.id });
    await logAction(req.user.id, 'AML_CASE_OPENED', 'AML_CASE', c.id, { case_type: c.case_type, risk_level: c.risk_level }, req);
    res.json({ success: true, case: c });
  } catch (error) { next(error); }
});

router.put('/aml/cases/:id', async (req, res, next) => {
  try {
    const c = await governanceService.updateAmlCase(parseInt(req.params.id, 10), req.user.id, req.body);
    await logAction(req.user.id, 'AML_CASE_UPDATED', 'AML_CASE', c.id, req.body, req);
    res.json({ success: true, case: c });
  } catch (error) { next(error); }
});

router.post('/aml/cases/:id/notes', async (req, res, next) => {
  try {
    res.json({ success: true, note: await governanceService.addAmlNote(parseInt(req.params.id, 10), req.user.id, req.body.note) });
  } catch (error) { next(error); }
});

// Fraud alerts (queue for AML case opening)
router.get('/fraud/alerts', async (req, res, next) => {
  try {
    res.json({ success: true, alerts: await fraudService.getAllAlerts(req.query.severity || null, Number(req.query.limit) || 100) });
  } catch (error) { next(error); }
});

router.post('/fraud/alerts/:id/resolve', async (req, res, next) => {
  try {
    res.json({ success: true, alert: await fraudService.resolveAlert(parseInt(req.params.id, 10), req.user.id) });
  } catch (error) { next(error); }
});

// ===== OBSERVABILITY / BI =====
router.get('/metrics/kpis', async (req, res, next) => {
  try { res.json({ success: true, kpis: await observabilityService.getBusinessKpis() }); }
  catch (error) { next(error); }
});

router.get('/metrics/trend', async (req, res, next) => {
  try { res.json({ success: true, trend: await observabilityService.getTransactionTrend(Number(req.query.days) || 14) }); }
  catch (error) { next(error); }
});

router.get('/metrics/types', async (req, res, next) => {
  try { res.json({ success: true, types: await observabilityService.getTransactionTypeBreakdown() }); }
  catch (error) { next(error); }
});

// ===== CROSS-BORDER / COUNTRIES =====
router.get('/countries', async (req, res, next) => {
  try { res.json({ success: true, countries: await countryService.listCountries() }); }
  catch (error) { next(error); }
});

router.post('/countries', async (req, res, next) => {
  try {
    const c = await countryService.addCountry(req.body);
    await logAction(req.user.id, 'COUNTRY_ADDED', 'COUNTRY', c.id, { code: c.code }, req);
    res.json({ success: true, country: c });
  } catch (error) { next(error); }
});

router.put('/countries/:id', async (req, res, next) => {
  try {
    const c = await countryService.updateCountry(parseInt(req.params.id, 10), req.body);
    await logAction(req.user.id, 'COUNTRY_UPDATED', 'COUNTRY', c.id, req.body, req);
    res.json({ success: true, country: c });
  } catch (error) { next(error); }
});

// Public-ish quote helper (still admin for now)
router.post('/countries/quote', async (req, res, next) => {
  try {
    const { from_currency, to_country, amount } = req.body;
    res.json({ success: true, quote: await countryService.quoteTransfer(from_currency || 'TZS', to_country, amount) });
  } catch (error) { next(error); }
});

router.post('/countries/transfer', async (req, res, next) => {
  try {
    const { to_country, amount, recipient, note } = req.body;
    const result = await countryService.executeTransfer(req.user.id, to_country, amount, recipient, note);
    res.json(result);
  } catch (error) { next(error); }
});

// ===== CONFIG SETTINGS (four-eyes gate) =====
router.get('/config', async (req, res, next) => {
  try {
    const settings = await pool.query(`SELECT key, value, updated_at FROM config_settings ORDER BY key`);
    res.json({ success: true, settings: settings.rows });
  } catch (error) { next(error); }
});

router.put('/config/:key', async (req, res, next) => {
  try {
    const { value } = req.body;
    await pool.query(
      `INSERT INTO config_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [req.params.key, String(value), req.user.id]
    );
    await logAction(req.user.id, 'CONFIG_SET', 'CONFIG_SETTING', null, { key: req.params.key }, req);
    res.json({ success: true });
  } catch (error) { next(error); }
});

// ===== ANALYTICS DATA WAREHOUSE =====
router.get('/warehouse/metrics', async (req, res, next) => {
  try {
    const warehouse = require('../services/analyticsWarehouseService');
    const metrics = await warehouse.getWarehouseMetrics(Number(req.query.limit) || 30);
    res.json({ success: true, metrics });
  } catch (error) { next(error); }
});

router.post('/warehouse/aggregate', async (req, res, next) => {
  try {
    const warehouse = require('../services/analyticsWarehouseService');
    const result = await warehouse.runDailyAggregation(req.body.date);
    res.json(result);
  } catch (error) { next(error); }
});

// ===== AI CASH-FLOW FORECAST & ANOMALIES =====
router.get('/ai/forecasts', async (req, res, next) => {
  try {
    const aiCashFlow = require('../services/aiCashFlowService');
    const forecasts = await aiCashFlow.getForecasts();
    res.json({ success: true, forecasts });
  } catch (error) { next(error); }
});

router.post('/ai/forecasts/generate', async (req, res, next) => {
  try {
    const aiCashFlow = require('../services/aiCashFlowService');
    const result = await aiCashFlow.generateCashFlowForecast();
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/ai/anomalies', async (req, res, next) => {
  try {
    const aiCashFlow = require('../services/aiCashFlowService');
    const anomalies = await aiCashFlow.getAnomalies();
    res.json({ success: true, anomalies });
  } catch (error) { next(error); }
});

router.post('/ai/anomalies/detect', async (req, res, next) => {
  try {
    const aiCashFlow = require('../services/aiCashFlowService');
    const result = await aiCashFlow.detectAnomalies();
    res.json(result);
  } catch (error) { next(error); }
});

// ===== AI DOCUMENT INTELLIGENCE =====
router.get('/ai/documents/:projectId', async (req, res, next) => {
  try {
    const docIntel = require('../services/aiDocumentIntelligenceService');
    const documents = await docIntel.getProjectDocuments(parseInt(req.params.projectId, 10));
    res.json({ success: true, documents });
  } catch (error) { next(error); }
});

router.post('/ai/documents/parse', async (req, res, next) => {
  try {
    const docIntel = require('../services/aiDocumentIntelligenceService');
    const { project_id, doc_type, file_name, content } = req.body;
    const result = await docIntel.parseDocument(project_id ? parseInt(project_id, 10) : null, doc_type, file_name, content);
    res.json(result);
  } catch (error) { next(error); }
});

// ===== TREASURY MULTI-SIG =====
router.get('/treasury/proposals/:walletId', async (req, res, next) => {
  try {
    const treasury = require('../services/treasuryMultiSigService');
    const proposals = await treasury.listProposals(parseInt(req.params.walletId, 10));
    res.json({ success: true, proposals });
  } catch (error) { next(error); }
});

router.post('/treasury/proposals', async (req, res, next) => {
  try {
    const treasury = require('../services/treasuryMultiSigService');
    const result = await treasury.createProposal(req.user.id, req.body);
    await logAction(req.user.id, 'TREASURY_PROPOSAL_CREATED', 'TREASURY_PROPOSAL', result.proposal.id, { wallet_id: req.body.walletId }, req);
    res.json(result);
  } catch (error) { next(error); }
});

router.post('/treasury/proposals/:id/sign', requireStepUp('TREASURY_EXECUTE'), async (req, res, next) => {
  try {
    const treasury = require('../services/treasuryMultiSigService');
    const { approve } = req.body;
    const result = await treasury.signProposal(req.user.id, parseInt(req.params.id, 10), approve !== false);
    await logAction(req.user.id, 'TREASURY_PROPOSAL_SIGNED', 'TREASURY_PROPOSAL', parseInt(req.params.id, 10), { approve: approve !== false, executed: result.executed }, req);
    res.json(result);
  } catch (error) { next(error); }
});

// ===== PROJECT MONITORING & VARIANCE =====
router.get('/projects/:id/monitoring', async (req, res, next) => {
  try {
    const monitor = require('../services/projectMonitoringService');
    const snapshots = await monitor.getProjectMonitoring(parseInt(req.params.id, 10));
    res.json({ success: true, snapshots });
  } catch (error) { next(error); }
});

router.post('/projects/monitoring', async (req, res, next) => {
  try {
    const monitor = require('../services/projectMonitoringService');
    const result = await monitor.recordMonitoring({ ...req.body, reviewedBy: req.user.id });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/projects/:id/milestones', async (req, res, next) => {
  try {
    const monitor = require('../services/projectMonitoringService');
    const milestones = await monitor.listMilestones(parseInt(req.params.id, 10));
    res.json({ success: true, milestones });
  } catch (error) { next(error); }
});

router.post('/projects/milestones', async (req, res, next) => {
  try {
    const monitor = require('../services/projectMonitoringService');
    const milestone = await monitor.addMilestone(req.body);
    res.json({ success: true, milestone });
  } catch (error) { next(error); }
});

router.put('/projects/milestones/:id', async (req, res, next) => {
  try {
    const monitor = require('../services/projectMonitoringService');
    const milestone = await monitor.updateMilestone(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, milestone });
  } catch (error) { next(error); }
});

module.exports = router;
