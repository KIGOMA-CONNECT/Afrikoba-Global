const pool = require('../config/db');
const crypto = require('crypto');
const config = require('../config');
const { generateReference, formatMoney, maskPhone } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');
const governanceService = require('./governanceService');
const { createNotification } = require('./notificationService');
const smsService = require('./smsService');

const VALID_EVENT_TYPES = [
  'HARUSI', 'SEND_OFF', 'BIRTHDAY', 'GRADUATION', 'MAHAFALI', 'KIPAIMARA',
  'COMMUNION', 'KITCHEN_PARTY', 'BABY_SHOWER', 'FAMILY', 'UKOO', 'MTAJI',
  'REUNION', 'TAASISI', 'KIUNDU', 'COMMUNITY', 'OTHER',
];
const VALID_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'];
const VALID_MODES = ['FUNDRAISING', 'SAVINGS'];
const VALID_OWNER_TYPES = ['INDIVIDUAL', 'COUPLE', 'FAMILY', 'CLAN', 'GROUP', 'ORGANIZATION'];

function badge(err, statusCode = 400) {
  const e = new Error(err);
  e.statusCode = statusCode;
  return e;
}

function assertOwner(userId, event) {
  if (event.owner_user_id !== userId) throw badge('Huna ruhusa ya kuendesha tukio hili.', 403);
}

async function findEventById(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM social_events WHERE id = $1`, [eventId]
  );
  if (rows.length === 0) throw badge('Tukio halipo.', 404);
  return rows[0];
}

async function calculateDeadline(input) {
  if (input == null || input === '') return null;
  return String(input).slice(0, 10);
}

function localDateOnly(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

async function createEvent(userId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw badge('Jina la tukio ni lazima.', 400);
  const eventType = String(data.eventType || 'OTHER').toUpperCase();
  if (!VALID_EVENT_TYPES.includes(eventType)) throw badge(`Aina ya tukio hiyo haijulikani: ${eventType}`, 400);
  const ownerType = String(data.ownerType || 'INDIVIDUAL').toUpperCase();
  if (!VALID_OWNER_TYPES.includes(ownerType)) throw badge(`Aina ya mmiliki haijulikani: ${ownerType}`, 400);
  const targetAmount = Number(data.targetAmount);
  if (!(targetAmount > 0)) throw badge('Lengo la mchango (targetAmount) ni lazima liwe chanya.', 400);
  const eventDate = await calculateDeadline(data.eventDate);
  let contributionDeadline = await calculateDeadline(data.contributionDeadline);
  if (contributionDeadline && eventDate && contributionDeadline > eventDate) {
    contributionDeadline = eventDate;
  }
  const savingsCadence = data.savingsCadence ? String(data.savingsCadence).toUpperCase() : null;
  const savingsSessionAmount = data.savingsSessionAmount != null ? Number(data.savingsSessionAmount) : null;
  if (savingsSessionAmount != null && !(savingsSessionAmount > 0)) {
    throw badge('savingsSessionAmount lazima iwe chanya.', 400);
  }
  const rules = data.rules != null && typeof data.rules === 'object' ? data.rules : {};
  const status = data.status ? String(data.status).toUpperCase() : 'ACTIVE';
  if (!VALID_STATUSES.includes(status)) throw badge(`Hali ya tukio haijulikani: ${status}`, 400);

  const { rows } = await pool.query(
    `INSERT INTO social_events
       (name, event_type, description, owner_type, owner_user_id, target_amount,
        event_date, contribution_deadline, savings_cadence, savings_session_amount,
        rules, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [name, eventType, data.description || null, ownerType, userId, targetAmount,
     eventDate, contributionDeadline, savingsCadence, savingsSessionAmount,
     JSON.stringify(rules), status]
  );
  const event = rows[0];
  await pool.query(
    `INSERT INTO event_members (event_id, user_id, role) VALUES ($1,$2,'OWNER')
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [event.id, userId]
  );
  await logAudit({
    userId, eventType: 'EVENT_CREATE', entityType: 'event', entityId: event.id,
    referenceId: null, amount: targetAmount, afterData: { name, eventType, ownerType },
  });
  return event;
}

async function listUserEvents(userId) {
  const { rows } = await pool.query(
    `SELECT e.*,
       (SELECT COALESCE(SUM(amount), 0) FROM event_contributions c
         WHERE c.event_id = e.id AND c.mode = 'FUNDRAISING' AND c.status = 'SUCCESS') AS fundraising_raised,
       (SELECT COALESCE(SUM(amount), 0) FROM event_contributions c
         WHERE c.event_id = e.id AND c.mode = 'SAVINGS' AND c.status = 'SUCCESS') AS savings_raised,
       (SELECT COUNT(*) FROM event_contributions c WHERE c.event_id = e.id AND c.status = 'SUCCESS') AS donation_count
     FROM social_events e
     WHERE e.owner_user_id = $1
        OR EXISTS (SELECT 1 FROM event_contributions c WHERE c.event_id = e.id AND c.user_id = $1)
        OR EXISTS (SELECT 1 FROM event_members m WHERE m.event_id = e.id AND m.user_id = $1 AND m.status = 'ACTIVE')
     ORDER BY e.created_at DESC`,
    [userId]
  );
  return rows;
}

async function getEventContents(userId, eventId) {
  const event = await findEventById(eventId);
  return event;
}

async function updateEvent(userId, eventId, patch) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);

  const allowed = ['name', 'event_type', 'description', 'owner_type', 'target_amount',
    'event_date', 'contribution_deadline', 'savings_cadence', 'savings_session_amount',
    'rules', 'status'];
  const sets = [];
  const params = [eventId];
  let pi = 1;

  const finalStatus = patch.status ? String(patch.status).toUpperCase() : null;
  if (finalStatus && !VALID_STATUSES.includes(finalStatus)) throw badge(`Hali haijulikani: ${finalStatus}`, 400);

  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'status') {
      params.push(finalStatus);
    } else if (key === 'rules') {
      if (patch.rules != null && typeof patch.rules !== 'object') throw badge('rules lazima ziwe JSON object.', 400);
      params.push(patch.rules != null ? JSON.stringify(patch.rules) : '{}');
    } else if (key === 'event_type') {
      const v = String(patch[key]).toUpperCase();
      if (!VALID_EVENT_TYPES.includes(v)) throw badge(`Aina haijulikani: ${v}`, 400);
      params.push(v);
    } else if (key === 'owner_type') {
      const v = String(patch[key]).toUpperCase();
      if (!VALID_OWNER_TYPES.includes(v)) throw badge(`Aina ya mmiliki haijulikani: ${v}`, 400);
      params.push(v);
    } else if (key === 'target_amount') {
      const v = Number(patch[key]);
      if (!(v > 0)) throw badge('target_amount lazima iwe chanya.', 400);
      params.push(v);
    } else if (key === 'savings_session_amount') {
      const v = Number(patch[key]);
      if (!(v > 0)) throw badge('savings_session_amount lazima iwe chanya.', 400);
      params.push(v);
    } else if (key === 'event_date' || key === 'contribution_deadline') {
      params.push(await calculateDeadline(patch[key]));
    } else {
      params.push(patch[key]);
    }
    sets.push(`${key} = $${++pi}`);
  }
  if (sets.length === 0) return event;
  sets.push('updated_at = NOW()');
  const { rows } = await pool.query(
    `UPDATE social_events SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  const updated = rows[0];
  await logAudit({
    userId, eventType: 'EVENT_UPDATE', entityType: 'event', entityId: eventId,
    afterData: { fields: sets },
  });
  return updated;
}

async function contribute(userId, eventId, { amount, mode = 'FUNDRAISING', contributorName, commitmentId, planId }) {
  const amountN = Number(amount);
  if (!(amountN > 0)) throw badge('Kiasi cha mchango ni lazima kiwe chanya.', 400);
  const modeUp = String(mode).toUpperCase();
  if (!VALID_MODES.includes(modeUp)) throw badge(`Njia haijulikani: ${mode}`, 400);

  const event = await findEventById(eventId);
  if (event.status !== 'ACTIVE') throw badge('Tukio halipo kwenye hali ya kukubali michango.', 400);
  if (modeUp === 'FUNDRAISING' && event.contribution_deadline) {
    const today = new Date().toISOString().slice(0, 10);
    if (event.contribution_deadline < today) throw badge('Muda wa kuchangia umekwisha.', 400);
  }

  const reference = generateReference('EV');
  const toAccount = modeUp === 'SAVINGS' ? 'EVENT_SAVINGS' : 'EVENT_POOL';

  if (planId != null && modeUp !== 'SAVINGS') {
    throw badge('Mpango wa akiba unaendana na njia ya SAVINGS pekee.', 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (planId != null) {
      const planCheck = await client.query(
        `SELECT id FROM event_savings_plans WHERE id = $1 AND event_id = $2 AND status = 'ACTIVE'`,
        [Number(planId), eventId]
      );
      if (planCheck.rows.length === 0) throw badge('Mpango wa akiba haupo au haupo katika tukio hili.', 400);
    }
    if (commitmentId != null) {
      const commitCheck = await client.query(
        `SELECT id FROM event_commitments WHERE id = $1 AND event_id = $2 AND user_id = $3 AND status IN ('PENDING','PARTIAL')`,
        [Number(commitmentId), eventId, userId]
      );
      if (commitCheck.rows.length === 0) throw badge('Ahadi haiko sahihi kwa mchango huu.', 400);
    }
    const debit = await fin.debitWallet({
      client, userId, amount: amountN, reference,
      toAccount,
      description: `${modeUp} kwa tukio #${eventId}`,
      actor: 'eventService',
    });
    if (debit.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    const ins = await client.query(
      `INSERT INTO event_contributions (event_id, user_id, contributor_name, mode, amount, reference_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS') RETURNING id`,
      [eventId, userId, contributorName || null, modeUp, amountN, reference]
    );
    const contributionId = ins.rows[0].id;
    if (planId != null) {
      await client.query(
        `INSERT INTO event_savings_plan_contributions (plan_id, contribution_id) VALUES ($1,$2)`,
        [Number(planId), contributionId]
      );
    }
    if (commitmentId != null) {
      await client.query(
        `UPDATE event_commitments
            SET fulfilled = fulfilled + $1,
                status = CASE WHEN fulfilled + $1 >= amount THEN 'FULFILLED' ELSE 'PARTIAL' END
          WHERE id = $2`,
        [amountN, Number(commitmentId)]
      );
    }
    await client.query(
      modeUp === 'SAVINGS'
        ? `UPDATE social_events SET savings_amount = savings_amount + $1, updated_at = NOW() WHERE id = $2`
        : `UPDATE social_events SET collected_amount = collected_amount + $1, updated_at = NOW() WHERE id = $2`,
      [amountN, eventId]
    );
    await logAudit({
      userId, eventType: 'EVENT_CONTRIBUTE', entityType: 'event', entityId: eventId,
      referenceId: reference, amount: amountN, client,
    });
    await client.query('COMMIT');
    const totals = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM event_contributions
           WHERE event_id = $1 AND mode = 'FUNDRAISING' AND status = 'SUCCESS') AS fundraising_raised,
         (SELECT COALESCE(SUM(amount), 0) FROM event_contributions
           WHERE event_id = $1 AND mode = 'SAVINGS' AND status = 'SUCCESS') AS savings_raised`,
      [eventId]
    );
    return {
      success: true, reference, mode: modeUp, amount: amountN,
      contributorName: contributorName || null,
      collected: Number(totals.rows[0].fundraising_raised),
      savings: Number(totals.rows[0].savings_raised),
      message: `${formatMoney(amountN)} imepokelewa.`,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('EVENT_CONTRIBUTE_FAIL', error.message, { userId, eventId, reference });
    throw error;
  } finally {
    client.release();
  }
}

async function listContributions(eventId, { limit = 50, status } = {}) {
  const params = [eventId];
  const clauses = ['c.event_id = $1'];
  if (status) {
    params.push(String(status).toUpperCase());
    clauses.push(`c.status = $${params.length}`);
  }
  params.push(Math.min(parseInt(limit, 10) || 50, 200));
  const { rows } = await pool.query(
    `SELECT c.id, c.user_id, c.contributor_name, c.mode, c.amount, c.reference_id, c.status,
            c.created_at,
            COALESCE(u.full_name, c.contributor_name, 'Mgeni') AS contributor,
            u.phone_number
       FROM event_contributions c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY c.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({
    ...r,
    phone: r.phone_number ? maskPhone(r.phone_number) : null,
    phone_number: undefined,
  }));
}

async function addBudgetItem(userId, eventId, { category, description, amount }) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);
  const cat = String(category || '').trim().toUpperCase();
  if (!cat) throw badge('Kategoria ya bajeti ni lazima.', 400);
  const amountN = Number(amount);
  if (!(amountN > 0)) throw badge('Kiasi cha bajeti ni lazima kiwe chanya.', 400);
  const { rows } = await pool.query(
    `INSERT INTO event_budget_items (event_id, category, description, amount)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [eventId, cat, description || null, amountN]
  );
  await logAudit({
    userId, eventType: 'EVENT_BUDGET_ITEM', entityType: 'event', entityId: eventId,
    amount: amountN,
  });
  return rows[0];
}

async function listBudget(eventId) {
  const { rows } = await pool.query(
    `SELECT * FROM event_budget_items WHERE event_id = $1 ORDER BY created_at ASC`,
    [eventId]
  );
  return rows;
}

async function deleteBudgetItem(userId, eventId, itemId) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);
  const { rows } = await pool.query(
    `DELETE FROM event_budget_items WHERE id = $1 AND event_id = $2 RETURNING *`,
    [itemId, eventId]
  );
  if (rows.length === 0) throw badge('Kipengele cha bajeti hakipo.', 404);
  await logAudit({
    userId, eventType: 'EVENT_BUDGET_ITEM_REMOVE', entityType: 'event', entityId: eventId,
    amount: rows[0].amount,
  });
  return { success: true };
}

async function makeCommitment(actorId, eventId, { amount, dueDate, note, userId }) {
  const event = await findEventById(eventId);
  if (event.status !== 'ACTIVE') throw badge('Tukio halipo kwenye hali ya kukubali ahadi.', 400);
  const amountN = Number(amount);
  if (!(amountN > 0)) throw badge('Kiasi cha ahadi ni lazima kiwe chanya.', 400);
  const commitUserId = userId != null ? Number(userId) : actorId;
  if (commitUserId !== actorId) assertOwner(actorId, event);
  const dd = await calculateDeadline(dueDate);
  const { rows } = await pool.query(
    `INSERT INTO event_commitments (event_id, user_id, amount, note, due_date, created_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING *`,
    [eventId, commitUserId, amountN, note || null, dd, actorId]
  );
  await logAudit({
    userId: actorId, eventType: 'EVENT_COMMITMENT', entityType: 'event', entityId: eventId,
    amount: amountN,
  });
  return rows[0];
}

async function listCommitments(eventId) {
  const { rows } = await pool.query(
    `SELECT c.*, COALESCE(u.full_name, 'Mgeni') AS user_name
       FROM event_commitments c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.event_id = $1
      ORDER BY c.created_at DESC`,
    [eventId]
  );
  return rows.map((r) => {
    const amount = Number(r.amount);
    const fulfilled = Number(r.fulfilled);
    let status = r.status;
    if (status !== 'CANCELLED') {
      status = fulfilled >= amount ? 'FULFILLED' : (fulfilled > 0 ? 'PARTIAL' : 'PENDING');
    }
    return {
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      amount,
      fulfilled,
      remaining: Math.max(amount - fulfilled, 0),
      status,
      note: r.note,
      dueDate: r.due_date,
      createdAt: r.created_at,
    };
  });
}

async function cancelCommitment(actorId, eventId, commitmentId) {
  const event = await findEventById(eventId);
  const { rows } = await pool.query(
    `SELECT * FROM event_commitments WHERE id = $1 AND event_id = $2`,
    [commitmentId, eventId]
  );
  if (rows.length === 0) throw badge('Ahadi haipo.', 404);
  const c = rows[0];
  if (c.user_id !== actorId) assertOwner(actorId, event);
  if (c.status === 'CANCELLED') throw badge('Ahadi tayari imeghairiwa.', 400);
  if (Number(c.fulfilled) > 0) throw badge('Ahadi hii ina michango tayari; haiwezi kuondolewa.', 400);
  await pool.query(`UPDATE event_commitments SET status = 'CANCELLED' WHERE id = $1`, [commitmentId]);
  await logAudit({
    userId: actorId, eventType: 'EVENT_COMMITMENT_CANCEL', entityType: 'event',
    entityId: eventId, amount: Number(c.amount),
  });
  return { success: true };
}

async function createSavingsPlan(userId, eventId, { name, targetAmount, cadence, sessionAmount, startDate, endDate }) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);
  const nm = String(name || '').trim();
  if (!nm) throw badge('Jina la mpango wa akiba ni lazima.', 400);
  const target = Number(targetAmount);
  if (!(target > 0)) throw badge('Lengo la mpango lazima liwe chanya.', 400);
  const sess = Number(sessionAmount);
  if (!(sess > 0)) throw badge('Kiasi cha kila kipindi lazima kiwe chanya.', 400);
  const cad = cadence ? String(cadence).toUpperCase() : 'WEEKLY';
  const { rows } = await pool.query(
    `INSERT INTO event_savings_plans (event_id, name, target_amount, cadence, session_amount, start_date, end_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8) RETURNING *`,
    [eventId, nm, target, cad, sess, await calculateDeadline(startDate), await calculateDeadline(endDate), userId]
  );
  await logAudit({
    userId, eventType: 'EVENT_SAVINGS_PLAN', entityType: 'event', entityId: eventId,
    amount: target,
  });
  return rows[0];
}

async function listSavingsPlans(eventId) {
  const { rows } = await pool.query(
    `SELECT p.*,
       (SELECT COALESCE(SUM(c.amount), 0) FROM event_savings_plan_contributions pc
         JOIN event_contributions c ON c.id = pc.contribution_id
        WHERE pc.plan_id = p.id AND c.status = 'SUCCESS') AS collected,
       (SELECT COUNT(*) FROM event_savings_plan_contributions pc
         JOIN event_contributions c ON c.id = pc.contribution_id
        WHERE pc.plan_id = p.id AND c.status = 'SUCCESS') AS sessions
       FROM event_savings_plans p
      WHERE p.event_id = $1
      ORDER BY p.created_at ASC`,
    [eventId]
  );
  return rows.map((r) => ({
    ...r,
    targetAmount: Number(r.target_amount),
    sessionAmount: Number(r.session_amount),
    collected: Number(r.collected),
    sessions: Number(r.sessions),
    remaining: Math.max(Number(r.target_amount) - Number(r.collected), 0),
  }));
}

async function closeSavingsPlan(userId, eventId, planId) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);
  const { rows } = await pool.query(
    `UPDATE event_savings_plans SET status = 'COMPLETED', updated_at = NOW()
      WHERE id = $1 AND event_id = $2 RETURNING *`,
    [planId, eventId]
  );
  if (rows.length === 0) throw badge('Mpango wa akiba haupo.', 404);
  await logAudit({
    userId, eventType: 'EVENT_SAVINGS_PLAN_CLOSE', entityType: 'event', entityId: eventId,
  });
  return rows[0];
}

async function eventDashboard(eventId) {
  const event = await findEventById(eventId);
  const { rows } = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(amount), 0) FROM event_contributions
         WHERE event_id = $1 AND mode = 'FUNDRAISING' AND status = 'SUCCESS') AS fundraising_raised,
       (SELECT COALESCE(SUM(amount), 0) FROM event_contributions
         WHERE event_id = $1 AND mode = 'SAVINGS' AND status = 'SUCCESS') AS savings_raised,
       (SELECT COUNT(*) FROM event_contributions
         WHERE event_id = $1 AND status = 'SUCCESS') AS total_donations,
       (SELECT COUNT(DISTINCT user_id) FROM event_contributions
         WHERE event_id = $1 AND user_id IS NOT NULL AND status = 'SUCCESS') AS contributors`,
    [eventId]
  );
  const t = rows[0];
  const contributors = Number(t.contributors);
  const fundraising = Number(t.fundraising_raised);
  const savings = Number(t.savings_raised);
  const totalCollected = fundraising + savings;
  const target = Number(event.target_amount);
  const remaining = Math.max(target - totalCollected, 0);
  const progress = target > 0 ? Math.round((totalCollected / target) * 10000) / 100 : 0;

  const budget = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS items
       FROM event_budget_items WHERE event_id = $1`,
    [eventId]
  );
  const budgetCategories = await pool.query(
    `SELECT category, COUNT(*) AS items, SUM(amount) AS total
       FROM event_budget_items WHERE event_id = $1
      GROUP BY category ORDER BY total DESC`,
    [eventId]
  );

  const recent = await pool.query(
    `SELECT c.id, c.user_id, c.contributor_name, c.mode, c.amount, c.reference_id, c.created_at,
            COALESCE(u.full_name, c.contributor_name, 'Mgeni') AS contributor,
            u.phone_number
       FROM event_contributions c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.event_id = $1 AND c.status = 'SUCCESS'
      ORDER BY c.created_at DESC LIMIT 10`,
    [eventId]
  );

  const participants = await pool.query(
    `SELECT COUNT(*) FROM event_members WHERE event_id = $1 AND status = 'ACTIVE'`,
    [eventId]
  );
  const invitesActive = await pool.query(
    `SELECT COUNT(*) FROM event_invites WHERE event_id = $1 AND status = 'ACTIVE'`,
    [eventId]
  );

  const withdrawalsAgg = await pool.query(
    `SELECT mode, status, COALESCE(SUM(amount), 0)::float AS amount
       FROM event_withdrawals WHERE event_id = $1
      GROUP BY mode, status`,
    [eventId]
  );
  const withdrawBy = {};
  for (const w of withdrawalsAgg.rows) {
    withdrawBy[w.mode] = withdrawBy[w.mode] || { pending: 0, approved: 0, paid: 0, failed: 0 };
    withdrawBy[w.mode][String(w.status).toLowerCase()] = Number(w.amount);
  }
  const withdrawalSummary = {};
  for (const mode of VALID_MODES) {
    const w = withdrawBy[mode] || { pending: 0, approved: 0, paid: 0, failed: 0 };
    const poolTotal = mode === 'SAVINGS' ? Number(event.savings_amount || 0) : Number(event.collected_amount || 0);
    const held = w.pending + w.approved;
    withdrawalSummary[mode] = {
      available: Math.max(poolTotal - held, 0),
      pending: w.pending,
      approved: w.approved,
      paid: w.paid,
      totalPaid: w.paid,
    };
  }

  const commitmentsAgg = await pool.query(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(amount), 0) AS total,
            COALESCE(SUM(fulfilled), 0) AS fulfilled
       FROM event_commitments
      WHERE event_id = $1 AND status <> 'CANCELLED'`,
    [eventId]
  );
  const cAgg = commitmentsAgg.rows[0];
  const commitmentsTotal = Number(cAgg.total);
  const commitmentsFulfilled = Number(cAgg.fulfilled);

  const savingsPlansRows = await pool.query(
    `SELECT id, name, target_amount, cadence, session_amount, start_date, end_date, status,
       (SELECT COALESCE(SUM(c.amount), 0) FROM event_savings_plan_contributions pc
         JOIN event_contributions c ON c.id = pc.contribution_id
        WHERE pc.plan_id = p.id AND c.status = 'SUCCESS') AS collected
       FROM event_savings_plans p
      WHERE p.event_id = $1 AND status = 'ACTIVE'
      ORDER BY p.created_at ASC`,
    [eventId]
  );

  return {
    event: {
      id: event.id,
      name: event.name,
      eventType: event.event_type,
      description: event.description,
      ownerType: event.owner_type,
      ownerUserId: event.owner_user_id,
      eventDate: event.event_date,
      contributionDeadline: event.contribution_deadline,
      savingsCadence: event.savings_cadence,
      savingsSessionAmount: Number(event.savings_session_amount || 0),
      status: event.status,
      createdAt: event.created_at,
    },
    summary: {
      target,
      collected: { total: totalCollected, fundraising, savings },
      remaining,
      progress,
      format: { target: formatMoney(target), collected: formatMoney(totalCollected) },
    },
    stats: {
      contributors,
      donations: Number(t.total_donations),
      averageContribution: Number(t.total_donations) > 0 ? Math.round((totalCollected / Number(t.total_donations)) * 100) / 100 : 0,
    },
    budget: {
      total: Number(budget.rows[0].total),
      items: Number(budget.rows[0].items),
      categories: budgetCategories.rows.map((b) => ({ category: b.category, items: Number(b.items), total: Number(b.total) })),
    },
    commitments: {
      count: Number(cAgg.count),
      total: commitmentsTotal,
      fulfilled: commitmentsFulfilled,
      outstanding: Math.max(commitmentsTotal - commitmentsFulfilled, 0),
    },
    savingsPlans: savingsPlansRows.rows.map((p) => ({
      id: p.id,
      name: p.name,
      targetAmount: Number(p.target_amount),
      collected: Number(p.collected),
      remaining: Math.max(Number(p.target_amount) - Number(p.collected), 0),
      cadence: p.cadence,
      sessionAmount: Number(p.session_amount),
    })),
    recent: recent.rows.map((r) => ({
      id: r.id,
      contributor: r.contributor,
      mode: r.mode,
      amount: Number(r.amount),
      referenceId: r.reference_id,
      createdAt: r.created_at,
      phone: r.phone_number ? maskPhone(r.phone_number) : null,
    })),
    participants: {
      members: Number(participants.rows[0].count),
      invitesActive: Number(invitesActive.rows[0].count),
    },
    withdrawals: withdrawalSummary,
  };
}

/* ============================================================================
 * STAGE 3 — Withdrawals & settlement, members & invitations, reminders
 * ==========================================================================*/

async function isAdminUser(userId) {
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
  return rows.length > 0 && rows[0].role === 'ADMIN';
}

async function requestEventWithdrawal(actorId, eventId, { amount, mode, toUserId, comment }) {
  const event = await findEventById(eventId);
  assertOwner(actorId, event);
  const modeUp = String(mode || 'FUNDRAISING').toUpperCase();
  if (!VALID_MODES.includes(modeUp)) throw badge('Njia ya uondoaji haijulikani.', 400);
  const amountN = Number(amount);
  if (!(amountN > 0)) throw badge('Kiasi cha uondoaji ni lazima kiwe chanya.', 400);
  const recipient = toUserId != null ? Number(toUserId) : actorId;

  const poolCol = modeUp === 'SAVINGS' ? 'savings_amount' : 'collected_amount';
  const pending = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS pending
       FROM event_withdrawals
      WHERE event_id = $1 AND mode = $2 AND status IN ('PENDING','APPROVED')`,
    [eventId, modeUp]
  );
  const available = Math.max(Number(event[poolCol] || 0) - Number(pending.rows[0].pending), 0);
  if (amountN > available) {
    throw badge(`Fedha zilizopo za ${modeUp} katika tukio ni ${formatMoney(available)} pekee.`, 400);
  }

  const member = await pool.query(
    `SELECT 1 FROM event_members WHERE event_id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
    [eventId, recipient]
  );
  if (member.rows.length === 0) throw badge('Mpokeaji lazima awe mwanachama wa tukio.', 400);

  const reference = generateReference('EVW');
  const { rows } = await pool.query(
    `INSERT INTO event_withdrawals (event_id, user_id, mode, amount, reference_id, status, comment)
     VALUES ($1,$2,$3,$4,$5,'PENDING',$6) RETURNING *`,
    [eventId, recipient, modeUp, amountN, reference, comment || null]
  );
  const withdrawal = rows[0];

  // Four-eyes gate: high-value withdrawals need an admin approver (executor registered in routes).
  const stored = await governanceService.getSetting('EVENT_WITHDRAWAL_THRESHOLD');
  const parsed = parseFloat(stored);
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 5000000;
  let requiresApproval = false;
  let approvalFlowId = null;
  if (amountN >= threshold && !(await isAdminUser(actorId))) {
    const flow = await governanceService.createApprovalFlow({
      requesterId: actorId,
      actionType: 'EVENT_WITHDRAWAL',
      refType: 'EVENT_WITHDRAWAL',
      refId: withdrawal.id,
      data: { eventId, withdrawalId: withdrawal.id, mode: modeUp, amount: amountN, userId: recipient, reference },
    });
    approvalFlowId = flow.id;
    requiresApproval = true;
    await pool.query(
      `UPDATE event_withdrawals SET requires_approval = TRUE, approval_flow_id = $1, updated_at = NOW()
        WHERE id = $2`,
      [flow.id, withdrawal.id]
    );
  } else {
    // Direct (below-threshold) withdrawal: settle immediately.
    const executed = await executeEventWithdrawal({
      eventId,
      withdrawalId: withdrawal.id,
      mode: modeUp,
      amount: amountN,
      userId: recipient,
      reference,
    });
    if (!executed.dedup) {
      await pool.query(
        `UPDATE event_withdrawals SET requires_approval = FALSE, updated_at = NOW() WHERE id = $1`,
        [withdrawal.id]
      );
    }
  }
  logger.info('EVENT_WITHDRAWAL_REQUEST', `${requiresApproval ? 'Approval' : 'Direct'} withdrawal ${withdrawal.id} ref=${reference}`, { eventId, amount: amountN, mode: modeUp });
  return {
    success: true,
    withdrawal: { ...withdrawal, amount: amountN, pending: true },
    requiresApproval,
    approvalFlowId,
    available,
    message: requiresApproval ? 'Uondoaji wa kiasi kikubwa unahitaji idhini ya msimamizi (four-eyes).' : 'Uondoaji umeombwa kwa mafanikio.',
  };
}

async function executeEventWithdrawal({ eventId, withdrawalId, mode, amount, userId, reference }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE event_withdrawals
          SET status = 'PAID', paid_at = NOW(), reference_id = $3, updated_at = NOW()
        WHERE id = $1 AND event_id = $2 AND status IN ('PENDING','APPROVED')
        RETURNING *`,
      [withdrawalId, eventId, reference]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    const modeUp = String(mode || updated.rows[0].mode).toUpperCase();
    const amountN = Number(amount != null ? amount : updated.rows[0].amount);
    const toUserId = userId != null ? Number(userId) : updated.rows[0].user_id;
    const col = modeUp === 'SAVINGS' ? 'savings_amount' : 'collected_amount';
    const moved = await fin.groupToWallet({
      client,
      userId: toUserId,
      groupId: eventId,
      groupAccount: modeUp === 'SAVINGS' ? 'EVENT_SAVINGS' : 'EVENT_POOL',
      groupSql: `UPDATE social_events SET ${col} = ${col} - $1 WHERE id = $2`,
      amount: amountN,
      reference,
      description: `Uondoaji wa ${modeUp} kutoka tukio #${eventId}`,
      actor: 'eventService.withdraw',
    });
    if (moved.dedup) {
      await client.query('ROLLBACK');
      return { dedup: true, reference };
    }
    await logAudit({
      userId: toUserId, eventType: 'EVENT_WITHDRAWAL', entityType: 'event', entityId: eventId,
      referenceId: reference, amount: amountN, client,
    });
    await client.query('COMMIT');
    return { success: true, withdrawalId, reference, amount: amountN, paidTo: toUserId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `UPDATE event_withdrawals SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
      [withdrawalId]
    ).catch(() => {});
    logger.error('EVENT_WITHDRAWAL_FAIL', error.message, { eventId, withdrawalId, reference });
    throw error;
  } finally {
    client.release();
  }
}

async function listEventWithdrawals(eventId, { status } = {}) {
  const params = [eventId];
  const clauses = ['w.event_id = $1'];
  if (status) {
    params.push(String(status).toUpperCase());
    clauses.push(`w.status = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT w.id, w.event_id, w.user_id, w.mode, w.amount, w.reference_id, w.status,
            w.requires_approval, w.approval_flow_id, w.comment, w.paid_at, w.created_at,
            COALESCE(u.full_name, 'Mgeni') AS recipient,
            u.phone_number,
            ap.full_name AS approved_by_name
       FROM event_withdrawals w
       LEFT JOIN users u ON u.id = w.user_id
       LEFT JOIN users ap ON ap.id = w.approved_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY w.created_at DESC LIMIT 100`,
    params
  );
  return rows.map((r) => ({
    ...r,
    amount: Number(r.amount),
    phone: r.phone_number ? maskPhone(r.phone_number) : null,
    phone_number: undefined,
  }));
}

async function cancelEventWithdrawal(actorId, eventId, withdrawalId) {
  const event = await findEventById(eventId);
  assertOwner(actorId, event);
  const { rows } = await pool.query(
    `UPDATE event_withdrawals SET status = 'REJECTED', updated_at = NOW()
      WHERE id = $1 AND event_id = $2 AND status = 'PENDING' RETURNING *`,
    [withdrawalId, eventId]
  );
  if (rows.length === 0) throw badge('Uondoaji haupo au hauwezi kughairiwa (tayari umechakatwa).', 400);
  return { success: true, withdrawal: rows[0] };
}

async function createInvite(actorId, eventId, { maxUses, expiresDays }) {
  const event = await findEventById(eventId);
  assertOwner(actorId, event);
  const uses = Math.min(Math.max(parseInt(maxUses, 10) || 10, 1), 1000);
  const expiresAt = expiresDays != null
    ? new Date(Date.now() + (parseInt(expiresDays, 10) || 7) * 86400000)
    : null;
  let code = '';
  do {
    code = crypto.randomBytes(5).toString('hex').toUpperCase();
  } while ((await pool.query('SELECT 1 FROM event_invites WHERE code = $1', [code])).rows.length > 0);
  const { rows } = await pool.query(
    `INSERT INTO event_invites (code, event_id, created_by, max_uses, expires_at, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE') RETURNING *`,
    [code, eventId, actorId, uses, expiresAt]
  );
  await logAudit({ userId: actorId, eventType: 'EVENT_INVITE', entityType: 'event', entityId: eventId });
  return rows[0];
}

async function listInvites(actorId, eventId) {
  const event = await findEventById(eventId);
  assertOwner(actorId, event);
  const { rows } = await pool.query(
    `SELECT i.*, u.full_name AS created_by_name
       FROM event_invites i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.event_id = $1
      ORDER BY i.created_at DESC`,
    [eventId]
  );
  return rows;
}

async function joinEventByCode(userId, code) {
  const codeUp = String(code || '').trim().toUpperCase();
  if (!codeUp) throw badge('Kodi ya mwaliko ni lazima.', 400);
  const { rows } = await pool.query(
    `SELECT * FROM event_invites WHERE code = $1 AND status = 'ACTIVE'`,
    [codeUp]
  );
  if (rows.length === 0) throw badge('Mwaliko haupo au umeisha. Wasiliana na waandalizi.', 404);
  const invite = rows[0];
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    throw badge('Mwaliko umeisha muda wake.', 400);
  }
  const event = await findEventById(invite.event_id);
  const ins = await pool.query(
    `INSERT INTO event_members (event_id, user_id, role, invited_by)
     VALUES ($1,$2,'MEMBER',$3)
     ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'ACTIVE', invited_by = EXCLUDED.invited_by, joined_at = NOW()
     RETURNING *`,
    [event.id, userId, invite.created_by]
  );
  await pool.query(
    `UPDATE event_invites
        SET uses = uses + 1,
            status = CASE WHEN uses + 1 >= max_uses THEN 'EXHAUSTED' ELSE status END
      WHERE id = $1`,
    [invite.id]
  );
  const memberUser = (await pool.query('SELECT full_name FROM users WHERE id = $1', [userId])).rows[0];
  if (memberUser) {
    await notifyJoin(event.id, userId);
  }
  logger.info('EVENT_JOIN', `User ${userId} joined event ${event.id} via code`, { code: codeUp });
  return {
    success: true,
    event: { id: event.id, name: event.name, eventType: event.event_type, status: event.status },
    joinedAt: ins.rows[0].joined_at,
  };
}

async function addMemberByPhone(actorId, eventId, { phoneNumber }) {
  const event = await findEventById(eventId);
  assertOwner(actorId, event);
  const phone = String(phoneNumber || '').trim();
  if (!phone) throw badge('Namba ya simu ni lazima.', 400);
  const user = (await pool.query('SELECT id, full_name FROM users WHERE phone_number = $1', [phone])).rows[0];
  if (!user) throw badge('Mtumiaji huyo hajapatikana. Tumia mwaliko (invite code) kuwaalika.', 404);
  const ins = await pool.query(
    `INSERT INTO event_members (event_id, user_id, role, invited_by)
     VALUES ($1,$2,'MEMBER',$3)
     ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'ACTIVE', invited_by = EXCLUDED.invited_by
     RETURNING *`,
    [eventId, user.id, actorId]
  );
  await logAudit({ userId: actorId, eventType: 'EVENT_MEMBER_ADD', entityType: 'event', entityId: eventId });
  return { success: true, member: { user_id: user.id, full_name: user.full_name, role: 'MEMBER', ...ins.rows[0] } };
}

async function listEventMembers(eventId) {
  const { rows } = await pool.query(
    `SELECT m.event_id, m.user_id, m.role, m.status, m.joined_at, m.invited_by,
            COALESCE(u.full_name, 'Mgeni') AS user_name, u.phone_number
       FROM event_members m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.event_id = $1 AND (m.status = 'ACTIVE' OR m.role = 'OWNER')
      ORDER BY CASE m.role WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, m.joined_at ASC`,
    [eventId]
  );
  return rows.map((r) => ({
    event_id: r.event_id,
    userId: r.user_id,
    role: r.role,
    status: r.status,
    joinedAt: r.joined_at,
    invitedBy: r.invited_by,
    userName: r.user_name,
    phone: r.phone_number ? maskPhone(r.phone_number) : null,
  }));
}

async function removeMember(actorId, eventId, targetUserId) {
  const event = await findEventById(eventId);
  assertOwner(actorId, event);
  if (Number(targetUserId) === event.owner_user_id) throw badge('Mmiliki hawezi kuondolewa.', 400);
  const { rows } = await pool.query(
    `UPDATE event_members SET status = 'LEFT', role = 'MEMBER'
      WHERE event_id = $1 AND user_id = $2 AND status = 'ACTIVE' RETURNING *`,
    [eventId, Number(targetUserId)]
  );
  if (rows.length === 0) throw badge('Mwanachama hapo.,', 404);
  await logAudit({ userId: actorId, eventType: 'EVENT_MEMBER_REMOVE', entityType: 'event', entityId: eventId });
  return { success: true };
}

async function listEventReminders(eventId) {
  const { rows } = await pool.query(
    `SELECT r.*, u.full_name AS recipient_name
       FROM event_reminders r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1
      ORDER BY r.created_at DESC LIMIT 50`,
    [eventId]
  );
  return rows;
}

async function notifyJoin(eventId, newUserId) {
  try {
    const event = await findEventById(eventId);
    const who = (await pool.query('SELECT full_name FROM users WHERE id = $1', [newUserId])).rows[0];
    if (who) {
      await createNotification(event.owner_user_id, {
        title: 'Mwanachama mpya',
        body: `${who.full_name} amejiunga na tukio "${event.name}".`,
        type: 'INFO', channel: 'IN_APP', entityType: 'event', entityId: eventId,
      });
    }
  } catch (e) { logger.error('EVENT_JOIN_NOTIFY', e.message); }
}

async function runEventReminders() {
  const today = new Date().toISOString().slice(0, 10);
  let sent = 0;
  let failed = 0;
  try {
    const due = await pool.query(
      `SELECT c.id, c.event_id, c.user_id, c.amount, c.fulfilled, c.due_date,
              u.full_name, u.phone_number
         FROM event_commitments c
         JOIN users u ON u.id = c.user_id
         JOIN social_events e ON e.id = c.event_id AND e.status = 'ACTIVE'
        WHERE c.status IN ('PENDING','PARTIAL')
          AND c.due_date IS NOT NULL
          AND c.due_date >= CURRENT_DATE AND c.due_date <= CURRENT_DATE + 3
          AND NOT EXISTS (
            SELECT 1 FROM event_reminders r
             WHERE r.commitment_id = c.id AND r.type = 'COMMITMENT_DUE'
               AND r.status = 'SENT' AND r.sent_date = CURRENT_DATE
          )`
    );
    for (const c of due.rows) {
      try {
        const remaining = Math.max(Number(c.amount) - Number(c.fulfilled), 0);
        const message = `${c.full_name}, ahadi yako ya ${formatMoney(remaining)} kwenye tukio ina mlango wa tarehe ${c.due_date}. Maliza mchango wako sasa.`;
        await createNotification(c.user_id, {
          title: 'Ahadi inakaribia',
          body: message, type: 'REMINDER', channel: 'IN_APP', entityType: 'event', entityId: c.event_id,
        });
        let channel = 'IN_APP';
        try {
          if (c.phone_number) {
            await smsService.sendSMS(c.phone_number, message);
            channel = 'BOTH';
          }
        } catch (_) { /* SMS best-effort */ }
        await pool.query(
          `INSERT INTO event_reminders (event_id, user_id, commitment_id, type, channel, status, sent_date, reference_data)
           VALUES ($1,$2,$3,'COMMITMENT_DUE',$4,'SENT',$5,$6) ON CONFLICT DO NOTHING`,
          [c.event_id, c.user_id, c.id, channel, today, JSON.stringify({ remaining })]
        );
        sent++;
      } catch (e) {
        failed++;
        logger.error('EVENT_REMINDER_CMT', e.message, { commitmentId: c.id });
      }
    }
  } catch (e) {
    logger.error('EVENT_REMINDER_SCAN', e.message);
  }

  try {
    const upcoming = await pool.query(
      `SELECT e.id, e.name, e.event_date, e.owner_user_id, u.full_name, u.phone_number
         FROM social_events e
         JOIN users u ON u.id = e.owner_user_id
        WHERE e.status = 'ACTIVE'
          AND e.event_date IS NOT NULL
          AND e.event_date >= CURRENT_DATE AND e.event_date <= CURRENT_DATE + 3
          AND NOT EXISTS (
            SELECT 1 FROM event_reminders r
             WHERE r.event_id = e.id AND r.type = 'EVENT_UPCOMING'
               AND r.status = 'SENT' AND r.sent_date = CURRENT_DATE
          )`
    );
    for (const ev of upcoming.rows) {
      try {
        const message = `${ev.full_name}, tukio "${ev.name}" ni tarehe ${ev.event_date}. Jipange vizuri!`;
        await createNotification(ev.owner_user_id, {
          title: 'Tukio linakaribia',
          body: message, type: 'REMINDER', channel: 'IN_APP', entityType: 'event', entityId: ev.id,
        });
        let channel = 'IN_APP';
        try {
          if (ev.phone_number) {
            await smsService.sendSMS(ev.phone_number, message);
            channel = 'BOTH';
          }
        } catch (_) { /* SMS best-effort */ }
        await pool.query(
          `INSERT INTO event_reminders (event_id, user_id, type, channel, status, sent_date, reference_data)
           VALUES ($1,$2,'EVENT_UPCOMING',$3,'SENT',$4,$5) ON CONFLICT DO NOTHING`,
          [ev.id, ev.owner_user_id, channel, today, JSON.stringify({ eventDate: ev.event_date })]
        );
        sent++;
      } catch (e) {
        failed++;
        logger.error('EVENT_REMINDER_EVT', e.message, { eventId: ev.id });
      }
    }
  } catch (e) {
    logger.error('EVENT_REMINDER_UPCOMING_SCAN', e.message);
  }
  if (sent > 0 || failed > 0) logger.info('EVENT_REMINDERS', `sent=${sent} failed=${failed}`);
  return { sent, failed };
}

// ===================== STAGE 4: PUBLIC SHARE + TEMPLATES + SERIES + REPORTS =====================

function generateToken() {
  return crypto.randomBytes(12).toString('hex');
}

async function ensurePublicShare(userId, eventId) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);
  let token = event.public_token;
  if (!token) {
    token = generateToken();
    await pool.query(`UPDATE social_events SET public_token = $1, updated_at = NOW() WHERE id = $2`, [token, eventId]);
  }
  return buildSharePayload(event, token);
}

function buildSharePayload(event, token) {
  const url = `${config.publicUrl}/p/${token}`;
  const text = `${event.name} — changia na ushiriki kupitia Afrikoba: ${url}`;
  return {
    token,
    url,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}`,
  };
}

async function getPublicEvent(token) {
  const { rows } = await pool.query(`SELECT e.*, u.full_name AS owner_name FROM social_events e JOIN users u ON u.id = e.owner_user_id WHERE e.public_token = $1`, [token]);
  if (rows.length === 0) throw badge('Tukio halipatikani kwa kiungo hiki.', 404);
  const event = rows[0];
  const [collect, members, donations] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0)::float AS total FROM event_contributions WHERE event_id=$1 AND status='SUCCESS'`, [event.id]),
    pool.query(`SELECT COUNT(*)::int AS total FROM event_members WHERE event_id=$1 AND status='ACTIVE'`, [event.id]),
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(DISTINCT user_id)::int AS contributors FROM event_contributions WHERE event_id=$1 AND status='SUCCESS'`, [event.id]),
  ]);
  return {
    id: event.id,
    name: event.name,
    eventType: event.event_type,
    description: event.description,
    ownerName: event.owner_name,
    eventDate: event.event_date,
    contributionDeadline: event.contribution_deadline,
    targetAmount: Number(event.target_amount),
    collectedAmount: Number(collect.rows[0].total),
    progress: event.target_amount > 0 ? Math.min(Math.round((Number(collect.rows[0].total) / Number(event.target_amount)) * 100), 100) : 0,
    donations: donations.rows[0].total,
    contributors: donations.rows[0].contributors,
    members: members.rows[0].total,
    status: event.status,
  };
}

async function joinEventByPublicLink(userId, token) {
  const { rows } = await pool.query(`SELECT id, status FROM social_events WHERE public_token = $1`, [token]);
  if (rows.length === 0) throw badge('Kiungo cha tukio si sahihi.', 404);
  const event = rows[0];
  if (event.status !== 'ACTIVE') throw badge('Tukio halikubali wanachama kwa sasa.', 400);
  await pool.query(
    `INSERT INTO event_members (event_id, user_id, role, status) VALUES ($1,$2,'MEMBER','ACTIVE')
     ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'ACTIVE', updated_at = NOW()`,
    [event.id, userId]
  );
  notifyJoin(event.id, userId);
  const summary = await findEventById(event.id);
  return { event: summary, joinedAt: new Date().toISOString() };
}

// ===================== TEMPLATES =====================

async function createEventTemplate(userId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw badge('Jina la template ni lazima.', 400);
  if (data.eventType) {
    const eventType = String(data.eventType).toUpperCase();
    if (!VALID_EVENT_TYPES.includes(eventType)) throw badge(`Aina ya tukio haijulikani: ${data.eventType}`, 400);
  }
  const budgetItems = Array.isArray(data.budgetItems) ? data.budgetItems : [];
  const { rows } = await pool.query(
    `INSERT INTO event_templates
       (organizer_id, name, event_type, owner_type, target_amount, description, rules,
        savings_cadence, savings_session_amount, budget_items)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [userId, name,
     data.eventType ? String(data.eventType).toUpperCase() : 'OTHER',
     data.ownerType ? String(data.ownerType).toUpperCase() : 'INDIVIDUAL',
     data.targetAmount != null ? Number(data.targetAmount) : null,
     data.description || null,
     data.rules && typeof data.rules === 'object' ? JSON.stringify(data.rules) : '{}',
     data.savingsCadence ? String(data.savingsCadence).toUpperCase() : null,
     data.savingsSessionAmount != null ? Number(data.savingsSessionAmount) : null,
     JSON.stringify(budgetItems)]
  );
  return rows[0];
}

async function listEventTemplates(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM event_templates WHERE organizer_id = $1 ORDER BY updated_at DESC`, [userId]
  );
  return rows;
}

async function getEventTemplate(userId, templateId) {
  const { rows } = await pool.query(`SELECT * FROM event_templates WHERE id = $1`, [templateId]);
  if (rows.length === 0) throw badge('Template haipo.', 404);
  if (rows[0].organizer_id !== userId) throw badge('Huna ruhusa ya template hii.', 403);
  return rows[0];
}

async function deleteEventTemplate(userId, templateId) {
  await getEventTemplate(userId, templateId);
  await pool.query(`DELETE FROM event_templates WHERE id = $1`, [templateId]);
  return { success: true };
}

async function saveEventAsTemplate(userId, eventId, name) {
  const event = await findEventById(eventId);
  assertOwner(userId, event);
  const budget = await pool.query(`SELECT category, description, amount FROM event_budget_items WHERE event_id = $1`, [eventId]);
  return createEventTemplate(userId, {
    name: String(name || `${event.name} — Template`).trim(),
    eventType: event.event_type,
    ownerType: event.owner_type,
    targetAmount: event.target_amount,
    description: event.description,
    rules: event.rules,
    savingsCadence: event.savings_cadence,
    savingsSessionAmount: event.savings_session_amount,
    budgetItems: budget.rows,
  });
}

async function createEventFromTemplate(userId, templateId, overrides = {}) {
  const template = await getEventTemplate(userId, templateId);
  const created = await createEvent(userId, {
    name: overrides.name || `${template.name} — ${new Date().toISOString().slice(0, 10)}`,
    eventType: template.event_type,
    ownerType: template.owner_type,
    targetAmount: Number(overrides.targetAmount != null ? overrides.targetAmount : template.target_amount),
    description: template.description,
    eventDate: overrides.eventDate || undefined,
    contributionDeadline: overrides.contributionDeadline || undefined,
    savingsCadence: template.savings_cadence || undefined,
    savingsSessionAmount: template.savings_session_amount,
    rules: template.rules,
  });
  for (const item of template.budget_items || []) {
    if (item && item.category && Number(item.amount) > 0) {
      await pool.query(
        `INSERT INTO event_budget_items (event_id, category, description, amount) VALUES ($1,$2,$3,$4)`,
        [created.id, item.category, item.description || null, Number(item.amount)]
      );
    }
  }
  await pool.query(`UPDATE event_templates SET usage_count = usage_count + 1, updated_at = NOW() WHERE id = $1`, [templateId]);
  return created;
}

// ===================== SERIES (RECURRING EVENTS) =====================

function nextSeriesDate(current, cadence, dayOfMonth) {
  const d = new Date(current);
  const day = d.getUTCDate();
  switch (String(cadence).toUpperCase()) {
    case 'WEEKLY': d.setUTCDate(day + 7); break;
    case 'BIWEEKLY': d.setUTCDate(day + 14); break;
    case 'QUARTERLY': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'YEARLY': d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default: {
      d.setUTCMonth(d.getUTCMonth() + 1);
      if (dayOfMonth) d.setUTCDate(Math.min(dayOfMonth, 28));
    }
  }
  return d;
}

async function buildSeriesStart(data) {
  const start = data.startDate || new Date();
  const base = new Date(start);
  if (String(data.cadence || 'MONTHLY').toUpperCase() === 'MONTHLY' && data.dayOfMonth) {
    base.setUTCDate(Math.min(Number(data.dayOfMonth), 28));
  }
  return base.toISOString().slice(0, 10);
}

async function createEventSeries(userId, data) {
  const name = String(data.name || '').trim();
  if (!name) throw badge('Jina la mfululizo ni lazima.', 400);
  const cadence = String(data.cadence || 'MONTHLY').toUpperCase();
  if (!['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].includes(cadence)) throw badge('Kadensi haijulikani.', 400);
  const dayOfMonth = data.dayOfMonth ? Math.min(Math.max(Number(data.dayOfMonth), 1), 28) : null;
  const templateId = data.templateId != null ? Number(data.templateId) : null;
  const nextRunAt = await buildSeriesStart(data);
  const { rows } = await pool.query(
    `INSERT INTO event_series
       (owner_id, template_id, name, cadence, day_of_month, event_type, target_amount, rules, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, templateId, name, cadence, dayOfMonth,
     data.eventType ? String(data.eventType).toUpperCase() : 'OTHER',
     data.targetAmount != null ? Number(data.targetAmount) : null,
     JSON.stringify(data.rules && typeof data.rules === 'object' ? data.rules : {}),
     nextRunAt]
  );
  return rows[0];
}

async function listEventSeries(userId) {
  const { rows } = await pool.query(
    `SELECT s.*, t.name AS template_name, e.name AS last_event_name,
       (SELECT COUNT(*) FROM social_events se WHERE se.series_id = s.id) AS events_count
     FROM event_series s
     LEFT JOIN event_templates t ON t.id = s.template_id
     LEFT JOIN social_events e ON e.id = s.last_event_id
     WHERE s.owner_id = $1 ORDER BY s.created_at DESC`, [userId]
  );
  return rows;
}

async function updateEventSeries(userId, seriesId, patch) {
  const series = await getSeriesForOwner(userId, seriesId);
  const sets = ['name', 'cadence', 'day_of_month', 'event_type', 'target_amount', 'rules', 'template_id', 'active', 'next_run_at'];
  const allowed = Object.keys(patch).filter((k) => sets.includes(k));
  if (allowed.length === 0) throw badge('Hakuna sehemu inayoweza kusasishwa.', 400);
  const cols = [];
  const vals = [];
  let idx = 1;
  for (const key of allowed) {
    let value = patch[key];
    if (key === 'cadence') value = String(value).toUpperCase();
    if (key === 'event_type') value = String(value).toUpperCase();
    if (key === 'rules') value = JSON.stringify(value || {});
    if (key === 'active') value = value === true || value === 'true';
    cols.push(`${key} = $${idx++}`);
    vals.push(value);
  }
  vals.push(seriesId);
  const { rows } = await pool.query(`UPDATE event_series SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${idx} RETURNING *`, vals);
  return rows[0];
}

async function getSeriesForOwner(userId, seriesId) {
  const { rows } = await pool.query(`SELECT * FROM event_series WHERE id = $1`, [seriesId]);
  if (rows.length === 0) throw badge('Mfululizo haupo.', 404);
  if (rows[0].owner_id !== userId) throw badge('Huna ruhusa ya mfululizo huu.', 403);
  return rows[0];
}

async function generateNextEventFromSeries(seriesId, force = false) {
  const series = await pool.query(`SELECT * FROM event_series WHERE id = $1`, [seriesId]);
  if (series.rows.length === 0) throw badge('Mfululizo haupo.', 404);
  const s = series.rows[0];
  if (!s.active && !force) throw badge('Mfululizo hauko aktifu.', 400);
  if (!s.next_run_at) throw badge('Hakuna tarehe iliyopangwa (next_run_at).', 400);

  let template = null;
  if (s.template_id) {
    const t = await pool.query(`SELECT * FROM event_templates WHERE id = $1`, [s.template_id]);
    template = t.rows.length ? t.rows[0] : null;
  }

  const eventDate = s.next_run_at instanceof Date ? localDateOnly(s.next_run_at) : s.next_run_at;
  const created = await createEvent(s.owner_id, {
    name: `${s.name} — ${eventDate}`,
    eventType: template ? template.event_type : s.event_type,
    ownerType: template ? template.owner_type : 'INDIVIDUAL',
    targetAmount: Number(template && template.target_amount ? template.target_amount : (s.target_amount || 1)),
    description: template ? template.description : null,
    eventDate,
    savingsCadence: template ? template.savings_cadence : null,
    savingsSessionAmount: template ? template.savings_session_amount : null,
    rules: template ? template.rules : s.rules,
  });

  if (template && Array.isArray(template.budget_items)) {
    for (const item of template.budget_items) {
      if (item && item.category && Number(item.amount) > 0) {
        await pool.query(
          `INSERT INTO event_budget_items (event_id, category, description, amount) VALUES ($1,$2,$3,$4)`,
          [created.id, item.category, item.description || null, Number(item.amount)]
        );
      }
    }
  }

  await pool.query(`UPDATE social_events SET series_id = $1, updated_at = NOW() WHERE id = $2`, [s.id, created.id]);

  const next = nextSeriesDate(s.next_run_at, s.cadence, s.day_of_month);
  await pool.query(
    `UPDATE event_series SET last_event_id = $1, events_generated = events_generated + 1, next_run_at = $2, updated_at = NOW() WHERE id = $3`,
    [created.id, next.toISOString().slice(0, 10), s.id]
  );

  if (template) {
    await pool.query(`UPDATE event_templates SET usage_count = usage_count + 1, updated_at = NOW() WHERE id = $1`, [template.id]);
  }

  await logAudit({ userId: s.owner_id, eventType: 'EVENT_SERIES_GENERATE', entityType: 'event_series', entityId: s.id,
    afterData: { eventId: created.id } });
  return created;
}

async function runDueEventSeries() {
  try {
    const due = await pool.query(
      `SELECT id FROM event_series WHERE active AND next_run_at IS NOT NULL AND next_run_at <= CURRENT_DATE ORDER BY next_run_at LIMIT 20`
    );
    let generated = 0;
    let failed = 0;
    for (const row of due.rows) {
      try {
        await generateNextEventFromSeries(row.id);
        generated++;
      } catch (e) {
        failed++;
        logger.error('EVENT_SERIES_RUN', `series ${row.id} failed: ${e.message}`);
      }
    }
    if (generated + failed > 0) logger.info('EVENT_SERIES', `generated=${generated} failed=${failed}`);
    return { due: due.rows.length, generated, failed };
  } catch (e) {
    logger.error('EVENT_SERIES_RUN', e.message);
    return { error: e.message };
  }
}

async function listSeriesEvents(userId, seriesId) {
  await getSeriesForOwner(userId, seriesId);
  const { rows } = await pool.query(
    `SELECT id, name, event_date, status, target_amount, collected_amount, savings_amount, created_at
     FROM social_events WHERE series_id = $1 ORDER BY event_date DESC`, [seriesId]
  );
  return rows;
}

// ===================== REPORTS & EXPORT =====================

function toCsv(rows) {
  if (!rows || rows.length === 0) return 'No data';
  const headers = Object.keys(rows[0]).join(',');
  const lines = rows.map((row) =>
    Object.values(row).map((v) => {
      if (v === null || v === undefined) return '';
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')
  );
  return [headers, ...lines].join('\n');
}

async function getEventReport(eventId) {
  const event = await findEventById(eventId);
  const owner = await pool.query(`SELECT full_name FROM users WHERE id = $1`, [event.owner_user_id]);
  const [contributions, members, budget, withdrawals, commitments, collect] = await Promise.all([
    pool.query(
      `SELECT c.mode, c.amount, c.reference_id, c.status, c.created_at, COALESCE(c.contributor_name, u.full_name) AS contributor
       FROM event_contributions c LEFT JOIN users u ON u.id = c.user_id WHERE c.event_id = $1 ORDER BY c.created_at`,
      [eventId]
    ),
    pool.query(
      `SELECT m.user_id, u.full_name AS user_name, m.role, m.status, m.joined_at,
         COALESCE((SELECT SUM(c.amount) FROM event_contributions c WHERE c.event_id = m.event_id AND c.user_id = m.user_id AND c.status='SUCCESS'),0)::float AS contributed
       FROM event_members m JOIN users u ON u.id = m.user_id
       WHERE m.event_id = $1 ORDER BY (m.role = 'OWNER') DESC, u.full_name`,
      [eventId]
    ),
    pool.query(`SELECT category, description, amount FROM event_budget_items WHERE event_id = $1 ORDER BY created_at`, [eventId]),
    pool.query(
      `SELECT w.mode, w.amount, w.status, w.requires_approval, w.reference_id, w.paid_at, w.created_at, COALESCE(u.full_name, '') AS recipient
       FROM event_withdrawals w LEFT JOIN users u ON u.id = w.user_id WHERE w.event_id = $1 ORDER BY w.created_at DESC`,
      [eventId]
    ),
    pool.query(
      `SELECT c.amount, c.fulfilled, c.status, c.note, c.created_at, u.full_name AS user_name
       FROM event_commitments c JOIN users u ON u.id = c.user_id WHERE c.event_id = $1 ORDER BY c.created_at`,
      [eventId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE mode='FUNDRAISING' AND status='SUCCESS'),0)::float AS fundraising,
              COALESCE(SUM(amount) FILTER (WHERE mode='SAVINGS' AND status='SUCCESS'),0)::float AS savings,
              SUM(amount)::float AS total,
              COUNT(*)::int AS donations,
              COUNT(DISTINCT user_id)::int AS contributors
       FROM event_contributions WHERE event_id = $1`,
      [eventId]
    ),
  ]);
  const collected = collect.rows[0] || { fundraising: 0, savings: 0, total: 0, donations: 0, contributors: 0 };
  const budgetTotal = budget.rows.reduce((a, b) => a + Number(b.amount), 0);
  return {
    event: {
      id: event.id, name: event.name, eventType: event.event_type, description: event.description,
      ownerUserId: event.owner_user_id,
      ownerName: owner.rows.length ? owner.rows[0].full_name : '',
      eventDate: event.event_date, contributionDeadline: event.contribution_deadline,
      status: event.status, createdAt: event.created_at, targetAmount: Number(event.target_amount),
    },
    summary: {
      collected: {
        fundraising: collected.fundraising,
        savings: collected.savings,
        total: collected.total,
      },
      remaining: Math.max(Number(event.target_amount) - collected.fundraising - collected.savings, 0),
      progress: Number(event.target_amount) > 0
        ? Math.min(Math.round(((collected.fundraising + collected.savings) / Number(event.target_amount)) * 100), 100) : 0,
      budgetTotal,
      budgetCoverage: budgetTotal > 0 ? Math.min(Math.round((collected.total / budgetTotal) * 100), 100) : 0,
      donations: collected.donations,
      contributors: collected.contributors,
      activeMembers: members.rows.filter((m) => m.status === 'ACTIVE').length,
    },
    contributions: contributions.rows,
    members: members.rows,
    budget: budget.rows,
    withdrawals: withdrawals.rows,
    commitments: commitments.rows,
  };
}

async function exportEventReportCsv(eventId, section) {
  const report = await getEventReport(eventId);
  const sec = String(section || 'all').toLowerCase();
  if (sec === 'contributions') return toCsv(report.contributions);
  if (sec === 'members') return toCsv(report.members.map((m) => ({ ...m, contributed: m.contributed })));
  if (sec === 'budget') return toCsv(report.budget);
  if (sec === 'withdrawals') return toCsv(report.withdrawals);
  if (sec === 'commitments') return toCsv(report.commitments);
  const out = [];
  out.push(['SECTION: SUMMARY'].join());
  out.push(toCsv([{ Event: report.event.name, Type: report.event.eventType, Status: report.event.status,
    Target: report.event.targetAmount, Fundraising: report.summary.collected.fundraising,
    Savings: report.summary.collected.savings, Total_Collected: report.summary.collected.total,
    Progress_Pct: report.summary.progress, Budget_Total: report.summary.budgetTotal,
    Donations: report.summary.donations, Contributors: report.summary.contributors,
    Active_Members: report.summary.activeMembers }]));
  out.push(['', 'SECTION: CONTRIBUTIONS'].join());
  out.push(toCsv(report.contributions));
  out.push(['', 'SECTION: MEMBERS'].join());
  out.push(toCsv(report.members));
  out.push(['', 'SECTION: BUDGET'].join());
  out.push(toCsv(report.budget));
  out.push(['', 'SECTION: WITHDRAWALS'].join());
  out.push(toCsv(report.withdrawals));
  out.push(['', 'SECTION: COMMITMENTS'].join());
  out.push(toCsv(report.commitments));
  return out.filter(Boolean).join('\n');
}

// ===================== ADMIN OVERSIGHT =====================

async function listAllEvents({ search, status, page = 1, limit = 100 }) {
  const offset = (Math.max(page, 1) - 1) * Math.min(limit, 200);
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.event_type, e.status, e.target_amount, e.collected_amount, e.savings_amount,
            e.event_date, e.created_at, u.full_name AS owner_name, u.phone_number AS owner_phone,
       (SELECT COUNT(*) FROM event_contributions c WHERE c.event_id = e.id AND c.status='SUCCESS') AS donations,
       (SELECT COUNT(*) FROM event_members m WHERE m.event_id = e.id AND m.status='ACTIVE') AS active_members,
       (SELECT COUNT(*) FROM event_withdrawals w WHERE w.event_id = e.id) AS withdrawals_count
     FROM social_events e JOIN users u ON u.id = e.owner_user_id
     WHERE ($1::text IS NULL OR e.name ILIKE '%' || $1 || '%')
       AND ($2::text IS NULL OR e.status = $2)
     ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`,
    [search || null, status || null, Math.min(limit, 200), offset]
  );
  return rows;
}

async function getWithdrawalsOverview({ status, page = 1, limit = 100 }) {
  const offset = (Math.max(page, 1) - 1) * Math.min(limit, 200);
  const { rows } = await pool.query(
    `SELECT w.id, w.event_id, e.name AS event_name, uo.full_name AS owner_name,
            w.mode, w.amount, w.status, w.requires_approval, w.reference_id, w.created_at, w.paid_at,
            r.full_name AS recipient_name
     FROM event_withdrawals w
     JOIN social_events e ON e.id = w.event_id
     JOIN users uo ON uo.id = e.owner_user_id
     LEFT JOIN users r ON r.id = w.user_id
     WHERE ($1::text IS NULL OR w.status = $1)
     ORDER BY w.created_at DESC LIMIT $2 OFFSET $3`,
    [status || null, Math.min(limit, 200), offset]
  );
  // Flag: large withdrawals (>= threshold) ya kukaribishwa na mchango wa hivi karibuni.
  const flagged = rows.filter((r) => r.requires_approval).map((r) => r.id);
  return { withdrawals: rows, flags: { requiresApproval: flagged } };
}

module.exports = {
  createEvent,
  listUserEvents,
  getEventContents,
  updateEvent,
  contribute,
  listContributions,
  addBudgetItem,
  listBudget,
  deleteBudgetItem,
  makeCommitment,
  listCommitments,
  cancelCommitment,
  createSavingsPlan,
  listSavingsPlans,
  closeSavingsPlan,
  eventDashboard,
  requestEventWithdrawal,
  executeEventWithdrawal,
  listEventWithdrawals,
  cancelEventWithdrawal,
  createInvite,
  listInvites,
  joinEventByCode,
  addMemberByPhone,
  listEventMembers,
  removeMember,
  listEventReminders,
  runEventReminders,
  ensurePublicShare,
  getPublicEvent,
  joinEventByPublicLink,
  createEventTemplate,
  listEventTemplates,
  getEventTemplate,
  deleteEventTemplate,
  saveEventAsTemplate,
  createEventFromTemplate,
  createEventSeries,
  listEventSeries,
  updateEventSeries,
  generateNextEventFromSeries,
  runDueEventSeries,
  listSeriesEvents,
  getEventReport,
  exportEventReportCsv,
  listAllEvents,
  getWithdrawalsOverview,
};