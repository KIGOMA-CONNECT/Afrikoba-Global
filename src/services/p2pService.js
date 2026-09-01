const pool = require('../config/db');
const config = require('../config');
const { generateReference, formatMoney } = require('../utils/helpers');
const { sendSMS } = require('./smsService');
const { generateInvestmentContract } = require('./contractService');
const { logAudit } = require('./auditService');
const { parsePagination, paginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');
const fin = require('../services/financialEngine');

async function createProject(ownerUserId, projectData) {
  const required = ['title', 'sector', 'description', 'targetAmount', 'sharePrice', 'roiPercentage', 'tenureMonths', 'paybackStartMonths', 'businessPlan', 'teamInfo'];
  for (const field of required) {
    if (projectData[field] === undefined || projectData[field] === null || projectData[field] === '') {
      throw Object.assign(new Error(`Tafadhali jaza ${field}.`), { statusCode: 400 });
    }
  }
  const numericFields = ['targetAmount', 'sharePrice', 'roiPercentage', 'tenureMonths', 'paybackStartMonths'];
  for (const field of numericFields) {
    if (parseFloat(projectData[field]) <= 0) {
      throw Object.assign(new Error(`${field} lazima iwe kubwa kuliko 0.`), { statusCode: 400 });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const projectResult = await client.query(
      `INSERT INTO investment_projects
        (owner_user_id, title, sector, description, target_amount, share_price, roi_percentage,
         tenure_months, payback_start_months, business_plan, team_info,
         business_registration_url, financial_projection_url,
         min_investment_amount, max_investment_per_investor, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'SUBMITTED')
       RETURNING *`,
      [
        ownerUserId,
        projectData.title,
        projectData.sector,
        projectData.description,
        projectData.targetAmount,
        projectData.sharePrice,
        projectData.roiPercentage,
        projectData.tenureMonths,
        projectData.paybackStartMonths,
        projectData.businessPlan,
        projectData.teamInfo,
        projectData.businessRegistrationUrl || null,
        projectData.financialProjectionUrl || null,
        projectData.minInvestmentAmount || 50000,
        projectData.maxInvestmentPerInvestor || null,
      ]
    );
    const project = projectResult.rows[0];

    const steps = ['KYC_KYB_VERIFICATION', 'FINANCIAL_AUDIT', 'ESCROW_SETUP', 'LEGAL_PRE_APPROVAL'];
    for (const step of steps) {
      await client.query(
        'INSERT INTO project_audit_steps (project_id, step_name) VALUES ($1, $2)',
        [project.id, step]
      );
    }

    await client.query(
      `INSERT INTO project_business_wallets (project_id) VALUES ($1)`,
      [project.id]
    );
    await client.query(
      `INSERT INTO project_settlement_rules (project_id) VALUES ($1)`,
      [project.id]
    );
    await client.query('COMMIT');
    return project;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Admin: Angalia mradi (Review) - TAINFUND Level 1+2+3 vetting
 * under_review → approved / rejected
 */
async function reviewProject(adminUserId, projectId, decision, reason) {
  const validDecisions = ['APPROVED', 'REJECTED'];
  if (!validDecisions.includes(decision)) {
    throw Object.assign(new Error('Uamuzi lazima uwe APPROVED au REJECTED.'), { statusCode: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const projectRes = await client.query(
      `SELECT * FROM investment_projects WHERE id = $1 FOR UPDATE`,
      [projectId]
    );
    const project = projectRes.rows[0];
    if (!project) throw Object.assign(new Error('Mradi haujapatikana.'), { statusCode: 404 });

    const allowedStatuses = ['SUBMITTED', 'UNDER_REVIEW'];
    if (!allowedStatuses.includes(project.status)) {
      throw Object.assign(new Error(`Mradi uko katika hali ya ${project.status} — haliwezi kukaguliwa.`), { statusCode: 400 });
    }

    if (decision === 'APPROVED') {
      await client.query(
        `UPDATE investment_projects SET status = 'ACTIVE', approved_at = NOW(), approved_by = $1, rejection_reason = NULL WHERE id = $2`,
        [adminUserId, projectId]
      );
    } else {
      await client.query(
        `UPDATE investment_projects SET status = 'REJECTED', rejection_reason = $1 WHERE id = $2`,
        [reason || 'Mradi haukufikia viwango vinavyohitajika.', projectId]
      );
    }

    await client.query('COMMIT');

    await logAudit({ eventType: 'PROJECT_REVIEW', action: decision, entityType: 'PROJECT', userId: adminUserId, entityId: projectId, afterData: { status: decision, reason } });

    const owner = await pool.query(
      `SELECT u.phone_number, u.full_name, p.title FROM investment_projects p
       JOIN users u ON u.id = p.owner_user_id WHERE p.id = $1`,
      [projectId]
    );

    const smsMsg = decision === 'APPROVED'
      ? `Habari ${owner.rows[0].full_name}, mradi wako "${owner.rows[0].title}" umekaguliwa na KUTHIBITISHWA! Wawekezaji sasa wanaweza kuwekeza.`
      : `Habari ${owner.rows[0].full_name}, mradi wako "${owner.rows[0].title}" umekataliwa. Sababu: ${reason || 'Haijafikia viwango.'}`;
    await sendSMS(owner.rows[0].phone_number, smsMsg).catch((smsErr) => logger.error('P2P', `SMS post-review imefunga: ${smsErr.message}`));

    return { success: true, status: decision, projectId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Admin: Orodha ya miradi inayosubiri ukaguzi
 */
async function listPendingProjects() {
  const result = await pool.query(
    `SELECT p.*, u.full_name AS owner_name, u.phone_number AS owner_phone,
            (SELECT COUNT(*) FROM investments i WHERE i.project_id = p.id)::int AS investor_count
     FROM investment_projects p
     JOIN users u ON u.id = p.owner_user_id
     WHERE p.status IN ('SUBMITTED', 'UNDER_REVIEW')
     ORDER BY p.created_at ASC`
  );
  return result.rows;
}

/**
 * Admin: Weka mradi chini ya ukaguzi
 */
async function markUnderReview(adminUserId, projectId) {
  const result = await pool.query(
    `UPDATE investment_projects SET status = 'UNDER_REVIEW' WHERE id = $1 AND status = 'SUBMITTED' RETURNING *`,
    [projectId]
  );
  if (result.rows.length === 0) {
    throw Object.assign(new Error('Mradi haupo katika hali ya SUBMITTED.'), { statusCode: 400 });
  }
  return { success: true, project: result.rows[0] };
}

/**
 * Admin: Kuhakiki mradi (Due Diligence) - hatua 4 lazima zote zipite
 */
async function verifyAuditStep(adminUserId, projectId, stepName, passed, notes) {
  const result = await pool.query(
    `UPDATE project_audit_steps
     SET status = $1, notes = $2, verified_by = $3, verified_at = NOW()
     WHERE project_id = $4 AND step_name = $5
     RETURNING *`,
    [passed ? 'PASSED' : 'FAILED', notes || null, adminUserId, projectId, stepName]
  );
  if (result.rows.length === 0) throw new Error('Hatua ya uhakiki haijapatikana.');

  const all = await pool.query(
    `SELECT status FROM project_audit_steps WHERE project_id = $1`,
    [projectId]
  );
  const allPassed = all.rows.every((r) => r.status === 'PASSED');
  if (allPassed) {
    await pool.query(
      `UPDATE investment_projects SET audit_notes = $1 WHERE id = $2`,
      [notes || 'Uhakiki kamili umekamilika.', projectId]
    );
    const owner = await pool.query(
      `SELECT u.phone_number, u.full_name, p.title FROM investment_projects p
       JOIN users u ON u.id = p.owner_user_id WHERE p.id = $1`,
      [projectId]
    );
    await sendSMS(
      owner.rows[0].phone_number,
      `Habari ${owner.rows[0].full_name}, uhakiki wa mradi "${owner.rows[0].title}" umekamilika.`
    );
  }
  return { success: true };
}

/**
 * Escrow Milestones - tengeneza awamu za kutolewa fedha
 */
async function createEscrowMilestones(adminUserId, projectId, milestones) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const projectRes = await client.query('SELECT * FROM investment_projects WHERE id = $1 FOR UPDATE', [projectId]);
    const project = projectRes.rows[0];
    if (project.status !== 'ACTIVE' && project.status !== 'FUNDED') {
      throw Object.assign(new Error('Mradi haujafunguliwa bado.'), { statusCode: 400 });
    }

    for (let i = 0; i < milestones.length; i++) {
      await client.query(
        `INSERT INTO escrow_milestones (project_id, milestone_number, title, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, milestone_number) DO NOTHING`,
        [projectId, i + 1, milestones[i].title, milestones[i].amount]
      );
    }
    await client.query('COMMIT');
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Wekeza kwenye mradi (investor buys shares)
 * - TAINFUND: min investment, max per investor (diversification cap)
 * - Fedha zinaondoka wallet ya mwekezaji
 * - Mkataba wa PDF unazalishwa na E-Signature Timestamp
 */
async function invest(userId, projectId, sharesToBuy, signatureIp) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const projectRes = await client.query(
      'SELECT * FROM investment_projects WHERE id = $1 FOR UPDATE',
      [projectId]
    );
    const project = projectRes.rows[0];
    if (!project) throw Object.assign(new Error('Mradi haujapatikana.'), { statusCode: 404 });
    if (project.status !== 'ACTIVE') {
      throw Object.assign(new Error('Mradi haujafunguliwa kwa wawekezaji bado.'), { statusCode: 400 });
    }

    const userRes = await client.query(
      'SELECT id, wallet_balance, full_name, phone_number, nida_number FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const user = userRes.rows[0];

    const sharePrice = parseFloat(project.share_price);
    const totalAmount = Math.round(sharePrice * parseInt(sharesToBuy, 10) * 100) / 100;
    if (totalAmount <= 0) throw Object.assign(new Error('Idadi ya hisa si sahihi.'), { statusCode: 400 });
    if (Number(user.wallet_balance) < totalAmount) {
      throw Object.assign(new Error('Salio la wallet lako halitoshi kuwekeza.'), { statusCode: 400 });
    }
    if (Number(project.raised_amount) + totalAmount > Number(project.target_amount)) {
      throw Object.assign(new Error('Uwekezaji unazidi lengo la mtaji.'), { statusCode: 400 });
    }

    // TAINFUND: minimum investment check
    const minInvest = parseFloat(project.min_investment_amount);
    if (minInvest && totalAmount < minInvest) {
      throw Object.assign(new Error(`Uwekezaji mdogo ni ${formatMoney(minInvest)}.`), { statusCode: 400 });
    }

    // TAINFUND: max per investor (diversification cap)
    if (project.max_investment_per_investor) {
      const existing = await client.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS invested FROM investments WHERE project_id = $1 AND investor_user_id = $2`,
        [projectId, userId]
      );
      const alreadyInvested = parseFloat(existing.rows[0].invested);
      const maxAllowed = parseFloat(project.max_investment_per_investor);
      if (alreadyInvested + totalAmount > maxAllowed) {
        throw Object.assign(new Error(
          `Kiwango cha juu kwa mwekezaji ni ${formatMoney(maxAllowed)}. Umeshaweka ${formatMoney(alreadyInvested)}.`
        ), { statusCode: 400 });
      }
    }

    const referenceId = generateReference('INV');
    const tx = await client.query(
      `INSERT INTO transactions
        (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'INVESTMENT', $4)
       RETURNING id`,
      [referenceId, userId, totalAmount, JSON.stringify({ project_id: projectId })]
    );

    await fin.debitWallet({ client, userId, amount: totalAmount, reference: referenceId, toAccount: 'SUSPENSE', description: 'Investment funding' });
    await client.query(
      'UPDATE investment_projects SET raised_amount = raised_amount + $1 WHERE id = $2',
      [totalAmount, projectId]
    );

    const investment = await client.query(
      `INSERT INTO investments
        (project_id, investor_user_id, shares_bought, total_amount, status, signer_ip, signer_phone, signer_nida)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7)
       RETURNING *`,
      [projectId, userId, sharesToBuy, totalAmount, signatureIp, user.phone_number, user.nida_number || null]
    );
    const investRow = investment.rows[0];

    // Mark project as FUNDED if target reached
    const updatedProject = await client.query('SELECT raised_amount, target_amount FROM investment_projects WHERE id = $1', [projectId]);
    if (parseFloat(updatedProject.rows[0].raised_amount) >= parseFloat(updatedProject.rows[0].target_amount)) {
      await client.query(`UPDATE investment_projects SET status = 'FUNDED' WHERE id = $1`, [projectId]);
    }

    await client.query('COMMIT');

    await logAudit({ eventType: 'INVESTMENT', action: 'CREATE', entityType: 'INVESTMENT', userId, entityId: investRow.id, referenceId, amount: totalAmount, afterData: { project_id: projectId, shares: sharesToBuy } });

    // PDF Contract (baada ya COMMIT ili tusifungwe kwenye transaction)
    const signature = { ip: signatureIp, timestamp: new Date() };
    let contractUrl = null;
    try {
      const contract = await generateInvestmentContract({
        investor: { full_name: user.full_name, phone_number: user.phone_number, nida_number: user.nida_number },
        project: {
          title: project.title,
          sector: project.sector,
          description: project.description,
          roi_percentage: project.roi_percentage,
          tenure_months: project.tenure_months,
          payback_start_months: project.payback_start_months,
        },
        investment: { reference_id: referenceId, total_amount: totalAmount, shares_bought: sharesToBuy, share_price: sharePrice },
        signature,
      });
      contractUrl = contract.url;
      await pool.query(
        `UPDATE investments SET contract_pdf_url = $1, contract_signed_at = NOW() WHERE id = $2`,
        [contractUrl, investRow.id]
      );
    } catch (contractError) {
      logger.error('CONTRACT', contractError.message);
    }

    const msg = `Habari ${user.full_name}, umewekeza ${formatMoney(totalAmount)} kwenye ${project.title}. Hisa: ${sharesToBuy}. Ref: ${referenceId}`;
    await sendSMS(user.phone_number, msg);

    return {
      success: true,
      referenceId,
      totalAmount,
      sharesBought: sharesToBuy,
      contractPdfUrl: contractUrl,
      message: 'Uwekezaji umefanikiwa.',
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Release escrow milestone - fedha kwenda wallet ya mjasiriamali
 */
async function releaseMilestone(adminUserId, milestoneId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const milestoneRes = await client.query(
      `SELECT em.*, p.owner_user_id, u.phone_number, u.full_name
       FROM escrow_milestones em
       JOIN investment_projects p ON p.id = em.project_id
       JOIN users u ON u.id = p.owner_user_id
       WHERE em.id = $1 FOR UPDATE OF em`,
      [milestoneId]
    );
    const milestone = milestoneRes.rows[0];
    if (!milestone) throw Object.assign(new Error('Milestone haijapatikana.'), { statusCode: 404 });
    if (milestone.status === 'RELEASED') {
      throw Object.assign(new Error('Milestone hii imeshakutolewa.'), { statusCode: 400 });
    }

    await client.query(
      `UPDATE escrow_milestones SET status = 'RELEASED', released_at = NOW(), released_by = $1 WHERE id = $2`,
      [adminUserId, milestoneId]
    );
    const referenceId = generateReference('EM');
    await fin.creditWallet({ client, userId: milestone.owner_user_id, amount: milestone.amount, reference: referenceId, fromAccount: 'SUSPENSE', description: 'Escrow milestone release' });
    const txRes = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'INVESTMENT_PAYOUT', $4)
       RETURNING id`,
      [referenceId, milestone.owner_user_id, milestone.amount, JSON.stringify({ project_id: milestone.project_id, milestone_id: milestone.id })]
    );

    await client.query(
      `INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description)
       VALUES ($1, $2, $3, $4, 'Escrow milestone release')`,
      [txRes.rows[0].id, referenceId, milestone.owner_user_id, milestone.amount]
    );

    await client.query('COMMIT');

    await logAudit({ eventType: 'ESCROW_RELEASE', action: 'RELEASE', entityType: 'MILESTONE', userId: adminUserId, entityId: milestoneId, referenceId, amount: milestone.amount, afterData: { project_id: milestone.project_id, owner: milestone.owner_user_id } });

    const msg = `Habari ${milestone.full_name}, awamu ya escrow "${milestone.title}" imetolewa: ${formatMoney(milestone.amount)}. Ref: ${referenceId}`;
    await sendSMS(milestone.phone_number, msg).catch((smsErr) => logger.error('P2P', `SMS post-milestone imefunga: ${smsErr.message}`));
    return { success: true, referenceId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Orodha ya miradi inayofunguliwa kwa wawekezaji
 */
async function listProjects(status, sector, forAdmin, pagination) {
  let whereClause = '';
  const params = [status || null, sector || null];

  if (forAdmin) {
    whereClause = `WHERE ($1::varchar IS NULL OR p.status = $1)
                    AND ($2::varchar IS NULL OR p.sector = $2)`;
  } else {
    whereClause = `WHERE p.status = 'ACTIVE'
                    AND ($1::varchar IS NULL OR p.sector = $2)`;
  }

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM investment_projects p ${whereClause}`,
    params
  );
  const total = countRes.rows[0].total;

  const { page, limit, offset } = pagination || { page: 1, limit: 100, offset: 0 };
  const result = await pool.query(
    `SELECT p.*,
            (SELECT COUNT(*) FROM investments i WHERE i.project_id = p.id)::int AS investor_count
     FROM investment_projects p
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $3 OFFSET $4`,
    [...params, limit, offset]
  );
  return { data: result.rows, pagination: paginationMeta(total, page, limit) };
}

async function getProjectDetails(projectId) {
  const project = await pool.query('SELECT * FROM investment_projects WHERE id = $1', [projectId]);
  if (project.rows.length === 0) throw new Error('Mradi haujapatikana.');
  const milestones = await pool.query(
    'SELECT * FROM escrow_milestones WHERE project_id = $1 ORDER BY milestone_number',
    [projectId]
  );
  const wallet = await pool.query(
    'SELECT * FROM project_business_wallets WHERE project_id = $1',
    [projectId]
  );
  const rules = await pool.query(
    'SELECT * FROM project_settlement_rules WHERE project_id = $1',
    [projectId]
  );
  const investors = await pool.query(
    `SELECT i.id, i.shares_bought, i.total_amount, i.status, i.contract_pdf_url, i.created_at,
            u.full_name, u.phone_number
     FROM investments i JOIN users u ON u.id = i.investor_user_id
     WHERE i.project_id = $1 ORDER BY i.created_at DESC`,
    [projectId]
  );
  const auditSteps = await pool.query(
    'SELECT * FROM project_audit_steps WHERE project_id = $1 ORDER BY id',
    [projectId]
  );
  return {
    ...project.rows[0],
    milestones: milestones.rows,
    businessWallet: wallet.rows[0] || null,
    settlementRules: rules.rows[0] || null,
    investors: investors.rows,
    auditSteps: auditSteps.rows,
  };
}

/**
 * TAINFUND: Investor Portfolio Summary
 * - Jumla ya uwekezaji, mradi, mapato, diversification
 */
async function getInvestorPortfolio(userId) {
  const investments = await pool.query(
    `SELECT i.id, i.shares_bought, i.total_amount, i.status AS investment_status, i.created_at AS invested_at,
            p.id AS project_id, p.title, p.sector, p.roi_percentage, p.tenure_months,
            p.status AS project_status, p.target_amount, p.raised_amount
     FROM investments i
     JOIN investment_projects p ON p.id = i.project_id
     WHERE i.investor_user_id = $1
     ORDER BY i.created_at DESC`,
    [userId]
  );

  const rows = investments.rows;
  const totalInvested = rows.reduce((sum, r) => sum + parseFloat(r.total_amount), 0);
  const totalShares = rows.reduce((sum, r) => sum + parseInt(r.shares_bought, 10), 0);
  const projectsCount = new Set(rows.map((r) => r.project_id)).size;
  const sectors = [...new Set(rows.map((r) => r.sector))];
  const activeCount = rows.filter((r) => r.investment_status === 'ACTIVE').length;
  const repaidCount = rows.filter((r) => r.investment_status === 'REPAID').length;

  return {
    totalInvested,
    totalShares,
    projectsCount,
    activeInvestments: activeCount,
    repaidInvestments: repaidCount,
    sectors,
    investments: rows,
  };
}

module.exports = {
  createProject,
  reviewProject,
  listPendingProjects,
  markUnderReview,
  verifyAuditStep,
  createEscrowMilestones,
  invest,
  releaseMilestone,
  listProjects,
  getProjectDetails,
  getInvestorPortfolio,
};
