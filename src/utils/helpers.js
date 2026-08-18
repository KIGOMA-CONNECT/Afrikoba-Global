const crypto = require('crypto');

/**
 * Sasa namba ya simu kwenda format ya kimataifa 255XXXXXXXXX (Beem)
 */
function toInternationalFormat(phone) {
  let p = String(phone).trim().replace(/\s+/g, '');
  if (p.startsWith('+')) p = p.substring(1);
  if (p.startsWith('0')) p = '255' + p.substring(1);
  if (!p.startsWith('255')) p = '255' + p;
  return p;
}

/**
 * Sasa namba kwenda format ya AzamPay MNO (0XXXXXXXXX)
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
  const p = toInternationalFormat(phone);
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
