/**
 * OPS/Admin endpoints za kuangalia na kushughulikia issue cache + replica routing.
 * Mounted at /api/cache (visible through ADMIN flags / OPERATOR per app).
 */
const express = require('express');
const { authRequired, requireRoles } = require('../middleware/auth');
const cache = require('../utils/cache');
const { replicaInfo } = require('../config/replica');

const router = express.Router();

router.use(authRequired);

// OPERATOR au ADMIN - takwimu za cache na read-replica routing
router.get('/stats', requireRoles('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    res.json({ success: true, cache: cache.getStats(), replica: replicaInfo() });
  } catch (e) { next(e); }
});

// Futa cache nzima (mf. baada ya rollout)
router.post('/flush', requireRoles('ADMIN'), async (req, res, next) => {
  try {
    await cache.flush();
    const s = cache.getStats();
    res.json({ success: true, message: 'Cache imefutwa.', cache: s });
  } catch (e) { next(e); }
});

module.exports = router;