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

  // AML / wallet freezes (400/403)
  AML_ACCOUNT_FROZEN:           { status: 403, message: 'Akaunti imefungwa kwa sababu za kufuata sheria. Wasiliana na huduma kwa wateja.' },
  AML_FREEZE_ALREADY_ACTIVE:    { status: 400, message: 'Akaunti hii tayari imefungwa.' },
  AML_FREEZE_NOT_ACTIVE:        { status: 400, message: 'Kufunga huku si tena ACTIVE.' },
  AML_FREEZE_NOT_FOUND:         { status: 404, message: 'Kufunga haikupatikana.' },

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

  // SACCOS savings (400/403/404)
  SACCOS_SAVINGS_AMOUNT_INVALID:  { status: 400, message: 'Kiasi cha akiba hakikubaliki.' },
  SACCOS_SAVINGS_BELOW_MIN_DEPOSIT: { status: 400, message: 'Kiasi kiko chini ya kiwango cha chini cha amana.' },
  SACCOS_SAVINGS_ABOVE_MAX_DEPOSIT: { status: 400, message: 'Kiasi kimezidi kiwango cha juu cha amana.' },
  SACCOS_SAVINGS_INSUFFICIENT:    { status: 400, message: 'Akiba haitoshi kwa uondoaji huu.' },
  SACCOS_SAVINGS_WITHDRAWAL_NOT_FOUND: { status: 404, message: 'Ombi la uondoaji halijapatikana.' },
  SACCOS_SAVINGS_DECIDED:         { status: 400, message: 'Ombi hili la uondoaji tayari limeamuliwa.' },

  // SACCOS credit (400/403/404)
  SACCOS_LOAN_AMOUNT_INVALID:      { status: 400, message: 'Kiasi cha mkopo hakikubaliki.' },
  SACCOS_LOAN_BELOW_MIN:           { status: 400, message: 'Kiasi cha mkopo iko chini ya kiwango cha chini.' },
  SACCOS_LOAN_ABOVE_MAX:           { status: 400, message: 'Kiasi cha mkopo kimezidi kiwango cha juu.' },
  SACCOS_LOAN_TERM_TOO_LONG:       { status: 400, message: 'Muda wa mkopo haukubaliki kwa SACCOS hii.' },
  SACCOS_LOANS_AT_LIMIT:           { status: 400, message: 'Umefikia kiwango cha juu cha mikopo hai.' },
  SACCOS_LOAN_EXPOSURE_EXCEEDED:    { status: 400, message: 'Mkopo unazidi kikomo cha mkopo wa mwanachama (exposure).' },
  SACCOS_LOAN_CONCENTRATION_EXCEEDED: { status: 400, message: 'Mkopo huu ungezidi kikomo cha umiliki wa hatari kwenye portfolio (concentration).' },
  SACCOS_RISK_LIMITS_INVALID:       { status: 400, message: 'Vigezo vya kikomo vya mkopo ni vibaya.' },
  SACCOS_LOAN_APPLICATION_NOT_FOUND: { status: 404, message: 'Ombi la mkopo halijapatikana.' },
  SACCOS_LOAN_APPLICATION_DECIDED: { status: 400, message: 'Ombi hili la mkopo tayari limeamuliwa.' },
  SACCOS_LOAN_NOT_FOUND:           { status: 404, message: 'Mkopo haujapatikana.' },
  SACCOS_LOAN_NOT_DISBURSABLE:     { status: 400, message: 'Mkopo huu hauwezi kutolewa (haliko PENDING).' },
  SACCOS_LOAN_ALREADY_CLOSED:      { status: 400, message: 'Mkopo huu tayari umekamilika.' },
  SACCOS_LOAN_REPAY_EXCEEDS:       { status: 400, message: 'Kiasi cha rejesho kinazidi deni lililobaki.' },

  // SACCOS loan installments (400/404)
  SACCOS_LOAN_INSTALLMENT_NOT_FOUND: { status: 404, message: 'Awamu ya malipo haijapatikana.' },
  SACCOS_LOAN_INSTALLMENT_ORDER:     { status: 400, message: 'Lipa awamu za awali kabla ya hii.' },
  SACCOS_LOAN_INSTALLMENT_ALREADY_PAID: { status: 400, message: 'Awamu hii tayari imelipwa.' },
  SACCOS_LOAN_INSTALLMENTS_EXIST:    { status: 400, message: 'Ratiba ya awamu tayari imekwisha jalizwa.' },

  // SACCOS governance (400/403/404)
  SACCOS_GOV_RESOLUTION_NOT_FOUND: { status: 404, message: 'Azimio halijapatikana.' },
  SACCOS_GOV_RESOLUTION_STATE:     { status: 400, message: 'Hali ya azimio hairuhusu hatua hii.' },
  SACCOS_GOV_VOTE_INVALID:         { status: 400, message: 'Chaguo la kura halikubaliki.' },
  SACCOS_GOV_VOTE_ALREADY:         { status: 400, message: 'Umekwisha piga kura kwenye azimio hili.' },

  // SACCOS meetings (400/403/404)
  SACCOS_MEETING_NOT_FOUND:           { status: 404, message: 'Mkutano haujapatikana.' },
  SACCOS_MEETING_TITLE:               { status: 400, message: 'Jina la mkutano linahitajika.' },
  SACCOS_MEETING_DATES:               { status: 400, message: 'Tarehe ya mkutano si sahihi.' },
  SACCOS_MEETING_QUORUM:              { status: 400, message: 'Asilimia ya uhalali (quorum) si sahihi (1-100).' },
  SACCOS_MEETING_STATE:               { status: 400, message: 'Hali ya mkutano hairuhusu hatua hii.' },
  SACCOS_MEETING_MINUTES_REQUIRED:    { status: 400, message: 'Maandishi ya maelezo ya mkutano (minutes) yanahitajika.' },
  SACCOS_MEETING_ATTENDANCE_STATE:    { status: 400, message: 'Hali ya hudhurio haikubaliki (PRESENT/ABSENT/EXCUSED).' },

  // SACCOS savings interest (400/404)
  SACCOS_SAVINGS_INTEREST_RATE:             { status: 400, message: 'Kiwango cha riba ya akiba hakijawekwa (savings.interestRatePercent).' },
  SACCOS_SAVINGS_INTEREST_CYCLE_EXISTS:     { status: 400, message: 'Mzunguko wa riba wa mwezi huu tayari umetumwa.' },
  SACCOS_SAVINGS_INTEREST_STATE:            { status: 400, message: 'Hali ya mzunguko hairuhusu hatua hii.' },
  SACCOS_SAVINGS_INTEREST_NO_AWARDS:        { status: 400, message: 'Hakuna wastahiki wa riba ya akiba.' },
  SACCOS_SAVINGS_INTEREST_POSTED:           { status: 400, message: 'Riba ya akiba tayari imetumwa (duplicate).' },
  SACCOS_SAVINGS_INTEREST_CYCLE_NOT_FOUND:  { status: 404, message: 'Mzunguko wa riba haujapatikana.' },

  // SACCOS savings-backed lending (400)
  SACCOS_LOAN_BACKING_INSUFFICIENT: { status: 400, message: 'Amana na hisa hazitoshi kuunga mkopo huu (limit = salio × multiple).' },

  // SACCOS welfare fund (400/404)
  SACCOS_WELFARE_SCHEME_NOT_FOUND:    { status: 404, message: 'Mpango wa ustawi haujapatikana.' },
  SACCOS_WELFARE_SCHEME_EXISTS:       { status: 400, message: 'Mpango wa ustawi wenye jina hili tayari upo.' },
  SACCOS_WELFARE_SCHEME_ARCHIVED:     { status: 400, message: 'Mpango huu wa ustawi umezimwa.' },
  SACCOS_WELFARE_SCHEME_AMOUNT:       { status: 400, message: 'Kiasi cha mpango wa ustawi si sahihi.' },
  SACCOS_WELFARE_ALREADY_JOINED:      { status: 400, message: 'Tayari umechangia kwenye mpango huu.' },
  SACCOS_WELFARE_CONTRIBUTION_LOW:    { status: 400, message: 'Mchango wa chini wa mpango huu unahitajika.' },
  SACCOS_WELFARE_CLAIM_NOT_FOUND:     { status: 404, message: 'Ombi la ustawi halijapatikana.' },
  SACCOS_WELFARE_CLAIM_AMOUNT:        { status: 400, message: 'Kiasi cha ombi la ustawi si sahihi (hakizidi malipo ya mpango).' },
  SACCOS_WELFARE_CLAIM_ACTIVE:        { status: 400, message: 'Tayari una ombi la ustawi linalosubiri au lililokubaliwa kwenye mpango huu.' },
  SACCOS_WELFARE_CLAIM_STATE:         { status: 400, message: 'Hali ya ombi la ustawi hairuhusu hatua hii.' },
  SACCOS_WELFARE_FUND_INSUFFICIENT:   { status: 400, message: 'Hazina ya ustawi haina fedha za kutosha kulipa ombi hili.' },
  SACCOS_WELFARE_PAID:                { status: 400, message: 'Ombi hili la ustawi tayari limelipwa.' },

  // SACCOS accounting (400/403/404)
  SACCOS_ACC_PERIOD_NOT_FOUND:     { status: 404, message: 'Kipindi cha uhasibu hakijapatikana.' },
  SACCOS_ACC_PERIOD_STATE:         { status: 400, message: 'Hali ya kipindi hairuhusu hatua hii.' },
  SACCOS_ACC_PERIOD_ALREADY_OPEN:  { status: 400, message: 'Kipindi kingine cha uhasibu kimekwisha funguliwa.' },
  SACCOS_ACC_PERIOD_OPEN:          { status: 400, message: 'Fungua kipindi cha uhasibu kabla ya kuweka kumbukumbu.' },
  SACCOS_ACC_PERIOD_RANGE:         { status: 400, message: 'Tarehe za kipindi hazina mpangilio sahihi.' },
  SACCOS_ACC_ENTRY_KIND:           { status: 400, message: 'Aina ya kumbukumbu haikubaliki.' },
  SACCOS_ACC_AMOUNT:               { status: 400, message: 'Kiasi lazima kiwe chanya.' },
  SACCOS_ACC_ACCOUNT_UNKNOWN:      { status: 400, message: 'Akaunti maalum haipatikani.' },

  // SACCOS investments (400/403/404)
  SACCOS_INV_PRODUCT_NOT_FOUND:  { status: 404, message: 'Bidhaa ya uwekezaji haijapatikana.' },
  SACCOS_INV_PRODUCT_INACTIVE:   { status: 400, message: 'Bidhaa ya uwekezaji haifanyi kazi (IMEFUNGWA).' },
  SACCOS_INV_NOT_FOUND:          { status: 404, message: 'Uwekezaji haujapatikana.' },
  SACCOS_INV_STATE:              { status: 400, message: 'Hali ya uwekezaji hairuhusu hatua hii.' },
  SACCOS_INV_NOT_MATURED:        { status: 400, message: 'Uwekezaji bado haujafikia ukomavu.' },
  SACCOS_INV_NAME_REQUIRED:      { status: 400, message: 'Jina la bidhaa linahitajika.' },
  SACCOS_INV_RATE_OR_TERM:       { status: 400, message: 'Kiwango au muda wa uwekezaji si sahihi.' },
  SACCOS_INV_AMOUNT:             { status: 400, message: 'Kiasi cha uwekezaji lazima kiwe chanya.' },
  SACCOS_INV_BELOW_MIN:          { status: 400, message: 'Kiasi kiko chini ya kiwango cha chini.' },
  SACCOS_INV_ABOVE_MAX:          { status: 400, message: 'Kiasi kinazidi kiwango cha juu.' },

  // SACCOS dividends (400/403/404)
  SACCOS_DIV_RUN_NOT_FOUND:   { status: 404, message: 'Mgawanyo wa faida haujapatikana.' },
  SACCOS_DIV_STATE:           { status: 400, message: 'Hali ya mgawanyo hairuhusu hatua hii.' },
  SACCOS_DIV_PERIOD_CLOSED:   { status: 400, message: 'Lazima kipindi cha uhasibu kifungwe kabla ya kutangaza mgawanyo.' },
  SACCOS_DIV_PERIOD_USED:     { status: 400, message: 'Mgawanyo wa faida kwa kipindi hiki umekwisha tangazwa.' },
  SACCOS_DIV_NO_SHARES:       { status: 400, message: 'Hakuna wanachama wenye hisa zilizostahiki.' },
  SACCOS_DIV_PER_SHARE:       { status: 400, message: 'Kiasi kwa hisa lazima kiwe chanya.' },
  SACCOS_DIV_TOTAL:           { status: 400, message: 'Jumla ya fedha kwa mgawanyo lazima iwe chanya.' },

  // SACCOS fund management (400/404)
  SACCOS_FUND_NOT_FOUND:     { status: 404, message: 'Hazina haijapatikana.' },
  SACCOS_FUND_EXISTS:        { status: 400, message: 'Hazina yenye msimbo huu tayari ipo.' },
  SACCOS_FUND_CODE:          { status: 400, message: 'Msimbo wa hazina haukubaliki.' },
  SACCOS_FUND_STATE:         { status: 400, message: 'Hali ya hazina hairuhusu hatua hii.' },
  SACCOS_FUND_HAS_BALANCE:   { status: 400, message: 'Hazina yenye salio haiwezi kufungwa.' },
  SACCOS_FUND_INSUFFICIENT:  { status: 400, message: 'Salio la hazina halitoshi kwa uhamishaji huu.' },
  SACCOS_FUND_SAME:          { status: 400, message: 'Huwezi kuhamisha hazina kwenda yenyewe.' },
  SACCOS_FUND_AMOUNT:        { status: 400, message: 'Kiasi cha hazina lazima kiwe chanya.' },
  SACCOS_FUND_TARGET:        { status: 400, message: 'Kiasi cha lengo lazima kiwe kisicho hasi.' },

  // SACCOS loan-loss reserves (400/404)
  SACCOS_LLR_NOT_FOUND:      { status: 404, message: 'Utoaji wa akiba ya mkopo haujapatikana.' },
  SACCOS_LLR_EXISTS:         { status: 400, message: 'Akiba ya mkopo kwa mkopo huu imekwisha tolewa.' },
  SACCOS_LLR_STATE:          { status: 400, message: 'Hali ya akiba hii hairuhusu hatua hii.' },
  SACCOS_LLR_AMOUNT:         { status: 400, message: 'Kiasi cha akiba ya mkopo hakikubaliki.' },

  // SACCOS loan guarantors / co-signers (400/403/404)
  SACCOS_LOAN_GUARANTOR_NOT_FOUND:  { status: 404, message: 'Mdhamini huyu hajapatikana.' },
  SACCOS_LOAN_GUARANTOR_SELF:       { status: 400, message: 'Huwezi kudhamini mkopo wako mwenyewe.' },
  SACCOS_LOAN_GUARANTOR_NOT_MEMBER: { status: 400, message: 'Mdhamini lazima awe mwanachama hai wa SACCOS hii.' },
  SACCOS_LOAN_GUARANTOR_EXISTS:     { status: 400, message: 'Mwanachama huyu tayari amedhamini ombi hili.' },
  SACCOS_LOAN_GUARANTOR_REQUIRED:   { status: 400, message: 'Idadi ya wadhamini inayohitajika haijafikiwa (guaranteesRequired).' },
  SACCOS_LOAN_GUARANTOR_STATE:      { status: 400, message: 'Hali ya udhamini hairuhusu hatua hii.' },
  SACCOS_LOAN_GUARANTOR_APP_CLOSED: { status: 400, message: 'Ombi hili la mkopo halipo tena PENDING.' },
  SACCOS_LOAN_GUARANTOR_NO_ARREARS: { status: 400, message: 'Hakuna awamu zilizochelewa za kulipwa na mdhamini.' },
  SACCOS_LOAN_GUARANTOR_REQUIRED_CAP: { status: 400, message: 'Udhamini unaohitajika haujakamilika (guaranteesRequired = 0).' },

  // SACCOS loan restructure (400/403/404)
  SACCOS_LOAN_RESTRUCTURE_STATE: { status: 400, message: 'Mkopo huu hauwezi kupangwa upya (unahitaji kuwa ACTIVE na kuwa na deni).' },
  SACCOS_LOAN_RESTRUCTURE_TERM:  { status: 400, message: 'Muda mpya wa mkopo lazima uwe namba kamili kati ya 1 na 120.' },
  SACCOS_LOAN_RESTRUCTURE_RATE:  { status: 400, message: 'Kiwango kipya cha riba lazima kiwe kikubwa kuliko au sawa na 0.' },

  // SACCOS loan write-off (400/404)
  SACCOS_LOAN_WRITE_OFF_STATE:   { status: 400, message: 'Mkopo huu hauwezi kufutwa (unahitaji kuwa ACTIVE na kuwa na deni).' },
  SACCOS_LOAN_WRITE_OFF_REASON:  { status: 400, message: 'Sababu ya kufuta mkopo inahitajika.' },
  SACCOS_LOAN_WRITTEN_OFF:       { status: 400, message: 'Mkopo huu umekwisha futwa.' },

  // SACCOS lending products - OWNER/BOARD-defined loan schemes (increment 19)
  SACCOS_LOAN_PRODUCT_NOT_FOUND: { status: 404, message: 'Bidhaa ya mkopo haijapatikana.' },
  SACCOS_LOAN_PRODUCT_ARCHIVED:  { status: 400, message: 'Bidhaa hii ya mkopo imezimwa (ARCHIVED).' },
  SACCOS_LOAN_PRODUCT_CODE_TAKEN:{ status: 400, message: 'Msimbo wa bidhaa ya mkopo tayari upo.' },
  SACCOS_LOAN_PRODUCT_INVALID:   { status: 400, message: 'Taarifa za bidhaa ya mkopo hazikubaliki (riba 0-100%, muda 1-120, min < max).' },

  // SACCOS standing orders / recurring contributions (400/404)
  SACCOS_STANDING_ORDER_AMOUNT:  { status: 400, message: 'Kiasi cha amri ya mara kwa mara lazima kiwe chanya.' },
  SACCOS_STANDING_ORDER_DAY:     { status: 400, message: 'Siku ya mwezi lazima iwe kati ya 1 na 28.' },
  SACCOS_STANDING_ORDER_TYPE:    { status: 400, message: 'Aina ya lengo la amri haikubaliki.' },
  SACCOS_STANDING_ORDER_TARGET:  { status: 400, message: 'Lengo la amri halipo, limezimwa, au si la mwanachama huyu.' },
  SACCOS_STANDING_ORDER_NOT_FOUND: { status: 404, message: 'Amri ya mara kwa mara haijapatikana.' },
  SACCOS_STANDING_ORDER_STATE:   { status: 400, message: 'Hali ya amri hii hairuhusu hatua hii.' },

  // SACCOS member exit & settlement (400/404)
  SACCOS_EXIT_ALREADY_SETTLED: { status: 400, message: 'Utaratibu wa kuondoka kwa mwanachama huyu umekwisha fanyika.' },
  SACCOS_EXIT_NONE:          { status: 404, message: 'Hakuna utaratibu wa kuondoka.' },

  // Cross-border remittance lifecycle (increment 21c) (400/404)
  REMITTANCE_CORRIDOR_NOT_FOUND:  { status: 404, message: 'Korido haipo.' },
  REMITTANCE_AMOUNT_INVALID:      { status: 400, message: 'Kiasi si sahihi.' },
  REMITTANCE_AMOUNT_OUT_OF_RANGE: { status: 400, message: 'Kiasi kiko nje ya mipaka ya korido.' },
  REMITTANCE_QUOTE_NOT_FOUND:     { status: 404, message: 'Nukuu haipatikani.' },
  REMITTANCE_QUOTE_EXPIRED:       { status: 400, message: 'Nukuu imeisha muda wake. Tafadhali tengeneza nukuu mpya.' },
  REMITTANCE_QUOTE_USED:          { status: 400, message: 'Nukuu hii tayari imetumika.' },
  REMITTANCE_BENEFICIARY_NOT_FOUND: { status: 404, message: 'Mpokeaji wa mara kwa mara hajapatikana.' },
  REMITTANCE_TRANSFER_NOT_FOUND:  { status: 404, message: 'Uhamisho haujapatikana.' },
  REMITTANCE_TRANSFER_STATE:      { status: 400, message: 'Hali ya uhamisho hairuhusu hatua hii.' },
  REMITTANCE_INVALID_PAYOUT:      { status: 400, message: 'Njia ya malipo haikubaliki.' },
  REMITTANCE_ALREADY_PICKED_UP:   { status: 400, message: 'Uhamisho tayari umechukuliwa.' },

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
