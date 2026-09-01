/**
 * Partner Banking / Bank-as-a-Service (BaaS)
 * K1: Apply + admin approve | K2: Funding | K3: Signed payout rails
 * K4: Idempotency | K5: Webhooks | K6: Statement & summary
 */

const crypto = require('crypto');
const pool = require('../config/db');
const url = require('url');
const http = require('http');
const https = require('https');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('../services/financialEngine');

function computeSignature(secret, timestampSec, body) {
  return crypto.createHmac('sha256', secret).update(`${timestampSec}\n${body}`).digest('hex');
}

function badge(err, statusCode) {
  return Object.assign(new Error(err), { statusCode });
}

async function logTx(client, userId, amount, type, meta) {
  await client.query(
    `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
     VALUES ($1, $2, $3, 0, $3, 'SUCCESS', $4, $5)`,
    [generateReference('BAP'), userId, amount, type, JSON.stringify(meta || {})]
  );
}

async function logPartnerTxn(partnerId, type, amount, ref, requestId, phone, status, client) {
  const run = client || pool;
  await run.query(
    `INSERT INTO partner_transactions (partner_id, type, amount, reference, request_id, phone, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [partnerId, type, amount, ref, requestId || null, phone || null, status || 'COMPLETED']
  );
}

function deliver(options) {
  return new Promise((resolve) => {
    const lib = options.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: options.hostname,
      port: options.port,
      path: options.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bap-Signature': options.signature,
        'X-Timestamp': options.timestamp,
        'Content-Length': Buffer.byteLength(options.body),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0 }); });
    req.write(options.body);
    req.end();
  });
}

async function deliverWebhook(partner, event, payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = computeSignature(partner.api_secret, ts, body);
  const row = await pool.query(
    `INSERT INTO partner_webhooks (partner_id, event, payload, request_ts, request_body, request_signature)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [partner.id, event, JSON.stringify(payload), ts, body, sig]
  );
  let statusCode = 0;
  if (partner.webhook_url) {
    const u = url.parse(partner.webhook_url);
    const res = await deliver({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path,
      signature: sig, timestamp: ts, body,
    });
    statusCode = res.status;
  }
  const delivered = statusCode >= 200 && statusCode < 300;
  const result = await pool.query(
    `UPDATE partner_webhooks SET status = $2, response_status = $3, attempts = attempts + 1,
            delivered_at = COALESCE($4, delivered_at)
     WHERE id = $1 RETURNING status, response_status, request_ts, request_signature, request_body`,
    [row.rows[0].id, delivered ? 'DELIVERED' : 'FAILED', statusCode, delivered ? new Date() : null]
  );
  return { delivered: result.rows[0] };
}

// ====================================================================
// K1: APPLICATION & APPROVAL
// ====================================================================

async function applyPartner(data) {
  const { name, contact_email, phone, country, webhook_url } = data || {};
  if (!name || !contact_email || !phone) throw badge('Name, email na phone ni lazima.', 400);
  const res = await pool.query(
    `INSERT INTO partners (name, contact_email, phone, country, webhook_url)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name, status, created_at`,
    [name, contact_email, phone, country || 'TANZANIA', webhook_url || null]
  );
  return res.rows[0];
}

async function approvePartner(adminId, partnerId) {
  const p = await pool.query('SELECT * FROM partners WHERE id = $1', [partnerId]);
  if (!p.rows.length) throw badge('Partner hapatikani.', 404);
  if (p.rows[0].status !== 'PENDING') throw badge(`Hali ya partner ni ${p.rows[0].status} - haiwezi kupitishwa tayari.`, 400);
  const apiKey = 'bap_' + crypto.randomBytes(12).toString('hex');
  const apiSecret = 'sk_' + crypto.randomBytes(24).toString('hex');
  await pool.query(`UPDATE partners SET status='ACTIVE', api_key=$1, api_secret=$2, updated_at=NOW() WHERE id=$3`,
    [apiKey, apiSecret, partnerId]);
  await logAudit(adminId, 'PARTNER_APPROVED', `Partner #${partnerId} limeheshimiwa`).catch(() => {});
  return { partner_id: partnerId, api_key: apiKey, api_secret: apiSecret, status: 'ACTIVE', message: 'API Secret hurejeshwa mara moja tu.' };
}

function stripSecret(partner) {
  return { ...partner, api_secret: partner.api_secret ? 'MASKED' : null };
}

async function listPartners(adminId) {
  const res = await pool.query(
    `SELECT p.id, p.name, p.contact_email, p.phone, p.country, p.status,
            p.balance, p.monthly_volume, p.webhook_url, p.api_secret, p.created_at,
            COUNT(pt.id)::int AS txns
     FROM partners p LEFT JOIN partner_transactions pt ON pt.partner_id = p.id
     GROUP BY p.id ORDER BY p.created_at DESC`
  );
  return res.rows.map(stripSecret);
}

async function setPartnerSuspended(adminId, partnerId, suspended) {
  const status = suspended ? 'SUSPENDED' : 'ACTIVE';
  const r = await pool.query('UPDATE partners SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING status', [status, partnerId]);
  if (!r.rows.length) throw badge('Partner hapatikani.', 404);
  await logAudit(adminId, 'PARTNER_SUSPEND_STATE', `Partner #${partnerId} -> ${status}`).catch(() => {});
  return { partner_id: partnerId, status };
}

// ====================================================================
// K2: FUNDING (admin book transfer)
// ====================================================================

async function fundPartner(adminId, partnerId, amount) {
  const amountNum = Number(amount);
  if (!isFinite(amountNum) || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);
  const ref = generateReference('PF');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT * FROM partners WHERE id=$1 FOR UPDATE', [partnerId]);
    if (!p.rows.length) throw badge('Partner hapatikani.', 404);
    await client.query('UPDATE partners SET balance = balance + $1, updated_at=NOW() WHERE id=$2', [amountNum, partnerId]);
    await fin.postJournal({
      client,
      lines: [
        { accountCode: 'SUSPENSE', direction: 'DR', amount: amountNum },
        { accountCode: 'PARTNER_BALANCE', direction: 'CR', amount: amountNum }
      ],
      referenceId: `${ref}:FND`,
      description: `Partner funding: ${p.rows[0].name}`
    });
    await logPartnerTxn(partnerId, 'FUNDING', amountNum, ref, null, null, 'COMPLETED', client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await logAudit(adminId, 'PARTNER_FUNDING', `Partner #${partnerId} +${formatMoney(amountNum)}`).catch(() => {});
  const after = await pool.query('SELECT balance FROM partners WHERE id=$1', [partnerId]);
  return { partner_id: partnerId, reference: ref, balance: Number(after.rows[0].balance) };
}

// ====================================================================
// K3-K4: SIGNED PAYOUT RAILS (idempotent)
// ====================================================================

async function processPayout(partner, payload) {
  const { phone, amount, request_id } = payload || {};
  if (!phone) throw badge('Namba ya simu ya mteja ni lazima.', 400);
  const amountNum = Number(amount);
  if (!isFinite(amountNum) || amountNum <= 0) throw badge('Kiasi si sahihi.', 400);
  if (!request_id) throw badge('request_id (idempotency) ni lazima.', 400);

  const dup = await pool.query(
    'SELECT reference FROM partner_transactions WHERE partner_id=$1 AND request_id=$2',
    [partner.id, request_id]
  );
  if (dup.rows.length) {
    const bal = await pool.query('SELECT balance FROM partners WHERE id=$1', [partner.id]);
    return { success: true, duplicate: true, reference: dup.rows[0].reference, partner_balance: Number(bal.rows[0].balance), message: 'Ombi lilishatolewa (idempotent).' };
  }

  const p = await pool.query('SELECT * FROM partners WHERE id=$1 FOR UPDATE', [partner.id]);
  if (Number(p.rows[0].balance) < amountNum) {
    const ref = generateReference('BPF');
    await logPartnerTxn(partner.id, 'FAILED', amountNum, ref, request_id, phone, 'FAILED');
    throw badge('Salio la partner halitoshi.', 400);
  }

  const reference = generateReference('BP');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT id, wallet_balance FROM users WHERE phone_number=$1 FOR UPDATE', [phone]);
    if (!u.rows.length) {
      await client.query('ROLLBACK');
      throw badge('Mteja hapatikani kwenye mfumo.', 404);
    }
    await client.query('UPDATE partners SET balance = balance - $1, monthly_volume = monthly_volume + $1, updated_at=NOW() WHERE id=$2', [amountNum, partner.id]);
    await fin.creditWallet({
      client,
      userId: u.rows[0].id,
      amount: Number(amountNum),
      reference: `BP:${request_id}:CR`,
      fromAccount: 'PARTNER_BALANCE',
      description: `Partner payout ${reference}`,
    });
    await logTx(client, u.rows[0].id, amountNum, 'PARTNER_PAYOUT', { partner_id: partner.id, partner_name: partner.name, reference });
    await logPartnerTxn(partner.id, 'PAYOUT', amountNum, reference, request_id, phone, 'COMPLETED');
    const after = await client.query('SELECT balance, monthly_volume FROM partners WHERE id=$1', [partner.id]);
    await client.query('COMMIT');
    const web = partner.webhook_url ? await deliverWebhook(partner, 'PAYOUT_SETTLED', {
      event: 'PAYOUT_SETTLED', reference, phone, amount: amountNum, partner_id: partner.id, created_at: new Date().toISOString(),
    }) : null;
    return {
      success: true, duplicate: false, reference, phone, amount: amountNum,
      partner_balance: Number(after.rows[0].balance), monthly_volume: Number(after.rows[0].monthly_volume),
      webhook: web ? { delivered: web.delivered.status, response_status: web.delivered.response_status } : null,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ====================================================================
// K6: STATEMENT & SUMMARY
// ====================================================================

async function partnerStatement(partnerId) {
  const res = await pool.query(
    `SELECT type, amount, reference, request_id, phone, status, created_at
     FROM partner_transactions WHERE partner_id=$1 ORDER BY created_at DESC`,
    [partnerId]
  );
  return res.rows;
}

async function partnerSummary(partnerId) {
  const p = await pool.query('SELECT balance, monthly_volume, status FROM partners WHERE id=$1', [partnerId]);
  if (!p.rows.length) throw badge('Partner hapatikani.', 404);
  const agg = await pool.query(
    `SELECT COUNT(*)::int AS payouts,
            COUNT(*) FILTER (WHERE status='FAILED')::int AS failed,
            COALESCE(SUM(amount) FILTER (WHERE type='PAYOUT' AND status='COMPLETED'),0)::numeric AS payout_volume
     FROM partner_transactions WHERE partner_id=$1`,
    [partnerId]
  );
  return {
    balance: Number(p.rows[0].balance),
    monthly_volume: Number(p.rows[0].monthly_volume),
    status: p.rows[0].status,
    payouts: Number(agg.rows[0].payouts),
    failed_payouts: Number(agg.rows[0].failed),
    payout_volume: Number(agg.rows[0].payout_volume),
  };
}

async function partnerWebhooks(adminId, partnerId) {
  const res = await pool.query(
    `SELECT id, event, payload, status, request_ts, request_signature, request_body, response_status, attempts, delivered_at
     FROM partner_webhooks WHERE partner_id=$1 ORDER BY created_at DESC`,
    [partnerId]
  );
  return res.rows;
}

module.exports = {
  computeSignature,
  applyPartner,
  approvePartner,
  listPartners,
  setPartnerSuspended,
  fundPartner,
  processPayout,
  partnerStatement,
  partnerSummary,
  partnerWebhooks,
};