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

async function applyAgriLoan(userId, data) {
  const { farmId, supplierId, amount, loanType, gracePeriodMonths, tenureMonths } = data;
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
       SET status = 'DISBURSED', repayment_due_date = $1, updated_at = NOW() 
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
      `UPDATE agri_loans SET status = $1, updated_at = NOW() WHERE id = $2`,
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

module.exports = {
  createFarmProfile,
  listFarmProfiles,
  applyAgriLoan,
  listAgriLoans,
  disburseAgriLoan,
  repayAgriLoan,
  createOfftakeAgreement
};
