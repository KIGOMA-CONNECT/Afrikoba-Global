const logger = require('../utils/logger');

function notFound(req, res) {
  res.status(404).json({ success: false, code: 'RESOURCE_NOT_FOUND', message: `Route ${req.method} ${req.path} haipatikani.` });
}

function errorHandler(err, req, res, next) {
  logger.error('SERVER', err.message, { stack: err.stack, code: err.code });
  const status = err.statusCode || 500;
  const body = {
    success: false,
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'),
    message: status >= 500 ? 'Hitilafu ya ndani ya server.' : err.message,
  };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
