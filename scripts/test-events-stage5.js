/* ============================================================
 * AFRIKOBA GLOBAL - SOCIAL EVENTS STAGE 5 REGRESSION
 * Reminders & deadlines: member-wide upcoming sweep,
 * contribution-deadline nudges (DEADLINE), /reminders/mine panel,
 * idempotence/dedup, and OVERDUE commitment flagging.
 * ============================================================ */
const BASE = process.env.EVENTS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const eventService = require('../src/services/eventService');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}

function nowSuffix() { return String(Date.now()).slice(-6); }
function utcToday() { return new Date().toISOString().slice(0, 10); }
function addDaysUtc(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'DEPOSIT', $4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'events-stage5-funding' })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [tx.rows[0].id, ref, userId, amount, 'Test funding']
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function balanceOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}

(async () => {
  const suffix = nowSuffix();
  const today = utcToday();
  const eventDate = addDaysUtc(today, 2);
  const deadline = addDaysUtc(today, 1);

  const ownerPhone = `255735${suffix}`;
  const alicePhone = `255736${suffix}`;

  const owner = await register(ownerPhone, 'Remind Owner');
  const ownerId = owner.data.user.id;
  const ownerToken = owner.data.token;
  const alice = await register(alicePhone, 'Remind Alice');
  const aliceId = alice.data.user.id;
  const aliceToken = alice.data.token;

  let eventId = null;

  await section('1. UPCOMING + DEADLINE SWEEP (member-wide)');
  {
    const created = await api('POST', '/api/events', ownerToken, {
      name: `ReminderStar ${suffix}`, eventType: 'HARUSI', ownerType: 'INDIVIDUAL',
      targetAmount: 900000, eventDate, contributionDeadline: deadline,
      description: 'Kipimo cha Stage 5 reminders',
    });
    await expect(created.status === 201 && created.data.event.id, 'Tukio la reminders linaundwa (201)', `${created.status}`);
    eventId = created.data.event.id;

    const invite = await api('POST', `/api/events/${eventId}/invites`, ownerToken, { maxUses: 5, expiresDays: 3 });
    const code = invite.data.invite && invite.data.invite.code;
    await expect(invite.status === 201 && !!code, 'Invite code inazalishwa', `${invite.status}`);

    const joinAlice = await api('POST', '/api/events/join', aliceToken, { code });
    await expect(joinAlice.status === 200 && joinAlice.data.success, 'Alice anajiunga na tukio', `${joinAlice.status}`);

    const run1 = await eventService.runEventReminders();
    await expect(typeof run1.sent === 'number' && typeof run1.failed === 'number', 'runEventReminders inarudisha {sent,failed}', JSON.stringify(run1));

    const rows = await pool.query(
      `SELECT r.type, r.user_id, r.sent_date FROM event_reminders r
        WHERE r.event_id = $1 AND r.sent_date = CURRENT_DATE`, [eventId]
    );
    const typesByUser = (uid) => new Set(rows.rows.filter((r) => Number(r.user_id) === uid).map((r) => r.type));
    const ownerTypes = typesByUser(ownerId);
    const aliceTypes = typesByUser(aliceId);
    await expect(ownerTypes.has('EVENT_UPCOMING'), 'Mmiliki anapata EVENT_UPCOMING', JSON.stringify(rows.rows));
    await expect(aliceTypes.has('EVENT_UPCOMING'), 'Alice (mwanachama) anapata EVENT_UPCOMING pia', JSON.stringify(rows.rows));
    await expect(ownerTypes.has('DEADLINE'), 'Mmiliki anapata DEADLINE (hajachangia)', JSON.stringify(rows.rows));
    await expect(aliceTypes.has('DEADLINE'), 'Alice anapata DEADLINE (hajachangia)', JSON.stringify(rows.rows));
  }

  await section('2. /reminders/mine PANEL');
  {
    const mine = await api('GET', '/api/events/reminders/mine', aliceToken, null);
    await expect(mine.status === 200, 'GET /events/reminders/mine -> 200', `${mine.status}`);
    const upcoming = mine.data.upcoming || [];
    const ownEvent = upcoming.find((e) => Number(e.id) === eventId);
    await expect(!!ownEvent, 'Upcoming inajumuisha tukio jipya', JSON.stringify(upcoming).slice(0, 200));
    await expect((mine.data.reminders || []).length >= 1, 'Reminders zilizotumwa zinaonekana kwenye panel', `${(mine.data.reminders || []).length}`);
    await expect(new Set((mine.data.reminders || []).filter((r) => Number(r.event_id) === eventId).map((r) => r.type)).has('DEADLINE'), 'Paneli lina DEADLINE reminder', JSON.stringify(mine.data.reminders || []).slice(0, 200));
  }

  await section('3. DEDUP (kubaki dynamic)');
  {
    const before = await pool.query(
      `SELECT type, user_id, COUNT(*) AS c FROM event_reminders
        WHERE event_id = $1 AND sent_date = CURRENT_DATE
        GROUP BY type, user_id`, [eventId]
    );
    const counts = new Map(before.rows.map((r) => [`${r.user_id}:${r.type}`, Number(r.c)]));
    await eventService.runEventReminders();
    const after = await pool.query(
      `SELECT type, user_id, COUNT(*) AS c FROM event_reminders
        WHERE event_id = $1 AND sent_date = CURRENT_DATE
        GROUP BY type, user_id`, [eventId]
    );
    let same = true;
    for (const row of after.rows) {
      const key = `${row.user_id}:${row.type}`;
      if (counts.get(key) !== Number(row.c)) same = false;
    }
    await expect(same, 'Kurudiwa kwa sweep hakuzalishi reminder duplicative', JSON.stringify(after.rows).slice(0, 200));
  }

  await section('4. OVERDUE COMMITMENTS');
  {
    const overdueEvent = await api('POST', '/api/events', ownerToken, {
      name: `OverdueStar ${suffix}`, eventType: 'OTHER', ownerType: 'INDIVIDUAL',
      targetAmount: 400000, eventDate: addDaysUtc(today, 10),
      description: 'Kipimo cha OVERDUE',
    });
    const oeId = overdueEvent.data.event.id;
    await expect(overdueEvent.status === 201 && !!oeId, 'Tukio la pili linaundwa', `${overdueEvent.status}`);

    const ins = await pool.query(
      `INSERT INTO event_commitments (event_id, user_id, amount, fulfilled, status, due_date, created_by)
       VALUES ($1, $2, 300000, 0, 'PENDING', CURRENT_DATE - 1, $3) RETURNING id`,
      [oeId, aliceId, ownerId]
    );
    const cid = ins.rows[0].id;
    await expect(!!cid, 'Ahadi yenye due_date ya jana imeandikwa', `${cid}`);

    await eventService.runEventReminders();
    const c = await pool.query('SELECT status FROM event_commitments WHERE id = $1', [cid]);
    await expect(c.rows[0].status === 'OVERDUE', 'Ahadi ya jana inawekwa OVERDUE na sweep', `${c.rows[0].status}`);

    const mine = await api('GET', '/api/events/reminders/mine', aliceToken, null);
    const dues = mine.data.dues || [];
    const over = dues.find((d) => Number(d.id) === cid);
    await expect(!!over && over.status === 'OVERDUE', '/reminders/mine inajumuisha ahadi OVERDUE', JSON.stringify(dues).slice(0, 200));
  }

  await section('5. MULTI-CURRENCY CONTRIBUTIONS');
  {
    const fxEvent = await api('POST', '/api/events', ownerToken, {
      name: `FxStar ${suffix}`, eventType: 'OTHER', ownerType: 'INDIVIDUAL',
      targetAmount: 2000000, eventDate: addDaysUtc(today, 10),
      description: 'Kipimo cha multi-currency',
    });
    const fxId = fxEvent.data.event && fxEvent.data.event.id;
    await expect(fxEvent.status === 201 && !!fxId, 'Tukio la FX linaundwa', `${fxEvent.status}`);

    const invite = await api('POST', `/api/events/${fxId}/invites`, ownerToken, { maxUses: 5, expiresDays: 3 });
    const code = invite.data.invite && invite.data.invite.code;
    const joinAlice = await api('POST', '/api/events/join', aliceToken, { code });
    await expect(joinAlice.status === 200, 'Alice anajiunga na tukio la FX', `${joinAlice.status}`);

    await fundWallet(aliceId, 1000000);
    const beforeBal = await balanceOf(aliceId);

    const bad = await api('POST', `/api/events/${fxId}/contributions`, aliceToken, { amount: 100, currency: 'XXX' });
    await expect(bad.status === 400, 'Sarafu isiyotambuliwa -> 400', `${bad.status}`);

    const res = await api('POST', `/api/events/${fxId}/contributions`, aliceToken, { amount: 1000, currency: 'KES', mode: 'FUNDRAISING' });
    await expect(res.status === 200 && res.data.success, 'Mchango wa KES 1,000 unakubaliwa', `${res.status}`);
    await expect(Number(res.data.amount) === 16700, 'TZS sawa ni 16,700 (rate 16.7)', `${res.data.amount}`);
    await expect(Number(res.data.currencyAmount) === 1000 && res.data.currency === 'KES', 'Meta ya currency inarudi kwenye response', `${res.data.currencyAmount} ${res.data.currency}`);

    const rowq = await pool.query(
      `SELECT amount, currency, currency_amount FROM event_contributions WHERE reference_id = $1`, [res.data.reference]
    );
    await expect(Number(rowq.rows[0].amount) === 16700 && rowq.rows[0].currency === 'KES' && Number(rowq.rows[0].currency_amount) === 1000, 'DB inarejesha amount (TZS) + currency_amount (KES)', JSON.stringify(rowq.rows[0]));

    const after = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [aliceId]);
    await expect((Number(beforeBal) - Number(after.rows[0].wallet_balance)) === 16700, 'Wallet imepungua kwa TZS 16,700 sawa', `${Number(beforeBal) - Number(after.rows[0].wallet_balance)}`);

    const evRow = await pool.query('SELECT collected_amount FROM social_events WHERE id = $1', [fxId]);
    await expect(Number(evRow.rows[0].collected_amount) === 16700, 'collected_amount iliongezeka kwa 16,700', `${evRow.rows[0].collected_amount}`);

    const tzs = await api('POST', `/api/events/${fxId}/contributions`, aliceToken, { amount: 500, currency: 'TZS' });
    await expect(tzs.status === 200 && Number(tzs.data.amount) === 500 && tzs.data.currency === 'TZS', 'Mchango wa TZS wa kawaida unabaki sawa', `${tzs.status}`);
    const tzq = await pool.query(
      `SELECT amount, currency, currency_amount FROM event_contributions WHERE reference_id = $1`, [tzs.data.reference]
    );
    await expect(Number(tzq.rows[0].amount) === 500 && tzq.rows[0].currency === 'TZS' && Number(tzq.rows[0].currency_amount) === 500, 'TZS row ina currency_amount inayolingana', JSON.stringify(tzq.rows[0]));

    const list = await api('GET', `/api/events/${fxId}/contributions?limit=50`, aliceToken, null);
    const fxRow = (list.data.contributions || []).find((c) => c.reference_id === res.data.reference);
    await expect(!!fxRow && fxRow.currency === 'KES' && Number(fxRow.currency_amount) === 1000, 'Orodha ya michango ina currency meta', JSON.stringify(fxRow));

    const rep = await api('GET', `/api/events/${fxId}/report`, aliceToken, null);
    const exchange = (rep.data.report && rep.data.report.summary && rep.data.report.summary.exchange) || [];
    const kesEx = exchange.find((x) => x.currency === 'KES');
    await expect(Number(kesEx && kesEx.amount) === 1000, 'Muhtasari wa report una FX KES=1,000', JSON.stringify(exchange));
    const repRow = (rep.data.report && rep.data.report.contributions || []).find((c) => c.reference_id === res.data.reference);
    await expect(!!repRow && repRow.currency === 'KES' && Number(repRow.currency_amount) === 1000, 'Report JSON inajumuisha currency meta ya mchango', JSON.stringify(repRow));

    const csvRes = await fetch(`${BASE}/api/events/${fxId}/report/csv?section=contributions`, { headers: { Authorization: `Bearer ${aliceToken}` } });
    const csv = await csvRes.text();
    await expect(csvRes.status === 200 && csv.includes('currency_amount') && csv.includes('KES'), 'CSV ya contributions ina column za currency + KES', `${csvRes.status}`);
  }

  console.log(`\nStage 5: passed=${passed} failed=${failed}`);
  if (failed > 0) {
    console.log('Failures:', failures.join(' | '));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((e) => {
  console.error('STAGE5 FATAL', e);
  console.error((e.stack || '').slice(0, 1200));
  setTimeout(() => process.exit(1), 300);
});