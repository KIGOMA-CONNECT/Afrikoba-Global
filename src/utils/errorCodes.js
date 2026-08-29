/**
 * Machine-readable error codes for Afrikoba Global API.
 * Format: MODULE_ERROR_CODE (e.g. AUTH_INVALID_OTP, WALLET_INSUFFICIENT_FUNDS)
 *
 * Clients should switch on these codes, NOT on HTTP status or message text.
 */

const ERROR_CODES = {
  // Auth (401)
  AUTH_MISSING_TOKEN:            { status: 401, message: 'Token ya uingizaji inahitajika.' },
  AUTH_INVALID_TOKEN:            { status: 401, message: 'Token si sahihi.' },
  AUTH_EXPIRED_TOKEN:            { status: 401, message: 'Token imeisha.' },

  // Auth (403)
  AUTH_INVALID_OTP:              { status: 403, message: 'OTP si sahihi.' },
  AUTH_OTP_NOT_FOUND:            { status: 403, message: 'OTP haujapatikana.' },
  AUTH_OTP_EXPIRED:              { status: 403, message: 'OTP imeisha.' },
  AUTH_OTP_MAX_ATTEMPTS:         { status: 403, message: 'Majaribio ya OTP yameisha.' },
  AUTH_OTP_COOLDOWN:             { status: 429, message: 'Subiri kabla ya kuomba OTP nyingine.' },
  AUTH_ACCOUNT_NOT_FOUND:        { status: 404, message: 'Akaunti haijapatikana.' },
  AUTH_BAD_CREDENTIALS:          { status: 401, message: 'Kitambulisho si sahihi.' },
  AUTH_INSUFFICIENT_SCOPE:       { status: 403, message: 'Huna ruhusa ya kufanya hii.' },
  AUTH_KYC_REQUIRED:             { status: 403, message: 'Hifadhi inahitaji kiwango cha KYC.' },
  AUTH_SUBSCRIPTION_REQUIRED:    { status: 403, message: 'Huduma hii inahitaji usajili.' },
  AUTH_PIN_REQUIRED:             { status: 403, message: 'PIN inahitajika.' },

  // Validation (400)
  VALIDATION_ERROR:              { status: 400, message: 'Data si sahihi.' },

  // Resource (404)
  RESOURCE_NOT_FOUND:            { status: 404, message: 'Tafta si sahihi.' },

  // Wallet (400)
  WALLET_INSUFFICIENT_FUNDS:     { status: 400, message: 'Salio halitoshi.' },
  WALLET_SELF_TRANSFER:          { status: 400, message: 'Haiwezi kujihamishia.' },
  WALLET_INVALID_AMOUNT:         { status: 400, message: 'Kiasi si sahihi.' },
  WALLET_PROVIDER_UNAVAILABLE:   { status: 503, message: 'Mtoa huduma haipatikani.' },

  // VICOBA (400)
  VICOBA_ALREADY_MEMBER:         { status: 400, message: 'Uko tayari kwenye kikundi hiki.' },
  VICOBA_INVALID_JOIN_CODE:      { status: 400, message: 'Msimbo wa kikundi si sahihi.' },
  VICOBA_SHARE_OVER_LIMIT:       { status: 400, message: 'Hisa zimezidi kikomo.' },

  // P2P (400)
  P2P_PROJECT_EXCEEDS_TARGET:    { status: 400, message: 'Uwekezaji unazidi shabaha.' },
  P2P_PROJECT_NOT_ACTIVE:        { status: 400, message: 'Mradi si hai.' },

  // Currency (400/404)
  CURRENCY_NOT_SUPPORTED:        { status: 400, message: 'Sarafu haijaungwa.' },
  CURRENCY_NOT_ACTIVE:           { status: 400, message: 'Sarafu haijawashwa.' },
  CURRENCY_USER_NOT_FOUND:       { status: 404, message: 'Mtumiaji hajapatikana.' },
  CURRENCY_BALANCE_MISSING:      { status: 400, message: 'Salio halitoshi.' },
  CURRENCY_TZS_COST_MISSING:     { status: 400, message: 'Salio la TZS halitoshi.' },
  FX_RATE_NOT_FOUND:             { status: 404, message: 'Kiwango cha ubadilishaji hakipatikani.' },

  // Generic
  INTERNAL_ERROR:                { status: 500, message: 'Hitilafu ya ndani ya server.' },
};

/**
 * Create an error with a machine-readable code.
 * @param {string} code - Key from ERROR_CODES (e.g. 'WALLET_INSUFFICIENT_FUNDS')
 * @param {Object} [details] - Optional additional data sent to client
 */
function createAppError(code, details) {
  const entry = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR;
  const err = new Error(entry.message);
  err.statusCode = entry.status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

module.exports = { ERROR_CODES, createAppError };
