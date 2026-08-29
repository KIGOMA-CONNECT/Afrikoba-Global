const crypto = require('crypto');
const { normalizeToE164 } = require('./phone');

/**
 * Sasa namba ya simu kwenda format ya kimataifa 255XXXXXXXXX (Beem).
 * Sasa inaunga nchi nyingi: namba yoyote ya E.164 ya nchi iliyowashwa
 * (254, 256, 250…) hubakia kama ilivyo; national 07xx huenda kwa 255 kwa default.
 */
function toInternationalFormat(phone, countryHint = 'TZ') {
  return normalizeToE164(phone, countryHint) || String(phone).trim();
}

/**
 * Sasa namba kwenda format ya AzamPay MNO (0XXXXXXXXX) — Tanzania pekee
 */
function toLocalFormat(phone) {
  let p = String(phone).trim().replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.substring(1);
  if (p.startsWith('255')) p = '0' + p.substring(3);
  return p;
}

/**
 * Tengeneza Reference ID yenye prefix (e.g. DP-A1B2C3D4)
 */
function generateReference(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Compute Add-on Fee (commission)
 * totalCharged = walletAmount + commission
 */
function computeDepositAmounts(walletAmount, commissionPercent) {
  const amount = Math.round(parseFloat(walletAmount) * 100) / 100;
  const commission = Math.round(amount * commissionPercent * 100) / 100;
  const totalCharged = Math.round((amount + commission) * 100) / 100;
  return { walletAmount: amount, commission, totalCharged };
}

/**
 * Format namba kama fedha (TZS 101,000)
 */
function formatMoney(n) {
  return `TZS ${Number(n || 0).toLocaleString('en-US')}`;
}

function maskPhone(phone) {
  const p = String(phone || '').replace(/\s+/g, '');
  if (p.length < 8) return '****';
  return p.slice(0, 4) + '****' + p.slice(-3);
}

module.exports = {
  toInternationalFormat,
  toLocalFormat,
  generateReference,
  computeDepositAmounts,
  formatMoney,
  maskPhone,
};
