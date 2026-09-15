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

// --- Phase 4: Transparency & investor notifications --------------------------
router.get('/projects/mine/transparency', async (req, res, next) => {
  try {
    const investments = await projectFinance.getMyTransparency(req.user.id);
    return res.json({ success: true, investments });
  } catch (e) { next(e); }
});

router.get('/projects/:id/transparency', async (req, res, next) => {
  try {
    const transparency = await projectFinance.getProjectTransparency(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, transparency });
  } catch (e) { next(e); }
});

router.get('/projects/:id/payouts', async (req, res, next) => {
  try {
    const result = await projectFinance.listDividendPayouts(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/projects/:id/dividend/payout', requireRoles('ADMIN', 'MODERATOR', 'EXPERT'), async (req, res, next) => {
  try {
    const result = await projectFinance.payProjectDividends({ projectId: parseInt(req.params.id, 10), actorUserId: req.user.id, actorRole: req.user.role });
    return res.json({ success: true, ...result });
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

// Phase 5: investment refund (project must be EXPIRED) and cap table
router.post('/projects/:id/investments/:investmentId/refund', async (req, res, next) => {
  try {
    const result = await projectService.refundInvestment(parseInt(req.params.id, 10), parseInt(req.params.investmentId, 10), req.user.id);
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/projects/:id/cap-table', async (req, res, next) => {
  try {
    const capTable = await projectService.getCapTable(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, capTable });
  } catch (e) { next(e); }
});

// Phase 6: lifecycle completion & settlement reporting
router.post('/projects/:id/complete', async (req, res, next) => {
  try {
    const result = await projectFinance.completeProject({
      projectId: parseInt(req.params.id, 10), actorUserId: req.user.id, actorRole: req.user.role,
    });
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/projects/:id/settlement', async (req, res, next) => {
  try {
    const report = await projectFinance.getSettlementReport(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, ...report });
  } catch (e) { next(e); }
});

// Phase 19: audit-grade settlement report PDF (owner/investor/expert)
router.get('/projects/:id/settlement/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareSettlementPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="settlement-${data.document_reference}.pdf"`);
    projectFinance.renderSettlementReportPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 20: audit-grade liquidation report PDF (owner/expert)
router.get('/projects/:id/liquidation/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareLiquidationPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="liquidation-${data.reference}.pdf"`);
    projectFinance.renderLiquidationReportPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 20: audit-grade close-out report PDF (owner/investor/expert)
router.get('/projects/:id/close-out/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareCloseOutPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="closeout-${data.project.id}.pdf"`);
    projectFinance.renderCloseOutReportPdf(data, res);
  } catch (e) { next(e); }
});

router.get('/projects/mine/performance', async (req, res, next) => {
  try {
    const performance = await projectFinance.getMyPerformance(req.user.id);
    return res.json({ success: true, ...performance });
  } catch (e) { next(e); }
});

router.get('/projects/mine/performance/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportMyPerformanceCsv(req.user.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=my-project-portfolio.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

// Phase 27: investor self-service performance statement (PDF)
router.get('/projects/mine/performance/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareMyPerformancePdf(req.user.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=my-project-portfolio.pdf');
    projectFinance.renderMyPerformancePdf(data, res);
  } catch (e) { next(e); }
});

// Phase 27: platform investor registry (JSON / CSV / PDF) - expert only
router.get('/projects/ops/investor-registry', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getPlatformInvestorRegistry({ userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/ops/investor-registry/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportPlatformInvestorRegistryCsv({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=platform-investor-registry.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/ops/investor-registry/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.preparePlatformInvestorRegistryPdf({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=platform-investor-registry.pdf');
    projectFinance.renderPlatformInvestorRegistryPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 7/8: close-out - fund release to owner (reserve + residual) + report
router.post('/projects/:id/close-out/reserve', async (req, res, next) => {
  try {
    const result = await projectFinance.releaseOwnerReserve({
      projectId: parseInt(req.params.id, 10), actorUserId: req.user.id, actorRole: req.user.role,
    });
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.post('/projects/:id/close-out/residual', async (req, res, next) => {
  try {
    const result = await projectFinance.releaseOwnerResidual({
      projectId: parseInt(req.params.id, 10), actorUserId: req.user.id, actorRole: req.user.role,
    });
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/projects/:id/close-out', async (req, res, next) => {
  try {
    const report = await projectFinance.getCloseOutReport(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, ...report });
  } catch (e) { next(e); }
});

// Phase 9: per-stakeholder project statement (any lifecycle state) + CSV export
router.get('/projects/:id/statement', async (req, res, next) => {
  try {
    const statement = await projectFinance.getProjectStatement(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, ...statement });
  } catch (e) { next(e); }
});

router.get('/projects/:id/statement/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportProjectStatementCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=project-${req.params.id}-statement.csv`);
    return res.send(csv);
  } catch (e) { next(e); }
});

// Phase 10: liquidation report + final close (terminal lifecycle step)
router.get('/projects/:id/liquidation', async (req, res, next) => {
  try {
    const report = await projectFinance.getLiquidationReport(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(report);
  } catch (e) { next(e); }
});

router.post('/projects/:id/liquidate', async (req, res, next) => {
  try {
    const result = await projectFinance.liquidateProject(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

// Phase 11: personal stakeholder receipt (owner / own-investor position) + CSV
router.get('/projects/:id/receipt', async (req, res, next) => {
  try {
    const receipt = await projectFinance.getPersonalReceipt(parseInt(req.params.id, 10), { userId: req.user.id });
    return res.json(receipt);
  } catch (e) { next(e); }
});

router.get('/projects/:id/receipt/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportPersonalReceiptCsv(parseInt(req.params.id, 10), { userId: req.user.id });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=project-${req.params.id}-receipt.csv`);
    return res.send(csv);
  } catch (e) { next(e); }
});

// Phase 19: audit-grade personal investment receipt PDF (owner/investor)
router.get('/projects/:id/receipt/pdf', async (req, res, next) => {
  try {
    const receipt = await projectFinance.getPersonalReceipt(parseInt(req.params.id, 10), { userId: req.user.id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=${receipt.receipt_reference}.pdf`);
    projectFinance.renderPersonalReceiptPdf(receipt, res);
  } catch (e) { next(e); }
});

// Phase 12: authorized transaction-level project ledger (provenance / audit)
router.get('/projects/:id/ledger', async (req, res, next) => {
  try {
    const ledger = await projectFinance.getProjectLedger(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(ledger);
  } catch (e) { next(e); }
});

// Phase 14: close-out report + liquidation snapshot CSV exports
router.get('/projects/:id/close-out/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportCloseOutReportCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=project-${req.params.id}-closeout.csv`);
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/liquidation/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportLiquidationCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=project-${req.params.id}-liquidation.csv`);
    return res.send(csv);
  } catch (e) { next(e); }
});

// Phase 13: scheduled drawdown plan (tranche cash management)
router.post('/projects/:id/drawdowns', async (req, res, next) => {
  try {
    const result = await projectFinance.createDrawdownPlan(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

router.get('/projects/:id/drawdowns', async (req, res, next) => {
  try {
    const result = await projectFinance.listDrawdowns(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(result);
  } catch (e) { next(e); }
});

// Phase 15: governed editing of SCHEDULED tranches (amount/purpose) + plan total
router.patch('/projects/:id/drawdowns', async (req, res, next) => {
  try {
    const result = await projectFinance.updateDrawdownPlan(req.user.id, parseInt(req.params.id, 10), req.body);
    return res.json(result);
  } catch (e) { next(e); }
});

router.post('/projects/:id/drawdowns/:trancheId/request', async (req, res, next) => {
  try {
    const result = await projectFinance.requestTranche(req.user.id, parseInt(req.params.id, 10), parseInt(req.params.trancheId, 10));
    return res.status(201).json({ success: true, ...result });
  } catch (e) { next(e); }
});

// Phase 18: audit-grade disbursement payment voucher (PDF), owner or expert only
router.get('/projects/:id/disbursements/voucher/:reference', async (req, res, next) => {
  try {
    const voucher = await projectFinance.getDisbursementVoucher(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }, decodeURIComponent(req.params.reference));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="voucher-${voucher.voucher_number}.pdf"`);
    projectFinance.renderDisbursementVoucherPdf(voucher, res);
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

// Phase 16: platform-wide project-finance operations book (ops/compliance)
router.get('/projects/ops/pfe-book', async (req, res, next) => {
  try {
    const book = await projectFinance.getPlatformPfeBook({ userId: req.user.id, role: req.user.role });
    return res.json(book);
  } catch (e) { next(e); }
});

router.get('/projects/ops/pfe-book/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportPlatformPfeBookCsv({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=platform-pfe-book.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

// Phase 21: audit-grade platform ops book PDF (expert)
router.get('/projects/ops/pfe-book/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareOpsBookPdf({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=platform-pfe-book.pdf');
    projectFinance.renderOpsBookPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 21: per-project waterfall execution ledger (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/waterfall-ledger', async (req, res, next) => {
  try {
    const ledger = await projectFinance.getWaterfallLedger(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(ledger);
  } catch (e) { next(e); }
});

router.get('/projects/:id/waterfall-ledger/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportWaterfallLedgerCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=waterfall-ledger.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/waterfall-ledger/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareWaterfallLedgerPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=waterfall-ledger.pdf');
    projectFinance.renderWaterfallLedgerPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 22: dividend payout register (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/payout-register', async (req, res, next) => {
  try {
    const reg = await projectFinance.getPayoutRegister(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(reg);
  } catch (e) { next(e); }
});

router.get('/projects/:id/payout-register/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportPayoutRegisterCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=payout-register.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/payout-register/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.preparePayoutRegisterPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=payout-register.pdf');
    projectFinance.renderPayoutRegisterPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 22: escrow & drawdown cash-flow projection (JSON / CSV) - owner/expert
router.get('/projects/:id/escrow-projection', async (req, res, next) => {
  try {
    const proj = await projectFinance.getEscrowProjection(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(proj);
  } catch (e) { next(e); }
});

router.get('/projects/:id/escrow-projection/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportEscrowProjectionCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=escrow-projection.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

// Phase 23: platform-wide dividend ledger (JSON / CSV / PDF) - expert
router.get('/projects/ops/dividend-ledger', async (req, res, next) => {
  try {
    const ledger = await projectFinance.getPlatformDividendLedger({ userId: req.user.id, role: req.user.role });
    return res.json(ledger);
  } catch (e) { next(e); }
});

router.get('/projects/ops/dividend-ledger/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportPlatformDividendLedgerCsv({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=platform-dividend-ledger.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/ops/dividend-ledger/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.preparePlatformDividendLedgerPdf({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=platform-dividend-ledger.pdf');
    projectFinance.renderPlatformDividendLedgerPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 23: per-project drawdown schedule document (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/drawdown-schedule', async (req, res, next) => {
  try {
    const doc = await projectFinance.getDrawdownSchedule(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    return res.json(doc);
  } catch (e) { next(e); }
});

router.get('/projects/:id/drawdown-schedule/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportDrawdownScheduleCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=drawdown-schedule.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/drawdown-schedule/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareDrawdownPlanPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=drawdown-schedule.pdf');
    projectFinance.renderDrawdownPlanPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 24: milestone operational register (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/milestone-register', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getMilestoneRegister(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/milestone-register/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportMilestoneRegisterCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=milestone-register.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/milestone-register/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareMilestoneRegisterPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=milestone-register.pdf');
    projectFinance.renderMilestoneRegisterPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 24: revenue processing register (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/revenue-register', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getRevenueRegister(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/revenue-register/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportRevenueRegisterCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=revenue-register.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/revenue-register/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareRevenueRegisterPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=revenue-register.pdf');
    projectFinance.renderRevenueRegisterPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 25: waterfall rules governance record (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/waterfall-governance', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getWaterfallGovernance(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/waterfall-governance/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportWaterfallGovernanceCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=waterfall-governance.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/waterfall-governance/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareWaterfallGovernancePdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=waterfall-governance.pdf');
    projectFinance.renderWaterfallGovernancePdf(data, res);
  } catch (e) { next(e); }
});

// Phase 26: reserve releases register (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/reserve-releases', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getReserveReleasesRegister(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/reserve-releases/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportReserveReleasesCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=reserve-releases.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/reserve-releases/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareReserveReleasesPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=reserve-releases.pdf');
    projectFinance.renderReserveReleasesPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 28: funding intake register (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/funding-intake', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getFundingIntakeRegister(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/funding-intake/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportFundingIntakeCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=funding-intake.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/funding-intake/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareFundingIntakePdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=funding-intake.pdf');
    projectFinance.renderFundingIntakePdf(data, res);
  } catch (e) { next(e); }
});

// Phase 29: platform project register (JSON / CSV / PDF) - expert only
router.get('/projects/ops/project-register', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getPlatformProjectRegister({ userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/ops/project-register/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportPlatformProjectRegisterCsv({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=platform-project-register.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/ops/project-register/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.preparePlatformProjectRegisterPdf({ userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=platform-project-register.pdf');
    projectFinance.renderPlatformProjectRegisterPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 30: settlement close-out register (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/settlement-register', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getSettlementRegister(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/settlement-register/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportSettlementRegisterCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=settlement-register.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/settlement-register/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareSettlementRegisterPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=settlement-register.pdf');
    projectFinance.renderSettlementRegisterPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 31: project escrow & wallet journal (JSON / CSV / PDF) - owner/expert
router.get('/projects/:id/wallet-journal', async (req, res, next) => {
  try {
    return res.json(await projectFinance.getWalletJournal(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role }));
  } catch (e) { next(e); }
});

router.get('/projects/:id/wallet-journal/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportWalletJournalCsv(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=wallet-journal.csv');
    return res.send(csv);
  } catch (e) { next(e); }
});

router.get('/projects/:id/wallet-journal/pdf', async (req, res, next) => {
  try {
    const data = await projectFinance.prepareWalletJournalPdf(parseInt(req.params.id, 10), { userId: req.user.id, role: req.user.role });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename=wallet-journal.pdf');
    projectFinance.renderWalletJournalPdf(data, res);
  } catch (e) { next(e); }
});

// Phase 17: admin force-close stuck funding + per-investor dividend statement
router.post('/projects/:id/funding/force-close', async (req, res, next) => {
  try {
    const r = await projectFinance.forceCloseFunding(req.user.id, req.user.role, parseInt(req.params.id, 10), req.body || {});
    return res.json(r);
  } catch (e) { next(e); }
});

router.get('/projects/:id/investor-statement', async (req, res, next) => {
  try {
    const stmt = await projectFinance.getInvestorStatement({ userId: req.user.id, role: req.user.role }, parseInt(req.params.id, 10));
    return res.json(stmt);
  } catch (e) { next(e); }
});

router.get('/projects/:id/investor-statement/export', async (req, res, next) => {
  try {
    const csv = await projectFinance.exportInvestorStatementCsv({ userId: req.user.id, role: req.user.role }, parseInt(req.params.id, 10));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=investor-statement.csv');
    return res.send(csv);
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
