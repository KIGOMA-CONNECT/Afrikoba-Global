const express = require('express');
const { authRequired } = require('../middleware/auth');
const notificationService = require('../services/notificationService');

const router = express.Router();

// Get notifications
router.get('/', authRequired, async (req, res, next) => {
  try {
    const { page, limit, unreadOnly } = req.query;
    const result = await notificationService.getNotifications(req.user.id, {
      page: parseInt(page) || 1,
      limit: Math.min(parseInt(limit) || 20, 100),
      unreadOnly: unreadOnly === 'true',
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// Get unread count
router.get('/unread-count', authRequired, async (req, res, next) => {
  try {
    const count = await notificationService.getUnreadCount(req.user.id);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
});

// Mark notification as read
router.put('/:id/read', authRequired, async (req, res, next) => {
  try {
    const success = await notificationService.markAsRead(req.user.id, parseInt(req.params.id));
    res.json({ success });
  } catch (error) {
    next(error);
  }
});

// Mark all as read
router.put('/read-all', authRequired, async (req, res, next) => {
  try {
    const count = await notificationService.markAllAsRead(req.user.id);
    res.json({ success: true, count });
  } catch (error) {
    next(error);
  }
});

// Get notification preferences
router.get('/preferences', authRequired, async (req, res, next) => {
  try {
    const prefs = await notificationService.getPreferences(req.user.id);
    res.json({ success: true, preferences: prefs });
  } catch (error) {
    next(error);
  }
});

// Update notification preferences
router.put('/preferences', authRequired, async (req, res, next) => {
  try {
    const prefs = await notificationService.updatePreferences(req.user.id, req.body);
    res.json({ success: true, preferences: prefs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
