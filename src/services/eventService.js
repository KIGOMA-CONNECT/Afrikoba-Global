const pool = require('../config/db');
const { generateReference, formatMoney, maskPhone } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const logger = require('../utils/logger');
const fin = require('./financialEngine');

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
  };
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
};