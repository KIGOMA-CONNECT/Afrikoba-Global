/**
 * DEVICE TRUST GUARD
 * Attaches req.deviceFingerprint and enforces the user's device_policy:
 *   PERMISSIVE    -> record first-seen device alert, allow
 *   TRUSTED_ONLY  -> require a registered + trusted device fingerprint
 * Applies after authRequired on money-movement routes.
 */

const config = require('../config');
const deviceService = require('../services/deviceService');

async function enforceDeviceTrust(req, res, next) {
  try {
    if (!req.user) return next();
    const fingerprint = deviceService.generateFingerprint(req);
    req.deviceFingerprint = fingerprint;

    const policy = req.user.device_policy || config.device.defaultPolicy;
    const row = await deviceService.trustedDeviceStatus(req.user.id, fingerprint);

    if (policy === 'TRUSTED_ONLY' && (!row || !row.is_active || !row.is_trusted)) {
      return res.status(403).json({
        success: false,
        message: 'Kifaa hiki hakijakubaliwa. Dhibitisha kifaa chako kabla ya muamala.',
        code: 'DEVICE_NOT_TRUSTED',
        devicePolicy: policy,
      });
    }

    if (!row) {
      await deviceService.noteNewDevice(req.user.id, fingerprint, req).catch(() => {});
    } else {
      deviceService.touchDevice(req.user.id, fingerprint, req).catch(() => {});
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { enforceDeviceTrust };