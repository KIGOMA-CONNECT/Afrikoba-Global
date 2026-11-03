'use strict';
const { Pool } = require('pg');

const DB_NAME = process.env.DB_NAME || '';
if (!/^(phase68_amount_guard_[a-z0-9_]+|afrikoba_global)$/.test(DB_NAME) || process.env.PHASE68_TEST_DB !== DB_NAME) {
  console.error('SUITE ERROR');
  process.exit(2);
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: DB_NAME,
});

let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  OK ' + label); }
function fail(label, extra) { failed++; failures.push(label); console.log('  FAIL ' + label + (extra ? ' :: ' + extra : '')); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uid = (await client.query('SELECT min(id) AS id FROM users')).rows[0].id;

    console.log('\n--- Withdrawal Amount Validation Test ---');

    // Test 1: Zero amount
    const zeroResult = await (async () => {
      try {
        const walletService = require('../src/services/walletService');
        await walletService.withdrawToMno(uid, 0, 'MPESA', null);
        return { success: true };
      } catch (e) {
        return { success: false, code: e.code, message: e.message };
      }
    })();
    await expect(zeroResult.success === false, 'Zero amount rejected', JSON.stringify(zeroResult));

    // Test 2: Negative amount
    const negResult = await (async () => {
      try {
        const walletService = require('../src/services/walletService');
        await walletService.withdrawToMno(uid, -1000, 'MPESA', null);
        return { success: true };
      } catch (e) {
        return { success: false, code: e.code, message: e.message };
      }
    })();
    await expect(negResult.success === false, 'Negative amount rejected', JSON.stringify(negResult));

    // Test 3: Non-finite amount (Infinity)
    const infResult = await (async () => {
      try {
        const walletService = require('../src/services/walletService');
        await walletService.withdrawToMno(uid, Infinity, 'MPESA', null);
        return { success: true };
      } catch (e) {
        return { success: false, code: e.code, message: e.message };
      }
    })();
    await expect(infResult.success === false, 'Infinity amount rejected', JSON.stringify(infResult));

    // Test 4: Below minimum (1000)
    const belowResult = await (async () => {
      try {
        const walletService = require('../src/services/walletService');
        await walletService.withdrawToMno(uid, 500, 'MPESA', null);
        return { success: true };
      } catch (e) {
        return { success: false, code: e.code, message: e.message };
      }
    })();
    await expect(belowResult.success === false, 'Below minimum (500) rejected', JSON.stringify(belowResult));

    // Test 5: AzamPay disabled (expected - payout contract not verified)
    const disabledResult = await (async () => {
      try {
        const walletService = require('../src/services/walletService');
        await walletService.withdrawToMno(uid, 5000, 'MPESA', null);
        return { success: true };
      } catch (e) {
        return { success: false, code: e.code, message: e.message };
      }
    })();
    await expect(disabledResult.success === false && (disabledResult.code === 'AZAMPAY_DISABLED' || disabledResult.code === 'PAYOUT_CONTRACT_UNVERIFIED'), 'AzamPay disabled (fail-closed)', JSON.stringify(disabledResult));

    await client.query('ROLLBACK');
    console.log('\nWITHDRAWAL VALIDATION TESTS: ' + passed + ' passed, ' + failed + ' failed');
    if (failures.length) console.log('FAILED:', failures.join(' | '));
    process.exit(failed ? 1 : 0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
