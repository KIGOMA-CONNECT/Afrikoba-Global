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

  // QR code payments (400/404)
  QR_CODE_NOT_FOUND:             { status: 404, message: 'Msimbo wa QR haipatikani.' },
  QR_CODE_EXPIRED:               { status: 400, message: 'Msimbo wa QR umeisha muda.' },
  QR_SELF_PAY_INVALID:           { status: 400, message: 'Huwezi kulipa QR code yako mwenyewe.' },
  QR_AMOUNT_REQUIRED:            { status: 400, message: 'Kiasi kinahitajika.' },

  // Field Partners (Kiva-style)
  FIELD_PARTNER_NOT_FOUND:       { status: 404, message: 'Shirika la mshirika halijapatikana.' },
  FIELD_PARTNER_INACTIVE:        { status: 403, message: 'Shirika la mshirika halijawashwa.' },
  FIELD_PARTNER_UNAUTHORIZED:    { status: 403, message: 'Huna ruhusa ya kufanya hili kwa mshirika huyu.' },
  FIELD_PARTNER_POOL_INSUFFICIENT: { status: 400, message: 'Hazina ya ukopeshaji haitoshi.' },
  FP_LOAN_NOT_FOUND:             { status: 404, message: 'Mkopo haujapatikana.' },
  FP_LOAN_STATUS_INVALID:        { status: 400, message: 'Hali ya mkopo hairuhusu hatua hii.' },
  FP_REPAYMENT_EXCEEDS_DUE:      { status: 400, message: 'Malipo yanazidi deni lililobaki.' },
  FP_BORROWER_NOT_FOUND:         { status: 404, message: 'Mkopoaji hajapatikana.' },

  // Support tickets (400/403/404)
  SUPPORT_TICKET_NOT_FOUND:      { status: 404, message: 'Tikiti haipatikani.' },
  SUPPORT_CATEGORY_INVALID:      { status: 400, message: 'Kategoria batili.' },
  SUPPORT_STATUS_INVALID:        { status: 400, message: 'Hali batili.' },
  SUPPORT_SUBJECT_REQUIRED:      { status: 400, message: 'Kichwa cha ujumbe kinahitajika.' },
  SUPPORT_DESCRIPTION_REQUIRED:  { status: 400, message: 'Maelezo yanahitajika.' },

  // Device security (403/404/429)
  DEVICE_NOT_TRUSTED:            { status: 403, message: 'Kifaa hiki hakijakubaliwa. Dhibitisha kifaa chako.' },
  DEVICE_POLICY_INVALID:         { status: 400, message: 'Sera ya kifaa si sahihi.' },
  DEVICE_NOT_FOUND:              { status: 404, message: 'Kifaa hakijapatikana.' },
  DEVICE_RATE_LIMIT_EXCEEDED:    { status: 429, message: 'Ombi nyingi sana kutoka kifaa hiki.' },

  // Insurance (400/404)
  INSURANCE_PRODUCT_NOT_FOUND:   { status: 404, message: 'Bidhaa haipatikani.' },
  INSURANCE_AGE_INVALID:         { status: 400, message: 'Umri haujazingatiwa kwa bidhaa hii.' },
  INSURANCE_POLICY_NOT_FOUND:    { status: 404, message: 'Sera haipatikani.' },

  // Cards (400/403/404)
  CARD_NOT_FOUND:                { status: 404, message: 'Kadi haipatikani.' },
  CARD_NOT_OWNER:                { status: 403, message: 'Hii kadi sio yako.' },
  CARD_INACTIVE:                 { status: 403, message: 'Kadi haifanyi kazi (imefungwa au imeblock).' },
  CARD_BLOCKED:                  { status: 403, message: 'Kadi imeblock.' },
  CARD_MERCHANT_REQUIRED:        { status: 400, message: 'Jina la muuzaji ni lazima.' },
  CARD_AMOUNT_INVALID:           { status: 400, message: 'Kiasi si sahihi.' },
  CARD_INVALID_CVV:              { status: 400, message: 'CVV si sahihi.' },
  CARD_OVER_PER_TXN_LIMIT:       { status: 400, message: 'Kiasi kinazidi kikomo cha miamala (per-txn limit).' },
  CARD_OVER_DAILY_LIMIT:         { status: 400, message: 'Kiasi kinazidi kikomo cha siku (daily limit).' },
  CARD_AUTH_NOT_FOUND:           { status: 404, message: 'Authorization haipatikani au imeshawekwa.' },

  // SACCOS foundation (400/403/404/409)
  SACCOS_NAME_REQUIRED:          { status: 400, message: 'Jina la SACCOS linahitajika.' },
  SACCOS_NAME_TAKEN:             { status: 409, message: 'Jina la SACCOS tayari limesajiliwa.' },
  SACCOS_NOT_FOUND:              { status: 404, message: 'SACCOS haijapatikana.' },
  SACCOS_NOT_MEMBER:             { status: 403, message: 'Huna uanachama wa SACCOS hii.' },
  SACCOS_RBAC:                   { status: 403, message: 'Jukumu lako haliruhusu hatua hii ndani ya SACCOS.' },
  SACCOS_ALREADY_MEMBER:         { status: 409, message: 'Mtumiaji huyu tayari ni mwanachama.' },
  SACCOS_PHONE_NOT_FOUND:        { status: 404, message: 'Namba ya simu haijapatikana kwenye Afrikoba.' },
  SACCOS_MEMBER_NOT_FOUND:       { status: 404, message: 'Mwanachama hajapatikana.' },
  SACCOS_MEMBER_FORBIDDEN:       { status: 403, message: 'Huwezi kufanya hatua hii kwa mwanachama huyu.' },
  SACCOS_MEMBER_STATUS_INVALID:  { status: 400, message: 'Hali ya uanachama hairuhusu hatua hii.' },

  // SACCOS shares (400/403/404)
  SACCOS_SHARES_INVALID:         { status: 400, message: 'Idadi ya hisa haikubaliki.' },
  SACCOS_SHARES_BELOW_MIN:       { status: 400, message: 'Idadi ya hisa iko chini ya kiwango cha chini.' },
  SACCOS_SHARES_ABOVE_MAX:       { status: 400, message: 'Idadi ya hisa imezidi kiwango cha juu.' },
  SACCOS_SHARES_NOT_ACTIVE:      { status: 400, message: 'SACCOS haijaanzishwa (haina hali ya ACTIVE).' },
  SACCOS_SHARE_PURCHASE_NOT_FOUND: { status: 404, message: 'Ununuzi wa hisa haujapatikana.' },
  SACCOS_SHARE_DECIDED:          { status: 400, message: 'Ununuzi huu wa hisa tayari umeamuliwa.' },

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
