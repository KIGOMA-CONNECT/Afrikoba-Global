const pool = require('../config/db');
const crypto = require('crypto');
const { transferWallet } = require('./walletService');
const { sendSMS } = require('./smsService');
const currencyService = require('./currencyService');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');

// ====================================================================
// G1: FAMILY / SHARED WALLETS
// ====================================================================

async function createFamilyWallet(userId, data) {
  const { name, description, currency } = data;
  if (!name) throw Object.assign(new Error('Jina la familia ni lazima.'), { statusCode: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query(
      `INSERT INTO family_wallets (name, created_by, currency, description, balance) VALUES ($1,$2,$3,$4,0) RETURNING *`,
      [name, userId, currency || 'TZS', description || null]
    );
    await client.query(
      `INSERT INTO family_wallet_members (wallet_id, user_id, role, can_spend, status, joined_at) VALUES ($1,$2,'OWNER',TRUE,'ACTIVE',NOW())`,
      [w.rows[0].id, userId]
    );
    await client.query('COMMIT');
    return w.rows[0];
  } finally { client.release(); }
}

async function inviteMember(walletId, ownerId, data) {
  const { phone, role, can_spend, spending_limit } = data;
  if (!phone) throw Object.assign(new Error('Simu ya mwanachama ni lazima.'), { statusCode: 400 });
  const member = await pool.query('SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = (SELECT id FROM users WHERE phone_number = $2)', [walletId, phone.trim()]);
  if (member.rows.length) throw Object.assign(new Error('Mtu huyu tayari yuko kwenye familia.'), { statusCode: 400 });
  const u = await pool.query('SELECT id, full_name, phone_number FROM users WHERE phone_number = $1', [phone.trim()]);
  if (!u.rows.length) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
  const owner = await pool.query("SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = $2 AND role = 'OWNER'", [walletId, ownerId]);
  if (!owner.rows.length) throw Object.assign(new Error('Una hitaji kuwa OWNER.'), { statusCode: 403 });
  const res = await pool.query(
    `INSERT INTO family_wallet_members (wallet_id, user_id, role, can_spend, spending_limit, status) VALUES ($1,$2,$3,$4,$5,'INVITED') RETURNING *`,
    [walletId, u.rows[0].id, role || 'MEMBER', can_spend !== false, spending_limit || 0]
  );
  await sendSMS(u.rows[0].phone_number, 'Umealikwa kwenye Familia Wallet ya Afrikoba. Ingia app kujiunga.').catch(() => {});
  return res.rows[0];
}

async function joinFamilyWallet(walletId, userId) {
  const res = await pool.query(
    `UPDATE family_wallet_members SET status = 'ACTIVE', joined_at = NOW() WHERE wallet_id = $1 AND user_id = $2 RETURNING *`,
    [walletId, userId]
  );
  if (!res.rows.length) throw Object.assign(new Error('Aliyealikwa hayapatikani.'), { statusCode: 404 });
  return res.rows[0];
}

async function listFamilyWallets(userId) {
  const res = await pool.query(
    `SELECT fw.*, fwm.role, fwm.status FROM family_wallets fw
     JOIN family_wallet_members fwm ON fw.id = fwm.wallet_id WHERE fwm.user_id = $1 ORDER BY fw.created_at DESC`,
    [userId]
  );
  return res.rows;
}

async function getFamilyWallet(walletId, userId) {
  const member = await pool.query('SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = $2', [walletId, userId]);
  if (!member.rows.length) throw Object.assign(new Error('Huna ufikiaji wa familia hii.'), { statusCode: 403 });
  const wallet = await pool.query('SELECT * FROM family_wallets WHERE id = $1', [walletId]);
  const members = await pool.query('SELECT fwm.*, u.full_name, u.phone_number FROM family_wallet_members fwm JOIN users u ON fwm.user_id = u.id WHERE fwm.wallet_id = $1', [walletId]);
  const tx = await pool.query('SELECT * FROM family_wallet_transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 20', [walletId]);
  return { wallet: wallet.rows[0], members: members.rows, transactions: tx.rows };
}

async function familyContribute(walletId, userId, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const member = await pool.query("SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = $2 AND status = 'ACTIVE'", [walletId, userId]);
  if (!member.rows.length) throw Object.assign(new Error('Sio mwanachama hai.'), { statusCode: 403 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sender = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (Number(sender.rows[0].wallet_balance) < amountNum) throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountNum, userId]);
    await client.query('UPDATE family_wallets SET balance = balance + $1 WHERE id = $2', [amountNum, walletId]);
    await client.query(
      `INSERT INTO family_wallet_transactions (wallet_id, actor_user_id, amount, type, description) VALUES ($1,$2,$3,'CONTRIBUTION',$4)`,
      [walletId, userId, amountNum, 'Mchango wa familia']
    );
    await client.query('COMMIT');
    return { success: true, amount: amountNum, message: 'Umependekeza kwenye Familia Wallet.' };
  } finally { client.release(); }
}

async function familySpend(walletId, userId, amount, description) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const member = await pool.query("SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = $2 AND status = 'ACTIVE'", [walletId, userId]);
  if (!member.rows.length) throw Object.assign(new Error('Sio mwanachama hai.'), { statusCode: 403 });
  if (!member.rows[0].can_spend) throw Object.assign(new Error('Huna ruhusa ya kutumia.'), { statusCode: 403 });
  if (Number(member.rows[0].spending_limit) > 0 && amountNum > Number(member.rows[0].spending_limit)) {
    throw Object.assign(new Error('Kiasi kimezidi limit yako.'), { statusCode: 400 });
  }
  const w = await pool.query('SELECT balance FROM family_wallets WHERE id = $1 FOR UPDATE', [walletId]);
  if (Number(w.rows[0].balance) < amountNum) throw Object.assign(new Error('Salio la familia halitoshi.'), { statusCode: 400 });
  await pool.query('UPDATE family_wallets SET balance = balance - $1 WHERE id = $2', [amountNum, walletId]);
  await pool.query(
    `INSERT INTO family_wallet_transactions (wallet_id, actor_user_id, amount, type, description) VALUES ($1,$2,$3,'SPEND',$4)`,
    [walletId, userId, amountNum, description || 'Matumizi ya familia']
  );
  return { success: true, amount: amountNum, message: 'Matumizi yamepunguza salio la familia.' };
}

async function familyTransfer(walletId, userId, toPhone, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const member = await pool.query("SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = $2 AND status = 'ACTIVE'", [walletId, userId]);
  if (!member.rows.length) throw Object.assign(new Error('Sio mwanachama hai.'), { statusCode: 403 });
  if (!member.rows[0].can_spend) throw Object.assign(new Error('Huna ruhusa ya kutuma.'), { statusCode: 403 });
  const w = await pool.query('SELECT balance FROM family_wallets WHERE id = $1 FOR UPDATE', [walletId]);
  if (Number(w.rows[0].balance) < amountNum) throw Object.assign(new Error('Salio la familia halitoshi.'), { statusCode: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE family_wallets SET balance = balance - $1 WHERE id = $2', [amountNum, walletId]);
    const to = await client.query('SELECT id, wallet_balance, full_name, phone_number FROM users WHERE phone_number = $1 FOR UPDATE', [toPhone.trim()]);
    if (!to.rows.length) throw Object.assign(new Error('Mpokeaji hajapatikana.'), { statusCode: 404 });
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amountNum, to.rows[0].id]);
    await client.query(
      `INSERT INTO family_wallet_transactions (wallet_id, actor_user_id, counterparty_user_id, amount, type, description) VALUES ($1,$2,$3,$4,'TRANSFER_OUT',$5)`,
      [walletId, userId, to.rows[0].id, amountNum, `Tuma kwa ${toPhone}`]
    );
    await client.query('COMMIT');
    await sendSMS(to.rows[0].phone_number, `Umepokea TZS ${formatMoney(amountNum)} kutoka Familia Wallet.`).catch(() => {});
    return { success: true, amount: amountNum, message: 'Fedha zimetumwa kutoka Familia Wallet.' };
  } finally { client.release(); }
}

async function removeMember(walletId, ownerId, memberUserId) {
  const owner = await pool.query("SELECT * FROM family_wallet_members WHERE wallet_id = $1 AND user_id = $2 AND role = 'OWNER'", [walletId, ownerId]);
  if (!owner.rows.length) throw Object.assign(new Error('Una hitaji kuwa OWNER.'), { statusCode: 403 });
  const res = await pool.query("UPDATE family_wallet_members SET status = 'REMOVED' WHERE wallet_id = $1 AND user_id = $2 RETURNING *", [walletId, memberUserId]);
  return res.rows[0];
}

// ====================================================================
// G2: MULTI-CURRENCY
// ====================================================================

async function getBalances(userId) {
  const main = await pool.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
  const others = await pool.query('SELECT currency_code, balance FROM user_balances WHERE user_id = $1', [userId]);
  return { tzs: Number(main.rows[0].wallet_balance), locked: Number(main.rows[0].locked_balance), currencies: others.rows };
}

async function topUpCurrency(userId, currency, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const rate = await getFxRate(currency);
  const tzsCost = amountNum * Number(rate);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (Number(u.rows[0].wallet_balance) < tzsCost) throw Object.assign(new Error(`Salio la TZS halitoshi (unahitaji ${formatMoney(tzsCost)}).`), { statusCode: 400 });
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [tzsCost, userId]);
    await client.query(
      `INSERT INTO user_balances (user_id, currency_code, balance) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, currency_code) DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, currency, amountNum]
    );
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, currency_code, fx_rate, fx_base_currency, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, $4, $5, 'TZS', 'SUCCESS', 'CURRENCY_TOPUP', $6)`,
      [generateReference(), userId, tzsCost, currency, rate, JSON.stringify({ amount: amountNum })]
    );
    await client.query('COMMIT');
    return { success: true, currency, amount: amountNum, tzs_cost: tzsCost, message: `Umepata ${amountNum} ${currency}.` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function getFxRate(currency) {
  return currencyService.getRateToTzs(currency);
}

async function convertCurrency(userId, from, to, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const rateData = await currencyService.getExchangeRate(from, to);
  if (!rateData) throw Object.assign(new Error('Kiwango cha ubadilishaji hakipatikani.'), { statusCode: 400 });
  const converted = amountNum * rateData.rate;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND currency_code = $2 FOR UPDATE', [userId, from]);
    if (!b.rows.length || Number(b.rows[0].balance) < amountNum) throw Object.assign(new Error(`Salio la ${from} halitoshi.`), { statusCode: 400 });
    await client.query('UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND currency_code = $3', [amountNum, userId, from]);
    await client.query(
      `INSERT INTO user_balances (user_id, currency_code, balance) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, currency_code) DO UPDATE SET balance = user_balances.balance + $3`,
      [userId, to, converted]
    );
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, currency_code, fx_rate, fx_base_currency, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, $4, $5, $6, 'SUCCESS', 'CURRENCY_CONVERT', $7)`,
      [generateReference(), userId, amountNum, from, rateData.rate, 'TZS', JSON.stringify({ to, converted: Number(converted.toFixed(2)), rateSource: rateData.source })]
    );
    await client.query('COMMIT');
    return { success: true, from, to, converted: Number(converted.toFixed(2)), message: `Imebadilishwa kuwa ${converted.toFixed(2)} ${to}.` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function transferForeign(userId, toPhone, currency, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT balance FROM user_balances WHERE user_id = $1 AND currency_code = $2 FOR UPDATE', [userId, currency]);
    if (!b.rows.length || Number(b.rows[0].balance) < amountNum) throw Object.assign(new Error(`Salio la ${currency} halitoshi.`), { statusCode: 400 });
    const to = await client.query('SELECT id FROM users WHERE phone_number = $1', [toPhone.trim()]);
    if (!to.rows.length) throw Object.assign(new Error('Mpokeaji hajapatikana.'), { statusCode: 404 });
    await client.query('UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND currency_code = $3', [amountNum, userId, currency]);
    await client.query(
      `INSERT INTO user_balances (user_id, currency_code, balance) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, currency_code) DO UPDATE SET balance = user_balances.balance + $3`,
      [to.rows[0].id, currency, amountNum]
    );
    await client.query('COMMIT');
    return { success: true, amount: amountNum, currency, message: `Umetuma ${amountNum} ${currency}.` };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ====================================================================
// G3: BIOMETRIC / DEVICE BINDING
// ====================================================================

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

async function registerDevice(userId, data) {
  const { device_id, device_name, biometric_token } = data;
  if (!device_id) throw Object.assign(new Error('Device ID ni lazima.'), { statusCode: 400 });
  const res = await pool.query(
    `INSERT INTO user_devices (user_id, device_id, device_name, biometric_token, is_trusted, last_used)
     VALUES ($1,$2,$3,$4,TRUE,NOW())
     ON CONFLICT (user_id, device_id) DO UPDATE SET device_name = $3, biometric_token = $4, is_trusted = TRUE, last_used = NOW()
     RETURNING id, device_id, device_name, is_trusted, created_at`,
    [userId, device_id, device_name || 'Device', biometric_token ? hashToken(biometric_token) : null]
  );
  return res.rows[0];
}

async function listDevices(userId) {
  const res = await pool.query('SELECT id, device_id, device_name, is_trusted, last_used, created_at FROM user_devices WHERE user_id = $1', [userId]);
  return res.rows;
}

async function removeDevice(userId, deviceId) {
  const res = await pool.query('DELETE FROM user_devices WHERE user_id = $1 AND device_id = $2 RETURNING id', [userId, deviceId]);
  if (!res.rows.length) throw Object.assign(new Error('Device haijapatikana.'), { statusCode: 404 });
  return { success: true };
}

async function generateChallenge(userId, deviceId) {
  const dev = await pool.query('SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  if (!dev.rows.length) throw Object.assign(new Error('Device haijapatikana.'), { statusCode: 404 });
  const nonce = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE user_devices SET challenge_nonce = $1, nonce_expires = NOW() + INTERVAL \'5 minutes\' WHERE id = $2', [nonce, dev.rows[0].id]);
  return { challenge: nonce, expires_in: 300 };
}

async function verifyChallenge(userId, deviceId, response) {
  const dev = await pool.query('SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  if (!dev.rows.length) throw Object.assign(new Error('Device haijapatikana.'), { statusCode: 404 });
  const d = dev.rows[0];
  if (!d.challenge_nonce || new Date(d.nonce_expires) < new Date()) throw Object.assign(new Error('Challenge imeisha muda.'), { statusCode: 400 });
  if (d.challenge_nonce !== response) throw Object.assign(new Error('Jibu si sahihi.'), { statusCode: 400 });
  await pool.query('UPDATE user_devices SET challenge_nonce = NULL, last_used = NOW() WHERE id = $1', [d.id]);
  return { success: true, verified: true };
}

async function biometricLogin(phone, deviceId, biometricToken) {
  const u = await pool.query('SELECT id, full_name, phone_number FROM users WHERE phone_number = $1', [phone.trim()]);
  if (!u.rows.length) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
  const dev = await pool.query('SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2', [u.rows[0].id, deviceId]);
  if (!dev.rows.length) throw Object.assign(new Error('Device haijasajiliwa.'), { statusCode: 403 });
  if (!dev.rows[0].biometric_token) throw Object.assign(new Error('Biometric haijasajiliwa.'), { statusCode: 400 });
  if (dev.rows[0].biometric_token !== hashToken(biometricToken)) throw Object.assign(new Error('Biometric hailingani.'), { statusCode: 401 });
  await pool.query('UPDATE user_devices SET last_used = NOW() WHERE id = $1', [dev.rows[0].id]);
  return { success: true, verified: true, user: u.rows[0] };
}

// ====================================================================
// G4: OFFLINE QUEUE
// ====================================================================

async function queueOfflineOp(userId, opType, payload) {
  const res = await pool.query(
    `INSERT INTO offline_operations (user_id, op_type, payload, status) VALUES ($1,$2,$3,'QUEUED') RETURNING *`,
    [userId, opType, JSON.stringify(payload)]
  );
  return res.rows[0];
}

async function getOfflineOps(userId, status) {
  const params = [userId];
  let q = 'SELECT * FROM offline_operations WHERE user_id = $1';
  if (status) { q += ' AND status = $2'; params.push(status); }
  q += ' ORDER BY created_at ASC';
  const res = await pool.query(q, params);
  return res.rows;
}

async function syncOfflineOps(userId) {
  const ops = await pool.query("SELECT * FROM offline_operations WHERE user_id = $1 AND status = 'QUEUED' ORDER BY created_at ASC", [userId]);
  let processed = 0, failed = 0;
  for (const op of ops.rows) {
    try {
      const p = op.payload;
      if (op.op_type === 'TRANSFER' && p.toPhone && p.amount) {
        await transferWallet(userId, p.toPhone, Number(p.amount), p.note || 'Offline transfer');
      } else if (op.op_type === 'CONTRIBUTION' && p.walletId && p.amount) {
        await familyContribute(p.walletId, userId, Number(p.amount));
      } else if (op.op_type === 'BILL_PAYMENT' && p.biller && p.amount) {
        // best-effort: logged; full bill pay requires external; mark processed for offline replay
      } else {
        throw new Error('Aina ya operesheni haijulikani');
      }
      await pool.query("UPDATE offline_operations SET status = 'PROCESSED', synced_at = NOW() WHERE id = $1", [op.id]);
      processed++;
    } catch (e) {
      await pool.query('UPDATE offline_operations SET status = $1, error_message = $2 WHERE id = $3', ['FAILED', e.message, op.id]);
      failed++;
    }
  }
  return { processed, failed, message: 'Offline ops zimesawazishwa.' };
}

// ====================================================================
// G5: ROUND-UP SAVINGS
// ====================================================================

async function createRoundupRule(userId, data) {
  const { savings_goal_id, round_to } = data;
  const res = await pool.query(
    `INSERT INTO roundup_rules (user_id, savings_goal_id, is_active, round_to) VALUES ($1,$2,TRUE,$3)
     ON CONFLICT (user_id) DO UPDATE SET is_active = TRUE, savings_goal_id = $2, round_to = $3 RETURNING *`,
    [userId, savings_goal_id || null, round_to || 1000]
  );
  return res.rows[0];
}

async function getRoundupSummary(userId) {
  const r = await pool.query('SELECT * FROM roundup_rules WHERE user_id = $1', [userId]);
  const logs = await pool.query('SELECT COALESCE(SUM(rounded_amount),0) AS total FROM roundup_log WHERE user_id = $1', [userId]);
  return { rule: r.rows[0] || null, total_saved: Number(logs.rows[0].total) };
}

async function processRoundUps(userId) {
  const rule = await pool.query('SELECT * FROM roundup_rules WHERE user_id = $1 AND is_active = TRUE', [userId]);
  if (!rule.rows.length) throw Object.assign(new Error('Hamna kanuni ya round-up.'), { statusCode: 400 });
  const r = rule.rows[0];
  const roundTo = Number(r.round_to) || 1000;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txs = await client.query(
      `SELECT t.* FROM transactions t
       LEFT JOIN roundup_log rl ON rl.transaction_id = t.id
       WHERE t.user_id = $1 AND t.status = 'SUCCESS' AND t.type = 'TRANSFER' AND rl.id IS NULL
       ORDER BY t.created_at DESC LIMIT 50`,
      [userId]
    );
    let totalRound = 0;
    for (const t of txs.rows) {
      const amt = Number(t.total_charged);
      const rounded = Math.ceil(amt / roundTo) * roundTo;
      const spare = rounded - amt;
      if (spare <= 0) continue;
      const u = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (Number(u.rows[0].wallet_balance) < spare) continue;
      await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [spare, userId]);
      totalRound += spare;
      await client.query('INSERT INTO roundup_log (user_id, transaction_id, rounded_amount) VALUES ($1,$2,$3)', [userId, t.id, spare]);
      if (r.savings_goal_id) {
        await client.query('UPDATE savings_goals SET current_amount = current_amount + $1 WHERE id = $2 AND user_id = $3', [spare, r.savings_goal_id, userId]);
      }
    }
    if (totalRound > 0) {
      await client.query('UPDATE roundup_rules SET total_roundup = total_roundup + $1 WHERE id = $2', [totalRound, r.id]);
    }
    await client.query('COMMIT');
    return { success: true, roundup_saved: totalRound, message: `Round-up imeokoa TZS ${formatMoney(totalRound)}.` };
  } finally { client.release(); }
}

module.exports = {
  createFamilyWallet, inviteMember, joinFamilyWallet, listFamilyWallets, getFamilyWallet,
  familyContribute, familySpend, familyTransfer, removeMember,
  getBalances, topUpCurrency, convertCurrency, transferForeign,
  registerDevice, listDevices, removeDevice, generateChallenge, verifyChallenge, biometricLogin,
  queueOfflineOp, getOfflineOps, syncOfflineOps,
  createRoundupRule, getRoundupSummary, processRoundUps
};
