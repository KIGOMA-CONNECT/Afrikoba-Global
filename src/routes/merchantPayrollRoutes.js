/**
 * Merchant Payroll Routes (merchant-funded payroll).
 * Mounted at /api/merchant/payroll.
 */
const express = require('express');
const pool = require('../config/db');
const payrollService = require('../services/payrollService');
const { authRequired } = require('../middleware/auth');
const { requireStepUp } = require('../services/stepUpAuthService');

const router = express.Router();
router.use(authRequired);

async function myMerchantId(req) { return (await payrollService.merchantForUser(req.user.id)).id; }

// ===== Schedules =====
router.post('/schedules', async (req, res, next) => {
  try {
    const merchantId = await myMerchantId(req);
    const result = await payrollService.createSchedule(req.user.id, { ...req.body, merchantId });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/schedules', async (req, res, next) => {
  try {
    const merchantId = await myMerchantId(req);
    const schedules = await payrollService.listSchedules({ merchantId });
    res.json({ success: true, schedules });
  } catch (error) { next(error); }
});

router.post('/schedules/:id/entries', async (req, res, next) => {
  try {
    await payrollService.assertScheduleOwnership(parseInt(req.params.id, 10), req.user.id);
    const entry = await payrollService.addScheduleEntry(parseInt(req.params.id, 10), req.body);
    res.json({ success: true, entry });
  } catch (error) { next(error); }
});

router.patch('/schedules/:id/status', async (req, res, next) => {
  try {
    await payrollService.assertScheduleOwnership(parseInt(req.params.id, 10), req.user.id);
    const schedule = await payrollService.pauseSchedule(parseInt(req.params.id, 10), !!req.body.active);
    res.json({ success: true, schedule });
  } catch (error) { next(error); }
});

// ===== Runs =====
router.post('/runs', async (req, res, next) => {
  try {
    const merchantId = await myMerchantId(req);
    const { scheduleId, periodStart, periodEnd, approveImmediately } = req.body;
    const sched = await payrollService.assertScheduleOwnership(parseInt(scheduleId, 10), req.user.id);
    if (Number(sched.merchant_id) !== merchantId) return res.status(403).json({ success: false, error: 'Ratiba hailekewi.' });
    const result = await payrollService.runPayroll(parseInt(scheduleId, 10), { periodStart, periodEnd, approveImmediately });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/runs', async (req, res, next) => {
  try {
    const merchantId = await myMerchantId(req);
    const runs = await payrollService.listRuns(req.query.schedule_id ? parseInt(req.query.schedule_id, 10) : null, { merchantId });
    res.json({ success: true, runs });
  } catch (error) { next(error); }
});

router.post('/runs/:id/approve', requireStepUp('PAYROLL_PAY'), async (req, res, next) => {
  try {
    const run = await assertRunMerchant(req, parseInt(req.params.id, 10));
    const result = await payrollService.approveAndPayRun(run.id, req.user.id);
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/runs/:id/payslips', async (req, res, next) => {
  try {
    const run = await assertRunMerchant(req, parseInt(req.params.id, 10));
    const payslips = await payrollService.listRunPayslips(run.id);
    res.json({ success: true, payslips });
  } catch (error) { next(error); }
});

async function assertRunMerchant(req, runId) {
  const merchantId = await myMerchantId(req);
  const run = (await pool.query('SELECT * FROM payroll_runs WHERE id=$1', [runId])).rows[0];
  if (!run) throw Object.assign(new Error('Run haipatikani.'), { statusCode: 404 });
  if (Number(run.merchant_id) !== merchantId) throw Object.assign(new Error('Run hailekewi.'), { statusCode: 403 });
  return run;
}

module.exports = router;