'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '../src/services/vicobaService.js');
const SCHEMA_FILE = path.resolve(__dirname, '../src/validations/schemas.js');

const src = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const schemas = fs.readFileSync(SCHEMA_FILE, 'utf8').replace(/\r\n/g, '\n');

function getFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} function not found`);

  const braceStart = source.indexOf('{', start);
  assert.ok(braceStart >= 0, `${name} opening brace not found`);

  let depth = 0;
  let inString = null;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`${name} boundary not found`);
}

const approve = getFunctionBody(src, 'approveLoan');
const schedule = getFunctionBody(src, 'generateLoanSchedule');
const repay = getFunctionBody(src, 'repayLoan');

const checks = [
  [
    'approval uses deterministic loan disbursement reference',
    /VICOBA:LOAN:\$\{loanId\}:DISBURSE/.test(approve),
  ],
  [
    'approval group debit has sufficient-balance guard',
    /group_wallet_balance\s*>=\s*\$1/.test(approve),
  ],
  [
    'approval checks guarded group debit rowCount',
    /rowCount\s*!==\s*1/.test(approve),
  ],
  [
    'approval does not silently swallow outbox failure',
    /enqueueOutbox\([\s\S]*?reference:\s*`VICOBA:LOAN:\$\{loanId\}`[\s\S]*?tx:\s*client,[\s\S]*?\}\);\s*await client\.query\('COMMIT'\)/.test(approve) &&
      !/enqueueOutbox\([\s\S]*?\.catch\(\(\)\s*=>\s*\{\}\)/.test(
        approve.slice(
          approve.indexOf('await enqueueOutbox'),
          approve.indexOf("await client.query('COMMIT')")
        )
      ),
  ],
  [
    'schedule can execute using caller transaction client',
    /client\s*=\s*null/.test(schedule),
  ],
  [
    'approval generates schedule before commit',
    /generateLoanSchedule\([\s\S]*?\bclient\s*\)/.test(approve),
  ],
  [
    'repayment validates finite positive amount',
    /Number\.isFinite\(amountNum\)/.test(repay) &&
      /amountNum\s*<=\s*0/.test(repay),
  ],
  [
    'repayment performs idempotency lookup after loan lock and before mutable guards',
    (() => {
      const loanLock = repay.indexOf(
        'SELECT * FROM vicoba_loan_requests WHERE id = $1 AND applicant_user_id = $2 FOR UPDATE'
      );
      const idempotencyLookup = repay.indexOf(
        'FROM vicoba_loan_repayments'
      );
      const statusGuard = repay.indexOf(
        "if (loan.status !== 'DISBURSED')"
      );
      const scheduleLookup = repay.indexOf(
        'FROM vicoba_loan_schedules'
      );
      const outstandingGuard = repay.indexOf(
        'amountNum > Number(loan.outstanding_balance)'
      );

      return (
        loanLock >= 0 &&
        idempotencyLookup > loanLock &&
        statusGuard > idempotencyLookup &&
        scheduleLookup > idempotencyLookup &&
        outstandingGuard > idempotencyLookup
      );
    })(),
  ],
  [
    'repayment detects idempotency amount mismatch',
    /existingAmount\s*!==\s*amountNum/.test(repay) &&
      /statusCode:\s*409/.test(repay),
  ],
  [
    'repayment supports an idempotency key',
    /idempotencyKey/.test(repay),
  ],
  [
    'repayment prevents amount above outstanding balance',
    /amountNum\s*>\s*Number\(loan\.outstanding_balance\)/.test(repay),
  ],
  [
    'repayment prevents amount above current installment',
    /amountNum\s*>\s*remainingInstallmentBalance/.test(repay),
  ],
  [
    'repayment reference is deterministic when idempotency key is supplied',
    /VLR-\$\{loanId\}-\$\{idempotencyKey\}/.test(repay),
  ],
  [
    'repayment remains transactional',
    /await\s+client\.query\(['"`]BEGIN['"`]\)/.test(repay) &&
      /await\s+client\.query\(['"`]COMMIT['"`]\)/.test(repay) &&
      /ROLLBACK/.test(repay),
  ],
  [
    'repayment schema accepts idempotencyKey',
    /idempotencyKey:\s*z\.string\(\)\.min\(1\)\.max\(32\)/.test(schemas),
  ],
];

let pass = 0;
let fail = 0;

for (const [name, ok] of checks) {
  if (ok) {
    console.log(`PASS  ${name}`);
    pass++;
  } else {
    console.log(`FAIL  ${name}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
