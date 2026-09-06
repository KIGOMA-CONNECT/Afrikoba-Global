const pool = require('../config/db');
const { generateReference, formatMoney } = require('../utils/helpers');
const { logAudit } = require('./auditService');
const fin = require('./financialEngine');

/**
 * KILIMO (AGRI-FINANCE) SERVICE
 */

async function createFarmProfile(userId, data) {
  const { farmName, region, district, sizeAcres, primaryCrop, irrigationType, expectedHarvestDate, historicalYieldTons } = data;
  const res = await pool.query(
    `INSERT INTO farm_profiles (user_id, farm_name, region, district, size_acres, primary_crop, irrigation_type, expected_harvest_date, historical_yield_tons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, farmName, region, district, sizeAcres, primaryCrop, irrigationType || 'RAIN_FED', expectedHarvestDate, historicalYieldTons || 0.00]
  );
  await logAudit(userId, 'AGRI_FARM_PROFILE_CREATED', `Created farm profile: ${farmName}`);
  return res.rows[0];
}

async function listFarmProfiles(userId) {
  const res = await pool.query('SELECT * FROM farm_profiles WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return res.rows;
}

async function listAgriSuppliers() {
  const res = await pool.query(
    'SELECT id, supplier_name, category, phone_number, verified FROM agri_input_suppliers WHERE verified = TRUE ORDER BY supplier_name'
  );
  return res.rows;
}

async function applyAgriLoan(userId, data) {
  const { enforceHighValueKyc } = require('./kycDocumentService');
  const config = require('../config');
  await enforceHighValueKyc({ userId, amount: data.amount, threshold: config.lending.highValueLoanThreshold, requiredLevel: config.lending.highValueKycLevel });
  const { farmId = data.farm_id, supplierId = data.supplier_id, amount, loanType = data.loan_type, gracePeriodMonths = data.grace_period_months, tenureMonths = data.tenure_months } = data;
  const res = await pool.query(
    `INSERT INTO agri_loans (farm_id, borrower_user_id, supplier_id, amount, loan_type, grace_period_months, tenure_months)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [farmId, userId, supplierId || null, amount, loanType || 'INPUT_FINANCING', gracePeriodMonths || 3, tenureMonths || 6]
  );
  await logAudit(userId, 'AGRI_LOAN_APPLIED', `Applied for agri-loan of ${amount}`);
  return res.rows[0];
}

async function listAgriLoans(userId, isAdmin = false) {
  const q = isAdmin
    ? `SELECT al.*, fp.farm_name, u.full_name as borrower_name, s.supplier_name
       FROM agri_loans al
       JOIN farm_profiles fp ON fp.id = al.farm_id
       JOIN users u ON u.id = al.borrower_user_id
       LEFT JOIN agri_input_suppliers s ON s.id = al.supplier_id
       ORDER BY al.created_at DESC`
    : `SELECT al.*, fp.farm_name, s.supplier_name
       FROM agri_loans al
       JOIN farm_profiles fp ON fp.id = al.farm_id
       LEFT JOIN agri_input_suppliers s ON s.id = al.supplier_id
       WHERE al.borrower_user_id = $1
       ORDER BY al.created_at DESC`;
  const res = isAdmin ? await pool.query(q) : await pool.query(q, [userId]);
  return res.rows;
}

async function disburseAgriLoan(adminUserId, loanId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loan = (await client.query('SELECT * FROM agri_loans WHERE id = $1 AND status = \'PENDING\' FOR UPDATE', [loanId])).rows[0];
    if (!loan) throw new Error('Agri-loan not found or not in PENDING status.');

    const ref = generateReference('AGD');

    if (loan.supplier_id) {
      // Input Financing: Credit goes directly to input supplier
      await fin.creditWallet({ client, userId: loan.borrower_user_id, amount: loan.amount, reference: ref, fromAccount: 'TREASURY', description: `Agri loan input disbursement to supplier #${loan.supplier_id}` });
      // In realistic scenario, supplier would receive the payment via the platform. We simulate by crediting borrower escrow/clearing.
    } else {
      // Direct farm loan: Credit borrower wallet
      await fin.creditWallet({ client, userId: loan.borrower_user_id, amount: loan.amount, reference: ref, fromAccount: 'TREASURY', description: `Direct Agri loan disbursement` });
    }

    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + Number(loan.tenure_months));

    await client.query(
      `UPDATE agri_loans 
       SET status = 'DISBURSED', repayment_due_date = $1
       WHERE id = $2`,
      [dueDate, loanId]
    );

    await logAudit(adminUserId, 'AGRI_LOAN_DISBURSED', `Disbursed agri-loan ${loanId} of ${loan.amount}`);
    await client.query('COMMIT');
    return { success: true, dueDate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function repayAgriLoan(userId, loanId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loan = (await client.query('SELECT * FROM agri_loans WHERE id = $1 AND borrower_user_id = $2 FOR UPDATE', [loanId, userId])).rows[0];
    if (!loan || loan.status !== 'DISBURSED') throw new Error('Active agri-loan not found.');

    const user = (await client.query('SELECT wallet_balance FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (Number(user.wallet_balance) < amount) throw new Error('Insufficient wallet balance.');

    const ref = generateReference('AGR');

    await fin.debitWallet({ client, userId, amount, reference: ref, toAccount: 'TREASURY', description: `Agri loan repayment #${loanId}` });

    const isFullyPaid = amount >= Number(loan.amount); // Simplistic model (could have remaining balance logic)
    const newStatus = isFullyPaid ? 'REPAID' : 'DISBURSED';

    await client.query(
      `UPDATE agri_loans SET status = $1 WHERE id = $2`,
      [newStatus, loanId]
    );

    await logAudit(userId, 'AGRI_LOAN_REPAYMENT', `Paid ${amount} towards agri-loan ${loanId}`);
    await client.query('COMMIT');
    return { success: true, status: newStatus };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function createOfftakeAgreement(userId, data) {
  const { loanId, offtakerName, agreedPricePerKg, committedQuantityKg, contractUrl } = data;
  const res = await pool.query(
    `INSERT INTO agri_offtake_agreements (agri_loan_id, offtaker_name, agreed_price_per_kg, committed_quantity_kg, contract_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [loanId, offtakerName, agreedPricePerKg, committedQuantityKg, contractUrl]
  );
  await logAudit(userId, 'AGRI_OFFTAKE_AGREEMENT_CREATED', `Offtake agreement with ${offtakerName} created for loan #${loanId}`);
  return res.rows[0];
}

/* ================= FARM SEASONS + YIELD TRACKING ================= */

async function getOwnedFarmOrThrow(userId, farmId, statusCode = 403) {
  const res = await pool.query('SELECT id FROM farm_profiles WHERE id = $1 AND user_id = $2', [farmId, userId]);
  if (!res.rows.length) throw Object.assign(new Error('Shamba halipatikani au sio lako.'), { statusCode });
  return res.rows[0];
}

async function createSeason(userId, farmId, data) {
  await getOwnedFarmOrThrow(userId, farmId);
  const { seasonName, plantingDate, expectedHarvestDate, crop, areaAcres, expectedYieldTons } = data;
  const res = await pool.query(
    `INSERT INTO farm_seasons (farm_id, season_name, planting_date, expected_harvest_date, crop, area_acres, expected_yield_tons)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [farmId, seasonName, plantingDate, expectedHarvestDate, crop, areaAcres || null, expectedYieldTons || 0]
  );
  await logAudit(userId, 'FARM_SEASON_CREATED', `Season "${seasonName}" created for farm #${farmId}`);
  return res.rows[0];
}

async function listSeasons(userId, farmId) {
  await getOwnedFarmOrThrow(userId, farmId);
  const res = await pool.query(
    `SELECT * FROM farm_seasons WHERE farm_id = $1 ORDER BY created_at DESC`,
    [farmId]
  );
  return res.rows;
}

/**
 * Harvest close-out: marks the ACTIVE season COMPLETED, records the measured
 * yield + sale amount, and rolls the yield into the farm profile history.
 */
async function completeHarvest(userId, seasonId, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const season = (await client.query(
      `SELECT fs.*, fp.user_id AS owner_id FROM farm_seasons fs
       JOIN farm_profiles fp ON fp.id = fs.farm_id
       WHERE fs.id = $1 FOR UPDATE`,
      [seasonId]
    )).rows[0];
    if (!season || season.owner_id !== userId) {
      throw Object.assign(new Error('Msimu haupatikani au sio wako.'), { statusCode: 403 });
    }
    if (season.status !== 'ACTIVE') throw Object.assign(new Error('Msimu tayari umefungwa.'), { statusCode: 400 });

    const actualYieldTons = Number(data.actualYieldTons ?? data.actual_yield_tons ?? 0);
    const saleAmount = Number(data.saleAmount ?? data.sale_amount ?? 0);
    if (!(actualYieldTons >= 0) || !(saleAmount >= 0)) {
      throw Object.assign(new Error('Mavuno na bei viwe thamani chanya.'), { statusCode: 400 });
    }

    await client.query(
      `UPDATE farm_seasons
       SET status = 'COMPLETED', actual_yield_tons = $1, sale_amount = $2, notes = $3, updated_at = NOW()
       WHERE id = $4`,
      [actualYieldTons, saleAmount, data.notes || null, seasonId]
    );
    await client.query(
      `UPDATE farm_profiles SET historical_yield_tons = historical_yield_tons + $1 WHERE id = $2`,
      [actualYieldTons, season.farm_id]
    );
    await logAudit(userId, 'FARM_SEASON_COMPLETED', `Harvest recorded: ${actualYieldTons} tons (${formatMoney(saleAmount)})`);
    await client.query('COMMIT');
    const fresh = (await client.query(
      `SELECT fs.*, (SELECT historical_yield_tons FROM farm_profiles WHERE id = fs.farm_id) AS farm_historical_yield_tons
       FROM farm_seasons fs WHERE fs.id = $1`,
      [seasonId]
    )).rows[0];
    return fresh;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ================= AGRONOMIST ADVISORIES ================= */

async function createAdvisory(agronomistUserId, data) {
  const { farmId = data.farm_id, seasonId = data.season_id, category, title, advice, actionDueDate = data.action_due_date } = data;
  if (!farmId || !category || !title || !advice) {
    throw Object.assign(new Error('Shamba, kategoria, kichwa na ushauri vinahitajika.'), { statusCode: 400 });
  }
  const farm = await pool.query('SELECT id FROM farm_profiles WHERE id = $1', [farmId]);
  if (!farm.rows.length) throw Object.assign(new Error('Shamba halipatikani.'), { statusCode: 404 });
  if (seasonId) {
    const season = await pool.query('SELECT id FROM farm_seasons WHERE id = $1 AND farm_id = $2', [seasonId, farmId]);
    if (!season.rows.length) throw Object.assign(new Error('Msimu huo haupo kwenye shamba hili.'), { statusCode: 400 });
  }
  const res = await pool.query(
    `INSERT INTO agri_advisories (season_id, farm_id, agronomist_user_id, category, title, advice, action_due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [seasonId || null, farmId, agronomistUserId, category, title, advice, actionDueDate || null]
  );
  await logAudit(agronomistUserId, 'AGRI_ADVISORY_CREATED', `Advisory "${title}" issued for farm #${farmId}`);
  return res.rows[0];
}

async function listAdvisories(userId, role, farmId) {
  const isAdmin = role === 'ADMIN';
  const isAgronomist = role === 'AGRONOMIST' || role === 'ADMIN';
  const params = [];
  let where = '';
  if (farmId) {
    params.push(farmId);
    where += 'AND a.farm_id = $' + params.length + ' ';
  }
  if (!isAdmin) {
    if (isAgronomist) {
      params.push(userId);
      where += 'AND a.agronomist_user_id = $' + params.length + ' ';
    } else {
      params.push(userId);
      where += 'AND fp.user_id = $' + params.length + ' ';
    }
  }
  const res = await pool.query(
    `SELECT a.*, fp.user_id AS farm_owner_id, fp.farm_name, fs.season_name,
            u.full_name AS agronomist_name
     FROM agri_advisories a
     JOIN farm_profiles fp ON fp.id = a.farm_id
     LEFT JOIN farm_seasons fs ON fs.id = a.season_id
     JOIN users u ON u.id = a.agronomist_user_id
     WHERE 1=1 ${where}
     ORDER BY a.created_at DESC`,
    params
  );
  return res.rows;
}

async function actionAdvisory(userId, role, advisoryId) {
  const advisory = await pool.query(
    `SELECT a.*, fp.user_id AS farm_owner_id FROM agri_advisories a
     JOIN farm_profiles fp ON fp.id = a.farm_id
     WHERE a.id = $1`,
    [advisoryId]
  );
  if (!advisory.rows.length) throw Object.assign(new Error('Ushauri haupatikani.'), { statusCode: 404 });
  const row = advisory.rows[0];
  const allowed = role === 'ADMIN' || row.farm_owner_id === userId || row.agronomist_user_id === userId;
  if (!allowed) throw Object.assign(new Error('Huna ruhusa ya kuchukulia hatua ushauri huu.'), { statusCode: 403 });
  const res = await pool.query(
    `UPDATE agri_advisories SET status = 'ACTIONED', updated_at = NOW() WHERE id = $1 AND status = 'ISSUED' RETURNING *`,
    [advisoryId]
  );
  if (!res.rows.length) throw Object.assign(new Error('Ushauri hauko kwenye hali ya ISSUED.'), { statusCode: 400 });
  await logAudit(userId, 'AGRI_ADVISORY_ACTIONED', `Advisory #${advisoryId} marked ACTIONED`);
  return res.rows[0];
}

module.exports = {
  createFarmProfile,
  listFarmProfiles,
  listAgriSuppliers,
  applyAgriLoan,
  listAgriLoans,
  disburseAgriLoan,
  repayAgriLoan,
  createOfftakeAgreement,
  createSeason,
  listSeasons,
  completeHarvest,
  createAdvisory,
  listAdvisories,
  actionAdvisory
};
