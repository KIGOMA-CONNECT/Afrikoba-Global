const express = require('express');
const projectService = require('../services/projectService');
const projectFinance = require('../services/projectFinanceService');
const { authRequired, requireRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// ============================================================================
// PROJECT FINANCE GOVERNANCE (FinOS Phase 0-2)
// ============================================================================

// --- Project documents -------------------------------------------------------
router.post('/projects/:id/documents', async (req, res, next) => {
  try {
    const doc = await projectFinance.addProjectDocument(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, document: doc });
  } catch (e) { next(e); }
});

router.get('/projects/:id/documents', async (req, res, next) => {
  try {
    const docs = await projectFinance.listProjectDocuments(parseInt(req.params.id, 10));
    return res.json({ success: true, documents: docs });
  } catch (e) { next(e); }
});

router.get('/projects/:id/documents/:documentId', async (req, res, next) => {
  try {
    const doc = await projectFinance.getProjectDocument(parseInt(req.params.id, 10), parseInt(req.params.documentId, 10));
    return res.json({ success: true, document: doc });
  } catch (e) { next(e); }
});

router.delete('/projects/:id/documents/:documentId', async (req, res, next) => {
  try {
    const result = await projectFinance.deleteProjectDocument(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.documentId, 10));
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

// --- Waterfall rules (versioned & freezable) ---------------------------------
router.get('/projects/:id/waterfall-rules', async (req, res, next) => {
  try {
    const rules = await projectFinance.listWaterfallRules(parseInt(req.params.id, 10));
    return res.json({ success: true, rules });
  } catch (e) { next(e); }
});

router.post('/projects/:id/waterfall-rules', async (req, res, next) => {
  try {
    const rule = await projectFinance.createInitialRules(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, rule });
  } catch (e) { next(e); }
});

router.post('/projects/:id/waterfall-rules/proposals', async (req, res, next) => {
  try {
    const rule = await projectFinance.proposeWaterfallRules(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, rule });
  } catch (e) { next(e); }
});

router.post('/projects/:id/waterfall-rules/:ruleId/approve', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const rule = await projectFinance.approveWaterfallRule(req.user.id, parseInt(req.params.ruleId, 10), req.body);
    return res.json({ success: true, rule });
  } catch (e) { next(e); }
});

router.post('/projects/:id/waterfall-rules/:ruleId/freeze', requireRoles('ADMIN', 'MODERATOR'), async (req, res, next) => {
  try {
    const rule = await projectFinance.freezeWaterfallRule(req.user.id, parseInt(req.params.ruleId, 10));
    return res.json({ success: true, rule });
  } catch (e) { next(e); }
});

router.post('/projects/:id/waterfall-rules/:ruleId/unfreeze', requireRoles('ADMIN', 'MODERATOR'), async (req, res, next) => {
  try {
    const rule = await projectFinance.unfreezeWaterfallRule(req.user.id, parseInt(req.params.ruleId, 10));
    return res.json({ success: true, rule });
  } catch (e) { next(e); }
});

// --- Incoming revenue & waterfall engine --------------------------------------
router.post('/projects/:id/revenue/process-incoming', async (req, res, next) => {
  try {
    const { amount, revenue_type, unique_reference, description } = req.body;
    const result = await projectFinance.processIncomingRevenue(req.user.id, parseInt(req.params.id, 10), { amount, revenue_type, unique_reference, description });
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/projects/:id/revenue/transactions', async (req, res, next) => {
  try {
    const revenue = await projectFinance.listRevenueTransactions(parseInt(req.params.id, 10));
    return res.json({ success: true, revenue });
  } catch (e) { next(e); }
});

router.get('/projects/:id/revenue/allocations', async (req, res, next) => {
  try {
    const allocations = await projectFinance.listRevenueAllocations(parseInt(req.params.id, 10));
    return res.json({ success: true, allocations });
  } catch (e) { next(e); }
});

// --- Milestone proof & expert review ------------------------------------------
router.post('/projects/:id/milestones/:milestoneId/submit-proof', async (req, res, next) => {
  try {
    const milestone = await projectFinance.submitMilestoneProof(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.milestoneId, 10), req.body);
    return res.status(201).json({ success: true, milestone });
  } catch (e) { next(e); }
});

router.get('/projects/:id/milestones/:milestoneId/evidence', async (req, res, next) => {
  try {
    const evidence = await projectFinance.listMilestoneEvidence(parseInt(req.params.id, 10), parseInt(req.params.milestoneId, 10));
    return res.json({ success: true, evidence });
  } catch (e) { next(e); }
});

router.post('/projects/:id/milestones/:milestoneId/expert-review', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const milestone = await projectFinance.reviewMilestone(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.milestoneId, 10), req.body);
    return res.json({ success: true, milestone });
  } catch (e) { next(e); }
});

router.post('/projects/:id/milestones/:milestoneId/approve', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const milestone = await projectFinance.reviewMilestone(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.milestoneId, 10), { decision: 'APPROVED', ...req.body });
    return res.json({ success: true, milestone });
  } catch (e) { next(e); }
});

router.post('/projects/:id/milestones/:milestoneId/reject', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const milestone = await projectFinance.reviewMilestone(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.milestoneId, 10), { decision: 'REJECTED', ...req.body });
    return res.json({ success: true, milestone });
  } catch (e) { next(e); }
});

// --- Two-phase disbursement governance -----------------------------------------
router.get('/projects/:id/disbursement-requests', async (req, res, next) => {
  try {
    const requests = await projectFinance.listDisbursementRequests(parseInt(req.params.id, 10));
    return res.json({ success: true, requests });
  } catch (e) { next(e); }
});

router.post('/projects/:id/disbursement-requests', async (req, res, next) => {
  try {
    const result = await projectFinance.requestDisbursement(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/projects/:id/disbursement-requests/:requestId/expert-review', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const request = await projectFinance.reviewDisbursement(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.requestId, 10), req.body);
    return res.json({ success: true, request });
  } catch (e) { next(e); }
});

router.post('/projects/:id/disbursement-requests/:requestId/approve', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const request = await projectFinance.approveDisbursement(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.requestId, 10));
    return res.json({ success: true, request });
  } catch (e) { next(e); }
});

router.post('/projects/:id/disbursement-requests/:requestId/reject', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const request = await projectFinance.rejectDisbursement(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.requestId, 10), req.body);
    return res.json({ success: true, request });
  } catch (e) { next(e); }
});

router.post('/projects/:id/disbursement-requests/:requestId/execute', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const result = await projectFinance.executeDisbursement(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.requestId, 10));
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

// --- AI review (advisory only) & audit trail ------------------------------------
router.get('/projects/:id/ai-review', async (req, res, next) => {
  try {
    const review = await projectFinance.getAiReview(parseInt(req.params.id, 10));
    return res.json({ success: true, review });
  } catch (e) { next(e); }
});

router.post('/projects/:id/ai-review/re-run', async (req, res, next) => {
  try {
    const review = await projectFinance.runAiReview(parseInt(req.params.id, 10));
    return res.json({ success: true, review });
  } catch (e) { next(e); }
});

// --- Phase 3: consultation fee & expert review queue -----------------------------
router.post('/projects/:id/consultation/pay', async (req, res, next) => {
  try {
    const { unique_reference } = req.body;
    if (!unique_reference) {
      return res.status(400).json({ success: false, message: 'unique_reference inahitajika.' });
    }
    const result = await projectFinance.payConsultationFee(parseInt(req.params.id, 10), req.user.id, unique_reference);
    return res.status(result.already_paid ? 200 : 201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/projects/:id/consultation/status', async (req, res, next) => {
  try {
    const project = await projectService.getProject(parseInt(req.params.id, 10));
    const consultations = await projectFinance.listConsultations(parseInt(req.params.id, 10));
    return res.json({
      success: true,
      fee: Number(project.consultation_fee) || 0,
      paid_at: project.consultation_paid_at || null,
      consultation_count: consultations.length,
      consultations,
    });
  } catch (e) { next(e); }
});

router.get('/projects/review-queue', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const queue = await projectFinance.listProjectsForReview();
    return res.json({ success: true, queue });
  } catch (e) { next(e); }
});

router.get('/projects/:id/audit-trail', async (req, res, next) => {
  try {
    const trail = await projectFinance.getAuditTrail(parseInt(req.params.id, 10));
    return res.json({ success: true, trail });
  } catch (e) { next(e); }
});

// --- Project submission & workflow ---------------------------------------
router.post('/projects', async (req, res, next) => {
  try {
    const project = await projectService.createProject(req.user.id, req.body);
    return res.status(201).json({ success: true, project });
  } catch (e) { next(e); }
});

router.post('/projects/:id/submit', async (req, res, next) => {
  try {
    const project = await projectService.submitProject(req.user.id, parseInt(req.params.id, 10));
    return res.json({ success: true, project });
  } catch (e) { next(e); }
});

// Governance workflow (admin / moderator only)
router.post('/projects/:id/workflow', requireRoles('ADMIN', 'MODERATOR'), async (req, res, next) => {
  try {
    const { stage, decision, reason, risk_classification } = req.body;
    const project = await projectService.makeWorkflowDecision(req.user.id, parseInt(req.params.id, 10), { stage, decision, reason, risk_classification });
    return res.json({ success: true, project });
  } catch (e) { next(e); }
});

router.post('/projects/:id/publish', requireRoles('ADMIN', 'MODERATOR'), async (req, res, next) => {
  try {
    const project = await projectService.publishProject(req.user.id, parseInt(req.params.id, 10));
    return res.json({ success: true, project });
  } catch (e) { next(e); }
});

// --- Agreements -----------------------------------------------------------
router.post('/projects/:id/agreements', async (req, res, next) => {
  try {
    const agreement = await projectService.createAgreement(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, agreement });
  } catch (e) { next(e); }
});

router.get('/projects/:id/agreements', async (req, res, next) => {
  try {
    const agreements = await projectService.listAgreements(req.user.id, parseInt(req.params.id, 10));
    return res.json({ success: true, agreements });
  } catch (e) { next(e); }
});

// --- Investment -----------------------------------------------------------
router.post('/projects/:id/invest', async (req, res, next) => {
  try {
    const { amount, unique_reference, agreement_version } = req.body;
    const result = await projectService.invest(req.user.id, parseInt(req.params.id, 10), { amount, unique_reference, agreement_version });
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

// --- Budget & Milestones ---------------------------------------------------
router.post('/projects/:id/budget', async (req, res, next) => {
  try {
    const item = await projectService.addBudgetItem(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, item });
  } catch (e) { next(e); }
});

router.post('/projects/:id/milestones', async (req, res, next) => {
  try {
    const milestone = await projectService.addMilestone(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, milestone });
  } catch (e) { next(e); }
});

router.post('/projects/:id/disbursement', async (req, res, next) => {
  try {
    const { milestone_id, amount, unique_reference } = req.body;
    const result = await projectService.disburse(req.user.id, parseInt(req.params.id, 10), { milestone_id, amount, unique_reference });
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/projects/:id/progress', async (req, res, next) => {
  try {
    const { completion_pct, expenditure, details } = req.body;
    const report = await projectService.submitProgressReport(req.user.id, parseInt(req.params.id, 10), { completion_pct, expenditure, details });
    return res.status(201).json({ success: true, report });
  } catch (e) { next(e); }
});

// --- Revenue / Payroll / Distribution --------------------------------------
router.post('/projects/:id/revenue', async (req, res, next) => {
  try {
    const { revenue_type, amount, unique_reference } = req.body;
    const result = await projectService.recordRevenue(req.user.id, parseInt(req.params.id, 10), { revenue_type, amount, unique_reference });
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/projects/:id/payroll', async (req, res, next) => {
  try {
    const { payee_user_id, role, amount, unique_reference } = req.body;
    const result = await projectService.recordPayroll(req.user.id, parseInt(req.params.id, 10), { payee_user_id, role, amount, unique_reference });
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/projects/:id/distribution', async (req, res, next) => {
  try {
    const { gross_profit, period_label } = req.body;
    const result = await projectService.computeDistribution(req.user.id, parseInt(req.params.id, 10), { gross_profit, period_label });
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

// --- Reads ------------------------------------------------------------------
router.get('/projects', async (req, res, next) => {
  try {
    const projects = await projectService.listProjects(req.query.status || null);
    return res.json({ success: true, projects });
  } catch (e) { next(e); }
});

router.get('/projects/mine/investments', async (req, res, next) => {
  try {
    const investments = await projectService.listMyInvestments(req.user.id);
    return res.json({ success: true, investments });
  } catch (e) { next(e); }
});

router.get('/projects/:id', async (req, res, next) => {
  try {
    const project = await projectService.getProject(parseInt(req.params.id, 10));
    const [budget, milestones, progress, reports] = await Promise.all([
      projectService.listBudget(project.id),
      projectService.listMilestones(project.id),
      projectService.listProgressReports(project.id),
    ]);
    return res.json({ success: true, project, budget, milestones, progress, reports });
  } catch (e) { next(e); }
});

router.get('/projects/:id/financials', async (req, res, next) => {
  try {
    const financials = await projectService.getProjectFinancials(req.user.id, parseInt(req.params.id, 10));
    return res.json({ success: true, financials });
  } catch (e) { next(e); }
});

module.exports = router;
