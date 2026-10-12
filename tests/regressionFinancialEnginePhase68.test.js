#!/usr/bin/env node
'use strict';

// Static regression checks only. No database connections or mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const engine = fs.readFileSync('src/services/financialEngine.js', 'utf8');
const currency = fs.readFileSync('src/services/currencyService.js', 'utf8');

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: start marker missing`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${label}: end marker missing`);
  return source.slice(start, end);
}

const group = section(
  engine,
  'async function groupToWallet(',
  '\n}\n\n/**',
  'groupToWallet'
);

const debit = group.indexOf(
  'const groupDebit = await client.query(groupSql, [amountN, groupId])'
);
const debitGuard = group.indexOf('groupDebit.rowCount !== 1');
const credit = group.indexOf(
  'UPDATE users SET wallet_balance = wallet_balance + $1'
);
const journal = group.indexOf('await postJournal({');

assert.ok(debit >= 0, 'group debit result must be captured');
assert.ok(debitGuard > debit, 'group debit rowCount guard must follow debit');
assert.ok(credit > debitGuard, 'recipient credit must follow debit guard');
assert.ok(journal > credit, 'journal must follow recipient credit');
console.log('PASS groupToWallet debit guard ordering');

const rates = section(
  currency,
  'async function getExchangeRate(',
  '\nasync function convert(',
  'getExchangeRate'
);
assert.ok(
  rates.includes('Number.isFinite(inverseRate) && inverseRate > 0'),
  'inverse rate must be finite and positive'
);
console.log('PASS inverse FX rate validation');

const conversion = section(
  currency,
  'async function convert(',
  '\nasync function getRateToTzs(',
  'convert'
);
assert.ok(
  conversion.includes('!Number.isFinite(rateData.rate) || rateData.rate <= 0'),
  'conversion must reject invalid FX rates'
);
assert.ok(
  conversion.includes('if (!Number.isFinite(convertedRaw))'),
  'conversion must reject multiplication overflow'
);
assert.ok(
  conversion.includes('!Number.isFinite(convertedAmount) || convertedAmount <= 0'),
  'rounded conversion must be finite and positive'
);
console.log('PASS conversion rate, overflow and rounded amount guards');


const eventService = fs.readFileSync('src/services/eventService.js', 'utf8');
const vicobaService = fs.readFileSync('src/services/vicobaService.js', 'utf8');
const mkobaService = fs.readFileSync('src/services/mkobaService.js', 'utf8');

assert.ok(
  eventService.includes('!Number.isFinite(amountN) || amountN <= 0'),
  'event withdrawal must reject non-finite and non-positive amounts'
);
assert.ok(
  eventService.includes('WHERE id = $2 AND ${col} >= $1'),
  'event withdrawal debit must guard available balance'
);

assert.ok(
  vicobaService.includes("const amountText = typeof rawAmount === 'string' ? rawAmount.trim() : '';"),
  'social fund request must parse the complete input strictly'
);
assert.ok(
  vicobaService.includes('/^(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/'),
  'social fund request must reject trailing or embedded non-numeric characters'
);
assert.ok(
  vicobaService.includes('!Number.isFinite(finalAmount) || finalAmount <= 0'),
  'social fund approval must reject invalid amounts'
);
assert.ok(
  vicobaService.includes('WHERE id = $2 AND total_balance >= $1'),
  'social fund debit must guard available balance'
);
assert.ok(
  vicobaService.includes('WHERE id = $2 AND group_wallet_balance >= $1'),
  'VICOBA group withdrawal must guard available balance'
);
console.log('PASS event and VICOBA withdrawal amount and balance guards');

assert.equal(
  mkobaService.split('group_wallet_balance = group_wallet_balance - $1 WHERE id = $2 AND group_wallet_balance >= $1').length - 1,
  2,
  'both MKOBA debit paths must guard available balance'
);
console.log('PASS both MKOBA debit balance guards');

console.log('RESULT: 5 static regression groups passed');
