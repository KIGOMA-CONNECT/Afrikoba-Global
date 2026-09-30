/**
 * Phase 62 regression fingerprint.
 *
 * This test defines the source-level contract for two newly identified
 * financial-engine defects:
 *
 * A. auditBalance() must fail closed when the audit INSERT fails.
 * B. postDeposit() must lock the wallet row before reading wallet_balance.
 *
 * This file does NOT claim live database validation.
 */

const fs = require('fs');
const assert = require('assert');
const path = require('path');

const FILE = path.join(
  __dirname,
  '..',
  'src',
  'services',
  'financialEngine.js'
);

const src = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const out = [];

function run(name, fn) {
  try {
    fn();
    out.push(`PASS  ${name}`);
    pass++;
  } catch (e) {
    out.push(`FAIL  ${name} -- ${e.message}`);
    fail++;
  }
}

// A1 — auditBalance must not swallow audit INSERT failures.
run('#A1 auditBalance is fail-closed: audit INSERT failures propagate', () => {
  const start = src.indexOf('async function auditBalance');
  const end = src.indexOf('async function postJournal', start);

  assert.ok(start >= 0, 'auditBalance function not found');
  assert.ok(end > start, 'auditBalance function boundary not found');

  const fn = src.slice(start, end);

  assert.ok(
    fn.includes('INSERT INTO financial_audit_log'),
    'auditBalance must write to financial_audit_log'
  );

  assert.ok(
    fn.includes("catch (e)"),
    'auditBalance must have an error handler'
  );

  assert.ok(
    fn.includes("logger.error('FIN_AUDIT'"),
    'auditBalance must log audit failure'
  );

  assert.ok(
    fn.includes('throw e;'),
    'auditBalance must rethrow the audit INSERT failure'
  );
});

// A2 — postDeposit must lock the wallet row before reading balance.
run('#A2 postDeposit locks wallet row before balance snapshot', () => {
  const start = src.indexOf('async function postDeposit');
  assert.ok(start >= 0, 'postDeposit function not found');

  const end = src.indexOf('\nasync function ', start + 10);
  const fn = src.slice(start, end > start ? end : src.length);

  const balanceSelect = fn.indexOf(
    'SELECT wallet_balance FROM users WHERE id = $1'
  );

  assert.ok(balanceSelect >= 0, 'postDeposit wallet balance SELECT not found');

  const selectEnd = fn.indexOf('`', balanceSelect);
  const statement = fn.slice(balanceSelect, selectEnd >= 0 ? selectEnd : balanceSelect + 150);

  assert.ok(
    /FOR UPDATE/.test(statement),
    'postDeposit balance SELECT must use FOR UPDATE'
  );
});

// A3 — postDeposit must retain an explicit transaction.
run('#A3 postDeposit remains transactional', () => {
  const start = src.indexOf('async function postDeposit');
  assert.ok(start >= 0, 'postDeposit function not found');

  const end = src.indexOf('\nasync function ', start + 10);
  const fn = src.slice(start, end > start ? end : src.length);

  assert.ok(/'BEGIN'/.test(fn), 'postDeposit must BEGIN a transaction');
  assert.ok(/'COMMIT'/.test(fn), 'postDeposit must COMMIT only after successful work');
  assert.ok(/ROLLBACK/.test(fn), 'postDeposit must retain rollback handling');
});

// A4 — postDeposit must retain audit + mutation in same transactional function.
run('#A4 postDeposit retains wallet mutation and audit in one transaction', () => {
  const start = src.indexOf('async function postDeposit');
  assert.ok(start >= 0, 'postDeposit function not found');

  const end = src.indexOf('\nasync function ', start + 10);
  const fn = src.slice(start, end > start ? end : src.length);

  assert.ok(
    /UPDATE users SET wallet_balance/.test(fn),
    'postDeposit wallet mutation not found'
  );

  assert.ok(
    /auditBalance\(/.test(fn),
    'postDeposit audit call not found'
  );
});

// A5 — no TX224-specific workaround may be introduced.
run('#A5 Phase 62 remains generic; no TX224 special case', () => {
  assert.ok(!/TX224/.test(src), 'TX224-specific workaround detected');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
