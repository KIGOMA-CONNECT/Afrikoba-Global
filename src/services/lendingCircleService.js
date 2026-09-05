const pool = require('../config/db');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');

/**
 * KIVA-STYLE LENDING CIRCLES & CROWDFUNDING SERVICE
 */

async function createFieldPartner(data) {
  const { name, countryCode, region, riskRating } = data;
  const res = await pool.query(
    `INSERT INTO field_partners (name, country_code, region, risk_rating)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, countryCode || 'TZ', region, riskRating || 'LOW']
  );
  return res.rows[0];
}

async function listFieldPartners() {
  const res = await pool.query('SELECT * FROM field_partners WHERE active = TRUE');
  return res.rows;
}

async function createCircle(leaderUserId, data) {
  const { name, fieldPartnerId, description, location, impactCategory } = data;
  const res = await pool.query(
    `INSERT INTO lending_circles (name, leader_user_id, field_partner_id, description, location, impact_category)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, leaderUserId, fieldPartnerId, description, location, impactCategory || 'COMMUNITY']
  );
  
  // Auto-add leader as member
  await pool.query(
    'INSERT INTO lending_circle_members (circle_id, user_id, role) VALUES ($1, $2, $3)',
    [res.rows[0].id, leaderUserId, 'LEADER']
  );

  await logAudit(leaderUserId, 'LENDING_CIRCLE_CREATED', `Created circle: ${name}`);
  return res.rows[0];
}

async function joinCircle(userId, circleId) {
  const res = await pool.query(
    `INSERT INTO lending_circle_members (circle_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *`,
    [circleId, userId]
  );
  return res.rows[0];
}

async function createCampaign(borrowerUserId, data) {
  const { circleId, title, story, targetAmount, termMonths } = data;
  const res = await pool.query(
    `INSERT INTO crowdfund_campaigns (circle_id, borrower_user_id, title, story, target_amount, term_months)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [circleId, borrowerUserId, title, story, targetAmount, termMonths || 12]
  );
  await logAudit(borrowerUserId, 'CROWDFUND_CAMPAIGN_CREATED', `Created campaign: ${title} for ${targetAmount}`);
  return res.rows[0];
}

async function listCampaigns(status = 'FUNDING') {
  const res = await pool.query(
    `SELECT c.*, lc.name as circle_name, u.full_name as borrower_name
     FROM crowdfund_campaigns c
     LEFT JOIN lending_circles lc ON lc.id = c.circle_id
     JOIN users u ON u.id = c.borrower_user_id
     WHERE c.status = $1`,
    [status]
  );
  return res.rows;
}

async function contribute(lenderUserId, campaignId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const campRes = await client.query(
      'SELECT * FROM crowdfund_campaigns WHERE id = $1 AND status = \'FUNDING\' FOR UPDATE',
      [campaignId]
    );
    const camp = campRes.rows[0];
    if (!camp) throw new Error('Campaign not found or not in funding phase.');

    const remaining = Number(camp.target_amount) - Number(camp.raised_amount);
    if (amount > remaining) throw new Error(`Amount exceeds target. Only ${remaining} left.`);

    // Check lender balance
    const lenderRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [lenderUserId]);
    if (Number(lenderRes.rows[0].wallet_balance) < amount) throw new Error('Insufficient wallet balance.');

    const ref = generateReference('CF');

    // 1. Debit Lender
    await fin.debitWallet({ client, userId: lenderUserId, amount, reference: ref, toAccount: 'SUSPENSE', description: `Contribution to ${camp.title}` });

    // 2. Log Contribution
    await client.query(
      'INSERT INTO crowdfund_contributions (campaign_id, lender_user_id, amount) VALUES ($1, $2, $3)',
      [campaignId, lenderUserId, amount]
    );

    // 3. Update Campaign
    const newRaised = Number(camp.raised_amount) + Number(amount);
    let newStatus = camp.status;
    if (newRaised >= Number(camp.target_amount)) {
      newStatus = 'FULLY_FUNDED';
    }

    await client.query(
      'UPDATE crowdfund_campaigns SET raised_amount = $1, status = $2 WHERE id = $3',
      [newRaised, newStatus, campaignId]
    );

    await logAudit(lenderUserId, 'CROWDFUND_CONTRIBUTION', `Contributed ${amount} to ${camp.title}`);
    await client.query('COMMIT');
    return { success: true, status: newStatus };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function disburseCampaign(adminUserId, campaignId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const camp = (await client.query('SELECT * FROM crowdfund_campaigns WHERE id = $1 FOR UPDATE', [campaignId])).rows[0];
    if (camp.status !== 'FULLY_FUNDED') throw new Error('Campaign must be FULLY_FUNDED to disburse.');

    const ref = generateReference('CFD');

    // Credit borrower
    await fin.creditWallet({ client, userId: camp.borrower_user_id, amount: camp.raised_amount, reference: ref, fromAccount: 'SUSPENSE', description: `Crowdfund disbursement: ${camp.title}` });

    await client.query('UPDATE crowdfund_campaigns SET status = \'DISBURSED\' WHERE id = $1', [campaignId]);

    await logAudit(adminUserId, 'CROWDFUND_DISBURSED', `Disbursed ${camp.raised_amount} for campaign ${camp.id}`);
    await client.query('COMMIT');
    return { success: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  createFieldPartner,
  listFieldPartners,
  createCircle,
  joinCircle,
  createCampaign,
  listCampaigns,
  contribute,
  disburseCampaign
};
