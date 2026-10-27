#!/usr/bin/env node
'use strict';

// Static regression checks for consultation-fee idempotency (payConsultationFee).
// No database connections or mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');

const src = fs.readFileSync('src/services/projectFinanceService.js', 'utf8');

// Extract payConsultationFee function body.
const start = src.indexOf('async function payConsultationFee(');
assert.notEqual(start, -1, 'payConsultationFee function missing');
const end = src.indexOf('\nasync function listConsultations(', start);
assert.notEqual(end, -1, 'listConsultations marker missing');
const fn = src.slice(start, end);

function has(s) { return fn.includes(s); }

// S1: duplicate detection uses claim.claimed
assert.ok(has('if (!claim.claimed)'), 'S1: must check claim.claimed, not truthiness of claim object');
console.log('PASS S1 duplicate detection uses claim.claimed');

// S2: single transition (setOperationState only, no finalizeOperation)
assert.ok(has("fin.setOperationState("), 'S2: setOperationState must be called');
assert.ok(!has("fin.finalizeOperation("), 'S2: finalizeOperation must NOT be called in payConsultationFee');
console.log('PASS S2 single transition (setOperationState only)');

// S3: transition result checked
assert.ok(has('transition.transitioned'), 'S3: transition result must be checked');
console.log('PASS S3 transition result checked');

// S4: duplicate path checks operation_type and status
assert.ok(has("operation_type = 'PROJECT_CONSULTATION'"), 'S4: duplicate path must check operation_type');
assert.ok(has("status = 'SUCCESS'"), 'S4: duplicate path must check status SUCCESS');
console.log('PASS S4 duplicate path checks operation_type and status');

// S5: duplicate path checks consultation.status === 'PAID'
assert.ok(has("consultation.status === 'PAID'") || has("status === 'PAID'"), 'S5: duplicate path must check consultation status PAID');
console.log('PASS S5 duplicate path checks consultation status PAID');

// S6: debitWallet result captured and validated
assert.ok(has('const debitResult = await fin.debitWallet('), 'S6: debitWallet result must be captured');
assert.ok(has('debitResult.success === true'), 'S6: must check debitResult.success');
assert.ok(has('!debitResult.dedup'), 'S6: must check !debitResult.dedup');
assert.ok(has('Number(debitResult.debited) === Number(fee)'), 'S6: must check debited amount');
console.log('PASS S6 debitWallet result validated');

// S7: logAudit wrapped in try/catch post-commit, outside main try
assert.ok(fn.includes('if (auditPayload)'), 'S7: audit must be conditional on auditPayload');
assert.ok(fn.includes('try {\n      await logAudit(auditPayload)'), 'S7: logAudit must be wrapped in try/catch');
console.log('PASS S7 logAudit wrapped in try/catch (post-commit)');

// S8: claimOperation uses operationType PROJECT_CONSULTATION
assert.ok(has("operationType: 'PROJECT_CONSULTATION'"), 'S8: claimOperation must use PROJECT_CONSULTATION');
console.log('PASS S8 claimOperation uses PROJECT_CONSULTATION');

// S9: project-row lock present
assert.ok(has('FROM projects WHERE id = $1 FOR UPDATE'), 'S9: FOR UPDATE lock on projects must be present');
console.log('PASS S9 project-row lock present (FOR UPDATE)');

// S10: owner mismatch throws 403
assert.ok(has("throw new ValidityError('Unaweza kulipa consultation fee kwa mradi wako tu.', 403)"), 'S10: owner mismatch must throw 403');
console.log('PASS S10 owner mismatch throws 403');

// S11: DB-side exact timestamp equality (no JS Date .getTime())
assert.ok(has('IS NOT DISTINCT FROM'), 'S11: must use DB-side IS NOT DISTINCT FROM for timestamp');
assert.ok(!fn.includes('.getTime()'), 'S11: must NOT use JS Date .getTime() for timestamp comparison');
console.log('PASS S11 DB-side exact timestamp equality (no JS Date .getTime())');

// S12: inconsistent early state throws 409
assert.ok(has("throw new ValidityError(\n        'Hali ya malipo ya consultation si sahihi (inconsistency). Wasiliana na msimamizi.',\n        409\n      )"), 'S12: inconsistent early state must throw 409');
console.log('PASS S12 inconsistent early state throws 409');

// S13: Layer A uses consultation.unique_reference for operation lookup
assert.ok(has('consultation.unique_reference'), 'S13: Layer A must use consultation.unique_reference for op lookup');
console.log('PASS S13 Layer A uses consultation.unique_reference');

// S14: committed flag guards ROLLBACK
assert.ok(has('if (!committed) {'), 'S14: committed flag must guard ROLLBACK');
console.log('PASS S14 committed flag guards ROLLBACK');

// S15: ada/owner read under lock
assert.ok(has('L.consultation_fee') && has('L.owner_user_id'), 'S15: must read fee/owner from locked row L');
console.log('PASS S15 fee/owner read from locked row');

// S16: post-commit audit block outside main try (or guarded)
assert.ok(fn.indexOf('POST-COMMIT AUDIT') > fn.indexOf('} finally {'), 'S16: audit block must be after finally');
console.log('PASS S16 post-commit audit outside main try');

// S17: Layer A does NOT compare consultation.amount to current fee
const layerAStart = fn.indexOf('if (L.consultation_paid_at)');
const feeValidation = fn.indexOf('const fee = Number(L.consultation_fee)');
assert.ok(layerAStart < feeValidation, 'S17: Layer A must come before fee validation');
console.log('PASS S17 Layer A before fee validation (fee-change safety)');

// S18: fee validation after Layer A
assert.ok(feeValidation > layerAStart, 'S18: fee validation must appear after Layer A block');
console.log('PASS S18 fee validation after Layer A');

// S19: no JS Date equality for timestamps
assert.ok(!fn.includes('new Date(') || !fn.includes('.getTime()'), 'S19: no JS Date .getTime() for timestamp comparison');
console.log('PASS S19 no JS Date equality for timestamps');

// S20: amount comparisons use DB-side or string (no Number() for NUMERIC amount comparison in op checks)
// Check that opOk in Layer A uses DB-side (rows.length > 0) not Number() comparison
assert.ok(has('AND amount = $3') || has('amount = $3'), 'S20: amount comparison should be DB-side ($3 parameter)');
console.log('PASS S20 amount comparison is DB-side');

console.log('');
console.log('RESULT: S1-S20 ALL PASSED');
console.log('Total static checks: 20');
console.log('Passed: 20');
console.log('Failed: 0');
process.exitCode = 0;
