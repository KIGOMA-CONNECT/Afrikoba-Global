/**
 * Developer Portal Routes
 * API key management, sandbox test, webhook simulator.
 * Mounted at /api/developer
 */

const express = require('express');
const { authRequired } = require('../middleware/auth');
const developerService = require('../services/developerService');

const router = express.Router();

router.use(authRequired);

// List my API keys
router.get('/api-keys', async (req, res, next) => {
  try { res.json({ success: true, keys: await developerService.listApiKeys(req.user.id) }); }
  catch (e) { next(e); }
});

// Create an API key (returns the raw key once)
router.post('/api-keys', async (req, res, next) => {
  try { res.json({ success: true, key: await developerService.createApiKey(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

// Deactivate an API key
router.delete('/api-keys/:id', async (req, res, next) => {
  try { res.json({ success: true, deleted: await developerService.revokeApiKey(req.user.id, parseInt(req.params.id, 10)) }); }
  catch (e) { next(e); }
});

// Permanently delete an API key
router.delete('/api-keys/:id/permanent', async (req, res, next) => {
  try { res.json({ success: true, deleted: await developerService.deleteApiKey(req.user.id, parseInt(req.params.id, 10)) }); }
  catch (e) { next(e); }
});

// Simulate a webhook delivery
router.post('/webhook/simulate', async (req, res, next) => {
  try { res.json({ success: true, delivery: await developerService.simulateWebhook(req.user.id, req.body) }); }
  catch (e) { next(e); }
});

// Webhook delivery log
router.get('/webhook/deliveries', async (req, res, next) => {
  try { res.json({ success: true, deliveries: await developerService.getWebhookDeliveries(req.user.id) }); }
  catch (e) { next(e); }
});

// Sandbox: test endpoint (echoes back the user's authenticated info)
router.get('/sandbox/ping', async (req, res, next) => {
  try {
    res.json({ success: true, message: 'Pong! API is working.', user_id: req.user.id, timestamp: new Date().toISOString() });
  } catch (e) { next(e); }
});

module.exports = router;
