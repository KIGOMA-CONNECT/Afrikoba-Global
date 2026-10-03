'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '../src/services/mkobaService.js');
const src = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

function getFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.ok(start >= 0, `${name} function not found`);

  const braceStart = source.indexOf('{', start);
  assert.ok(braceStart >= 0, `${name} function opening brace not found`);

  let depth = 0;
  let inString = null;
  let escaped = false;

  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`${name} function boundary not found`);
}

const fn = getFunctionBody(src, 'approveProfitDistribution');

const checks = [
  [
    'group wallet row is locked before payout',
    /SELECT\s+group_wallet_balance\s+FROM\s+vicoba_groups\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(fn),
  ],
  [
    'group wallet balance is read before payout',
    /const\s+groupWalletBalance\s*=\s*Number\s*\(\s*groupRes\.rows\[0\]\.group_wallet_balance\s*\)/.test(fn),
  ],
  [
    'only unpaid payouts are selected',
    /FROM\s+vicoba_profit_payouts\s+WHERE\s+distribution_id\s*=\s*\$1\s+AND\s+paid\s*=\s*FALSE/i.test(fn),
  ],
  [
    'total payable is calculated from payout rows',
    /const\s+totalPayable\s*=\s*payouts\.rows\.reduce/.test(fn),
  ],
  [
    'insufficient group wallet balance is rejected',
    /groupWalletBalance\s*<\s*totalPayable/.test(fn),
  ],
  [
    'groupToWallet receives group wallet decrement SQL',
    /groupSql:\s*['"`]UPDATE\s+vicoba_groups\s+SET\s+group_wallet_balance\s*=\s*group_wallet_balance\s*-\s*\$1\s+WHERE\s+id\s*=\s*\$2['"`]/i.test(fn),
  ],
  [
    'payout remains transaction-protected',
    /await\s+client\.query\s*\(\s*['"`]BEGIN['"`]\s*\)/.test(fn) &&
      /await\s+client\.query\s*\(\s*['"`]COMMIT['"`]\s*\)/.test(fn) &&
      /ROLLBACK/.test(fn),
  ],
  [
    'profit pool is not modified by approval patch',
    !/UPDATE\s+vicoba_groups\s+SET\s+total_profit_pool/i.test(fn),
  ],
  [
    'no TX224-specific workaround exists',
    !/TX224/.test(fn),
  ],
];

for (const [name, passed] of checks) {
  assert.ok(passed, name);
  console.log(`PASS  ${name}`);
}

console.log(`\n${checks.length} passed, 0 failed`);
