/**
 * Multi-country phone utilities.
 * - Canonical storage: international format WITHOUT leading '+' or '00'
 *   (e.g. 255712000001, 254712345678) — existing DB convention.
 * - National format (07xx…) is resolved to E.164 using a country hint
 *   (default TZ), matching the legacy behaviour while extending support
 *   to every active country/dial-code in the list.
 */

const SUPPORTED_COUNTRIES = [
  { code: 'TZ', name: 'Tanzania', dial: '255', nationalLen: 9, example: '0712 345 678' },
  { code: 'KE', name: 'Kenya', dial: '254', nationalLen: 9, example: '0712 345 678' },
  { code: 'UG', name: 'Uganda', dial: '256', nationalLen: 9, example: '0751 234 567' },
  { code: 'RW', name: 'Rwanda', dial: '250', nationalLen: 9, example: '0788 123 456' },
  { code: 'BI', name: 'Burundi', dial: '257', nationalLen: 8, example: '07 1234 567' },
  { code: 'ET', name: 'Ethiopia', dial: '251', nationalLen: 9, example: '0911 234 567' },
  { code: 'SO', name: 'Somalia', dial: '252', nationalLen: 9, example: '0612 345 678' },
  { code: 'CD', name: 'DR Congo', dial: '243', nationalLen: 9, example: '0812 345 678' },
  { code: 'MW', name: 'Malawi', dial: '265', nationalLen: 9, example: '0888 123 456' },
  { code: 'MZ', name: 'Mozambique', dial: '258', nationalLen: 9, example: '0812 345 678' },
  { code: 'ZM', name: 'Zambia', dial: '260', nationalLen: 9, example: '0955 123 456' },
  { code: 'GH', name: 'Ghana', dial: '233', nationalLen: 9, example: '0233 123 456' },
  { code: 'NG', name: 'Nigeria', dial: '234', nationalLen: 10, example: '0801 234 5678' },
  { code: 'ZA', name: 'South Africa', dial: '27', nationalLen: 9, example: '071 123 4567' },
  { code: 'EG', name: 'Egypt', dial: '20', nationalLen: 10, example: '0100 123 4567' },
].sort((a, b) => b.dial.length - a.dial.length || b.dial.localeCompare(a.dial));

const DIAL_MAP = new Map(SUPPORTED_COUNTRIES.map((c) => [c.dial, c]));
const COUNTRY_MAP = new Map(SUPPORTED_COUNTRIES.map((c) => [c.code, c]));

function digitsOnly(phone) {
  return String(phone || '').replace(/\s+/g, '');
}

/**
 * Determine the country entry whose dial code prefixes a number.
 * Longest dial prefix wins (e.g. 250 Rwanda vs 25…). Returns null if none.
 */
function countryFromE164(phone) {
  const p = digitsOnly(phone).replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d+$/.test(p)) return null;
  for (const c of SUPPORTED_COUNTRIES) {
    if (p.startsWith(c.dial) && p.length === c.dial.length + c.nationalLen) return c;
  }
  // Loose match (only dial prefix) for detecting origin of partial input.
  for (const c of SUPPORTED_COUNTRIES) {
    if (p.startsWith(c.dial)) return c;
  }
  return null;
}

function countryByCode(code) {
  return COUNTRY_MAP.get(String(code || '').toUpperCase()) || null;
}

/**
 * Normalize a phone number to canonical international format (no '+').
 * Accepts:
 *  - bare E.164 for any supported country: 2550712345678 / 254712345678
 *  - '+…' or '00…' prefixed: +2550712345678
 *  - national format starting with '0' resolved against `countryHint` (default TZ):
 *    0712345678 → 2550712345678
 * Returns null when the number cannot be normalized to a supported country.
 */
function normalizeToE164(phone, countryHint = 'TZ') {
  let p = digitsOnly(phone);
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);

  if (!/^\d+$/.test(p)) return null;

  const hint = countryByCode(countryHint);
  if (p.startsWith('0') && hint) {
    p = hint.dial + p.slice(1);
    const c = countryFromE164(p);
    if (c && p.length === c.dial.length + c.nationalLen) return p;
    return null;
  }

  const c = countryFromE164(p);
  if (c) return p;
  return null;
}

function isValidPhone(phone, countryHint = 'TZ') {
  return normalizeToE164(phone, countryHint) !== null;
}

function countryFromPhone(phone, countryHint = 'TZ') {
  const normalized = normalizeToE164(phone, countryHint);
  if (!normalized) return 'TZ';
  const c = countryFromE164(normalized);
  return c ? c.code : 'TZ';
}

function toLocalFormat(phone) {
  let p = digitsOnly(phone);
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('255')) return '0' + p.slice(3);
  return p;
}

function maskPhone(phone) {
  const p = digitsOnly(phone);
  if (p.length < 8) return '****';
  return p.slice(0, 5) + '****' + p.slice(-3);
}

module.exports = {
  SUPPORTED_COUNTRIES,
  normalizeToE164,
  isValidPhone,
  countryFromPhone,
  countryFromE164,
  countryByCode,
  toLocalFormat,
  maskPhone,
};