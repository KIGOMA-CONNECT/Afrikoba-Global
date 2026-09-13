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

async function listCircles() {
  const res = await pool.query(
    `SELECT c.*, fp.name AS field_partner_name, u.full_name AS leader_name,
            COUNT(cm.id) AS member_count
     FROM lending_circles c
     LEFT JOIN field_partners fp ON fp.id = c.field_partner_id
     JOIN users u ON u.id = c.leader_user_id
     LEFT JOIN lending_circle_members cm ON cm.circle_id = c.id
     GROUP BY c.id, fp.name, u.full_name
     ORDER BY c.created_at DESC`
  );
  return res.rows;
}

async function createCampaign(borrowerUserId, data) {
  const { enforceHighValueKyc } = require('./kycDocumentService');
  const config = require('../config');
  await enforceHighValueKyc({ userId: borrowerUserId, amount: data.targetAmount, threshold: config.lending.highValueLoanThreshold, requiredLevel: config.lending.highValueKycLevel });
  const { circleId, title, story, targetAmount, termMonths, interestRate, fundingDeadline } = data;
  const res = await pool.query(
    `INSERT INTO crowdfund_campaigns (circle_id, borrower_user_id, title, story, target_amount, term_months, interest_rate, funding_deadline, outstanding_balance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $5) RETURNING *`,
    [circleId, borrowerUserId, title, story, targetAmount, termMonths || 12, interestRate || 0, fundingDeadline || null]
  );
  await logAudit(borrowerUserId, 'CROWDFUND_CAMPAIGN_CREATED', `Created campaign: ${title} for ${targetAmount}`);
  return res.rows[0];
}

async function listCampaigns(status) {
  if (!status) {
    const res = await pool.query(
      `SELECT c.*, lc.name as circle_name, u.full_name as borrower_name
       FROM crowdfund_campaigns c
       LEFT JOIN lending_circles lc ON lc.id = c.circle_id
       JOIN users u ON u.id = c.borrower_user_id
       ORDER BY c.created_at DESC`
    );
    return res.rows;
  }
  const res = await pool.query(
    `SELECT c.*, lc.name as circle_name, u.full_name as borrower_name
     FROM crowdfund_campaigns c
     LEFT JOIN lending_circles lc ON lc.id = c.circle_id
     JOIN users u ON u.id = c.borrower_user_id
     WHERE c.status = $1
     ORDER BY c.created_at DESC`,
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
    if (camp.funding_deadline && new Date(camp.funding_deadline) < new Date()) {
      throw new Error('Campaign funding deadline has passed.');
    }
    if (Number(camp.borrower_user_id) === Number(lenderUserId)) {
      throw new Error('Borrower cannot contribute to their own campaign.');
    }

    const remaining = Number(camp.target_amount) - Number(camp.raised_amount);
    if (Number(amount) <= 0) throw new Error('Invalid contribution amount.');
    if (amount > remaining) throw new Error(`Amount exceeds target. Only ${remaining} left.`);

    // Check lender balance
    const lenderRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [lenderUserId]);
    if (Number(lenderRes.rows[0].wallet_balance) < amount) throw new Error('Insufficient wallet balance.');

    const ref = generateReference('CF');

    // 1. Debit Lender -> LENDING_POOL
    await fin.debitWallet({ client, userId: lenderUserId, amount, reference: ref, toAccount: 'LENDING_POOL', description: `Contribution to ${camp.title}`, productType: 'LENDING_CIRCLES', productRef: String(campaignId) });

    // 2. Log Contribution
    const contribRef = generateReference('CC');
    await client.query(
      `INSERT INTO crowdfund_contributions (campaign_id, lender_user_id, amount, reference, status) VALUES ($1, $2, $3, $4, 'HELD')`,
      [campaignId, lenderUserId, amount, contribRef]
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

    // Credit borrower from the LENDING_POOL
    await fin.creditWallet({ client, userId: camp.borrower_user_id, amount: camp.raised_amount, reference: ref, fromAccount: 'LENDING_POOL', description: `Crowdfund disbursement: ${camp.title}`, productType: 'LENDING_CIRCLES', productRef: String(campaignId) });

    await client.query(
      `UPDATE crowdfund_campaigns SET status = 'DISBURSED', disbursed_at = NOW(), outstanding_balance = raised_amount, updated_at = NOW()
       WHERE id = $1 AND raised_amount > 0`,
      [campaignId]
    );

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

// ---- Campaign lifecycle: status guard ------------------------------------

async function setCampaignStatus(client, campaignId, newStatus, extra = {}) {
  const sets = ['status = $1'];
  const params = [newStatus, campaignId];
  let i = 3;
  if (extra.disbursed_at)  { sets.push(`disbursed_at = $${i++}`); params.push(extra.disbursed_at); }
  if (extra.repaid_at)     { sets.push(`repaid_at    = $${i++}`); params.push(extra.repaid_at); }
  if (extra.cancelled_at)  { sets.push(`cancelled_at = $${i++}`, `cancelled_by = $${i++}`, `cancel_reason = $${i++}`); params.push(extra.cancelled_at, extra.cancelled_by, extra.cancel_reason); }
  if (extra.defaulted_at)  { sets.push(`defaulted_at = $${i++}`); params.push(extra.defaulted_at); }
  if (extra.outstanding != null) { sets.push(`outstanding_balance = $${i++}`); params.push(extra.outstanding); }
  if (extra.total_interest != null) { sets.push(`total_interest_paid = $${i++}`); params.push(extra.total_interest); }
  await client.query(
    `UPDATE crowdfund_campaigns SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $2 RETURNING *`,
    params
  );
}

async function cancelCampaign(actorUserId, campaignId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campRes = await client.query(
      "SELECT * FROM crowdfund_campaigns WHERE id = $1 AND status IN ('FUNDING','FULLY_FUNDED') FOR UPDATE",
      [campaignId]
    );
    const camp = campRes.rows[0];
    if (!camp) throw Object.assign(new Error('Campaign not found or cannot be cancelled.'), { statusCode: 404 });

    // Refund all held contributions
    const contribs = await client.query(
      "SELECT * FROM crowdfund_contributions WHERE campaign_id = $1 AND status = 'HELD'",
      [campaignId]
    );
    for (const c of contribs.rows) {
      const ref = generateReference('CRF'); // crowdfund refund
      await fin.creditWallet({
        client, userId: c.lender_user_id, amount: Number(c.amount), reference: ref, fromAccount: 'LENDING_POOL',
        description: `Crowdfund refund for campaign ${campaignId}`, productType: 'LENDING_CIRCLES', productRef: String(campaignId),
      });
      await client.query(
        "UPDATE crowdfund_contributions SET status = 'REFUNDED', refunded_at = NOW(), refund_reference = $1 WHERE id = $2",
        [ref, c.id]
      );
    }

    await setCampaignStatus(client, campaignId, 'CANCELLED', {
      cancelled_at: new Date(), cancelled_by: actorUserId, cancel_reason: 'Cancelled by actor',
    });
    await logAudit(actorUserId, 'CROWDFUND_CANCELLED', `Cancelled campaign ${campaignId}`);
    await client.query('COMMIT');
    return { success: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function repayLoan(borrowerUserId, campaignId, { amount, interestAmount = 0 }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campRes = await client.query(
      "SELECT * FROM crowdfund_campaigns WHERE id = $1 AND status = 'DISBURSED' FOR UPDATE",
      [campaignId]
    );
    const camp = campRes.rows[0];
    if (!camp) throw Object.assign(new Error('Campaign not found or not in REPAYMENT phase.'), { statusCode: 404 });
    if (Number(camp.borrower_user_id) !== Number(borrowerUserId)) {
      throw Object.assign(new Error('Only the borrower can make repayments.'), { statusCode: 403 });
    }
    const totalOwed = Number(camp.outstanding_balance);
    const principalAmt = Math.min(amount, totalOwed);
    const intAmt = Math.min(interestAmount, amount - principalAmt);
    const borrowerBal = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [borrowerUserId]);
    if (Number(borrowerBal.rows[0].wallet_balance) < amount) {
      throw Object.assign(new Error('Salio lako halitoshi.'), { statusCode: 400 });
    }

    // Debit borrower's wallet
    const repayRef = generateReference('CRE');
    await fin.debitWallet({
      client, userId: borrowerUserId, amount: amount, reference: repayRef,
      toAccount: 'LENDING_POOL',
      description: `Loan repayment for campaign ${campaignId}`,
      productType: 'LENDING_CIRCLES', productRef: String(campaignId),
    });
    // Record repayment row
    const repayRow = await client.query(
      `INSERT INTO crowdfund_repayments (campaign_id, borrower_user_id, reference, amount, principal_amount, interest_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,'SUCCESS') RETURNING id`,
      [campaignId, borrowerUserId, repayRef, amount, principalAmt, intAmt]
    );
    const repaymentId = repayRow.rows[0].id;

    // Credit interest to revenue (pool -> interest income)
    if (intAmt > 0) {
      const intRef = generateReference('CRI');
      await fin.postJournal({
        client,
        lines: [
          { accountCode: 'LENDING_POOL', direction: 'DR', amount: intAmt },
          { accountCode: 'LENDING_INTEREST_INCOME', direction: 'CR', amount: intAmt },
        ],
        referenceId: intRef,
        description: `Interest portion for repayment ${repaymentId}`,
        postedBy: 'engine:lendingRepay',
        productType: 'LENDING_CIRCLES', productRef: String(campaignId),
      });
      await client.query('UPDATE crowdfund_repayments SET interest_amount = $1 WHERE id = $2', [intAmt, repaymentId]);
    }

    // Distribute principal pro-rata to lenders
    const totalRaised = Number(camp.raised_amount);
    const contribs = await client.query(
      "SELECT lender_user_id, amount FROM crowdfund_contributions WHERE campaign_id = $1 AND status = 'HELD' FOR UPDATE",
      [campaignId]
    );
    let remainder = principalAmt;
    for (const c of contribs.rows) {
      const share = totalRaised > 0 ? Math.round(principalAmt * (Number(c.amount) / totalRaised) * 100) / 100 : 0;
      const payout = Math.min(share, remainder);
      if (payout > 0) {
        const pRef = generateReference('CRP');
        await fin.creditWallet({
          client, userId: c.lender_user_id, amount: payout, reference: pRef,
          fromAccount: 'LENDING_POOL',
          description: `Principal return for campaign ${campaignId}`,
          productType: 'LENDING_CIRCLES', productRef: String(campaignId),
        });
        await client.query(
          `INSERT INTO crowdfund_lender_payouts (repayment_id, campaign_id, lender_user_id, reference, principal_amount, total_amount, status)
           VALUES ($1,$2,$3,$4,$5,$5,'SUCCESS')`,
          [repaymentId, campaignId, c.lender_user_id, pRef, payout]
        );
        remainder -= payout;
      }
    }

    const newOutstanding = Math.max(0, totalOwed - principalAmt);
    const newInterestPaid = Number(camp.total_interest_paid) + intAmt;
    const newStatus = newOutstanding <= 0.01 ? 'REPAID' : 'DISBURSED';
    await setCampaignStatus(client, campaignId, newStatus, {
      outstanding: newOutstanding,
      total_interest: newInterestPaid,
      ...(newStatus === 'REPAID' ? { repaid_at: new Date() } : {}),
    });

    await logAudit(borrowerUserId, 'CROWDFUND_REPAYMENT', `Repaid ${amount} (principal ${principalAmt}, interest ${intAmt}) on campaign ${campaignId}`);
    await client.query('COMMIT');
    return { success: true, repaymentId, newStatus, outstanding: newOutstanding };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function markDefault(adminUserId, campaignId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campRes = await client.query(
      "SELECT * FROM crowdfund_campaigns WHERE id = $1 AND status = 'DISBURSED' FOR UPDATE",
      [campaignId]
    );
    if (!campRes.rows[0]) throw Object.assign(new Error('Campaign not found or not in DISBURSED state.'), { statusCode: 404 });
    await setCampaignStatus(client, campaignId, 'DEFAULTED', { defaulted_at: new Date() });
    await logAudit(adminUserId, 'CROWDFUND_DEFAULTED', `Campaign ${campaignId} marked default`);
    await client.query('COMMIT');
    return { success: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function listCampaign(campaignId) {
  const campRes = await pool.query(
    `SELECT c.*, lc.name AS circle_name, u.full_name AS borrower_name,
            (SELECT COUNT(*) FROM crowdfund_contributions cc WHERE cc.campaign_id = c.id) AS contribution_count,
            (SELECT COALESCE(SUM(cc.amount),0) FROM crowdfund_contributions cc WHERE cc.campaign_id = c.id) AS total_contributed,
            (SELECT COUNT(*) FROM crowdfund_repayments cr WHERE cr.campaign_id = c.id) AS repayment_count
     FROM crowdfund_campaigns c
     LEFT JOIN lending_circles lc ON lc.id = c.circle_id
     JOIN users u ON u.id = c.borrower_user_id
     WHERE c.id = $1`,
    [campaignId]
  );
  return campRes.rows[0] || null;
}

async function listRepayments(campaignId) {
  const res = await pool.query(
    'SELECT * FROM crowdfund_repayments WHERE campaign_id = $1 ORDER BY created_at DESC',
    [campaignId]
  );
  return res.rows;
}

async function listPayouts(campaignId) {
  const res = await pool.query(
    'SELECT clp.*, u.full_name AS lender_name FROM crowdfund_lender_payouts clp JOIN users u ON u.id = clp.lender_user_id WHERE clp.campaign_id = $1 ORDER BY clp.created_at DESC',
    [campaignId]
  );
  return res.rows;
}

module.exports = {
  createFieldPartner,
  listFieldPartners,
  createCircle,
  joinCircle,
  listCircles,
  createCampaign,
  listCampaigns,
  contribute,
  disburseCampaign,
  cancelCampaign,
  repayLoan,
  markDefault,
  listCampaign,
  listRepayments,
  listPayouts,
};
