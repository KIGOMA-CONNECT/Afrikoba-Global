/**
 * Virtual Cards
 * J1-J2: Issue/manage cards | J3: Authorization holds | J4: Settlement
 * J5: Refunds | J6: Statement & summary
 */

const crypto = require('crypto');
const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function genCvv() {
  return String(Math.floor(100 + Math.random() * 900));
}

function luhnCheckDigit(partial) {
  let sum = 0;
  let alt = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = Number(partial[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return (10 - (sum % 10)) % 10;
}

function genPan(scheme) {
  const prefix = scheme === 'MASTERCARD' ? '5' : (scheme === 'VERVE' ? '6' : '4');
  let partial = prefix;
  for (let i = 0; i < 14; i++) partial += Math.floor(Math.random() * 10);
  return partial + luhnCheckDigit(partial);
}

function maskPan(pan) {
  return `**** **** **** ${String(pan).slice(-4)}`;
}

function parseAmount(amount) {
  const n = Number(amount);
  return isFinite(n) ? n : NaN;
}

function badge(err, statusCode) {
  return Object.assign(new Error(err), { statusCode });
}

async function assertCardOwner(cardId, userId, mode) {
  const res = await pool.query('SELECT * FROM virtual_cards WHERE id = $1', [cardId]);
  if (!res.rows.length) throw badge('Kadi haipatikani.', 404);
  const card = res.rows[0];
  if (card.user_id !== userId) throw badge('Hii kadi sio yako.', 403);
  if (mode === 'active' && card.status !== 'ACTIVE') throw badge('Kadi haifanyi kazi (imefungwa au imeblock).', 403);
  return card;
}

async function todaySpend(cardId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS s FROM card_transactions
     WHERE card_id = $1 AND status IN ('AUTH_HOLD','SETTLED') AND created_at::date = CURRENT_DATE`,
    [cardId]
  );
  return Number(r.rows[0].s);
}

async function logCardTx(client, userId, cardId, merchantName, amount, status, authReference, declinedReason) {
  await client.query(
    `INSERT INTO card_transactions (card_id, user_id, merchant_name, amount, status, auth_reference, declined_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [cardId, userId, merchantName, amount, status, authReference, declinedReason || null]
  );
}

// ====================================================================
// J1-J2: ISSUE & MANAGE
// ====================================================================

async function issueCard(userId, data) {
  const scheme = ['VISA', 'MASTERCARD', 'VERVE'].includes(data.scheme) ? data.scheme : 'VISA';
  const pan = genPan(scheme);
  const cvv = genCvv();
  const now = new Date();
  const expiryMonth = String(now.getMonth() + 1).padStart(2, '0');
  const expiryYear = String(now.getFullYear() + 3);
  const res = await pool.query(
    `INSERT INTO virtual_cards (user_id, scheme, card_number_hash, masked_number, expiry_month, expiry_year, cvv_hash,
                                daily_limit, per_txn_limit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, scheme, masked_number, expiry_month, expiry_year, status, daily_limit, per_txn_limit, issued_at`,
    [userId, scheme, sha256(pan), maskPan(pan), expiryMonth, expiryYear, sha256(cvv),
     data.daily_limit != null ? Number(data.daily_limit) : 2000000,
     data.per_txn_limit != null ? Number(data.per_txn_limit) : 500000]
  );
  await logAudit(userId, 'CARD_ISSUED', `${scheme} virtual card imetolewa`).catch(() => {});
  const card = res.rows[0];
  return { card, pan: pan, cvv: cvv, message: 'Pan + CVV hurejeshwa mara moja tu — yahifadhi kwa usalama.' };
}

async function listCards(userId) {
  const res = await pool.query(
    `SELECT id, scheme, masked_number, expiry_month, expiry_year, status, daily_limit, per_txn_limit, issued_at
     FROM virtual_cards WHERE user_id = $1 ORDER BY issued_at DESC`,
    [userId]
  );
  return res.rows;
}

async function getCard(userId, cardId) {
  const card = await assertCardOwner(cardId, userId);
  return {
    id: card.id, scheme: card.scheme, masked_number: card.masked_number,
    expiry_month: card.expiry_month, expiry_year: card.expiry_year,
    status: card.status, daily_limit: card.daily_limit, per_txn_limit: card.per_txn_limit, issued_at: card.issued_at,
  };
}

async function setCardLimits(userId, cardId, data) {
  const card = await assertCardOwner(cardId, userId);
  if (card.status === 'BLOCKED') throw badge('Kadi imeblock — haiwezi kuwekewa mipaka.', 403);
  await pool.query(
    `UPDATE virtual_cards SET daily_limit = COALESCE($1, daily_limit), per_txn_limit = COALESCE($2, per_txn_limit), updated_at = NOW() WHERE id = $3`,
    [data.daily_limit != null ? Number(data.daily_limit) : null, data.per_txn_limit != null ? Number(data.per_txn_limit) : null, cardId]
  );
  return getCard(userId, cardId);
}

async function freezeCard(userId, cardId, freeze) {
  const card = await assertCardOwner(cardId, userId);
  if (card.status === 'BLOCKED') throw badge('Kadi imeblock.', 403);
  const status = freeze ? 'FROZEN' : 'ACTIVE';
  await pool.query(`UPDATE virtual_cards SET status = $1, updated_at = NOW() WHERE id = $2`, [status, cardId]);
  await logAudit(userId, 'CARD_FROZEN_STATE', `Kadi #${cardId} ${status}`).catch(() => {});
  return { success: true, card_id: cardId, status };
}

async function blockCard(userId, cardId) {
  const card = await assertCardOwner(cardId, userId);
  await pool.query(`UPDATE virtual_cards SET status = 'BLOCKED', updated_at = NOW() WHERE id = $1`, [cardId]);
  await logAudit(userId, 'CARD_BLOCKED', `Kadi #${cardId} imeblock (lost/stolen)`).catch(() => {});
  return { success: true, card_id: cardId, status: 'BLOCKED' };
}

// ====================================================================
// J3: AUTHORIZATION (wallet hold)
// ====================================================================

async function authorizeCard(userId, cardId, data) {
  const { merchant_name, amount, cvv } = data;
  const amountNum = parseAmount(amount);
  if (!merchant_name) throw badge('Jina la muuzaji ni lazima.', 400);
  if (!amountNum || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);

  const card = await pool.query('SELECT * FROM virtual_cards WHERE id = $1 FOR UPDATE', [cardId]);
  if (!card.rows.length) throw badge('Kadi haipatikani.', 404);
  const c = card.rows[0];
  if (c.user_id !== userId) throw badge('Hii kadi sio yako.', 403);

  const authRef = 'AUTH-' + generateReference().replace('undefined-', '');

  const declineWith = async (reason) => {
    const rc = await pool.connect();
    try {
      await rc.query('BEGIN');
      await logCardTx(rc, userId, cardId, merchant_name, amountNum, 'DECLINED', authRef, reason);
      await rc.query('COMMIT');
    } finally { rc.release(); }
    return null;
  };

  if (card.rows[0].status !== 'ACTIVE') {
    await declineWith(card.rows[0].status === 'FROZEN' ? 'CARD_FROZEN' : 'CARD_BLOCKED');
    throw badge('Kadi haifanyi kazi (imefungwa au imeblock).', 403);
  }
  if (!cvv || sha256(String(cvv).trim()) !== c.cvv_hash) {
    await declineWith('INVALID_CVV');
    throw badge('CVV si sahihi.', 400);
  }
  if (c.per_txn_limit && amountNum > Number(c.per_txn_limit)) {
    await declineWith('OVER_TRANSACTION_LIMIT');
    throw badge(`Kiasi kinazidi kikomo cha miamala (${c.per_txn_limit}).`, 400);
  }
  const spend = await todaySpend(cardId);
  if (c.daily_limit && (spend + amountNum) > Number(c.daily_limit)) {
    await declineWith('OVER_DAILY_LIMIT');
    throw badge('Kiasi kinazidi kikomo cha siku (daily limit).', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (Number(u.rows[0].wallet_balance) < amountNum) {
      await client.query('ROLLBACK').catch(() => {});
      const rc = await pool.connect();
      await rc.query('BEGIN');
      await logCardTx(rc, userId, cardId, merchant_name, amountNum, 'DECLINED', authRef, 'INSUFFICIENT_FUNDS');
      await rc.query('COMMIT');
      rc.release();
      throw badge('Salio lako halitoshi.', 400);
    }
    await fin.lockWallet({ client, userId, amount: amountNum, reference: `${authRef}:LOCK`, description: 'Card authorization hold' });
    await logCardTx(client, userId, cardId, merchant_name, amountNum, 'AUTH_HOLD', authRef, null);
    const after = await client.query('SELECT wallet_balance, locked_balance FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    return { success: true, status: 'AUTH_HOLD', auth_reference: authRef, locked_balance: Number(after.rows[0].locked_balance), wallet_balance: Number(after.rows[0].wallet_balance), message: 'Miamala imeidhinishwa (hold).' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// J4: SETTLEMENT (merchant)   |   J5: REFUND
// ====================================================================

async function settleCardAuth(adminId, authReference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query(
      "SELECT * FROM card_transactions WHERE auth_reference = $1 AND status = 'AUTH_HOLD' FOR UPDATE",
      [authReference]
    );
    if (!tx.rows.length) throw badge('Authorization haipatikani au imeshawekwa.', 404);
    const t = tx.rows[0];
    await fin.captureLock({ client, userId: t.user_id, amount: t.amount, reference: `${authReference}:CAPTURE`, toAccount: 'MNO_CLEARING', description: 'Card settlement' });
    await client.query(`UPDATE card_transactions SET status = 'SETTLED', settled_at = NOW() WHERE id = $1`, [t.id]);
    await client.query('COMMIT');
    await logAudit(adminId, 'CARD_SETTLEMENT', `AUTH ${authReference} imesettle (${t.amount})`).catch(() => {});
    return { success: true, auth_reference: authReference, amount: Number(t.amount), status: 'SETTLED' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function refundCardAuth(adminId, authReference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await client.query(
      "SELECT * FROM card_transactions WHERE auth_reference = $1 AND status = 'AUTH_HOLD' FOR UPDATE",
      [authReference]
    );
    if (!tx.rows.length) throw badge('Authorization haipatikani au imeshawekwa.', 404);
    const t = tx.rows[0];
    await fin.unlockWallet({ client, userId: t.user_id, amount: t.amount, reference: `${authReference}:REFUND`, description: 'Card refund' });
    await client.query(`UPDATE card_transactions SET status = 'REFUNDED', settled_at = NOW() WHERE id = $1`, [t.id]);
    await client.query('COMMIT');
    await logAudit(adminId, 'CARD_REFUND', `AUTH ${authReference} imerefund (${t.amount})`).catch(() => {});
    return { success: true, auth_reference: authReference, amount: Number(t.amount), status: 'REFUNDED' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// J6: STATEMENT & SUMMARY
// ====================================================================

async function cardStatement(userId, cardId) {
  const card = await assertCardOwner(cardId, userId);
  const res = await pool.query(
    `SELECT id, merchant_name, amount, status, auth_reference, declined_reason, settled_at, created_at
     FROM card_transactions WHERE card_id = $1 ORDER BY created_at DESC`,
    [cardId]
  );
  return { card: { id: card.id, masked_number: card.masked_number, scheme: card.scheme }, transactions: res.rows };
}

async function cardSummary(userId) {
  const cards = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
            COUNT(*) FILTER (WHERE status = 'FROZEN')::int AS frozen,
            COUNT(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked
     FROM virtual_cards WHERE user_id = $1`,
    [userId]
  );
  const spend = await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS month_spend,
            COUNT(*)::int AS auth_count
     FROM card_transactions
     WHERE user_id = $1 AND status IN ('AUTH_HOLD','SETTLED') AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW())`,
    [userId]
  );
  const locked = await pool.query('SELECT COALESCE(SUM(locked_balance),0)::numeric AS l FROM users WHERE id = $1', [userId]);
  return {
    totalCards: Number(cards.rows[0].total),
    activeCards: Number(cards.rows[0].active),
    frozenCards: Number(cards.rows[0].frozen),
    blockedCards: Number(cards.rows[0].blocked),
    spendThisMonth: Number(spend.rows[0].month_spend),
    activeAuthHolds: Number(spend.rows[0].auth_count),
    lockedBalanceTotal: Number(locked.rows[0].l),
  };
}

module.exports = {
  issueCard,
  listCards,
  getCard,
  setCardLimits,
  freezeCard,
  blockCard,
  authorizeCard,
  settleCardAuth,
  refundCardAuth,
  cardStatement,
  cardSummary,
};