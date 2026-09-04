/**
 * Project Monitoring & Variance Tracking Service
 * Implements earned value management (EVM) with cost variance (CV),
 * schedule variance (SV), and health status classification.
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

function classifyStatus({ actualCost, earnedValue, plannedValue, plannedDurationDays, elapsedDays }) {
  const cpi = plannedValue > 0 ? earnedValue / plannedValue : 1; // cost performance index
  const spi = plannedValue > 0 ? earnedValue / plannedValue : 1; // schedule performance index

  if (elapsedDays >= plannedDurationDays && plannedDurationDays > 0 && actualCost >= plannedValue) {
    return 'COMPLETED';
  }
  if (cpi < 0.85) return 'OVER_BUDGET';
  if (spi < 0.85) return 'BEHIND_SCHEDULE';
  if (cpi < 0.95 || spi < 0.95) return 'AT_RISK';
  return 'ON_TRACK';
}

async function recordMonitoring({ projectId, baselineBudget, actualCost, plannedValue, earnedValue, plannedDurationDays, elapsedDays, reviewedBy }) {
  const status = classifyStatus({ actualCost, earnedValue, plannedValue, plannedDurationDays, elapsedDays });
  const res = await pool.query(
    `INSERT INTO project_monitoring
       (project_id, baseline_budget, actual_cost, planned_value, earned_value, planned_duration_days, elapsed_days, status, last_reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [projectId, baselineBudget, actualCost, plannedValue, earnedValue, plannedDurationDays, elapsedDays, status, reviewedBy || null]
  );
  const row = res.rows[0];
  logger.info('PROJECT_MONITOR', `Monitoring snapshot for project ${projectId}: ${status}`);
  return { success: true, monitoring: row, variance: computeVariance(row), status };
}

function computeVariance(m) {
  const costVariance = Number(m.earned_value) - Number(m.actual_cost);
  const scheduleVariance = Number(m.earned_value) - Number(m.planned_value);
  const cpi = Number(m.actual_cost) > 0 ? Number(m.earned_value) / Number(m.actual_cost) : 1;
  const spi = Number(m.planned_value) > 0 ? Number(m.earned_value) / Number(m.planned_value) : 1;
  return {
    costVariance, scheduleVariance,
    cpi: Number(cpi.toFixed(2)),
    spi: Number(spi.toFixed(2)),
    estimateAtCompletion: Number((Number(m.baseline_budget) / (cpi || 1)).toFixed(2)),
    varianceAtCompletion: Number((Number(m.baseline_budget) - Number(m.baseline_budget) / (cpi || 1)).toFixed(2))
  };
}

async function getProjectMonitoring(projectId) {
  const res = await pool.query(
    `SELECT * FROM project_monitoring WHERE project_id = $1 ORDER BY snapshot_taken_at DESC LIMIT 20`,
    [projectId]
  );
  return res.rows.map((m) => ({ ...m, variance: computeVariance(m) }));
}

async function addMilestone({ projectId, milestoneName, plannedDate, plannedBudget }) {
  const res = await pool.query(
    `INSERT INTO project_milestones (project_id, milestone_name, planned_date, planned_budget)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [projectId, milestoneName, plannedDate, plannedBudget || 0]
  );
  return res.rows[0];
}

async function updateMilestone(milestoneId, { actualDate, actualCost, status }) {
  const res = await pool.query(
    `UPDATE project_milestones
        SET actual_date = COALESCE($2, actual_date),
            actual_cost = COALESCE($3, actual_cost),
            status = COALESCE($4, status),
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [milestoneId, actualDate || null, actualCost !== undefined ? actualCost : null, status || null]
  );
  return res.rows[0];
}

async function listMilestones(projectId) {
  const res = await pool.query(
    `SELECT * FROM project_milestones WHERE project_id = $1 ORDER BY planned_date ASC`,
    [projectId]
  );
  return res.rows;
}

module.exports = { recordMonitoring, getProjectMonitoring, computeVariance, addMilestone, updateMilestone, listMilestones };
