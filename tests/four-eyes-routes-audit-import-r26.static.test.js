#!/usr/bin/env node
'use strict';
/* AFRIKOBA — R26 F-R26-5: fourEyesRoutes.js calls logAction() at 17 sites but
 * b993f1c replaced its import with writeAudit, so every four-eyes HTTP request
 * (launch/approve/reject/cancel) committed its work and then answered 500
 * "logAction is not defined". Static guard: every audit helper the routes call
 * is imported. Runtime coverage: four-eyes-direct-gate-r26.phase71.test.js [3]. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/fourEyesRoutes.js'), 'utf8');
const m = src.match(/const\s*\{([^}]*)\}\s*=\s*require\('\.\.\/services\/auditService'\)/);
const imported = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
let passed = 0; let failed = 0;
for (const fn of ['logAction', 'writeAudit', 'logAudit']) {
  const used = new RegExp(`\\b${fn}\\(`).test(src);
  if (!used) continue;
  const ok = imported.includes(fn);
  if (ok) { passed++; console.log(`  ✓ ${fn}() is used and imported`); } else { failed++; console.log(`  ✗ ${fn}() is used but NOT imported`); }
}
const exported = Object.keys(require(path.join(__dirname, '..', 'src/services/auditService')));
for (const fn of imported) {
  if (exported.includes(fn)) { passed++; console.log(`  ✓ auditService exports ${fn}`); } else { failed++; console.log(`  ✗ auditService does not export ${fn}`); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
