const express = require('express');
const payrollService = require('../services/payrollService');
const { authRequired, requireRoles } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

// ===== Employee / member: my payslips =====
router.get('/payslips', async (req, res, next) => {
  try {
    const payslips = await payrollService.listPayslipsForUser(req.user.id);
    res.json({ success: true, payslips });
  } catch (error) { next(error); }
});

// ===== Admin: schedule management =====
router.post('/schedules', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const result = await payrollService.createSchedule(req.user.id, req.body);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/schedules', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const schedules = await payrollService.listSchedules();
    res.json({ success: true, schedules });
  } catch (error) { next(error); }
});

router.post('/schedules/:id/entries', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const entry = await payrollService.addScheduleEntry(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, entry });
  } catch (error) { next(error); }
});

router.patch('/schedules/:id/status', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const schedule = await payrollService.pauseSchedule(parseInt(req.params.id, 10), !!req.body.active);
    res.json({ success: true, schedule });
  } catch (error) { next(error); }
});

// ===== Runs =====
router.post('/runs', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { scheduleId, periodStart, periodEnd, approveImmediately } = req.body;
    const result = await payrollService.runPayroll(parseInt(scheduleId, 10), { periodStart, periodEnd, approveImmediately });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/runs', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const runs = await payrollService.listRuns(req.query.schedule_id ? parseInt(req.query.schedule_id, 10) : null);
    res.json({ success: true, runs });
  } catch (error) { next(error); }
});

router.post('/runs/:id/approve', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const result = await payrollService.approveAndPayRun(parseInt(req.params.id, 10), req.user.id);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/runs/:id/payslips', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const payslips = await payrollService.listRunPayslips(parseInt(req.params.id, 10));
    res.json({ success: true, payslips });
  } catch (error) { next(error); }
});

module.exports = router;
