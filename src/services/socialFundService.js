/**
 * Afrikoba Social Fund & Msaada Service
 * Event-based cooperative support (Rambirambi, medical, emergency, disaster)
 * with dedicated ledger segregation and privacy controls.
 */

const pool = require('../config/db');
const fin = require('./financialEngine');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');

async function createCase(userId, { contextType, caseType, beneficiaryName, beneficiaryPhone, title, description, targetAmount, deadline, privacyMode }) {
  const amount = Number(targetAmount);
  if (!amount || amount <= 0) throw Object.assign(new Error('Kiasi kinacholengwa kinahitajika.'), { statusCode: 400 });

  const result = await pool.query(
    `INSERT INTO social_fund_cases (initiator_id, context_type, case_type, beneficiary_name, beneficiary_phone, title, description, target_amount, deadline, privacy_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [userId, contextType || 'COMMUNITY', caseType || 'RAMBIRAMBI', beneficiaryName, beneficiaryPhone || null, title, description || null, amount, deadline, privacyMode || 'MEMBERS_ONLY']
  );
  return result.rows[0];
}

async function listCases(status = 'OPEN') {
  let query = `SELECT c.*, u.full_name AS initiator_name FROM social_fund_cases c JOIN users u ON c.initiator_id = u.id`;
  const params = [];
  if (status) {
    query += ` WHERE c.status = $1`;
    params.push(status);
  }
  query += ` ORDER BY c.created_at DESC`;
  const res = await pool.query(query, params);
  return res.rows;
}

async function getCaseDetails(caseId, currentUserId) {
  const c = await pool.query(
    `SELECT c.*, u.full_name AS initiator_name FROM social_fund_cases c JOIN users u ON c.initiator_id = u.id WHERE c.id = $1`,
    [caseId]
  );
  if (c.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404 });

  const caseData = c.rows[0];
  const contribs = await pool.query(
    `SELECT sc.id, sc.amount, sc.is_anonymous, sc.created_at, u.full_name FROM social_fund_contributions sc
     JOIN users u ON sc.user_id = u.id WHERE sc.case_id = $1 ORDER BY sc.created_at DESC`,
    [caseId]
  );

  // Apply privacy mask if anonymous amounts or members-only
  const maskedContribs = contribs.rows.map((co) => {
    if (co.is_anonymous && co.user_id !== currentUserId) {
      return { ...co, full_name: 'Mwanachama (Anonymous)', amount: null };
    }
    return co;
  });

  return { case: caseData, contributions: maskedContribs };
}

async function contribute(userId, caseId, amount, isAnonymous = false) {
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) throw Object.assign(new Error('Kiasi si sahihi.'), { statusCode: 400 });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const caseRes = await client.query('SELECT * FROM social_fund_cases WHERE id = $1 FOR UPDATE', [caseId]);
    if (caseRes.rows.length === 0) throw Object.assign(new Error('Kesi haipatikani.'), { statusCode: 404 });
    const c = caseRes.rows[0];
    if (c.status !== 'OPEN' && c.status !== 'COLLECTING') {
      throw Object.assign(new Error('Mchango huu umefungwa.'), { statusCode: 400 });
    }

    const userRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (Number(userRes.rows[0].wallet_balance) < amountNum) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    const referenceId = generateReference('SOC');

    // Debit user wallet and credit SOCIAL_FUND clearing
    await fin.debitWallet({
      client,
      userId,
      amount: amountNum,
      reference: referenceId,
      toAccount: 'SOCIAL_FUND_CLEARING',
      description: `Mchango wa jamii: ${c.title}`,
      actor: 'engine:social_fund'
    });

    await client.query(
      `INSERT INTO social_fund_contributions (case_id, user_id, amount, is_anonymous, reference_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [caseId, userId, amountNum, isAnonymous, referenceId]
    );

    const newTotal = Number(c.total_collected) + amountNum;
    const newStatus = newTotal >= Number(c.target_amount) ? 'CLOSED' : 'COLLECTING';

    await client.query(
      `UPDATE social_fund_cases SET total_collected = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [newTotal, newStatus, caseId]
    );

    await client.query('COMMIT');

    await logAudit({
      eventType: 'SOCIAL_FUND_CONTRIBUTION',
      action: 'CREATE',
      entityType: 'SOCIAL_FUND_CASE',
      userId,
      referenceId,
      amount: amountNum,
      afterData: { case_id: caseId }
    }).catch(() => {});

    return { success: true, referenceId, totalCollected: newTotal, status: newStatus, message: 'Asante kwa mchango wako.' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function requestPayout(caseId, adminId, recipientPhone, amount) {
  const amountNum = Number(amount);
  const referenceId = generateReference('SOP');
  const res = await pool.query(
    `INSERT INTO social_fund_payouts (case_id, authorized_by, amount, recipient_phone, reference_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [caseId, adminId, amountNum, recipientPhone, referenceId]
  );
  return res.rows[0];
}

module.exports = { createCase, listCases, getCaseDetails, contribute, requestPayout };
