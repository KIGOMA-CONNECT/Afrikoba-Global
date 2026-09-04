/**
 * Afrikoba Global — i18n (Swahili ↔ English)
 * - Default locale: sw (existing messages stay byte-identical → tests unaffected)
 * - Locale is chosen per-request from the Accept-Language header
 *   (middleware in src/i18n/middleware.js); frontend sends it explicitly.
 * - Messages may interpolate {{vars}}.
 */

const LOCALES = ['sw', 'en'];
const DEFAULT_LOCALE = 'sw';

const messages = {
  sw: {
    // ---- Global ----
    INTERNAL_ERROR: 'Hitilafu ya ndani ya server.',
    VALIDATION_ERROR: 'Tafta si sahihi.',
    RESOURCE_NOT_FOUND: 'Tafta si sahihi.',
    NOT_FOUND: 'Hakijapatikana.',
    TOO_MANY_REQUESTS: 'Maombi mengi sana. Jaribu tena baadaye.',
    FORBIDDEN: 'Inazuiliwa.',
    CONTENT_TYPE_REQUIRED: 'Content-Type header inahitajika.',
    CONTENT_TYPE_DENIED: 'Content-Type haijaidhinishwa.',
    ORIGIN_DENIED: 'Origin haijaidhinishwa.',
    ROUTE_NOT_FOUND: 'Route {{method}} {{path}} haipatikani.',

    // ---- Auth ----
    AUTH_MISSING_TOKEN: 'Token ya uingizaji inahitajika.',
    AUTH_INVALID_TOKEN: 'Token si sahihi.',
    AUTH_EXPIRED_TOKEN: 'Token imeisha.',
    AUTH_ACCOUNT_DISABLED: 'Akaunti imefungwa.',
    AUTH_SCOPE: 'Huna mamlaka ya kufanya hili.',
    AUTH_KYC_REQUIRED: 'Unahitaji KYC Level {{level}} ili kufanya muamala huu.',
    AUTH_PIN_REQUIRED: 'PIN inahitajika.',
    AUTH_OTP_SENT: 'OTP imetumwa.',
    AUTH_OTP_SENT_SMS: 'OTP imetumwa kwenye simu yako.',
    AUTH_OTP_COOLDOWN: 'Subiri sekunde {{waitSeconds}} kabla ya kutuma OTP tena.',
    AUTH_OTP_NOT_FOUND: 'OTP haujapatikana.',
    AUTH_OTP_EXPIRED: 'OTP umemalizika muda wake.',
    AUTH_OTP_MAX_ATTEMPTS: 'OTP umeshatumika mara nyingi. Tuma OTP mpya.',
    AUTH_INVALID_OTP: 'OTP si sahihi. Tuma OTP mpya.',
    AUTH_INVALID_OTP_ATTEMPTS: 'OTP si sahihi. Umebakiwa na majaribio {{remaining}}.',
    AUTH_STEPUP_REQUIRED: 'Uthibitisho wa hatua-mbili unahitajika kwa operesheni hii.',
    AUTH_STEPUP_INVALID: 'Uthibitisho wa hatua-mbili si sahihi.',
    AUTH_STEPUP_EXPIRED: 'Uthibitisho wa hatua-mbili umemalizika muda wake. Jaribu tena.',
    AUTH_ACCOUNT_NOT_FOUND: 'Akaunti haijapatikana.',
    AUTH_BAD_CREDENTIALS: 'Kitambulisho si sahihi.',
    AUTH_NO_ACCOUNT: 'Huna akaunti. Sajili kwanza.',
    AUTH_PHONE_EMAIL_EXISTS: 'Namba ya simu au email tayari imesajiliwa.',
    AUTH_PIN_SET: 'PIN imewekwa.',
    AUTH_PIN_4: 'PIN lazima iwe tarakimu 4.',
    AUTH_PROFILE_UPDATED: 'Profaili imesasishwa.',
    AUTH_PROFILE_NO_CHANGE: 'Hakuna kitu cha kubadilisha.',
    AUTH_LOGGED_OUT: 'Umeondoka.',
    AUTH_REFRESH_REQUIRED: 'Refresh token inahitajika.',
    AUTH_TOTP_REQUIRED: 'Ingiza kodi ya TOTP.',
    AUTH_TOTP_PARAMS: 'tempToken na totpCode zinahitajika.',
    AUTH_TOTP_TOKEN_EXPIRED: 'TempToken imeisha. Tafadhali ingia tena.',
    AUTH_TOTP_INVALID: 'Kodi ya TOTP si sahihi.',
    AUTH_TOTP_NOT_SETUP: 'TOTP haijaanzishwa kwa mtumiaji huyu.',
    AUTH_TOTP_BAD_LOGIN: 'Token si ya TOTP login.',
    AUTH_KYC_VERIFIED: 'KYC Level 2 imethibitishwa.',
    AUTH_NIDA_USED: 'NIDA tayari imetumika.',
    AUTH_BAD_CURRENT_PASSWORD: 'Nenosiri la sasa si sahihi.',
    AUTH_PASSWORD_CHANGED: 'Nenosiri limebadilishwa. Vikao vyote vya zamani vimefungwa.',
    AUTH_OTP_SMS: 'AFRIKOBA: Msimbo wako wa uthibitisho ni {{otp}}. Unamalizika ndani ya dakika {{minutes}}. Usimpe mtu yeyote!',

    // ---- Wallet ----
    WALLET_INSUFFICIENT_FUNDS: 'Salio halitoshi.',
    WALLET_SELF_TRANSFER: 'Haiwezi kujihamishia.',
    WALLET_INVALID_AMOUNT: 'Kiasi si sahihi.',
    WALLET_PROVIDER_UNAVAILABLE: 'Mtoa huduma haipatikani.',
    WALLET_MIN_AMOUNT: 'Kiasi kidogo ni TZS 1,000',
    WALLET_SAFETY_BLOCK: 'Muamala umekatwa kwa usalama. Wasiliana na msaidizi.',
    WALLET_WITHDRAW_BLOCK: 'Utoaji umekatwa kwa usalama. Wasiliana na msaidizi.',

    // ---- Currency / FX ----
    CURRENCY_REQUIRED: 'currency inahitajika.',
    CURRENCY_RATE_REQUIRED: 'from, to, rate zinahitajika.',
    CURRENCY_PARAMS_REQUIRED: 'amount, from, zinahitajika.',
    CURRENCY_NOT_SUPPORTED: 'Sarafu {{code}} haijaungwa.',
    CURRENCY_NOT_ACTIVE: 'Sarafu {{code}} haijawashwa.',
    CURRENCY_USER_NOT_FOUND: 'Mtumiaji hajapatikana.',
    FX_RATE_NOT_FOUND: 'Kiwango cha ubadilishaji {{from}} → {{to}} hakipatikani.',
    CURRENCY_TOPUP_DONE: 'Umepata {{amount}} {{currency}}.',
    CURRENCY_CONVERTED: 'Imebadilishwa kuwa {{amount}} {{to}}.',
    CURRENCY_SENT: 'Umetuma {{amount}} {{currency}}.',
    CURRENCY_BALANCE_MISSING: 'Salio la {{currency}} halitoshi.',
    CURRENCY_TZS_COST_MISSING: 'Salio la TZS halitoshi (unahitaji {{cost}}).',

    // ---- Family ----
    FAMILY_NAME_REQUIRED: 'Jina la familia ni lazima.',
    FAMILY_BALANCE_INSUFFICIENT: 'Salio lako halitoshi.',
    FAMILY_CONTRIBUTED: 'Umependekeza kwenye Familia Wallet.',

    // ---- VICOBA ----
    VICOBA_ALREADY_MEMBER: 'Uko tayari kwenye kikundi hiki.',
    VICOBA_INVALID_JOIN_CODE: 'Msimbo wa kikundi si sahihi.',
    VICOBA_SHARE_OVER_LIMIT: 'Hisa zimezidi kikomo.',
    VICOBA_CHAIR_ONLY: 'Mwenyekiti pekee anaweza kubadilisha mipangilio.',
    VICOBA_SETTINGS_UPDATED: 'Mipangilio imesasishwa.',
    VICOBA_CANNOT_REMOVE_SELF: 'Huwezi kuondoa mwenyewe.',
    VICOBA_MEMBER_REMOVED: 'Mwanachama ameondolewa.',

    // ---- Banking ----
    BANKING_AMOUNT_REQUIRED: 'Kiasi kinahitajika.',
    BANKING_NAME_PHONE_REQUIRED: 'Simu na jina vinahitajika.',
    BANKING_RECIPIENT_DELETED: 'Mpokeaji amefutwa.',
  },

  en: {
    // ---- Global ----
    INTERNAL_ERROR: 'Internal server error.',
    VALIDATION_ERROR: 'Invalid input.',
    RESOURCE_NOT_FOUND: 'Not found.',
    NOT_FOUND: 'Not found.',
    TOO_MANY_REQUESTS: 'Too many requests. Try again later.',
    FORBIDDEN: 'Access denied.',
    CONTENT_TYPE_REQUIRED: 'Content-Type header is required.',
    CONTENT_TYPE_DENIED: 'Content-Type is not allowed.',
    ORIGIN_DENIED: 'Origin is not allowed.',
    ROUTE_NOT_FOUND: 'Route {{method}} {{path}} not found.',

    // ---- Auth ----
    AUTH_MISSING_TOKEN: 'Authorization token is required.',
    AUTH_INVALID_TOKEN: 'Invalid token.',
    AUTH_EXPIRED_TOKEN: 'Token has expired.',
    AUTH_ACCOUNT_DISABLED: 'Account is disabled.',
    AUTH_SCOPE: 'You are not authorized to do this.',
    AUTH_KYC_REQUIRED: 'KYC Level {{level}} is required for this transaction.',
    AUTH_PIN_REQUIRED: 'PIN is required.',
    AUTH_OTP_SENT: 'OTP sent.',
    AUTH_OTP_SENT_SMS: 'OTP has been sent to your phone.',
    AUTH_OTP_COOLDOWN: 'Please wait {{waitSeconds}} seconds before requesting another OTP.',
    AUTH_OTP_NOT_FOUND: 'OTP not found.',
    AUTH_OTP_EXPIRED: 'OTP has expired.',
    AUTH_OTP_MAX_ATTEMPTS: 'OTP has been used too many times. Please request a new one.',
    AUTH_INVALID_OTP: 'Incorrect OTP. Please request a new one.',
    AUTH_INVALID_OTP_ATTEMPTS: 'Incorrect OTP. {{remaining}} attempts remaining.',
    AUTH_STEPUP_REQUIRED: 'Step-up verification is required for this operation.',
    AUTH_STEPUP_INVALID: 'Invalid step-up verification.',
    AUTH_STEPUP_EXPIRED: 'Step-up verification expired. Please try again.',
    AUTH_ACCOUNT_NOT_FOUND: 'Account not found.',
    AUTH_BAD_CREDENTIALS: 'Invalid credentials.',
    AUTH_NO_ACCOUNT: 'You have no account. Please register first.',
    AUTH_PHONE_EMAIL_EXISTS: 'Phone number or email is already registered.',
    AUTH_PIN_SET: 'PIN set successfully.',
    AUTH_PIN_4: 'PIN must be 4 digits.',
    AUTH_PROFILE_UPDATED: 'Profile updated.',
    AUTH_PROFILE_NO_CHANGE: 'Nothing to update.',
    AUTH_LOGGED_OUT: 'You have been logged out.',
    AUTH_REFRESH_REQUIRED: 'Refresh token is required.',
    AUTH_TOTP_REQUIRED: 'Enter your TOTP code.',
    AUTH_TOTP_PARAMS: 'tempToken and totpCode are required.',
    AUTH_TOTP_TOKEN_EXPIRED: 'Temporary token expired. Please sign in again.',
    AUTH_TOTP_INVALID: 'Invalid TOTP code.',
    AUTH_TOTP_NOT_SETUP: 'TOTP is not set up for this user.',
    AUTH_TOTP_BAD_LOGIN: 'Token is not a TOTP login token.',
    AUTH_KYC_VERIFIED: 'KYC Level 2 verified.',
    AUTH_NIDA_USED: 'NIDA number is already in use.',
    AUTH_BAD_CURRENT_PASSWORD: 'Current password is incorrect.',
    AUTH_PASSWORD_CHANGED: 'Password changed. All previous sessions have been closed.',
    AUTH_OTP_SMS: 'AFRIKOBA: Your verification code is {{otp}}. It expires in {{minutes}} minutes. Do not share it with anyone!',

    // ---- Wallet ----
    WALLET_INSUFFICIENT_FUNDS: 'Insufficient balance.',
    WALLET_SELF_TRANSFER: 'You cannot transfer to yourself.',
    WALLET_INVALID_AMOUNT: 'Invalid amount.',
    WALLET_PROVIDER_UNAVAILABLE: 'Service provider unavailable.',
    WALLET_MIN_AMOUNT: 'Minimum amount is TZS 1,000',
    WALLET_SAFETY_BLOCK: 'Transaction blocked for your safety. Please contact support.',
    WALLET_WITHDRAW_BLOCK: 'Withdrawal blocked for your safety. Please contact support.',

    // ---- Currency / FX ----
    CURRENCY_REQUIRED: 'currency is required.',
    CURRENCY_RATE_REQUIRED: 'from, to, rate are required.',
    CURRENCY_PARAMS_REQUIRED: 'amount and from are required.',
    CURRENCY_NOT_SUPPORTED: 'Currency {{code}} is not supported.',
    CURRENCY_NOT_ACTIVE: 'Currency {{code}} is not active.',
    CURRENCY_USER_NOT_FOUND: 'User not found.',
    FX_RATE_NOT_FOUND: 'Exchange rate {{from}} → {{to}} is not available.',
    CURRENCY_TOPUP_DONE: 'You received {{amount}} {{currency}}.',
    CURRENCY_CONVERTED: 'Converted to {{amount}} {{to}}.',
    CURRENCY_SENT: 'You sent {{amount}} {{currency}}.',
    CURRENCY_BALANCE_MISSING: 'Insufficient {{currency}} balance.',
    CURRENCY_TZS_COST_MISSING: 'Insufficient TZS balance (you need {{cost}}).',

    // ---- Family ----
    FAMILY_NAME_REQUIRED: 'Family name is required.',
    FAMILY_BALANCE_INSUFFICIENT: 'Your balance is insufficient.',
    FAMILY_CONTRIBUTED: 'You contributed to the Family Wallet.',

    // ---- VICOBA ----
    VICOBA_ALREADY_MEMBER: 'You are already in this group.',
    VICOBA_INVALID_JOIN_CODE: 'Invalid group code.',
    VICOBA_SHARE_OVER_LIMIT: 'Shares exceed the limit.',
    VICOBA_CHAIR_ONLY: 'Only the chairperson can change settings.',
    VICOBA_SETTINGS_UPDATED: 'Settings updated.',
    VICOBA_CANNOT_REMOVE_SELF: 'You cannot remove yourself.',
    VICOBA_MEMBER_REMOVED: 'Member removed.',

    // ---- Banking ----
    BANKING_AMOUNT_REQUIRED: 'Amount is required.',
    BANKING_NAME_PHONE_REQUIRED: 'Phone and name are required.',
    BANKING_RECIPIENT_DELETED: 'Recipient deleted.',
  },
};

function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(messages.sw, key);
}

function interpolate(template, vars = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
  );
}

function tr(key, locale = DEFAULT_LOCALE, vars = {}) {
  const dict = messages[locale] && hasKey(key) ? messages[locale] : messages[DEFAULT_LOCALE];
  const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  return interpolate(template, vars);
}

function resolveLocale(header) {
  if (!header) return DEFAULT_LOCALE;
  const first = String(header).split(',')[0].trim().toLowerCase();
  if (first.startsWith('en')) return 'en';
  if (first.startsWith('sw')) return 'sw';
  return DEFAULT_LOCALE;
}

/** Localize an error thrown by a service/route handler. */
function localizeError(err, locale) {
  const isServerError = (err.statusCode || err.status || 500) >= 500;
  if (isServerError) return tr('INTERNAL_ERROR', locale);
  if (err.code && hasKey(err.code)) return tr(err.code, locale, err._i18nVars);
  return err.message;
}

module.exports = { LOCALES, DEFAULT_LOCALE, messages, hasKey, tr, resolveLocale, localizeError };