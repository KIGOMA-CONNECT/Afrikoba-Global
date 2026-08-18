const { isSubscribed } = require('../services/serviceService');

/**
 * Service-gate middleware (choose-your-services model).
 * ADMIN bypasses gates; every other user must subscribe to the service first.
 */
function requireService(serviceKey) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Una hitaji kuingia.' });
    if (req.user.role === 'ADMIN') return next();
    const subscribed = await isSubscribed(req.user.id, serviceKey);
    if (!subscribed) {
      return res.status(403).json({
        success: false,
        code: 'SERVICE_NOT_SUBSCRIBED',
        serviceKey,
        message: `Hujajiunga na huduma ya ${serviceKey}. Jiunge kwanza kutoka Dashboard.`,
      });
    }
    next();
  };
}

module.exports = { requireService };
