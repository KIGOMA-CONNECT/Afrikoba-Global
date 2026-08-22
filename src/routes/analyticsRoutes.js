const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const analyticsService = require('../services/analyticsService');

const router = express.Router();

// Track event (authenticated)
router.post('/track', authRequired, async (req, res, next) => {
  try {
    const { eventType, eventData } = req.body;
    if (!eventType) return res.status(400).json({ success: false, message: 'eventType inahitajika.' });
    await analyticsService.trackEvent(req.user.id, eventType, eventData, req);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Admin: platform metrics
router.get('/admin/metrics', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const metrics = await analyticsService.getPlatformMetrics();
    res.json({ success: true, metrics });
  } catch (error) {
    next(error);
  }
});

// Admin: daily volume
router.get('/admin/volume', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const volume = await analyticsService.getDailyVolume();
    res.json({ success: true, volume });
  } catch (error) {
    next(error);
  }
});

// Admin: top users
router.get('/admin/top-users', authRequired, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const { limit } = req.query;
    const users = await analyticsService.getTopUsers(parseInt(limit) || 10);
    res.json({ success: true, users });
  } catch (error) {
    next(error);
  }
});

// User: my activity
router.get('/my-activity', authRequired, async (req, res, next) => {
  try {
    const activity = await analyticsService.getUserActivity(req.user.id);
    res.json({ success: true, activity });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
