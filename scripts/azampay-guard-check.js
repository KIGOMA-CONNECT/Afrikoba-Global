'use strict';
/* ============================================================================
 * AFRIKOBA — AzamPay / production-path GUARD (test-time regression gate)
 * ----------------------------------------------------------------------------
 * Proves that the withdrawal-reconciliation work did NOT touch the safety
 * properties the owner asked us to protect:
 *   G1  src/config/index.js  validateConfig()           (fail-fast rules)
 *   G2  src/config/index.js  azampay env mapping (AZAMPAY_ENABLED semantics)
 *   G3  src/services/azampayService.js assertAzamPayEnabled()  (503 guard)
 *   G4  src/services/azampayService.js production/sandbox gateway URLs
 *   G5  src/services/walletService.js AZAMPAY_DISABLED gates (all occurrences)
 *   G6  .github/workflows/ci.yml unchanged (no unapproved CI change)
 *
 * Run:  node scripts/azampay-guard-check.js      (from repo root)
 * Env:  GUARD_BASE_REF  (default "main")
 * Exit: 0 = all protected regions identical to base, 1 = regression found.
 * ==========================================================================*/
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_REF = process.env.GUARD_BASE_REF || 'main';
const root = path.resolve(__dirname, '..');

function show(rel) {
  return execFileSync('git', ['show', `${BASE_REF}:${rel}`], { cwd: root, encoding: 'utf8' });
}
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function matches(src, re) { const out = src.match(re) || []; return out; }

const checks = [];
function check(label, current, baseline) {
  const ok = current === baseline;
  checks.push({ label, ok });
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        base(${BASE_REF}):\n${String(baseline).split('\n').map((l) => '        | ' + l).join('\n')}`);
    console.log(`        current:\n${String(current).split('\n').map((l) => '        | ' + l).join('\n')}`);
  }
}

console.log('==============================');
console.log('AZAMPAY / PRODUCTION-PATH GUARD');
console.log('base ref: ' + BASE_REF);
console.log('==============================');

// --- G1 validateConfig() ---------------------------------------------------
const reValidate = /function validateConfig\(\)\s*\{[\s\S]*?\n\}/;
check('G1 validateConfig() unchanged', (read('src/config/index.js').match(reValidate) || ['<missing>'])[0],
  (show('src/config/index.js').match(reValidate) || ['<missing>'])[0]);

// --- G2 azampay env mapping ------------------------------------------------
const reAzCfg = /azampay:\s*\{[\s\S]*?\n  \},/;
check('G2 azampay config mapping (AZAMPAY_ENABLED semantics) unchanged',
  (read('src/config/index.js').match(reAzCfg) || ['<missing>'])[0],
  (show('src/config/index.js').match(reAzCfg) || ['<missing>'])[0]);

// --- G3 assertAzamPayEnabled() --------------------------------------------
const reAssert = /function assertAzamPayEnabled\(\)\s*\{[\s\S]*?\n\}/;
check('G3 assertAzamPayEnabled() (503 guard) unchanged',
  (read('src/services/azampayService.js').match(reAssert) || ['<missing>'])[0],
  (show('src/services/azampayService.js').match(reAssert) || ['<missing>'])[0]);

// --- G4 production / sandbox gateway URLs ---------------------------------
const reUrls = /const BASE_URL =[\s\S]*?azampay\.co\.tz';|const AUTH_URL =[\s\S]*?azampay\.co\.tz';/g;
check('G4 production + sandbox gateway URLs unchanged',
  JSON.stringify(matches(read('src/services/azampayService.js'), reUrls)),
  JSON.stringify(matches(show('src/services/azampayService.js'), reUrls)));

// --- G5 AZAMPAY_DISABLED gates in walletService ---------------------------
const reGate = /if \(!config\.azampay\.enabled\) \{[\s\S]*?\n  \}/g;
const curGates = matches(read('src/services/walletService.js'), reGate);
const baseGates = matches(show('src/services/walletService.js'), reGate);
check(`G5 AZAMPAY_DISABLED gate count (${baseGates.length} in base) preserved`, String(curGates.length), String(baseGates.length));
check('G5 AZAMPAY_DISABLED gate bodies unchanged', JSON.stringify(curGates), JSON.stringify(baseGates));

// --- G6 ci.yml untouched ---------------------------------------------------
check('G6 .github/workflows/ci.yml byte-identical to base', read('.github/workflows/ci.yml'), show('.github/workflows/ci.yml'));

// --- report ----------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
console.log('------------------------------');
console.log(`${checks.length - failed.length}/${checks.length} guard checks passed`);
if (failed.length) {
  console.log('GUARD RESULT: FAILED — unapproved change to protected production path(s):');
  failed.forEach((f) => console.log('  - ' + f.label));
  process.exit(1);
}
console.log('GUARD RESULT: PASS');
process.exit(0);
