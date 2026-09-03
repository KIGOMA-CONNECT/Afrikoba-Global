const express = require('express');
const projectService = require('../services/projectService');
const { authRequired, requireRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

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
