const express = require('express');
const { authRequired } = require('../middleware/auth');
const deviceService = require('../services/deviceService');
const { logAction } = require('../services/auditService');
const { createAppError } = require('../utils/errorCodes');

const router = express.Router();

router.use(authRequired);

// List my registered/trusted devices.
router.get('/', async (req, res, next) => {
  try {
    const devices = await deviceService.getTrustedDevices(req.user.id);
    return res.json({ success: true, devices });
  } catch (error) {
    next(error);
  }
});

// Register/trust the current request's device fingerprint.
router.post('/', async (req, res, next) => {
  try {
    const { deviceName } = req.body || {};
    const device = await deviceService.registerDevice(req.user.id, req, deviceName);
    logAction(req.user.id, 'DEVICE_REGISTERED', 'trusted_device', device.id, { fingerprint: device.device_fingerprint }, req);
    return res.status(201).json({ success: true, device });
  } catch (error) {
    next(error);
  }
});

// Self-manage device binding policy (PERMISSIVE | TRUSTED_ONLY).
router.put('/policy', async (req, res, next) => {
  try {
    const { policy } = req.body || {};
    if (!['PERMISSIVE', 'TRUSTED_ONLY'].includes(policy)) {
      throw createAppError('DEVICE_POLICY_INVALID');
    }
    const active = await deviceService.setDevicePolicy(req.user.id, policy);
    logAction(req.user.id, 'DEVICE_POLICY_SET', 'users', req.user.id, { policy }, req);
    return res.json({ success: true, devicePolicy: active });
  } catch (error) {
    next(error);
  }
});

// Revoke or restore an owned device.
router.put('/:id/trust', async (req, res, next) => {
  try {
    const { trusted, active } = req.body || {};
    const r = await poolUpdateDevice(req.user.id, Number(req.params.id), { trusted, active });
    if (!r) throw createAppError('DEVICE_NOT_FOUND');
    logAction(req.user.id, 'DEVICE_TRUST_UPDATED', 'trusted_device', r.id, { is_trusted: r.is_trusted, is_active: r.is_active }, req);
    return res.json({ success: true, device: r });
  } catch (error) {
    next(error);
  }
});

// Forget an owned device.
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await deviceService.removeDevice(req.user.id, Number(req.params.id));
    if (!removed) throw createAppError('DEVICE_NOT_FOUND');
    logAction(req.user.id, 'DEVICE_REMOVED', 'trusted_device', Number(req.params.id), {}, req);
    return res.json({ success: true, removed: true });
  } catch (error) {
    next(error);
  }
});

async function poolUpdateDevice(userId, deviceId, { trusted, active }) {
  const sets = [];
  const params = [];
  if (trusted !== undefined) {
    params.push(!!trusted);
    sets.push(`is_trusted = $${params.length}`);
  }
  if (active !== undefined) {
    params.push(!!active);
    sets.push(`is_active = $${params.length}`);
  }
  if (sets.length === 0) return null;
  params.push(userId, deviceId);
  const r = await require('../config/db').query(
    `UPDATE trusted_devices SET ${sets.join(', ')} WHERE user_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
    params
  );
  return r.rows[0] || null;
}

module.exports = router;