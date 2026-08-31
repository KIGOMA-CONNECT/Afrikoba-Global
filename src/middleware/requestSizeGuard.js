/**
 * Request Size Guard Middleware
 * Validates request body size before parsing, allowing per-route limits.
 */

function requestSizeGuard(limitBytes) {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || 0, 10);
    if (contentLength > limitBytes) {
      return res.status(413).json({
        success: false,
        message: 'Maombi ni makubwa sana.',
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    next();
  };
}

module.exports = { requestSizeGuard };