/**
 * AI Cash-Flow Forecasting & Financial Anomaly Detection Service
 * Analyzes historical daily volumes to forecast 30-day cash flow and detect anomalies.
 */

const pool = require('../config/db');
const logger = require('./utils/logger');

async function generateCashFlowForecast() {
  const client = await pool.connect();
  try {
    // Look at past 30 days average daily inflow/outflow
    const history = await client.query(
      `SELECT AVG(total_volume)::numeric AS avg_vol, AVG(total_fees)::numeric AS avg_fees
       FROM analytics_daily_aggregates
       WHERE aggregate_date >= CURRENT_DATE - INTERVAL '30 days'`
    );

    const avgVol = Number(history.rows[0]?.avg_vol || 0);
    const avgFees = Number(history.rows[0]?.avg_fees || 0);

    const forecasts = [];
    for (let i = 1; i <= 30; i++) {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + i);
      const dateStr = targetDate.toISOString().slice(0, 10);

      // Add slight variance simulation
      const variance = 1 + (Math.sin(i) * 0.1);
      const predictedInflow = avgVol * variance;
      const predictedOutflow = avgVol * 0.75 * variance;
      const net = predictedInflow - predictedOutflow;

      await client.query(
        `INSERT INTO cashflow_forecasts (forecast_date, predicted_inflow, predicted_outflow, net_cashflow, confidence_score)
         VALUES ($1, $2, $3, $4, 85.50)
         ON CONFLICT (forecast_date) DO UPDATE SET
           predicted_inflow = EXCLUDED.predicted_inflow,
           predicted_outflow = EXCLUDED.predicted_outflow,
           net_cashflow = EXCLUDED.net_cashflow,
           created_at = NOW()`,
        [dateStr, predictedInflow, predictedOutflow, net]
      );
      forecasts.push({ date: dateStr, predictedInflow, predictedOutflow, net });
    }

    logger.info('FORECAST', '30-day cash flow forecast generated successfully.');
    return { success: true, forecasts };
  } catch (err) {
    logger.error('FORECAST', `Forecast generation failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function detectAnomalies() {
  const client = await pool.connect();
  try {
    // Check for single transactions exceeding 10,000,000 TZS in past 24 hours
    const largeTxs = await client.query(
      `SELECT * FROM transactions WHERE total_charged > 10000000 AND created_at > NOW() - INTERVAL '24 hours'`
    );

    const anomalies = [];
    for (const tx of largeTxs.rows) {
      const check = await client.query(
        `SELECT id FROM financial_anomalies WHERE anomaly_type = 'LARGE_SINGLE_TRANSACTION' AND metadata->>'transaction_id' = $1`,
        [String(tx.id)]
      );
      if (check.rows.length === 0) {
        const res = await client.query(
          `INSERT INTO financial_anomalies (anomaly_type, severity, description, metadata)
           VALUES ('LARGE_SINGLE_TRANSACTION', 'HIGH', $1, $2) RETURNING *`,
          [`Kiasi kikubwa cha TZS ${tx.total_charged} kimeonekana kwenye muamala #${tx.reference_id}`, JSON.stringify({ transaction_id: tx.id, reference_id: tx.reference_id, amount: tx.total_charged })]
        );
        anomalies.push(res.rows[0]);
      }
    }

    return { success: true, detectedCount: anomalies.length, anomalies };
  } catch (err) {
    logger.error('ANOMALY', `Anomaly detection failed: ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
}

async function getForecasts() {
  const res = await pool.query(`SELECT * FROM cashflow_forecasts ORDER BY forecast_date ASC LIMIT 30`);
  return res.rows;
}

async function getAnomalies() {
  const res = await pool.query(`SELECT * FROM financial_anomalies WHERE is_resolved = FALSE ORDER BY created_at DESC`);
  return res.rows;
}

module.exports = { generateCashFlowForecast, detectAnomalies, getForecasts, getAnomalies };
