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

    await logAudit({
      userId: sellerUserId,
      eventType: 'P2P_SECONDARY_LISTING_CREATED',
      entityType: 'P2P_SECONDARY_LISTING',
      entityId: res.rows[0].id,
      client,
      details: {
        investmentId,
        projectId: investment.project_id,
        sharesForSale: Number(sharesForSale),
        pricePerShare: Number(pricePerShare),
      },
    });
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

    // 1. Lock the listing and its seller investment.
    const listingRes = await client.query(
      `SELECT l.*, i.project_id
       FROM p2p_secondary_listings l
       JOIN investments i ON i.id = l.investment_id
       WHERE l.id = $1
         AND l.status = 'ACTIVE'
       FOR UPDATE`,
      [listingId]
    );

    const listing = listingRes.rows[0];

    if (!listing) {
      throw new Error('Listing not active or found.');
    }

    if (Number(listing.seller_user_id) === Number(buyerUserId)) {
      throw new Error('Cannot buy your own listing.');
    }

    const sharesForSale = Number(listing.shares_for_sale);
    const pricePerShare = Number(listing.price_per_share);
    const totalCost = sharesForSale * pricePerShare;

    if (!Number.isFinite(sharesForSale) || sharesForSale <= 0) {
      throw new Error('Invalid listing shares.');
    }

    if (!Number.isFinite(pricePerShare) || pricePerShare <= 0) {
      throw new Error('Invalid listing price.');
    }

    if (!Number.isFinite(totalCost) || totalCost <= 0) {
      throw new Error('Invalid listing total cost.');
    }

    // 2. Lock buyer wallet.
    const buyerRes = await client.query(
      `SELECT id, wallet_balance
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [buyerUserId]
    );

    if (buyerRes.rows.length === 0) {
      throw new Error('Buyer not found.');
    }

    const buyerBalance = Number(buyerRes.rows[0].wallet_balance);

    if (!Number.isFinite(buyerBalance) || buyerBalance < totalCost) {
      throw new Error('Insufficient wallet balance.');
    }

    /*
     * 3. Serialize buyer/project investment creation.
     *
     * There is intentionally no UNIQUE(project_id, investor_user_id)
     * constraint on investments. The advisory transaction lock prevents
     * two concurrent secondary-market purchases for the same buyer/project
     * from both observing "no existing investment" and inserting duplicates.
     */
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended($1::text, 0)
       )`,
      [`P2P-INVESTMENT:${listing.project_id}:${buyerUserId}`]
    );

    // 4. Lock the buyer's existing investment, if any.
    const existingBuyerInv = await client.query(
      `SELECT id, shares_bought, total_amount, status
       FROM investments
       WHERE project_id = $1
         AND investor_user_id = $2
       ORDER BY id
       LIMIT 1
       FOR UPDATE`,
      [listing.project_id, buyerUserId]
    );

    // 5. Re-lock seller investment explicitly and fail closed on ownership
    //    and available shares. This makes the settlement invariant explicit.
    const sellerInvRes = await client.query(
      `SELECT id, investor_user_id, shares_bought, total_amount
       FROM investments
       WHERE id = $1
       FOR UPDATE`,
      [listing.investment_id]
    );

    const sellerInvestment = sellerInvRes.rows[0];

    if (!sellerInvestment) {
      throw new Error('Seller investment not found.');
    }

    if (Number(sellerInvestment.investor_user_id) !== Number(listing.seller_user_id)) {
      throw new Error('Seller investment ownership mismatch.');
    }

    const sellerShares = Number(sellerInvestment.shares_bought);

    if (!Number.isFinite(sellerShares) || sellerShares < sharesForSale) {
      throw new Error('Insufficient seller shares.');
    }

    // 6. Use independent idempotency references for the two financial legs.
    const settlementRef = generateReference('SEC');
    const debitRef = `${settlementRef}:DEBIT`;
    const creditRef = `${settlementRef}:CREDIT`;

    await fin.debitWallet({
      client,
      userId: buyerUserId,
      amount: totalCost,
      reference: debitRef,
      toAccount: 'SUSPENSE',
      description: `Secondary market buy #${listingId}`,
      productType: 'P2P_SECONDARY',
      productRef: String(listingId),
    });

    await fin.creditWallet({
      client,
      userId: listing.seller_user_id,
      amount: totalCost,
      reference: creditRef,
      fromAccount: 'SUSPENSE',
      description: `Secondary market sell #${listingId}`,
      productType: 'P2P_SECONDARY',
      productRef: String(listingId),
    });

    // 7. Reduce seller shares. Fail closed if the invariant changed.
    const sellerUpdate = await client.query(
      `UPDATE investments
       SET shares_bought = shares_bought - $1,
           total_amount = total_amount - ($1 * (total_amount / shares_bought))
       WHERE id = $2
         AND investor_user_id = $3
         AND shares_bought >= $1`,
      [sharesForSale, listing.investment_id, listing.seller_user_id]
    );

    if (sellerUpdate.rowCount !== 1) {
      throw new Error('Seller investment could not be settled safely.');
    }

    // 8. Add/update buyer investment.
    if (existingBuyerInv.rows.length > 0) {
      const buyerInvestment = existingBuyerInv.rows[0];

      if (buyerInvestment.status === 'CLOSED') {
        throw new Error('Buyer investment is closed.');
      }

      await client.query(
        `UPDATE investments
         SET shares_bought = shares_bought + $1,
             total_amount = total_amount + $2,
             status = 'ACTIVE'
         WHERE id = $3`,
        [sharesForSale, totalCost, buyerInvestment.id]
      );
    } else {
      await client.query(
        `INSERT INTO investments
           (project_id, investor_user_id, shares_bought, total_amount, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [listing.project_id, buyerUserId, sharesForSale, totalCost]
      );
    }

    // 9. Mark listing SOLD and verify the state transition.
    const soldRes = await client.query(
      `UPDATE p2p_secondary_listings
       SET status = 'SOLD',
           updated_at = NOW()
       WHERE id = $1
         AND status = 'ACTIVE'`,
      [listingId]
    );

    if (soldRes.rowCount !== 1) {
      throw new Error('Secondary listing could not be finalized.');
    }

    /*
     * 10. Audit the completed settlement using the same transaction client.
     * writeAudit() itself is non-throwing, so the settlement must not rely
     * on it for transaction failure semantics.
     */
    await client.query(
      `INSERT INTO audit_logs
         (user_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        buyerUserId,
        'P2P_SECONDARY_BUY',
        'P2P_SECONDARY_LISTING',
        listingId,
        JSON.stringify({
          listingId,
          projectId: listing.project_id,
          investmentId: listing.investment_id,
          sellerUserId: listing.seller_user_id,
          buyerUserId,
          shares: sharesForSale,
          pricePerShare,
          totalCost,
          settlementRef,
          debitRef,
          creditRef,
        }),
      ]
    );

    await client.query('COMMIT');

    return {
      success: true,
      ref: settlementRef,
      debitRef,
      creditRef,
    };
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

  const sharePrice = Number(p.share_price);
  if (sharePrice <= 0) return;

  // Headroom in this project's raise (respect target cap).
  const remainingRaise = Math.max(0, Number(p.target_amount) - Number(p.raised_amount));
  if (remainingRaise <= 0) return;

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
      const investAmount = Math.min(rule.max_amount_per_project, remainingBudget, Number(rule.wallet_balance), remainingRaise);

      // Calculate shares within remaining raise headroom
      let shares = Math.floor(investAmount / sharePrice);
      shares = Math.min(shares, Math.floor(remainingRaise / sharePrice));
      if (shares <= 0) continue;

      const actualCost = shares * sharePrice;

      // Respect project minimum ticket: skip quietly if below it.
      if (p.min_investment_amount && actualCost < Number(p.min_investment_amount)) continue;

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

async function runAutoInvestCycle() {
  const projects = await pool.query(
    `SELECT id FROM investment_projects WHERE status = 'ACTIVE'`
  );
  for (const row of projects.rows) {
    try {
      await executeAutoInvestForProject(row.id);
    } catch (err) {
      logger.error(`Auto-invest cycle error for project ${row.id}: ${err.message}`);
    }
  }
  return projects.rows.length;
}

module.exports = {
  createListing,
  listListings,
  buyListing,
  getAutoInvestRule,
  upsertAutoInvestRule,
  executeAutoInvestForProject,
  runAutoInvestCycle
};
