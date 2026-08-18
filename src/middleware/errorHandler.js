const logger = require('../utils/logger');

function notFound(req, res) {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} haipatikani.` });
}

function errorHandler(err, req, res, next) {
  logger.error('SERVER', err.message, { stack: err.stack });
  const status = err.statusCode || 500;
  res.status(status).json({
    success: false,
    message: status >= 500 ? 'Hitilafu ya ndani ya server.' : err.message,
  });
}

module.exports = { notFound, errorHandler };
