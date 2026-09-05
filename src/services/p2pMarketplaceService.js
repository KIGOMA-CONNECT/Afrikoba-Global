const pool = require('../config/db');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');
const p2p = require('./p2pService');
const logger = require('../utils/logger');

/**
 * P2P SECONDARY MARKET & AUTO-INVEST SERVICE
 */

// --- 1. SECONDARY MARKET ---

async function createListing(sellerUserId, data) {
  const { investmentId, sharesForSale, pricePerShare } = data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify ownership and available shares
    const investRes = await client.query(
      `SELECT i.*, p.share_price as orig_price 
       FROM investments i 
       JOIN investment_projects p ON p.id = i.project_id
       WHERE i.id = $1 AND i.investor_user_id = $2 FOR UPDATE`,
      [investmentId, sellerUserId]
    );
    const investment = investRes.rows[0];
    if (!investment) throw new Error('Investment record not found.');

    // Check if shares are already listed
    const listedRes = await client.query(
      `SELECT SUM(shares_for_sale) as total_listed FROM p2p_secondary_listings 
       WHERE investment_id = $1 AND status = 'ACTIVE'`,
      [investmentId]
    );
    const totalListed = parseInt(listedRes.rows[0].total_listed || 0);
    const available = parseInt(investment.shares_bought) - totalListed;

    if (parseInt(sharesForSale) > available) {
      throw new Error(`Insufficient shares. Available: ${available}`);
    }

    const res = await client.query(
      `INSERT INTO p2p_secondary_listings (seller_user_id, investment_id, shares_for_sale, price_per_share)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [sellerUserId, investmentId, sharesForSale, pricePerShare]
    );

    await logAudit(sellerUserId, 'P2P_SECONDARY_LISTING_CREATED', `Listed ${sharesForSale} shares at ${pricePerShare}/share`);
    await client.query('COMMIT');
    return res.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listListings(filters = {}) {
  const { status = 'ACTIVE' } = filters;
  const res = await pool.query(
    `SELECT l.*, p.title, p.sector, u.full_name as seller_name
     FROM p2p_secondary_listings l
     JOIN investments i ON i.id = l.investment_id
     JOIN investment_projects p ON p.id = i.project_id
     JOIN users u ON u.id = l.seller_user_id
     WHERE l.status = $1
     ORDER BY l.created_at DESC`,
    [status]
  );
  return res.rows;
}

async function buyListing(buyerUserId, listingId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const listingRes = await client.query(
      `SELECT l.*, i.project_id 
       FROM p2p_secondary_listings l
       JOIN investments i ON i.id = l.investment_id
       WHERE l.id = $1 AND l.status = 'ACTIVE' FOR UPDATE`,
      [listingId]
    );
    const listing = listingRes.rows[0];
    if (!listing) throw new Error('Listing not active or found.');
    if (listing.seller_user_id === buyerUserId) throw new Error('Cannot buy your own listing.');

    const totalCost = Number(listing.shares_for_sale) * Number(listing.price_per_share);

    // Verify buyer funds
    const buyerRes = await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [buyerUserId]);
    if (Number(buyerRes.rows[0].wallet_balance) < totalCost) throw new Error('Insufficient wallet balance.');

    const ref = generateReference('SEC');

    // 1. Financial Transfer
    await fin.debitWallet({ client, userId: buyerUserId, amount: totalCost, reference: ref, toAccount: 'SUSPENSE', description: `Secondary market buy #${listingId}` });
    await fin.creditWallet({ client, userId: listing.seller_user_id, amount: totalCost, reference: ref, fromAccount: 'SUSPENSE', description: `Secondary market sell #${listingId}` });

    // 2. Transfer Share Ownership
    // Reduce seller shares
    await client.query(
      `UPDATE investments SET shares_bought = shares_bought - $1, total_amount = total_amount - ($1 * (total_amount/shares_bought))
       WHERE id = $2`,
      [listing.shares_for_sale, listing.investment_id]
    );

    // Add/Update buyer shares
    const existingBuyerInv = await client.query(
      `SELECT id FROM investments WHERE project_id = $1 AND investor_user_id = $2`,
      [listing.project_id, buyerUserId]
    );

    if (existingBuyerInv.rows.length > 0) {
      await client.query(
        `UPDATE investments SET shares_bought = shares_bought + $1, total_amount = total_amount + $2
         WHERE id = $3`,
        [listing.shares_for_sale, totalCost, existingBuyerInv.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO investments (project_id, investor_user_id, shares_bought, total_amount, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [listing.project_id, buyerUserId, listing.shares_for_sale, totalCost]
      );
    }

    // 3. Mark Listing SOLD
    await client.query(`UPDATE p2p_secondary_listings SET status = 'SOLD', updated_at = NOW() WHERE id = $1`, [listingId]);

    await logAudit(buyerUserId, 'P2P_SECONDARY_BUY', `Bought ${listing.shares_for_sale} shares from listing #${listingId}`);
    await client.query('COMMIT');
    return { success: true, ref };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- 2. AUTO-INVEST ---

async function getAutoInvestRule(userId) {
  const res = await pool.query('SELECT * FROM p2p_auto_invest_rules WHERE user_id = $1', [userId]);
  return res.rows[0] || null;
}

async function upsertAutoInvestRule(userId, data) {
  const { enabled, minRoiPercentage, preferredSectors, maxAmountPerProject, budgetCap } = data;
  const res = await pool.query(
    `INSERT INTO p2p_auto_invest_rules (user_id, enabled, min_roi_percentage, preferred_sectors, max_amount_per_project, budget_cap)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       min_roi_percentage = EXCLUDED.min_roi_percentage,
       preferred_sectors = EXCLUDED.preferred_sectors,
       max_amount_per_project = EXCLUDED.max_amount_per_project,
       budget_cap = EXCLUDED.budget_cap,
       updated_at = NOW()
     RETURNING *`,
    [userId, enabled ?? true, minRoiPercentage, preferredSectors, maxAmountPerProject, budgetCap]
  );
  return res.rows[0];
}

async function executeAutoInvestForProject(projectId) {
  const projectRes = await pool.query('SELECT * FROM investment_projects WHERE id = $1', [projectId]);
  const p = projectRes.rows[0];
  if (!p || p.status !== 'ACTIVE') return;

  // Find users with matching rules
  const rules = await pool.query(
    `SELECT r.*, u.wallet_balance 
     FROM p2p_auto_invest_rules r
     JOIN users u ON u.id = r.user_id
     WHERE r.enabled = TRUE 
       AND r.min_roi_percentage <= $1
       AND $2 = ANY(r.preferred_sectors)
       AND r.total_auto_invested < r.budget_cap
       AND u.wallet_balance > 0`,
    [p.roi_percentage, p.sector]
  );

  for (const rule of rules.rows) {
    try {
      const remainingBudget = rule.budget_cap - rule.total_auto_invested;
      let investAmount = Math.min(rule.max_amount_per_project, remainingBudget, Number(rule.wallet_balance));
      
      // Calculate shares
      const shares = Math.floor(investAmount / p.share_price);
      if (shares <= 0) continue;

      const actualCost = shares * p.share_price;

      try {
        await p2p.invest(rule.user_id, p.id, shares);
        await pool.query(
          'UPDATE p2p_auto_invest_rules SET total_auto_invested = total_auto_invested + $1 WHERE id = $2',
          [actualCost, rule.id]
        );
        await logAudit(rule.user_id, 'AUTO_INVEST_EXECUTED', `Auto-invested ${actualCost} in project ${p.title}`);
      } catch (err) {
        logger.error(`Auto-invest failed for user ${rule.user_id} on project ${p.id}: ${err.message}`);
      }
    } catch (err) {
      logger.error(`Auto-invest process error: ${err.message}`);
    }
  }
}

module.exports = {
  createListing,
  listListings,
  buyListing,
  getAutoInvestRule,
  upsertAutoInvestRule,
  executeAutoInvestForProject
};
