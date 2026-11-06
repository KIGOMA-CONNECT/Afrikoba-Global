/* ============================================================
 * Phase 70 - DISPOSITION COMPLETENESS GATE for legacy APPROVED ADMIN_LARGE_REFUND requests.
 * Passes only when every legacy request in the reconciliation population has
 * exactly one explicit disposition, bound to the exact reconciliation file.
 * PASS validates structure and completeness only; it does not authenticate
 * evidence, prove financial correctness, or authorize execution/deployment.
 *
 * Usage: node scripts/gate-legacy-refund-dispositions.js <reconciliation.json> <dispositions.json>
 *
 * Dispositions file:
 * {
 *   "reconciliation_sha256": "<sha256 of the reconciliation file>",
 *   "dispositions": [
 *     { "request_id": 12, "classification_reviewed": "EXECUTED",
 *       "disposition": "CLOSE_AS_EXECUTED", "decided_by": 7,
 *       "decided_at": "2026-11-06T10:00:00Z", "evidence_ref": "FIN-REC-...", "rationale": "..." }
 *   ]
 * }
 * ============================================================ */
const fs = require('fs');
const crypto = require('crypto');

const ALLOWED = {
  EXECUTED: ['CLOSE_AS_EXECUTED'],
  UNEXECUTED: ['RECOVER_VIA_NEW_REFERENCE', 'CANCEL_UNEXECUTED'],
  INDETERMINATE: ['RESOLVED_WITH_EVIDENCE'],
};

function evaluate(recon, reconSha, doc) {
  const failures = [];
  if (!recon || typeof recon !== 'object' || !Array.isArray(recon.requests)) {
    return { pass: false, population: 0, dispositions: 0, failures: ['invalid reconciliation structure: requests must be an array'] };
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.dispositions)) {
    return { pass: false, population: recon.requests.length, dispositions: 0, failures: ['invalid dispositions structure: dispositions must be an array'] };
  }
  if (doc.reconciliation_sha256 !== reconSha) {
    failures.push(`dispositions are not bound to this reconciliation (expected ${reconSha}, found ${doc.reconciliation_sha256})`);
  }
  const population = recon.requests;
  const populationIds = new Set();
  for (const r of population) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      failures.push('invalid reconciliation request entry: expected an object');
      continue;
    }
    if (!Number.isSafeInteger(r.request_id) || r.request_id <= 0) {
      failures.push(`invalid reconciliation request_id: ${r.request_id}`);
    } else if (populationIds.has(r.request_id)) {
      failures.push(`request ${r.request_id}: duplicate reconciliation request_id`);
    } else {
      populationIds.add(r.request_id);
    }
    if (!Number.isSafeInteger(r.requester_id) || r.requester_id <= 0) {
      failures.push(`request ${r.request_id}: requester_id must be a positive safe integer`);
    }
    if (!Object.prototype.hasOwnProperty.call(ALLOWED, r.classification)) {
      failures.push(`request ${r.request_id}: invalid reconciliation classification ${r.classification}`);
    }
  }

  const byRequest = new Map();
  for (const d of doc.dispositions) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      failures.push('invalid disposition entry: expected an object');
      continue;
    }
    const id = d.request_id;
    if (!Number.isSafeInteger(id) || id <= 0) {
      failures.push(`invalid disposition request_id: ${d.request_id}`);
      continue;
    }
    if (byRequest.has(id)) failures.push(`request ${id}: duplicate disposition`);
    byRequest.set(id, d);
  }
  const knownIds = new Set(
    population
      .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
      .map((r) => r.request_id)
      .filter((id) => Number.isSafeInteger(id) && id > 0)
  );
  for (const id of byRequest.keys()) {
    if (!knownIds.has(id)) failures.push(`request ${id}: disposition for a request outside the reconciled population`);
  }
  for (const r of population) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const d = byRequest.get(r.request_id);
    const tag = `request ${r.request_id} (${r.classification})`;
    if (!d) { failures.push(`${tag}: missing disposition`); continue; }
    if (d.classification_reviewed !== r.classification) {
      failures.push(`${tag}: reviewed as ${d.classification_reviewed}, reconciled as ${r.classification}`);
    }
    if (!(ALLOWED[r.classification] || []).includes(d.disposition)) {
      failures.push(`${tag}: disposition ${d.disposition} not allowed (allowed: ${ALLOWED[r.classification].join(', ')})`);
    }
    const deciderId = d.decided_by;
    if (!Number.isSafeInteger(deciderId) || deciderId <= 0) {
      failures.push(`${tag}: decided_by must be a positive safe integer`);
    } else if (deciderId === r.requester_id) {
      failures.push(`${tag}: requester may not decide their own request`);
    }
    if (typeof d.evidence_ref !== 'string' || !d.evidence_ref.trim()) failures.push(`${tag}: evidence_ref missing or invalid`);
    if (typeof d.rationale !== 'string' || !d.rationale.trim()) failures.push(`${tag}: rationale missing or invalid`);
    if (typeof d.decided_at !== 'string' || !d.decided_at.trim() || Number.isNaN(Date.parse(d.decided_at))) {
      failures.push(`${tag}: decided_at missing or invalid`);
    }
  }
  return { pass: failures.length === 0, population: population.length, dispositions: byRequest.size, failures };
}

function main() {
  const [reconPath, dispPath] = process.argv.slice(2);
  if (!reconPath || !dispPath) {
    console.error('usage: gate-legacy-refund-dispositions.js <reconciliation.json> <dispositions.json>');
    process.exit(2);
  }
  const reconBuf = fs.readFileSync(reconPath);
  const recon = JSON.parse(reconBuf.toString('utf8'));
  const reconSha = crypto.createHash('sha256').update(reconBuf).digest('hex');
  const doc = JSON.parse(fs.readFileSync(dispPath, 'utf8'));
  const result = evaluate(recon, reconSha, doc);
  console.log(`GATE ${result.pass ? 'PASS' : 'FAIL'} population=${result.population} dispositions=${result.dispositions} reconciliation_sha256=${reconSha}`);
  for (const f of result.failures) console.log(`  - ${f}`);
  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) main();
module.exports = { evaluate, ALLOWED };
