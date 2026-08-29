const logger = require('../utils/logger');
const { tr, localizeError } = require('../i18n');

function notFound(req, res) {
  const locale = req.locale || 'sw';
  res.status(404).json({
    success: false,
    code: 'RESOURCE_NOT_FOUND',
    message: tr('ROUTE_NOT_FOUND', locale, { method: req.method, path: req.path }),
  });
}

function errorHandler(err, req, res, next) {
  logger.error('SERVER', err.message, { stack: err.stack, code: err.code });
  const status = err.statusCode || 500;
  const body = {
    success: false,
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'),
    message: localizeError(err, req.locale || 'sw'),
  };
  if (err.details) body.details = err.details;
  res.status(status).json(body);
}

module.exports = { notFound, errorHandler };
