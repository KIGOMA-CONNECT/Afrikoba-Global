const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const referralService = require('../services/referralService');

const router = express.Router();

// Get my referral code + stats
router.get('/my-code', authRequired, async (req, res, next) => {
  try {
    const stats = await referralService.getReferralStats(req.user.id);
    res.json({ success: true, ...stats });
  } catch (error) {
    next(error);
  }
});

// Generate new referral code
router.post('/generate-code', authRequired, async (req, res, next) => {
  try {
    const code = await referralService.generateReferralCode(req.user.id);
    res.json({ success: true, code });
  } catch (error) {
    next(error);
  }
});

// Admin: get all referrals
router.get('/admin/all', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await referralService.getAllReferrals({
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 20, 100),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
