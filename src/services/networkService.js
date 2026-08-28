const pool = require('../config/db');
const config = require('../config');
const { sendSMS } = require('./smsService');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');

// ====================================================================
// F1: AGENT NETWORK (cash-in / cash-out agents)
// ====================================================================

async function applyAgent(userId, data) {
  const { business_name, owner_name, phone, email, region, district, ward, latitude, longitude } = data;
  if (!business_name || !owner_name || !phone) {
    throw Object.assign(new Error('Jina la biashara, mmiliki na simu ni lazima.'), { statusCode: 400 });
  }
  const code = generateReference('AG').replace('AG-', 'AG');
  const res = await pool.query(
    `INSERT INTO agents (user_id, agent_code, business_name, owner_name, phone, email, region, district, ward, latitude, longitude, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING') RETURNING *`,
    [userId, code, business_name, owner_name, phone, email || null, region || null, district || null, ward || null, latitude || null, longitude || null]
  );
  return res.rows[0];
}

async function listAgents(filters = {}) {
  const where = [];
  const params = [];
  let i = 1;
  if (filters.status) { where.push(`status = $${i++}`); params.push(filters.status); }
  if (filters.region) { where.push(`region = $${i++}`); params.push(filters.region); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await pool.query(
    `SELECT id, agent_code, business_name, owner_name, region, district, ward, status, tier, commission_rate, balance FROM agents ${w} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  return res.rows;
}

async function getAgentByUser(userId) {
  const res = await pool.query('SELECT * FROM agents WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

async function getNearbyAgents(lat, lng, radiusKm = 10) {
  const res = await pool.query(
    `SELECT * FROM (
       SELECT id, agent_code, business_name, owner_name, region, district, ward, latitude, longitude,
              (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * cos(radians(longitude) - radians($2)) + sin(radians($1)) * sin(radians(latitude)))) AS distance_km
       FROM agents WHERE status = 'ACTIVE' AND latitude IS NOT NULL AND longitude IS NOT NULL
     ) sub
     WHERE distance_km < $3
     ORDER BY distance_km ASC LIMIT 20`,
    [lat, lng, radiusKm]
  );
  return res.rows;
}

async function verifyAgent(agentId, adminId) {
  const res = await pool.query(
    `UPDATE agents SET status = 'ACTIVE', verified_by = $2, verified_at = NOW() WHERE id = $1 RETURNING *`,
    [agentId, adminId]
  );
  return res.rows[0];
}

async function agentCashIn(agentId, customerPhone, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const agentRes = await pool.query('SELECT * FROM agents WHERE id = $1 FOR UPDATE', [agentId]);
  if (!agentRes.rows.length) throw Object.assign(new Error('Wakala hajapatikana.'), { statusCode: 404 });
  const agent = agentRes.rows[0];
  if (agent.status !== 'ACTIVE') throw Object.assign(new Error('Wakala haipo active.'), { statusCode: 400 });
  if (Number(agent.balance) < amountNum) throw Object.assign(new Error('Wakala hana fedha za kutosha (float).'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const custRes = await client.query('SELECT id, wallet_balance, full_name, phone_number FROM users WHERE phone_number = $1 FOR UPDATE', [customerPhone.trim()]);
    if (!custRes.rows.length) throw Object.assign(new Error('Mteja hajapatikana.'), { statusCode: 404 });
    const cust = custRes.rows[0];
    const commission = (amountNum * Number(agent.commission_rate)) / 100;
    const reference = generateReference('CI');
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS','CASH_IN', $4)`,
      [reference, cust.id, amountNum, JSON.stringify({ agent_id: agentId, agent_code: agent.agent_code })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amountNum, cust.id]);
    await client.query('UPDATE agents SET balance = balance - $1 WHERE id = $2', [amountNum, agent.id]);
    await client.query(
      `INSERT INTO agent_transactions (agent_id, customer_phone, type, amount, commission, reference, status)
       VALUES ($1,$2,'CASH_IN',$3,$4,$5,'SUCCESS')`,
      [agentId, customerPhone, amountNum, commission, reference]
    );
    await client.query('COMMIT');
    await sendSMS(cust.phone_number, `Umepokea TZS ${formatMoney(amountNum)} kwenye Pochi yako kupitia wakala ${agent.business_name}. Ref: ${reference}`).catch(() => {});
    return { success: true, reference, amount: amountNum, commission, new_customer_balance: Number(cust.wallet_balance) + amountNum };
  } finally { client.release(); }
}

async function agentCashOut(agentId, customerPhone, amount) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  const agentRes = await pool.query('SELECT * FROM agents WHERE id = $1 FOR UPDATE', [agentId]);
  if (!agentRes.rows.length) throw Object.assign(new Error('Wakala hajapatikana.'), { statusCode: 404 });
  const agent = agentRes.rows[0];
  if (agent.status !== 'ACTIVE') throw Object.assign(new Error('Wakala haipo active.'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const custRes = await client.query('SELECT id, wallet_balance, full_name, phone_number FROM users WHERE phone_number = $1 FOR UPDATE', [customerPhone.trim()]);
    if (!custRes.rows.length) throw Object.assign(new Error('Mteja hajapatikana.'), { statusCode: 404 });
    const cust = custRes.rows[0];
    if (Number(cust.wallet_balance) < amountNum) throw Object.assign(new Error('Salio la mteja halitoshi.'), { statusCode: 400 });
    const commission = (amountNum * Number(agent.commission_rate)) / 100;
    const reference = generateReference('CO');
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,0,$3,'SUCCESS','CASH_OUT', $4)`,
      [reference, cust.id, amountNum, JSON.stringify({ agent_id: agentId, agent_code: agent.agent_code })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountNum, cust.id]);
    await client.query('UPDATE agents SET balance = balance + $1 WHERE id = $2', [amountNum, agent.id]);
    await client.query(
      `INSERT INTO agent_transactions (agent_id, customer_phone, type, amount, commission, reference, status)
       VALUES ($1,$2,'CASH_OUT',$3,$4,$5,'SUCCESS')`,
      [agentId, customerPhone, amountNum, commission, reference]
    );
    await client.query('COMMIT');
    await sendSMS(cust.phone_number, `Umetoa TZS ${formatMoney(amountNum)} kutoka Pochi yako kupitia wakala ${agent.business_name}. Ref: ${reference}`).catch(() => {});
    return { success: true, reference, amount: amountNum, commission, new_customer_balance: Number(cust.wallet_balance) - amountNum };
  } finally { client.release(); }
}

async function agentSettlement(agentId, amount, type) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  if (!['DEPOSIT', 'WITHDRAWAL'].includes(type)) throw Object.assign(new Error('Aina ya settlement si sahihi.'), { statusCode: 400 });
  const reference = generateReference('AS');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (type === 'DEPOSIT') {
      await client.query('UPDATE agents SET balance = balance + $1 WHERE id = $2', [amountNum, agentId]);
    } else {
      const a = await client.query('SELECT balance FROM agents WHERE id = $1 FOR UPDATE', [agentId]);
      if (Number(a.rows[0].balance) < amountNum) throw Object.assign(new Error('Wakala hana balance ya kutosha.'), { statusCode: 400 });
      await client.query('UPDATE agents SET balance = balance - $1 WHERE id = $2', [amountNum, agentId]);
    }
    await client.query(
      `INSERT INTO agent_settlements (agent_id, amount, type, reference, status) VALUES ($1,$2,$3,$4,'PENDING') RETURNING *`,
      [agentId, amountNum, type, reference]
    );
    await client.query('COMMIT');
    return { success: true, reference };
  } finally { client.release(); }
}

async function agentDashboard(agentId) {
  const agent = await pool.query('SELECT * FROM agents WHERE id = $1', [agentId]);
  const stats = await pool.query(
    `SELECT type, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total, COALESCE(SUM(commission),0) AS commission
     FROM agent_transactions WHERE agent_id = $1 GROUP BY type`,
    [agentId]
  );
  return { agent: agent.rows[0], stats: stats.rows };
}

// ====================================================================
// F2: BULK PAYMENTS (payroll, disbursements)
// ====================================================================

async function createBulkBatch(userId, data) {
  const { batch_name, recipients, description, file_name } = data;
  if (!batch_name) throw Object.assign(new Error('Jina la batch ni lazima.'), { statusCode: 400 });
  if (!Array.isArray(recipients) || recipients.length === 0) throw Object.assign(new Error('Orodha ya wapokeaji inahitajika.'), { statusCode: 400 });
  const total = recipients.reduce((s, r) => s + Number(r.amount || 0), 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batch = await client.query(
      `INSERT INTO bulk_payment_batches (user_id, batch_name, total_amount, recipient_count, status, file_name, description)
       VALUES ($1,$2,$3,$4,'PENDING',$5,$6) RETURNING *`,
      [userId, batch_name, total, recipients.length, file_name || null, description || null]
    );
    for (const r of recipients) {
      await client.query(
        `INSERT INTO bulk_payment_items (batch_id, recipient_phone, recipient_name, amount, status)
         VALUES ($1,$2,$3,$4,'PENDING')`,
        [batch.rows[0].id, r.phone, r.name || null, Number(r.amount)]
      );
    }
    await client.query('COMMIT');
    return batch.rows[0];
  } finally { client.release(); }
}

async function getBulkBatch(batchId, userId) {
  const batch = await pool.query('SELECT * FROM bulk_payment_batches WHERE id = $1 AND user_id = $2', [batchId, userId]);
  if (!batch.rows.length) throw Object.assign(new Error('Batch hajapatikana.'), { statusCode: 404 });
  const items = await pool.query('SELECT * FROM bulk_payment_items WHERE batch_id = $1', [batchId]);
  return { ...batch.rows[0], items: items.rows };
}

async function processBulkBatch(batchId) {
  const batch = await pool.query('SELECT * FROM bulk_payment_batches WHERE id = $1', [batchId]);
  if (!batch.rows.length) throw Object.assign(new Error('Batch hajapatikana.'), { statusCode: 404 });
  const b = batch.rows[0];
  if (b.status === 'COMPLETED') return { message: 'Batch tayari imechakatwa.' };
  const items = await pool.query('SELECT * FROM bulk_payment_items WHERE batch_id = $1 AND status = $2', [batchId, 'PENDING']);
  let success = 0, failed = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE bulk_payment_batches SET status = 'PROCESSING' WHERE id = $1", [batchId]);
    for (const item of items.rows) {
      try {
        const sender = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [b.user_id]);
        const recipient = await client.query('SELECT id, wallet_balance FROM users WHERE phone_number = $1', [item.recipient_phone.trim()]);
        if (!recipient.rows.length) throw new Error('Mpokeaji hajapatikana');
        if (Number(sender.rows[0].wallet_balance) < Number(item.amount)) throw new Error('Salio halitoshi');
        const reference = generateReference('BP');
        await client.query(
          `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
           VALUES ($1,$2,$3,0,$3,'SUCCESS','BULK_PAYMENT', $4)`,
          [reference, b.user_id, item.amount, JSON.stringify({ recipient: item.recipient_phone, batch_id: batchId })]
        );
        await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [item.amount, b.user_id]);
        await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [item.amount, recipient.rows[0].id]);
        await client.query("UPDATE bulk_payment_items SET status = 'SUCCESS', transaction_id = (SELECT id FROM transactions WHERE reference_id = $1) WHERE id = $2", [reference, item.id]);
        success++;
      } catch (e) {
        await client.query('UPDATE bulk_payment_items SET status = $1, failure_reason = $2 WHERE id = $3', ['FAILED', e.message, item.id]);
        failed++;
      }
    }
    await client.query("UPDATE bulk_payment_batches SET status = 'COMPLETED', completed_at = NOW() WHERE id = $1", [batchId]);
    await client.query('COMMIT');
    return { success, failed, message: 'Batch imechakatwa.' };
  } finally { client.release(); }
}

async function listUserBatches(userId) {
  const res = await pool.query('SELECT id, batch_name, total_amount, recipient_count, status, created_at FROM bulk_payment_batches WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return res.rows;
}

// ====================================================================
// F3: SCHEDULED PAYMENTS
// ====================================================================

async function createScheduledPayment(userId, data) {
  const { recipient_phone, amount, type, description, scheduled_for, recurrence } = data;
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  if (!scheduled_for) throw Object.assign(new Error('Tarehe ya kulipa ni lazima.'), { statusCode: 400 });
  const res = await pool.query(
    `INSERT INTO scheduled_payments (user_id, recipient_phone, amount, type, description, scheduled_for, recurrence, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE') RETURNING *`,
    [userId, recipient_phone || null, amountNum, type || 'TRANSFER', description || null, scheduled_for, recurrence || 'ONCE']
  );
  return res.rows[0];
}

async function listScheduledPayments(userId) {
  const res = await pool.query('SELECT * FROM scheduled_payments WHERE user_id = $1 ORDER BY scheduled_for ASC', [userId]);
  return res.rows;
}

async function cancelScheduledPayment(id, userId) {
  const res = await pool.query("UPDATE scheduled_payments SET status = 'CANCELLED' WHERE id = $1 AND user_id = $2 RETURNING *", [id, userId]);
  if (!res.rows.length) throw Object.assign(new Error('Malipo yaliyopangwa hayapatikani.'), { statusCode: 404 });
  return res.rows[0];
}

async function processDueScheduledPayments() {
  const due = await pool.query(
    `SELECT * FROM scheduled_payments WHERE status = 'ACTIVE' AND scheduled_for <= NOW()`,
    []
  );
  let processed = 0;
  for (const sp of due.rows) {
    try {
      if (sp.type === 'TRANSFER' && sp.recipient_phone) {
        await require('./walletService').transferWallet(sp.user_id, sp.recipient_phone, sp.amount, sp.description || 'Malipo yaliyopangwa');
      }
      const next = computeNextExecution(sp);
      await pool.query(
        `UPDATE scheduled_payments SET last_executed = NOW(), ${next ? 'next_execution = $1, scheduled_for = $1, recurrence = $2' : "status = 'COMPLETED'"} WHERE id = $3`,
        next ? [next, sp.recurrence, sp.id] : [sp.id]
      );
      processed++;
    } catch (e) {
      await pool.query("UPDATE scheduled_payments SET status = 'FAILED' WHERE id = $1", [sp.id]);
      logger.error('SCHEDULED', `Imefeli: ${e.message}`);
    }
  }
  return { processed };
}

function computeNextExecution(sp) {
  if (!sp.recurrence || sp.recurrence === 'ONCE') return null;
  const base = sp.scheduled_for ? new Date(sp.scheduled_for) : new Date();
  if (sp.recurrence === 'DAILY') base.setDate(base.getDate() + 1);
  else if (sp.recurrence === 'WEEKLY') base.setDate(base.getDate() + 7);
  else if (sp.recurrence === 'MONTHLY') base.setMonth(base.getMonth() + 1);
  return base;
}

// ====================================================================
// F4: CROSS-BORDER REMITTANCES
// ====================================================================

async function listCorridors() {
  await ensureCorridors();
  const res = await pool.query('SELECT * FROM remittance_corridors WHERE is_active = TRUE ORDER BY from_country, to_country');
  return res.rows;
}

async function ensureCorridors() {
  const count = await pool.query('SELECT COUNT(*) AS c FROM remittance_corridors');
  if (Number(count.rows[0].c) === 0) {
    await pool.query(
      `INSERT INTO remittance_corridors (from_country, to_country, from_currency, to_currency, exchange_rate, fee_percentage, min_amount, max_amount) VALUES
       ('TZ','KE','TZS','KES',0.042,2.5,1000,5000000),
       ('TZ','UG','TZS','UGX',1.25,2.5,1000,5000000),
       ('TZ','RW','TZS','RWF',0.42,3.0,1000,5000000),
       ('TZ','BI','TZS','BIF',0.85,3.0,1000,5000000),
       ('KE','TZ','KES','TZS',23.8,2.5,100,200000),
       ('UG','TZ','UGX','TZS',0.80,2.5,100,200000)`,
      []
    );
  }
}

async function sendRemittance(senderId, data) {
  await ensureCorridors();
  const { recipient_phone, recipient_name, recipient_country, from_amount } = data;
  const amountNum = Number(from_amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });
  if (!recipient_phone || !recipient_name || !recipient_country) throw Object.assign(new Error('Maelezo ya mpokeaji ni lazima.'), { statusCode: 400 });
  const corridor = await pool.query('SELECT * FROM remittance_corridors WHERE from_country = $1 AND to_country = $2 AND is_active = TRUE', ['TZ', recipient_country]);
  if (!corridor.rows.length) throw Object.assign(new Error('Korido haipo.'), { statusCode: 400 });
  const c = corridor.rows[0];
  if (amountNum < Number(c.min_amount) || amountNum > Number(c.max_amount)) throw Object.assign(new Error('Kiasi kiko nje ya mipaka.'), { statusCode: 400 });
  const fee = (amountNum * Number(c.fee_percentage)) / 100;
  const toAmount = (amountNum - fee) * Number(c.exchange_rate);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sender = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [senderId]);
    if (Number(sender.rows[0].wallet_balance) < amountNum + fee) throw Object.assign(new Error('Salio halitoshi (pamoja na ada).'), { statusCode: 400 });
    const reference = generateReference('RM');
    const pickup = Math.random().toString(36).toUpperCase().slice(2, 8);
    await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1,$2,$3,$4,$5,'SUCCESS','REMITTANCE', $6)`,
      [reference, senderId, amountNum, fee, amountNum + fee, JSON.stringify({ recipient_phone, recipient_country, to_amount: toAmount })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amountNum + fee, senderId]);
    await client.query(
      `INSERT INTO remittance_transfers (sender_id, recipient_phone, recipient_name, recipient_country, from_amount, to_amount, exchange_rate, fee, reference, status, pickup_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'COMPLETED',$10) RETURNING *`,
      [senderId, recipient_phone, recipient_name, recipient_country, amountNum, toAmount, c.exchange_rate, fee, reference, pickup]
    );
    await client.query('COMMIT');
    return { success: true, reference, pickup_code: pickup, to_amount: toAmount, fee, message: 'Fedha zimetumwa. Mpokeaji atatumiwa pickup code.' };
  } finally { client.release(); }
}

async function pickupRemittance(pickupCode, recipientPhone, recipientName) {
  const res = await pool.query('SELECT * FROM remittance_transfers WHERE pickup_code = $1 AND recipient_phone = $2 AND status = $3', [pickupCode, recipientPhone, 'COMPLETED']);
  if (!res.rows.length) throw Object.assign(new Error('Uhamisho haujapatikana au tayari umechukuliwa.'), { statusCode: 404 });
  const r = res.rows[0];
  if (r.recipient_name.toLowerCase() !== String(recipientName).toLowerCase()) throw Object.assign(new Error('Jina la mpokeaji halilingani.'), { statusCode: 400 });
  await pool.query("UPDATE remittance_transfers SET status = 'PICKED_UP', completed_at = NOW() WHERE id = $1", [r.id]);
  return { success: true, amount: r.to_amount, currency: r.recipient_country === 'KE' ? 'KES' : r.recipient_country === 'UG' ? 'UGX' : r.recipient_country === 'RW' ? 'RWF' : 'BIF', message: 'Fedha zimechukuliwa.' };
}

async function getRemittanceHistory(userId) {
  const res = await pool.query('SELECT * FROM remittance_transfers WHERE sender_id = $1 ORDER BY created_at DESC', [userId]);
  return res.rows;
}

// ====================================================================
// F5: WEBHOOK SUBSCRIPTIONS (developer ecosystem)
// ====================================================================

const crypto = require('crypto');

async function createWebhook(userId, data) {
  const { url, events } = data;
  if (!url || !Array.isArray(events) || events.length === 0) throw Object.assign(new Error('URL na matukio ni lazima.'), { statusCode: 400 });
  const secret = crypto.randomBytes(32).toString('hex');
  const res = await pool.query(
    `INSERT INTO webhook_subscriptions (user_id, url, events, secret, is_active) VALUES ($1,$2,$3,$4,TRUE) RETURNING id, url, events, is_active, created_at`,
    [userId, url, events, secret]
  );
  return res.rows[0];
}

async function listWebhooks(userId) {
  const res = await pool.query('SELECT id, url, events, is_active, last_triggered, failure_count, created_at FROM webhook_subscriptions WHERE user_id = $1', [userId]);
  return res.rows;
}

async function triggerWebhookEvent(eventType, payload) {
  const subs = await pool.query('SELECT * FROM webhook_subscriptions WHERE is_active = TRUE AND $1 = ANY(events)', [eventType]);
  for (const sub of subs.rows) {
    const body = JSON.stringify({ event: eventType, data: payload, timestamp: new Date().toISOString() });
    const signature = crypto.createHmac('sha256', sub.secret).update(body).digest('hex');
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(sub.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Afrikoba-Signature': `sha256=${signature}`, 'X-Afrikoba-Event': eventType },
        body,
        signal: ctrl.signal
      });
      clearTimeout(timeout);
      await pool.query(
        `INSERT INTO webhook_deliveries (subscription_id, event_type, payload, status_code, attempts, delivered_at) VALUES ($1,$2,$3,$4,1,NOW())`,
        [sub.id, eventType, payload, resp.status]
      );
      await pool.query('UPDATE webhook_subscriptions SET last_triggered = NOW(), failure_count = 0 WHERE id = $1', [sub.id]);
    } catch (e) {
      await pool.query(
        `INSERT INTO webhook_deliveries (subscription_id, event_type, payload, attempts) VALUES ($1,$2,$3,1)`,
        [sub.id, eventType, payload]
      );
      await pool.query('UPDATE webhook_subscriptions SET failure_count = failure_count + 1 WHERE id = $1', [sub.id]);
    }
  }
  return { delivered: subs.rows.length };
}

async function testWebhook(subId, userId) {
  const sub = await pool.query('SELECT * FROM webhook_subscriptions WHERE id = $1 AND user_id = $2', [subId, userId]);
  if (!sub.rows.length) throw Object.assign(new Error('Webhook hajapatikana.'), { statusCode: 404 });
  return triggerWebhookEvent('test.ping', { message: 'Test ping', subscription_id: subId });
}

async function getWebhookDeliveries(subId, userId) {
  const sub = await pool.query('SELECT id FROM webhook_subscriptions WHERE id = $1 AND user_id = $2', [subId, userId]);
  if (!sub.rows.length) throw Object.assign(new Error('Webhook hajapatikana.'), { statusCode: 404 });
  const res = await pool.query('SELECT * FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 50', [subId]);
  return res.rows;
}

// ====================================================================
// F6: MERCHANT LOYALTY
// ====================================================================

async function createLoyaltyProgram(merchantId, data) {
  const { name, points_per_currency, redemption_rate } = data;
  if (!name) throw Object.assign(new Error('Jina la program ni lazima.'), { statusCode: 400 });
  const res = await pool.query(
    `INSERT INTO merchant_loyalty_programs (merchant_id, name, points_per_currency, redemption_rate, is_active) VALUES ($1,$2,$3,$4,TRUE) RETURNING *`,
    [merchantId, name, points_per_currency || 1.0, redemption_rate || 100.0]
  );
  return res.rows[0];
}

async function joinLoyaltyProgram(programId, userId) {
  const res = await pool.query(
    `INSERT INTO merchant_loyalty_accounts (program_id, user_id, points, total_earned, total_redeemed) VALUES ($1,$2,0,0,0)
     ON CONFLICT (program_id, user_id) DO NOTHING RETURNING *`,
    [programId, userId]
  );
  return res.rows[0] || { message: 'Tayari ni mwanachama.' };
}

async function earnLoyaltyPoints(programId, userId, amountSpent) {
  const prog = await pool.query('SELECT * FROM merchant_loyalty_programs WHERE id = $1', [programId]);
  if (!prog.rows.length) throw Object.assign(new Error('Program hajapatikana.'), { statusCode: 404 });
  const points = Math.floor(Number(amountSpent) * Number(prog.rows[0].points_per_currency));
  const res = await pool.query(
    `UPDATE merchant_loyalty_accounts SET points = points + $1, total_earned = total_earned + $1 WHERE program_id = $2 AND user_id = $3 RETURNING *`,
    [points, programId, userId]
  );
  if (!res.rows.length) throw Object.assign(new Error('Hujajiunga na program hii.'), { statusCode: 400 });
  return { points_earned: points, account: res.rows[0] };
}

async function redeemLoyaltyPoints(programId, userId, points) {
  const prog = await pool.query('SELECT * FROM merchant_loyalty_programs WHERE id = $1', [programId]);
  if (!prog.rows.length) throw Object.assign(new Error('Program hajapatikana.'), { statusCode: 404 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const acc = await client.query('SELECT * FROM merchant_loyalty_accounts WHERE program_id = $1 AND user_id = $2 FOR UPDATE', [programId, userId]);
    if (!acc.rows.length) throw Object.assign(new Error('Hujajiunga na program hii.'), { statusCode: 400 });
    if (Number(acc.rows[0].points) < points) throw Object.assign(new Error('Pointi hazotoshi.'), { statusCode: 400 });
    const value = (points / Number(prog.rows[0].redemption_rate)) * 100;
    await client.query('UPDATE merchant_loyalty_accounts SET points = points - $1, total_redeemed = total_redeemed + $1 WHERE program_id = $2 AND user_id = $3', [points, programId, userId]);
    await client.query('COMMIT');
    return { points_redeemed: points, value: value, message: 'Pointi zimeredeemwa.' };
  } finally { client.release(); }
}

async function getLoyaltyBalance(programId, userId) {
  const res = await pool.query('SELECT points, total_earned, total_redeemed FROM merchant_loyalty_accounts WHERE program_id = $1 AND user_id = $2', [programId, userId]);
  return res.rows[0] || { points: 0, total_earned: 0, total_redeemed: 0 };
}

// ====================================================================
// F7: AI SPENDING INSIGHTS
// ====================================================================

async function generateSpendingPrediction(userId) {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const res = await pool.query(
    `SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, SUM(total_charged) AS total
     FROM transactions WHERE user_id = $1 AND status = 'SUCCESS' AND created_at >= $2
     GROUP BY TO_CHAR(created_at, 'YYYY-MM') ORDER BY month ASC`,
    [userId, sixMonthsAgo]
  );
  const points = res.rows.map(r => Number(r.total));
  let prediction = 0;
  if (points.length >= 2) {
    const n = points.length;
    const meanX = (n - 1) / 2;
    const meanY = points.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - meanX) * (points[i] - meanY); den += (i - meanX) ** 2; }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;
    prediction = Math.max(0, Math.round(intercept + slope * n));
  } else if (points.length === 1) {
    prediction = points[0];
  }
  const month = new Date();
  month.setMonth(month.getMonth() + 1);
  const monthStr = month.toISOString().slice(0, 7);
  await pool.query('DELETE FROM spending_predictions WHERE user_id = $1 AND month = $2', [userId, monthStr]);
  await pool.query(
    `INSERT INTO spending_predictions (user_id, month, predicted_amount, confidence, model_version) VALUES ($1,$2,$3,0.8,'1.0')`,
    [userId, monthStr, prediction]
  );
  return { month: monthStr, predicted_amount: prediction, confidence: 0.8 };
}

async function getInsights(userId) {
  await generateSpendingPrediction(userId);
  const pred = await pool.query('SELECT * FROM spending_predictions WHERE user_id = $1 ORDER BY month DESC LIMIT 3', [userId]);
  const cats = await pool.query(
    `SELECT meta->>'category' AS category, SUM(total_charged) AS total FROM transactions
     WHERE user_id = $1 AND status = 'SUCCESS' AND meta ? 'category' GROUP BY meta->>'category' ORDER BY total DESC LIMIT 5`,
    [userId]
  );
  const tips = [];
  if (cats.rows.length) tips.push(`Unatumia zaidi kwenye: ${cats.rows[0].category} (TZS ${formatMoney(Number(cats.rows[0].total))}). Fikiria bajeti.`);
  tips.push('Weka malipo yako ya bills kiotomatiki kwa Scheduled Payments ili usikose tarehe.');
  tips.push('Tumia Agent karibu nawe kupata pesa taslimu bila gharama kubwa.');
  return { predictions: pred.rows, top_categories: cats.rows, tips };
}

// ====================================================================
// F8: ENHANCED REFERRAL PROGRAM
// ====================================================================

async function getReferralTiers() {
  const res = await pool.query('SELECT * FROM referral_tiers WHERE is_active = TRUE ORDER BY min_referrals ASC');
  return res.rows;
}

async function getUserReferralCode(userId) {
  const res = await pool.query('SELECT id, phone_number, full_name FROM users WHERE id = $1', [userId]);
  if (!res.rows.length) throw Object.assign(new Error('Mtumiaji hajapatikana.'), { statusCode: 404 });
  const code = `AFK${(1000 + userId).toString().padStart(5, '0')}`;
  return { referral_code: code, share_link: `https://afrikoba.com/join?ref=${code}` };
}

async function awardReferral(referrerId, referredId) {
  const existing = await pool.query('SELECT id FROM referral_rewards WHERE referrer_id = $1 AND referred_id = $2', [referrerId, referredId]);
  if (existing.rows.length) return { message: 'Tayari imetolewa.' };
  const count = await pool.query('SELECT COUNT(*) AS c FROM referral_rewards WHERE referrer_id = $1', [referrerId]);
  const tier = await pool.query('SELECT * FROM referral_tiers WHERE is_active = TRUE AND min_referrals <= $1 ORDER BY min_referrals DESC LIMIT 1', [Number(count.rows[0].c)]);
  const reward = tier.rows.length ? Number(tier.rows[0].reward_per_referral) : 1000;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO referral_rewards (referrer_id, referred_id, tier_name, reward_amount, status) VALUES ($1,$2,$3,$4,'PENDING')`,
      [referrerId, referredId, tier.rows.length ? tier.rows[0].name : 'Starter', reward]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [reward, referrerId]);
    await client.query('COMMIT');
    await logAudit({ eventType: 'REFERRAL_REWARD', action: 'CREATE', entityType: 'REFERRAL', userId: referrerId, afterData: { referred_id: referredId, reward } });
    return { success: true, reward, tier: tier.rows.length ? tier.rows[0].name : 'Starter' };
  } finally { client.release(); }
}

async function getReferralStats(userId) {
  const stats = await pool.query('SELECT COUNT(*) AS total, COALESCE(SUM(reward_amount),0) AS total_earned FROM referral_rewards WHERE referrer_id = $1', [userId]);
  const code = await getUserReferralCode(userId);
  return { ...stats.rows[0], ...code };
}

module.exports = {
  applyAgent, listAgents, getAgentByUser, getNearbyAgents, verifyAgent, agentCashIn, agentCashOut, agentSettlement, agentDashboard,
  createBulkBatch, getBulkBatch, processBulkBatch, listUserBatches,
  createScheduledPayment, listScheduledPayments, cancelScheduledPayment, processDueScheduledPayments,
  listCorridors, sendRemittance, pickupRemittance, getRemittanceHistory,
  createWebhook, listWebhooks, triggerWebhookEvent, testWebhook, getWebhookDeliveries,
  createLoyaltyProgram, joinLoyaltyProgram, earnLoyaltyPoints, redeemLoyaltyPoints, getLoyaltyBalance,
  generateSpendingPrediction, getInsights,
  getReferralTiers, getUserReferralCode, awardReferral, getReferralStats
};
