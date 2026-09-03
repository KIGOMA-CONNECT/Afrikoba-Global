/**
 * AI Project Intelligence, Decomposition & Waterfall Distribution Service
 * Sections 3, 4, 17, 20 & 22 of Master Architecture.
 */

const pool = require('../config/db');
const { generateReference } = require('../utils/helpers');

async function decomposeProject(projectId, projectName, totalBudget) {
  const budget = Number(totalBudget);
  // Automated WBS decomposition into standard phases
  const phases = [
    { phase: 'Phase 1: Planning & Permits', pct: 0.10, days: 30 },
    { phase: 'Phase 2: Foundation & Civil Works', pct: 0.30, days: 60 },
    { phase: 'Phase 3: Superstructure & Framing', pct: 0.35, days: 90 },
    { phase: 'Phase 4: Finishing & Handover', pct: 0.25, days: 45 }
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const createdTasks = [];
    for (const p of phases) {
      const taskCost = budget * p.pct;
      const res = await client.query(
        `INSERT INTO project_decompositions (project_id, phase_name, work_package, task_name, estimated_cost, duration_days, milestone_marker)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
        [projectId, p.phase, p.phase, `${projectName} - ${p.phase}`, taskCost, p.days]
      );
      createdTasks.push(res.rows[0]);
    }

    await client.query(
      `INSERT INTO controlled_project_accounts (project_id, escrow_balance) VALUES ($1, $2)
       ON CONFLICT (project_id) DO NOTHING`,
      [projectId, budget]
    );

    await client.query('COMMIT');
    return { success: true, phases: createdTasks };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function calculateWaterfall(projectId, totalRevenue, config = {}) {
  const rev = Number(totalRevenue);
  const investorPct = config.investorSharePct ?? 60.00;
  const ownerPct = config.ownerSharePct ?? 20.00;
  const reservePct = config.reservePct ?? 10.00;
  const reinvestPct = config.reinvestmentPct ?? 10.00;

  const distribution = {
    totalRevenue: rev,
    investorShare: rev * (investorPct / 100),
    ownerShare: rev * (ownerPct / 100),
    reserveAllocation: rev * (reservePct / 100),
    reinvestmentAllocation: rev * (reinvestmentPct / 100)
  };

  await pool.query(
    `INSERT INTO project_revenue_waterfall (project_id, total_revenue, investor_share_pct, owner_share_pct, reserve_pct, reinvestment_pct, distributed)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
    [projectId, rev, investorPct, ownerPct, reservePct, reinvestPct]
  );

  return distribution;
}

module.exports = { decomposeProject, calculateWaterfall };
