/**
 * i18n request middleware.
 * Sets req.locale from Accept-Language and attaches res.t(key, vars) so
 * route handlers can emit localized messages.
 */
const { tr, resolveLocale } = require('./index');

function i18n(req, res, next) {
  const locale = resolveLocale(req.get('Accept-Language'));
  req.locale = locale;
  res.locals.locale = locale;
  res.t = (key, vars) => tr(key, locale, vars);
  next();
}

module.exports = { i18n };