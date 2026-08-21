const express = require('express');
const mkobaService = require('../services/mkobaService');
const { authRequired } = require('../middleware/auth');
const { requireService } = require('../middleware/serviceGuard');

const router = express.Router();

router.use(authRequired);
router.use(requireService('VICOBA'));

// ==========================================
// GROUP CONSTITUTION / RULES
// ==========================================

router.post('/groups/:groupId/constitution', async (req, res, next) => {
  try {
    const constitution = await mkobaService.createConstitution(
      parseInt(req.params.groupId, 10),
      req.body
    );
    return res.status(201).json({ success: true, constitution });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/constitution', async (req, res, next) => {
  try {
    const constitution = await mkobaService.getConstitution(parseInt(req.params.groupId, 10));
    return res.json({ success: true, constitution });
  } catch (error) { next(error); }
});

// ==========================================
// SHARE PURCHASING
// ==========================================

router.post('/groups/:groupId/shares/buy', async (req, res, next) => {
  try {
    const { sharesCount } = req.body;
    if (!sharesCount) return res.status(400).json({ success: false, message: 'Jaza sharesCount.' });
    const result = await mkobaService.buyShares(req.user.id, parseInt(req.params.groupId, 10), sharesCount);
    return res.json(result);
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/shares', async (req, res, next) => {
  try {
    const purchases = await mkobaService.getSharePurchases(parseInt(req.params.groupId, 10));
    return res.json({ success: true, purchases });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/shares/my', async (req, res, next) => {
  try {
    const purchases = await mkobaService.getSharePurchases(parseInt(req.params.groupId, 10), req.user.id);
    return res.json({ success: true, purchases });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/shares/summary', async (req, res, next) => {
  try {
    const summary = await mkobaService.getMemberShareSummary(parseInt(req.params.groupId, 10));
    return res.json({ success: true, summary });
  } catch (error) { next(error); }
});

// ==========================================
// PROFIT SHARING
// ==========================================

router.post('/groups/:groupId/profits/calculate', async (req, res, next) => {
  try {
    const { cycleNumber, totalProfit } = req.body;
    if (!cycleNumber || !totalProfit) return res.status(400).json({ success: false, message: 'Jaza cycleNumber na totalProfit.' });
    const result = await mkobaService.calculateProfitDistribution(
      parseInt(req.params.groupId, 10), cycleNumber, totalProfit
    );
    return res.status(201).json({ success: true, ...result });
  } catch (error) { next(error); }
});

router.post('/profits/:distributionId/approve', async (req, res, next) => {
  try {
    const result = await mkobaService.approveProfitDistribution(
      parseInt(req.params.distributionId, 10), req.user.id
    );
    return res.json(result);
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/profits', async (req, res, next) => {
  try {
    const distributions = await mkobaService.getProfitDistributions(parseInt(req.params.groupId, 10));
    return res.json({ success: true, distributions });
  } catch (error) { next(error); }
});

router.get('/profits/my', async (req, res, next) => {
  try {
    const payouts = await mkobaService.getMyProfitPayouts(req.user.id);
    return res.json({ success: true, payouts });
  } catch (error) { next(error); }
});

// ==========================================
// 3-TIER FUND TRANSFERS
// ==========================================

router.post('/groups/:groupId/transfers', async (req, res, next) => {
  try {
    const { transferType, recipientUserId, recipientPhone, amount, note } = req.body;
    if (!amount) return res.status(400).json({ success: false, message: 'Jaza amount.' });
    const result = await mkobaService.initiateTransfer(
      req.user.id, parseInt(req.params.groupId, 10),
      { transferType, recipientUserId, recipientPhone, amount, note }
    );
    return res.status(201).json(result);
  } catch (error) { next(error); }
});

router.post('/transfers/:transferId/verify', async (req, res, next) => {
  try {
    const { approved, note } = req.body;
    if (approved === undefined) return res.status(400).json({ success: false, message: 'Jaza approved (true/false).' });
    const result = await mkobaService.verifyTransfer(req.user.id, parseInt(req.params.transferId, 10), { approved, note });
    return res.json(result);
  } catch (error) { next(error); }
});

router.post('/transfers/:transferId/approve', async (req, res, next) => {
  try {
    const { approved, note } = req.body;
    if (approved === undefined) return res.status(400).json({ success: false, message: 'Jaza approved (true/false).' });
    const result = await mkobaService.approveTransfer(req.user.id, parseInt(req.params.transferId, 10), { approved, note });
    return res.json(result);
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/transfers', async (req, res, next) => {
  try {
    const transfers = await mkobaService.listTransfers(parseInt(req.params.groupId, 10), req.query.status);
    return res.json({ success: true, transfers });
  } catch (error) { next(error); }
});

// ==========================================
// CROSS-NETWORK TOP-UP
// ==========================================

router.post('/groups/:groupId/topup/cross-network', async (req, res, next) => {
  try {
    const { amount, provider, externalRef, phone } = req.body;
    if (!amount || !provider) return res.status(400).json({ success: false, message: 'Jaza amount na provider.' });
    const result = await mkobaService.processCrossNetworkTopUp(
      parseInt(req.params.groupId, 10), req.user.id,
      { amount, provider, externalRef, phone }
    );
    return res.json(result);
  } catch (error) { next(error); }
});

// ==========================================
// MEETING ATTENDANCE
// ==========================================

router.post('/groups/:groupId/meetings', async (req, res, next) => {
  try {
    const { meetingDate, notes } = req.body;
    if (!meetingDate) return res.status(400).json({ success: false, message: 'Jaza meetingDate.' });
    const meeting = await mkobaService.scheduleMeeting(
      parseInt(req.params.groupId, 10), meetingDate, notes
    );
    return res.status(201).json({ success: true, meeting });
  } catch (error) { next(error); }
});

router.post('/meetings/:meetingId/attendance', async (req, res, next) => {
  try {
    const { userId, status, notes } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'Jaza userId.' });
    const result = await mkobaService.recordAttendance(
      parseInt(req.params.meetingId, 10), userId, status, notes
    );
    return res.json(result);
  } catch (error) { next(error); }
});

router.post('/meetings/:meetingId/attendance/bulk', async (req, res, next) => {
  try {
    const { attendance } = req.body;
    if (!Array.isArray(attendance) || attendance.length === 0) {
      return res.status(400).json({ success: false, message: 'Jaza attendance (list ya {userId, status}).' });
    }
    const results = await mkobaService.bulkRecordAttendance(
      parseInt(req.params.meetingId, 10), attendance
    );
    return res.json({ success: true, results });
  } catch (error) { next(error); }
});

router.get('/meetings/:meetingId/attendance', async (req, res, next) => {
  try {
    const attendance = await mkobaService.getMeetingAttendance(parseInt(req.params.meetingId, 10));
    return res.json({ success: true, attendance });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/attendance/my', async (req, res, next) => {
  try {
    const summary = await mkobaService.getMemberAttendanceSummary(
      parseInt(req.params.groupId, 10), req.user.id
    );
    return res.json({ success: true, summary });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/attendance/report', async (req, res, next) => {
  try {
    const report = await mkobaService.getGroupAttendanceReport(parseInt(req.params.groupId, 10));
    return res.json({ success: true, report });
  } catch (error) { next(error); }
});

// ==========================================
// ADVANCED REPORTING
// ==========================================

router.get('/groups/:groupId/reports/financial', async (req, res, next) => {
  try {
    const summary = await mkobaService.getGroupFinancialSummary(parseInt(req.params.groupId, 10));
    return res.json({ success: true, summary });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/reports/member', async (req, res, next) => {
  try {
    const summary = await mkobaService.getMemberFinancialSummary(
      parseInt(req.params.groupId, 10), req.user.id
    );
    return res.json({ success: true, summary });
  } catch (error) { next(error); }
});

router.get('/groups/:groupId/reports/loan-aging', async (req, res, next) => {
  try {
    const report = await mkobaService.getLoanAgingReport(parseInt(req.params.groupId, 10));
    return res.json({ success: true, report });
  } catch (error) { next(error); }
});

module.exports = router;
