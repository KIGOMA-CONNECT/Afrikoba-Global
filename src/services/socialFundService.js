/**
 * Afrikoba Social Fund & Msaada Service
 * Event-based cooperative support (Rambirambi, medical, emergency, disaster)
 * with dedicated ledger segregation and privacy controls.
 *
 * Increment 1: SF-01 to SF-10 remediation
 */

const pool = require('../config/db');
const fin = require('./financialEngine');
const { generateReference } = require('../utils/helpers');
const { strictAmount } = require('../utils/strictAmount');
const { writeAudit } = require('./auditService');

function sameUserId(a, b) {
  return a != null && b != null && String(a) === String(b);
}
const ALLOWED_CONTEXT_TYPES = ['FAMILY', 'WORKPLACE', 'SCHOOL', 'BUSINESS', 'FRIENDS', 'ASSOCIATION', 'COMMUNITY'];
const ALLOWED_CASE_TYPES = ['RAMBIRAMBI', 'MEDICAL', 'ACCIDENT', 'DISASTER', 'EMERGENCY', 'OTHER'];
const ALLOWED_PRIVACY_MODES = ['PUBLIC', 'MEMBERS_ONLY', 'ANONYMOUS_AMOUNTS'];
const ALLOWED_STATUSES = ['OPEN', 'COLLECTING', 'CLOSED', 'CANCELLED', 'EXPIRED', 'TARGET_REACHED', 'DISBURSEMENT_PENDING', 'PARTIALLY_DISBURSED', 'DISBURSED'];

// ---- Lifecycle state definitions (SF-10) ----

const LIFECYCLE_STATES = ['OPEN', 'COLLECTING', 'TARGET_REACHED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DISBURSEMENT_PENDING', 'PARTIALLY_DISBURSED', 'DISBURSED'];

const ALLOWED_TRANSITIONS = {
  OPEN: ['COLLECTING', 'CLOSED', 'CANCELLED', 'EXPIRED'],
  COLLECTING: ['TARGET_REACHED', 'CLOSED', 'CANCELLED', 'EXPIRED'],
  TARGET_REACHED: ['CLOSED', 'CANCELLED', 'DISBURSEMENT_PENDING'],
  CLOSED: ['CANCELLED', 'DISBURSEMENT_PENDING'],
  CANCELLED: [],
  EXPIRED: ['CANCELLED'],
  DISBURSEMENT_PENDING: ['PARTIALLY_DISBURSED', 'DISBURSED', 'CANCELLED'],
  PARTIALLY_DISBURSED: ['DISBURSED', 'CANCELLED'],
  DISBURSED: [],
};

function canTransition(from, to) {
  if (!LIFECYCLE_STATES.includes(from) || !LIFECYCLE_STATES.includes(to)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

const CONTRIBUTION_ALLOWED_STATES = ['OPEN', 'COLLECTING'];

// ---- Helpers ----

function requireField(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw Object.assign(new Error(`${name} inahitajika.`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
}

function validateEnum(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw Object.assign(new Error(`${name} si sahihi. Thamani zinazoruhusiwa: ${allowed.join(', ')}.`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
}

async function userExists(client, userId) {
  const res = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
  return res.rows.length > 0;
}

async function isAdmin(client, userId) {
  const res = await client.query("SELECT 1 FROM users WHERE id = $1 AND role = 'ADMIN'", [userId]);
  return res.rows.length > 0;
}

// ---- Case creation (SF-14) ----

async function createCase(userId, { contextType, caseType, beneficiaryName, beneficiaryPhone, title, description, targetAmount, deadline, privacyMode }) {
  requireField(beneficiaryName, 'Jina la mhusika (beneficiaryName)');
  requireField(title, 'Kichwa (title)');
  requireField(deadline, 'Mwisho (deadline)');

  const ctx = contextType || 'COMMUNITY';
  const ct = caseType || 'RAMBIRAMBI';
  const pm = privacyMode || 'MEMBERS_ONLY';

  validateEnum(ctx, ALLOWED_CONTEXT_TYPES, 'contextType');
  validateEnum(ct, ALLOWED_CASE_TYPES, 'caseType');
  validateEnum(pm, ALLOWED_PRIVACY_MODES, 'privacyMode');

  const amount = strictAmount(targetAmount, { field: 'targetAmount' });

  const deadlineDate = new Date(deadline);
  if (isNaN(deadlineDate.getTime())) {
    throw Object.assign(new Error('Mwisho (deadline) si tarehe sahihi.'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (deadlineDate <= new Date()) {
    throw Object.assign(new Error('Mwisho (deadline) lazima uwe baadaye.'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO social_fund_cases (initiator_id, context_type, case_type, beneficiary_name, beneficiary_phone, title, description, target_amount, deadline, privacy_mode, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN') RETURNING *`,
      [userId, ctx, ct, beneficiaryName.trim(), beneficiaryPhone || null, title.trim(), description || null, amount, deadlineDate.toISOString(), pm]
    );

    const caseData = result.rows[0];

    await writeAudit({
      userId,
      action: 'SOCIAL_FUND_CASE_CREATED',
      entityType: 'SOCIAL_FUND_CASE',
      entityId: caseData.id,
      meta: { context_type: ctx, case_type: ct, target_amount: amount, beneficiary: beneficiaryName, privacy_mode: pm },
      client
    });

    await client.query('COMMIT');
    return caseData;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Listing (SF-03: MEMBERS_ONLY privacy filtering in SQL before pagination) ----

async function listCases(status = 'OPEN', { page = 1, limit = 20, currentUserId = null } = {}) {
  const lim = Math.min(100, Math.max(1, limit));
  const offset = (Math.max(1, page) - 1) * lim;
  const params = [];
  let paramIdx = 1;

  const conditions = [];

  if (status) {
    conditions.push(`c.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  if (currentUserId) {
    conditions.push(`(
      c.privacy_mode = 'PUBLIC'
      OR c.privacy_mode = 'ANONYMOUS_AMOUNTS'
      OR c.initiator_id = $${paramIdx}
      OR EXISTS (SELECT 1 FROM social_fund_contributions sc WHERE sc.case_id = c.id AND sc.user_id = $${paramIdx})
    )`);
    params.push(currentUserId);
    paramIdx++;
  } else {
    conditions.push(`c.privacy_mode = 'PUBLIC'`);
  }

  let query = `SELECT c.*, u.full_name AS initiator_name FROM social_fund_cases c JOIN users u ON c.initiator_id = u.id`;
  if (conditions.length > 0) {
    query += ` WHERE ` + conditions.join(' AND ');
  }
  query += ` ORDER BY c.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(lim, offset);

  const res = await pool.query(query, params);

  // Mask total_collected for outsiders viewing ANONYMOUS_AMOUNTS campaigns (SF03-03: set-based, no N+1)
  if (currentUserId) {
    const anonCaseIds = res.rows
      .filter(r => r.privacy_mode === 'ANONYMOUS_AMOUNTS' && !sameUserId(r.initiator_id, currentUserId))
      .map(r => r.id);
    if (anonCaseIds.length > 0) {
      const contribRes = await pool.query(
        'SELECT DISTINCT case_id FROM social_fund_contributions WHERE case_id = ANY($1) AND user_id = $2',
        [anonCaseIds, currentUserId]
      );
      const contributorCaseIds = new Set(contribRes.rows.map(r => r.case_id));
      for (const row of res.rows) {
        if (row.privacy_mode === 'ANONYMOUS_AMOUNTS' && !sameUserId(row.initiator_id, currentUserId)) {
          if (!contributorCaseIds.has(row.id)) {
            row.total_collected = null;
          }
        }
      }
    }
  }

  return res.rows;
}

// ---- Case details ----

async function getCaseDetails(caseId, currentUserId) {
  const c = await pool.query(
    `SELECT c.*, u.full_name AS initiator_name FROM social_fund_cases c JOIN users u ON c.initiator_id = u.id WHERE c.id = $1`,
    [caseId]
  );
  if (c.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });

  const caseData = c.rows[0];

  const isInitiator = sameUserId(caseData.initiator_id, currentUserId);
  const contribCheck = await pool.query(
    'SELECT 1 FROM social_fund_contributions WHERE case_id = $1 AND user_id = $2 LIMIT 1',
    [caseId, currentUserId]
  );
  const isContributor = contribCheck.rows.length > 0;
  const isOutsider = !isInitiator && !isContributor;

  // Fail-closed: reject unknown or NULL privacy modes for outsiders
  if (!ALLOWED_PRIVACY_MODES.includes(caseData.privacy_mode)) {
    if (isOutsider) {
      throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });
    }
  }

  // MEMBERS_ONLY: only initiator or contributors may view
  if (caseData.privacy_mode === 'MEMBERS_ONLY' && isOutsider) {
    throw Object.assign(new Error('Kesi hii ni ya wanachama tu.'), { statusCode: 403, code: 'ACCESS_DENIED' });
  }

  // Select user_id for privacy masking
  const contribs = await pool.query(
    `SELECT sc.id, sc.user_id, sc.amount, sc.is_anonymous, sc.created_at, u.full_name FROM social_fund_contributions sc
     JOIN users u ON sc.user_id = u.id WHERE sc.case_id = $1 ORDER BY sc.created_at DESC`,
    [caseId]
  );

  // Apply privacy masks
  const maskedContribs = contribs.rows.map((co) => {
    const result = { ...co };

    // Anonymous contributor identity masking
    if (co.is_anonymous && !sameUserId(co.user_id, currentUserId)) {
      result.full_name = 'Mwanachama (Anonymous)';
    }

    // ANONYMOUS_AMOUNTS: mask amount for outsiders
    if (caseData.privacy_mode === 'ANONYMOUS_AMOUNTS' && isOutsider) {
      result.amount = null;
    }

    return result;
  });

  // Mask total_collected for outsiders on ANONYMOUS_AMOUNTS campaigns
  if (caseData.privacy_mode === 'ANONYMOUS_AMOUNTS' && isOutsider) {
    caseData.total_collected = null;
  }

  return { case: caseData, contributions: maskedContribs };
}

// ---- Contributions (SF-05, SF-06, SF-07, SF-08, SF-09, SF-10) ----

async function contribute(userId, caseId, amount, isAnonymous = false, idempotencyKey = null) {
  const amountNum = strictAmount(amount, { field: 'amount' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check
    if (idempotencyKey) {
      const existing = await client.query(
        'SELECT * FROM social_fund_contributions WHERE case_id = $1 AND user_id = $2 AND idempotency_key = $3',
        [caseId, userId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        const orig = existing.rows[0];
        // GSF-FIN-05: validate amount AND anonymity
        if (Number(orig.amount) !== amountNum) {
          throw Object.assign(new Error('Idempotency key reused with different amount.'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        if (Boolean(orig.is_anonymous) !== Boolean(isAnonymous)) {
          throw Object.assign(new Error('Idempotency key reused with different anonymity.'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        return { success: true, referenceId: orig.reference_id, totalCollected: null, status: null, message: 'Mchango uliopo tayari umerekodiwa (replay).' };
      }
    }

    // Case lock
    const caseRes = await client.query('SELECT * FROM social_fund_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (caseRes.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });
    const c = caseRes.rows[0];

    // Status check (SF-10)
    if (!CONTRIBUTION_ALLOWED_STATES.includes(c.status)) {
      throw Object.assign(new Error('Mchango huu umefungwa.'), { statusCode: 400, code: 'CASE_CLOSED' });
    }

    // Deadline check (SF-09)
    if (new Date(c.deadline) < new Date()) {
      throw Object.assign(new Error('Muda wa mchango umekwisha.'), { statusCode: 400, code: 'DEADLINE_EXPIRED' });
    }

    // Target reached check
    if (Number(c.total_collected) >= Number(c.target_amount)) {
      throw Object.assign(new Error('Lengo la mchango limetimia.'), { statusCode: 400, code: 'TARGET_REACHED' });
    }

    // User existence check (SF-07)
    const userRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (userRes.rows.length === 0) {
      throw Object.assign(new Error('Mtumiaji haipatikani.'), { statusCode: 404, code: 'USER_NOT_FOUND' });
    }
    if (Number(userRes.rows[0].wallet_balance) < amountNum) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400, code: 'INSUFFICIENT_BALANCE' });
    }

    const referenceId = generateReference('SOC');

    // GSF-FIN-01/02: Prelink transaction identity before journal posting
    const txRes = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta, product_type, product_ref)
       VALUES ($1, $2, $3, 0, $3, 'PENDING', 'SOCIAL_FUND_CONTRIBUTION', $4, 'SOCIAL_FUND', $5)
       ON CONFLICT (reference_id) DO NOTHING
       RETURNING id`,
      [referenceId, userId, amountNum, JSON.stringify({ case_id: caseId, is_anonymous: isAnonymous }), String(caseId)]
    );
    let transactionId;
    if (txRes.rows.length > 0) {
      transactionId = txRes.rows[0].id;
    } else {
      // Transaction already exists (replay) — fetch existing
      const existingTx = await client.query(
        'SELECT id FROM transactions WHERE reference_id = $1',
        [referenceId]
      );
      transactionId = existingTx.rows[0].id;
    }

    // Debit user wallet and credit SOCIAL_FUND clearing (with idempotency)
    const debitResult = await fin.debitWallet({
      client,
      userId,
      amount: amountNum,
      reference: referenceId,
      transactionId: transactionId,
      toAccount: 'SOCIAL_FUND_CLEARING',
      description: `Mchango wa jamii: ${c.title}`,
      actor: 'engine:social_fund',
      productType: 'SOCIAL_FUND',
      productRef: caseId
    });

    // Update transaction status to SUCCESS after successful debit
    await client.query(
      `UPDATE transactions SET status = 'SUCCESS', updated_at = NOW() WHERE id = $1`,
      [transactionId]
    );

    // Handle dedup (SF-08)
    if (debitResult.dedup) {
      const existingContrib = await client.query(
        'SELECT * FROM social_fund_contributions WHERE reference_id = $1',
        [referenceId]
      );
      if (existingContrib.rows.length > 0) {
        const orig = existingContrib.rows[0];
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        return { success: true, referenceId: orig.reference_id, totalCollected: Number(c.total_collected), status: c.status, message: 'Mchango uliopo tayari umerekodiwa (replay).' };
      }
      throw Object.assign(new Error('Hali isiyotarajiwa: mchango umedaiwa lakini hakuna rekodi.'), { statusCode: 500, code: 'INCONSISTENT_STATE' });
    }

    await client.query(
      `INSERT INTO social_fund_contributions (case_id, user_id, amount, is_anonymous, reference_id, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'SUCCESS')`,
      [caseId, userId, amountNum, isAnonymous, referenceId, idempotencyKey || null]
    );

    const newTotal = Number(c.total_collected) + amountNum;
    // Determine new status: TARGET_REACHED if target met, COLLECTING if was OPEN,
    // otherwise keep current status (COLLECTING stays COLLECTING)
    let newStatus;
    if (newTotal >= Number(c.target_amount)) {
      newStatus = 'TARGET_REACHED';
    } else if (c.status === 'OPEN') {
      newStatus = 'COLLECTING';
    } else {
      newStatus = c.status; // COLLECTING stays COLLECTING
    }

    await client.query(
      `UPDATE social_fund_cases SET total_collected = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newTotal, newStatus, caseId]
    );

    // Audit within transaction
    await writeAudit({
      userId,
      action: 'SOCIAL_FUND_CONTRIBUTION',
      entityType: 'SOCIAL_FUND_CASE',
      entityId: caseId,
      meta: { case_id: caseId, amount: amountNum, reference_id: referenceId, is_anonymous: isAnonymous },
      client
    });

    await client.query('COMMIT');

    return { success: true, referenceId, totalCollected: newTotal, status: newStatus, message: 'Asante kwa mchango wako.' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Payouts (SF-01, SF-22-SF-25) ----

async function requestPayout(caseId, adminId, recipientPhone, amount, idempotencyKey = null) {
  const amountNum = strictAmount(amount, { field: 'amount' });

  if (!recipientPhone || String(recipientPhone).trim() === '') {
    throw Object.assign(new Error('Namba ya simu ya mpokeaji inahitajika.'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify admin authorization
    const adminCheck = await client.query("SELECT 1 FROM users WHERE id = $1 AND role = 'ADMIN'", [adminId]);
    if (adminCheck.rows.length === 0) {
      throw Object.assign(new Error('Mtu huyu si msimamizi (admin).'), { statusCode: 403, code: 'ACCESS_DENIED' });
    }

    // Case lock
    const caseRes = await client.query('SELECT * FROM social_fund_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (caseRes.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });
    const c = caseRes.rows[0];

    // Case status check
    if (c.status !== 'CLOSED' && c.status !== 'COLLECTING' && c.status !== 'TARGET_REACHED') {
      throw Object.assign(new Error('Kesi hii haiwezi kulipwa kwa sasa.'), { statusCode: 400, code: 'INVALID_STATUS' });
    }

    // Beneficiary verification: recipient must match beneficiary phone
    if (c.beneficiary_phone && c.beneficiary_phone !== recipientPhone) {
      throw Object.assign(new Error('Namba ya simu ya mpokeaji haifanani na mhusika.'), { statusCode: 400, code: 'RECIPIENT_MISMATCH' });
    }

    // Idempotency check (GSF-PAY-02: resolve existing request before funds availability)
    if (idempotencyKey) {
      const existing = await client.query(
        'SELECT * FROM social_fund_payouts WHERE case_id = $1 AND idempotency_key = $2',
        [caseId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        const orig = existing.rows[0];
        // GSF-PAY-03: validate amount AND recipient
        if (Number(orig.amount) !== amountNum) {
          throw Object.assign(new Error('Idempotency key reused with different amount.'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        if (orig.recipient_phone !== recipientPhone) {
          throw Object.assign(new Error('Idempotency key reused with different recipient.'), { statusCode: 409, code: 'IDEMPOTENCY_CONFLICT' });
        }
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        return { success: true, payout: orig, message: 'Malipo yaliopo tayari yamerekodiwa (replay).' };
      }
    }

    // Available balance check (GSF-PAY-01: PENDING payouts reserve funds immediately)
    const payoutSum = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total_reserved FROM social_fund_payouts WHERE case_id = $1 AND status IN ('PENDING', 'APPROVED', 'DISBURSED')",
      [caseId]
    );
    const available = Number(c.total_collected) - Number(payoutSum.rows[0].total_reserved);
    if (amountNum > available) {
      throw Object.assign(new Error(`Kiasi kinacholipwa (${amountNum}) kinazidi kilichopo (${available}).`), { statusCode: 400, code: 'INSUFFICIENT_FUNDS' });
    }

    const referenceId = generateReference('SOP');

    // CR-03: Prelink transaction identity before payout creation
    const txRes = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta, product_type, product_ref)
       VALUES ($1, $2, $3, 0, $3, 'PENDING', 'SOCIAL_FUND_PAYOUT', $4, 'SOCIAL_FUND', $5)
       ON CONFLICT (reference_id) DO NOTHING
       RETURNING id`,
      [referenceId, adminId, amountNum, JSON.stringify({ case_id: caseId, recipient_phone: recipientPhone }), String(caseId)]
    );
    let transactionId;
    if (txRes.rows.length > 0) {
      transactionId = txRes.rows[0].id;
    } else {
      const existingTx = await client.query('SELECT id FROM transactions WHERE reference_id = $1', [referenceId]);
      transactionId = existingTx.rows[0].id;
    }

    const res = await client.query(
      `INSERT INTO social_fund_payouts (case_id, authorized_by, amount, recipient_phone, reference_id, idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING') RETURNING *`,
      [caseId, adminId, amountNum, recipientPhone, referenceId, idempotencyKey || null]
    );

    // Update transaction status to PENDING (will be updated on disbursement)
    // Transaction is already linked via reference_id = referenceId

    const payout = res.rows[0];

    // Audit within transaction
    await writeAudit({
      userId: adminId,
      action: 'SOCIAL_FUND_PAYOUT_REQUESTED',
      entityType: 'SOCIAL_FUND_PAYOUT',
      entityId: payout.id,
      meta: { case_id: caseId, amount: amountNum, recipient_phone: recipientPhone, reference_id: referenceId },
      client
    });

    await client.query('COMMIT');

    return { success: true, payout, message: 'Ombi la malipo limewasilishwa.' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Case status transition (SF-10) ----

// SF10-01: Institution-scoped authorization helper
// Approved policy: "Campaign status changes may be made by any user explicitly
// authorized under the institution's role/permission structure."
// Global ADMIN alone does NOT substitute for the required institution permission.
async function hasCaseStatusPermission(client, userId, caseData) {
  // SF10-01: Institution-scoped authorization (not initiator-only, not global-ADMIN-only)
  // Approved policy: "Campaign status changes may be made by any user explicitly
  // authorized under the institution's role/permission structure."
  // Global ADMIN alone does NOT substitute for the required institution permission.
  // Initiator-only authorization is NOT permitted (OD-10 R1 remediation).
  // 1. Check explicit permission grant in social_fund_case_permissions table
  //    (institution-scoped: user must have explicit grant for this specific case)
  try {
    const permRes = await client.query(
      'SELECT 1 FROM social_fund_case_permissions WHERE case_id = $1 AND user_id = $2 AND permission = $3 AND revoked_at IS NULL',
      [caseData.id, userId, 'CHANGE_STATUS']
    );
    if (permRes.rows.length > 0) return true;
  } catch (e) {
    // Table may not exist yet (migration not applied) — fail closed
    // Global ADMIN alone does not substitute for institution permission
  }

  // 2. No global ADMIN bypass — institution permission required
  return false;
}

async function changeCaseStatus(caseId, userId, newStatus, reason = null) {
  if (!LIFECYCLE_STATES.includes(newStatus)) {
    throw Object.assign(new Error(`Hali '${newStatus}' si sahihi.`), { statusCode: 400, code: 'INVALID_STATUS' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const caseRes = await client.query('SELECT * FROM social_fund_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (caseRes.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });
    const c = caseRes.rows[0];

    // SF10-01: Institution-scoped authorization (not initiator-only)
    // The campaign initiator is authorized. Additional authorization should be
    // granted via institution-scoped role/permission checks (GOV-AC-02).
    // TODO: Replace with full institution-scoped permission model when available.
    // SF10-01: Institution-scoped authorization (not initiator-only, not global-ADMIN-only)
    // Approved policy: "Campaign status changes may be made by any user explicitly
    // authorized under the institution's role/permission structure."
    // Global ADMIN alone does NOT substitute for the required institution permission.
    const hasPermission = await hasCaseStatusPermission(client, userId, c);
    if (!hasPermission) {
      throw Object.assign(new Error('Huna ruhusa ya kubadilisha hali ya kesi hii.'), { statusCode: 403, code: 'ACCESS_DENIED' });
    }

    if (!canTransition(c.status, newStatus)) {
      throw Object.assign(new Error(`Hali haiwezi kubadilishwa kutoka '${c.status}' kwenda '${newStatus}'.`), { statusCode: 400, code: 'INVALID_TRANSITION' });
    }

    await client.query(
      `UPDATE social_fund_cases SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, caseId]
    );

    await writeAudit({
      userId,
      action: 'SOCIAL_FUND_CASE_STATUS_CHANGED',
      entityType: 'SOCIAL_FUND_CASE',
      entityId: caseId,
      meta: { from: c.status, to: newStatus, reason },
      client
    });

    await client.query('COMMIT');
    return { success: true, caseId, from: c.status, to: newStatus };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Listing (SF-03: MEMBERS_ONLY privacy filtering in SQL before pagination) ----

async function listCases(status = 'OPEN', { page = 1, limit = 20, currentUserId = null } = {}) {
  const lim = Math.min(100, Math.max(1, limit));
  const offset = (Math.max(1, page) - 1) * lim;
  const params = [];
  let paramIdx = 1;

  const conditions = [];

  if (status) {
    conditions.push(`c.status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  if (currentUserId) {
    conditions.push(`(
      c.privacy_mode = 'PUBLIC'
      OR c.privacy_mode = 'ANONYMOUS_AMOUNTS'
      OR c.initiator_id = $${paramIdx}
      OR EXISTS (SELECT 1 FROM social_fund_contributions sc WHERE sc.case_id = c.id AND sc.user_id = $${paramIdx})
    )`);
    params.push(currentUserId);
    paramIdx++;
  } else {
    conditions.push(`c.privacy_mode = 'PUBLIC'`);
  }

  let query = `SELECT c.*, u.full_name AS initiator_name FROM social_fund_cases c JOIN users u ON c.initiator_id = u.id`;
  if (conditions.length > 0) {
    query += ` WHERE ` + conditions.join(' AND ');
  }
  query += ` ORDER BY c.created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
  params.push(lim, offset);

  const res = await pool.query(query, params);

  // Mask total_collected for outsiders viewing ANONYMOUS_AMOUNTS campaigns
  if (currentUserId) {
    for (const row of res.rows) {
      if (row.privacy_mode === 'ANONYMOUS_AMOUNTS' && !sameUserId(row.initiator_id, currentUserId)) {
        const contribCheck = await pool.query(
          'SELECT 1 FROM social_fund_contributions WHERE case_id = $1 AND user_id = $2 LIMIT 1',
          [row.id, currentUserId]
        );
        if (contribCheck.rows.length === 0) {
          row.total_collected = null;
        }
      }
    }
  }

  return res.rows;
}

// ---- Case details (SF-02, SF-03) ----

async function getCaseDetails(caseId, currentUserId) {
  const c = await pool.query(
    `SELECT c.*, u.full_name AS initiator_name FROM social_fund_cases c JOIN users u ON c.initiator_id = u.id WHERE c.id = $1`,
    [caseId]
  );
  if (c.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });

  const caseData = c.rows[0];

  const isInitiator = sameUserId(caseData.initiator_id, currentUserId);
  const contribCheck = await pool.query(
    'SELECT 1 FROM social_fund_contributions WHERE case_id = $1 AND user_id = $2 LIMIT 1',
    [caseId, currentUserId]
  );
  const isContributor = contribCheck.rows.length > 0;
  const isOutsider = !isInitiator && !isContributor;

  // Fail-closed: reject unknown or NULL privacy modes for outsiders
  if (!ALLOWED_PRIVACY_MODES.includes(caseData.privacy_mode)) {
    if (isOutsider) {
      throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });
    }
  }

  // MEMBERS_ONLY: only initiator or contributors may view
  if (caseData.privacy_mode === 'MEMBERS_ONLY' && isOutsider) {
    throw Object.assign(new Error('Kesi hii ni ya wanachama tu.'), { statusCode: 403, code: 'ACCESS_DENIED' });
  }

  // Select user_id for privacy masking
  const contribs = await pool.query(
    `SELECT sc.id, sc.user_id, sc.amount, sc.is_anonymous, sc.created_at, u.full_name FROM social_fund_contributions sc
     JOIN users u ON sc.user_id = u.id WHERE sc.case_id = $1 ORDER BY sc.created_at DESC`,
    [caseId]
  );

  // Apply privacy masks
  const maskedContribs = contribs.rows.map((co) => {
    const result = { ...co };

    // Anonymous contributor identity masking
    if (co.is_anonymous && !sameUserId(co.user_id, currentUserId)) {
      result.full_name = 'Mwanachama (Anonymous)';
    }

    // ANONYMOUS_AMOUNTS: mask amount for outsiders
    if (caseData.privacy_mode === 'ANONYMOUS_AMOUNTS' && isOutsider) {
      result.amount = null;
    }

    return result;
  });

  // Mask total_collected for outsiders on ANONYMOUS_AMOUNTS campaigns
  if (caseData.privacy_mode === 'ANONYMOUS_AMOUNTS' && isOutsider) {
    caseData.total_collected = null;
  }

  return { case: caseData, contributions: maskedContribs };
}

// ---- Contribution reconciliation (GSF-FIN-08) ----
async function reconcileContributions(caseId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get case
    const caseRes = await client.query('SELECT * FROM social_fund_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (caseRes.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404, code: 'NOT_FOUND' });
    const c = caseRes.rows[0];

    // Get contribution ledger totals
    const contribRes = await client.query(
      'SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM social_fund_contributions WHERE case_id = $1 AND status = \'SUCCESS\'',
      [caseId]
    );
    const ledgerTotal = Number(contribRes.rows[0].total);
    const contribCount = Number(contribRes.rows[0].count);

    // Get journal entry totals for this case
    const journalRes = await client.query(
      "SELECT COALESCE(SUM(CASE WHEN je.direction = 'CR' THEN je.amount ELSE 0 END), 0) AS credits, COALESCE(SUM(CASE WHEN je.direction = 'DR' THEN je.amount ELSE 0 END), 0) AS debits FROM journal_entries je WHERE je.reference_id IN (SELECT reference_id FROM social_fund_contributions WHERE case_id = $1)",
      [caseId]
    );
    const journalCredits = Number(journalRes.rows[0].credits);
    const journalDebits = Number(journalRes.rows[0].debits);

    // Get transaction count
    const txRes = await client.query(
      "SELECT COUNT(*) AS count FROM transactions WHERE product_type = 'SOCIAL_FUND' AND product_ref = $1",
      [String(caseId)]
    );
    const txCount = Number(txRes.rows[0].count);

    const projectedTotal = Number(c.total_collected);

    const discrepancies = [];
    if (Math.abs(ledgerTotal - projectedTotal) > 0.005) {
      discrepancies.push({ type: 'TOTAL_MISMATCH', ledger: ledgerTotal, projected: projectedTotal, diff: ledgerTotal - projectedTotal });
    }
    if (Math.abs(ledgerTotal - journalCredits) > 0.005) {
      discrepancies.push({ type: 'JOURNAL_MISMATCH', ledger: ledgerTotal, journal: journalCredits, diff: ledgerTotal - journalCredits });
    }
    if (contribCount !== txCount) {
      discrepancies.push({ type: 'COUNT_MISMATCH', contributions: contribCount, transactions: txCount, diff: contribCount - txCount });
    }
    if (Math.abs(journalCredits - journalDebits) > 0.005) {
      discrepancies.push({ type: 'UNBALANCED_JOURNAL', credits: journalCredits, debits: journalDebits, diff: journalCredits - journalDebits });
    }

    await client.query('COMMIT');

    return {
      caseId,
      ledgerTotal,
      projectedTotal,
      journalCredits,
      journalDebits,
      contribCount,
      txCount,
      discrepancies,
      reconciled: discrepancies.length === 0,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createCase, listCases, getCaseDetails, contribute, requestPayout, changeCaseStatus, canTransition, hasCaseStatusPermission, reconcileContributions, LIFECYCLE_STATES, ALLOWED_TRANSITIONS, ALLOWED_PRIVACY_MODES, CONTRIBUTION_ALLOWED_STATES };
