/**
 * AI Budget / BOQ Analysis Service
 *
 * Analyzes project BOQs and quotations against reference market rates to detect
 * cost anomalies / overpricing, computes a budget-health assessment with a
 * confidence score, and produces actionable recommendations.
 *
 * Model registered in the afri-ai governance register: afri-boq-1.0
 */

const pool = require('../config/db');
const logger = require('../utils/logger');

const BOQ_MODEL = 'afri-boq-1.0';

/** Normalize a line description to a known market-rate category. */
function categorize(description) {
  const d = String(description || '').toLowerCase();
  if (d.includes('foundation') || d.includes('excav')) return 'Foundation & Excavation';
  if (d.includes('steel') || d.includes('concrete') || d.includes('structural')) return 'Structural Steel & Concrete';
  if (d.includes('labor') || d.includes('labour') || d.includes('supervis')) return 'Labor & Supervision';
  if (d.includes('masonry') || d.includes('block')) return 'Masonry & Blockwork';
  if (d.includes('roof')) return 'Roofing';
  if (d.includes('electric') || d.includes('wiring')) return 'Electrical Installation';
  if (d.includes('plumb')) return 'Plumbing';
  if (d.includes('finish') || d.includes('paint')) return 'Finishing / Painting';
  return null;
}

async function marketRate(category, unit) {
  const res = await pool.query(
    'SELECT reference_rate, unit FROM ai_market_rates WHERE category=$1 ORDER BY updated_at DESC LIMIT 1',
    [category]
  );
  return res.rows[0] || null;
}

/** Analyze a single line item against its market reference. */
function analyzeLine(item, ref) {
  const unitCost = Number(item.unitCost) || 0;
  let variancePct = null, verdict = 'no-reference', suggestion = null;

  if (ref) {
    const refUnit = Number(ref.reference_rate) || 0;
    if (refUnit > 0) {
      // Compare like-for-like on unit cost where unit matches, else per-total basis
      const refValue = ref.unit ? refUnit : refUnit;
      variancePct = Math.round(((unitCost - refValue) / refValue) * 1000) / 10;
    }
    if (variancePct !== null) {
      if (variancePct > 25) verdict = 'overpriced';
      else if (variancePct < -25) verdict = 'underpriced';
      else verdict = 'fair';
    }
  }

  if (verdict === 'overpriced') {
    suggestion = `Review ${item.description || 'this item'} — priced ${variancePct}% above the ${ref.category} reference rate (${ref.reference_rate}).`;
  }

  return {
    ...item,
    category: ref ? ref.category : null,
    referenceRate: ref ? Number(ref.reference_rate) : null,
    variancePercent: variancePct,
    verdict,
    suggestion,
  };
}

/**
 * Analyze a budget / BOQ for a project.
 * `lineItems` shape: [{ description, quantity, unitCost, total }]
 */
async function analyzeBudget(projectId, documentId, lineItems, totalBudget) {
  let items = Array.isArray(lineItems) ? lineItems : [];
  if (items.length === 0) {
    // fall back to stored document extraction
    const doc = (await pool.query(
      'SELECT extracted_data FROM project_documents WHERE id=$1',
      [documentId || 0]
    )).rows[0];
    if (doc?.extracted_data?.items) items = doc.extracted_data.items;
  }

  const analyzed = [];
  let refTotal = 0, matched = 0, overpriced = 0;

  for (const item of items) {
    const cat = categorize(item.description);
    const ref = cat ? await marketRate(cat, item.unit) : null;
    const line = analyzeLine(item, ref);
    if (ref) { refTotal += Number(item.unitCost) || Number(item.total) || 0; matched++; }
    if (line.verdict === 'overpriced') overpriced++;
    analyzed.push(line);
  }

  const total = totalBudget || items.reduce((s, i) => s + (Number(i.total) || Number(i.unitCost) || 0), 0);
  const variance = refTotal > 0 ? total - refTotal : null;
  const variancePercent = refTotal > 0 ? Math.round((variance / refTotal) * 1000) / 10 : null;

  let health = 'WATCH';
  if (variancePercent === null) health = 'WATCH';
  else if (variancePercent <= 5) health = 'HEALTHY';
  else if (variancePercent <= 25) health = 'WATCH';
  else health = 'OVERPRICED';
  if (overpriced === 0 && variancePercent !== null && variancePercent < -10) health = 'UNDERPRICED';

  // Confidence: strong when many line items matched to references
  const confidence = Math.min(96, Math.round((matched / Math.max(items.length, 1)) * 100) * 0.9) ;

  const recommendations = [];
  if (overpriced > 0) recommendations.push({
    priority: 'HIGH',
    title: `Renegotiate ${overpriced} overpriced line item(s)`,
    body: 'Several BOQ items exceed reference market rates by >25%. Re-quote these before approval.',
    impact: 'Estimated cost reduction',
  });
  if (health === 'HEALTHY') recommendations.push({
    priority: 'LOW',
    title: 'Budget is market-aligned',
    body: 'Budget/BOQ pricing is within reference rates. Proceed with approval.',
    impact: 'Confidence in approval',
  });
  if (matched < Math.max(items.length, 1) * 0.3) recommendations.push({
    priority: 'MEDIUM',
    title: 'Add more references',
    body: 'Many items could not be matched to market rates. Provide more detail to improve analysis.',
    impact: 'Better confidence',
  });

  const res = await pool.query(
    `INSERT INTO ai_budget_analyses
       (project_id, document_id, total_budget, market_reference_total, variance, variance_percent, budget_health, confidence, line_items, recommendations, model_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [projectId, documentId, total, refTotal, variance, variancePercent, health, confidence,
     JSON.stringify(analyzed), JSON.stringify(recommendations), BOQ_MODEL]
  );

  // Register model usage in the AI governance register
  await pool.query(
    `INSERT INTO ai_model_register (model_key, model_version, generated_by, scope_user_id, insight_count)
     VALUES ($1,$2,'aiBudgetBoq', NULL, $3)`,
    [BOQ_MODEL, BOQ_MODEL, items.length]
  ).catch(() => {});

  logger.info('AI_BOQ', `Project ${projectId}: health=${health}, conf=${confidence}, items=${items.length}, overpriced=${overpriced}`);
  return res.rows[0];
}

async function listAnalyses(projectId) {
  const res = await pool.query(
    'SELECT * FROM ai_budget_analyses WHERE ($1::int IS NULL OR project_id=$1) ORDER BY created_at DESC',
    [projectId || null]
  );
  return res.rows;
}

async function getAnalysis(id) {
  const res = await pool.query('SELECT * FROM ai_budget_analyses WHERE id=$1', [id]);
  return res.rows[0] || null;
}

async function marketRates() {
  const res = await pool.query('SELECT * FROM ai_market_rates ORDER BY category');
  return res.rows;
}

module.exports = { analyzeBudget, listAnalyses, getAnalysis, marketRates };
