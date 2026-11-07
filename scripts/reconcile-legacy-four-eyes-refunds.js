/* ============================================================
 * Phase 70 - READ-ONLY reconciliation of legacy APPROVED ADMIN_LARGE_REFUND
 * requests created under the old REF-<approver>-<Date.now()> reference scheme.
 *
 * Every database query runs inside one READ ONLY transaction. The script never writes to the database; it writes the JSON evidence file using exclusive-create mode.
 * It classifies each legacy APPROVED request as:
 *   EXECUTED      - exactly one matching REF- CREDIT operation, SUCCESS, with a
 *                   balanced two-line journal on the expected system accounts, and
 *                   no unlinked journal evidence in the window.
 *   UNEXECUTED    - no matching REF- operation and no unlinked journal evidence.
 *   INDETERMINATE - anything else (multiple candidates, non-SUCCESS status, partial
 *                   journal, unlinked journal, or no approval row). Never auto-resolved.
 *
 * Required environment:
 *   RECONCILE_CONFIRM=read-only   explicit acknowledgement; the run is otherwise refused
 *   RECONCILE_OUTPUT=<file>       JSON evidence file to write
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 * ============================================================ */
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const { Client } = require('pg');

const WINDOW_BEFORE_MS = 5 * 60 * 1000;
const WINDOW_AFTER_MS = 24 * 60 * 60 * 1000;
const LEGACY_DESCRIPTION = 'Malipo ya marejesho (four-eyes)';

const iso = (d) => new Date(d).toISOString();

async function journalEvidence(client, reference) {
  const rows = (await client.query(
    `SELECT j.direction, j.amount, a.account_code, j.posted_by, j.description,
            j.entry_group_id, j.transaction_id, j.reference_id
       FROM journal_entries j
       JOIN ledger_accounts a ON a.id = j.account_id
      WHERE j.reference_id = $1 OR j.entry_group_id = $1
      ORDER BY j.id`,
    [reference]
  )).rows;

  const dr = rows
    .filter((r) => r.direction === 'DR')
    .reduce((n, r) => n + Number(r.amount), 0);
  const cr = rows
    .filter((r) => r.direction === 'CR')
    .reduce((n, r) => n + Number(r.amount), 0);

  return {
    lines: rows.length,
    dr_total: dr,
    cr_total: cr,
    balanced: rows.length > 0 && Math.abs(dr - cr) < 0.005,
    account_codes: [...new Set(rows.map((r) => r.account_code))].sort(),
    posted_by: [...new Set(rows.map((r) => r.posted_by))].sort(),
    line_evidence: rows.map((r) => ({
      direction: r.direction,
      amount: Number(r.amount),
      account_code: r.account_code,
      posted_by: r.posted_by,
      description: r.description,
      entry_group_id: r.entry_group_id == null ? null : String(r.entry_group_id),
      transaction_id: r.transaction_id == null ? null : String(r.transaction_id),
      reference_id: r.reference_id,
    })),
    entry_group_ids: [...new Set(rows.map((r) => r.entry_group_id == null ? null : String(r.entry_group_id)))],
    transaction_ids: [...new Set(rows.map((r) => r.transaction_id == null ? null : String(r.transaction_id)))],
    reference_ids: [...new Set(rows.map((r) => r.reference_id == null ? null : String(r.reference_id)))],
  };
}

async function auditEvidence(client, reference) {
  const rows = (await client.query(
    `SELECT account_kind, account_id, operation, amount,
            balance_before, balance_after, reference_id, actor, created_at
       FROM financial_audit_log
      WHERE reference_id = $1
      ORDER BY id`,
    [reference]
  )).rows;

  return {
    rows: rows.length,
    entries: rows.map((r) => ({
      account_kind: r.account_kind,
      account_id: r.account_id == null ? null : Number(r.account_id),
      operation: r.operation,
      amount: Number(r.amount),
      balance_before: r.balance_before == null ? null : Number(r.balance_before),
      balance_after: r.balance_after == null ? null : Number(r.balance_after),
      reference_id: r.reference_id,
      actor: r.actor,
      created_at: iso(r.created_at),
    })),
  };
}

async function classify(client, r) {
  const userId = Number(r.payload && r.payload.userId);
  const amount = Number(r.payload && r.payload.amount);
  const approval = await client.query(
    `SELECT approver_id, approver_role, created_at
       FROM four_eyes_approvals
      WHERE request_id = $1 AND decision = 'APPROVE' AND approver_role = 'ADMIN'
      ORDER BY created_at DESC, id DESC LIMIT 1`, [r.id]);
  const approverId = approval.rows.length ? Number(approval.rows[0].approver_id) : null;
  const approvalCreatedAt = approval.rows.length ? new Date(approval.rows[0].created_at) : null;
  const requestUpdatedAt = new Date(r.updated_at);
  const upperBound = approvalCreatedAt && approvalCreatedAt > requestUpdatedAt ? approvalCreatedAt : requestUpdatedAt;
  const from = new Date(new Date(r.created_at).getTime() - WINDOW_BEFORE_MS);
  const to = new Date(upperBound.getTime() + WINDOW_AFTER_MS);
  const base = {
    request_id: Number(r.id),
    requester_id: Number(r.requester_id),
    user_id: userId,
    amount,
    approver_id: approverId,
    requested_at: iso(r.created_at),
    approved_at: approvalCreatedAt ? iso(approvalCreatedAt) : iso(r.updated_at),
    window_from: iso(from),
    window_to: iso(to),
  };

  if (!Number.isSafeInteger(userId) || userId <= 0 || !(amount > 0)) {
    return { ...base, classification: 'INDETERMINATE', reasons: ['payload userId or amount is invalid'], candidates: [], unlinked_journal_refs: [] };
  }

  // Canonical request-linked reference takes precedence over legacy REF attribution.
  // EXECUTED requires the complete creditWallet evidence chain and an ADMIN approval.
  const canonicalReference = `FOUR_EYES_REFUND:${r.id}`;
  const canonicalResult = await client.query(
    `SELECT id, reference_id, operation_type, user_id, amount, status,
            transaction_id, created_at
       FROM financial_operations
      WHERE reference_id = $1
      ORDER BY id`,
    [canonicalReference]
  );

  if (canonicalResult.rows.length > 0) {
    const op = canonicalResult.rows[0];
    const journalRows = (await client.query(
      `SELECT j.direction, j.amount, a.account_code, j.reference_id,
              j.entry_group_id, j.transaction_id, j.posted_by, j.description
         FROM journal_entries j
         JOIN ledger_accounts a ON a.id = j.account_id
        WHERE j.reference_id = $1 OR j.entry_group_id = $1
        ORDER BY j.id`,
      [canonicalReference]
    )).rows;
    const audit = await auditEvidence(client, canonicalReference);

    const drTotal = journalRows.filter(x => x.direction === 'DR')
      .reduce((sum, x) => sum + Number(x.amount), 0);
    const crTotal = journalRows.filter(x => x.direction === 'CR')
      .reduce((sum, x) => sum + Number(x.amount), 0);
    const transactionId = op.transaction_id == null ? null : String(op.transaction_id);
    const journalActors = [...new Set(journalRows.map(x => x.posted_by))];
    const auditRow = audit.rows === 1 ? audit.entries[0] : null;
    const actorValid = journalActors.length === 1 &&
      typeof journalActors[0] === 'string' &&
      /^four-eyes:[1-9][0-9]*$/.test(journalActors[0]);

    const approvalExact = approverId != null &&
      Number.isSafeInteger(approverId) && approverId > 0;
    const operationExact = canonicalResult.rows.length === 1 &&
      op.operation_type === 'CREDIT' &&
      op.status === 'SUCCESS' &&
      Number(op.user_id) === userId &&
      Math.abs(Number(op.amount) - amount) < 0.005;

    const journalExact = journalRows.length === 2 &&
      Math.abs(drTotal - amount) < 0.005 &&
      Math.abs(crTotal - amount) < 0.005 &&
      journalRows.every(x =>
        x.reference_id === canonicalReference &&
        x.entry_group_id === canonicalReference &&
        (x.transaction_id == null ? null : String(x.transaction_id)) === transactionId &&
        x.posted_by === journalActors[0] &&
        x.description === LEGACY_DESCRIPTION
      ) &&
      journalRows.some(x => x.direction === 'DR' &&
        x.account_code === 'SUSPENSE' &&
        Math.abs(Number(x.amount) - amount) < 0.005) &&
      journalRows.some(x => x.direction === 'CR' &&
        x.account_code === 'CUSTOMER_WALLET' &&
        Math.abs(Number(x.amount) - amount) < 0.005);

    const auditExact = audit.rows === 1 && auditRow != null &&
      auditRow.account_kind === 'USER_BALANCE' &&
      auditRow.account_id === userId &&
      auditRow.operation === 'credit' &&
      Math.abs(auditRow.amount - amount) < 0.005 &&
      auditRow.balance_before != null &&
      auditRow.balance_after != null &&
      Math.abs((auditRow.balance_after - auditRow.balance_before) - amount) < 0.005 &&
      auditRow.reference_id === canonicalReference &&
      actorValid &&
      auditRow.actor === journalActors[0];

    const canonicalEvidence = {
      reference_id: op.reference_id,
      operation_count: canonicalResult.rows.length,
      operation_id: Number(op.id),
      operation_type: op.operation_type,
      status: op.status,
      user_id: Number(op.user_id),
      amount: Number(op.amount),
      transaction_id: transactionId,
      created_at: iso(op.created_at),
      approval: {
        valid_admin_approval: approvalExact,
        approver_id: approverId,
        approved_at: approvalCreatedAt ? iso(approvalCreatedAt) : null,
      },
      journal: {
        lines: journalRows.length,
        dr_total: drTotal,
        cr_total: crTotal,
        balanced: journalRows.length > 0 && Math.abs(drTotal - crTotal) < 0.005,
        line_evidence: journalRows.map(x => ({
          direction: x.direction,
          amount: Number(x.amount),
          account_code: x.account_code,
          reference_id: x.reference_id,
          entry_group_id: x.entry_group_id == null ? null : String(x.entry_group_id),
          transaction_id: x.transaction_id == null ? null : String(x.transaction_id),
          posted_by: x.posted_by,
          description: x.description,
        })),
      },
      audit,
    };

    if (approvalExact && operationExact && journalExact && auditExact) {
      return {
        ...base,
        classification: 'EXECUTED',
        reasons: ['canonical SUCCESS CREDIT has valid ADMIN approval, exact SUSPENSE-to-CUSTOMER_WALLET journal linkage and matching financial audit credit'],
        canonical_evidence: canonicalEvidence,
        candidates: [],
        unlinked_journal_refs: [],
      };
    }

    const reasons = [];
    if (!approvalExact) reasons.push('no valid ADMIN APPROVE approval row for canonical refund request');
    if (!operationExact) reasons.push('canonical operation is duplicated or is not a matching SUCCESS CREDIT for the request user and amount');
    if (!journalExact) reasons.push('canonical journal evidence is incomplete or differs from expected accounts, linkage, actor or description');
    if (!auditExact) reasons.push('canonical financial_audit_log evidence is missing or differs from expected USER_BALANCE credit or journal actor');

    return {
      ...base,
      classification: 'INDETERMINATE',
      reasons,
      canonical_evidence: canonicalEvidence,
      candidates: [],
      unlinked_journal_refs: [],
    };
  }

  if (approverId == null) {
    return { ...base, classification: 'INDETERMINATE', reasons: ['no valid ADMIN APPROVE approval row; cannot attribute the legacy reference'], candidates: [], unlinked_journal_refs: [] };
  }

  const ops = await client.query(
    `SELECT id, reference_id, operation_type, user_id, amount, status, transaction_id, created_at
       FROM financial_operations
      WHERE reference_id LIKE 'REF-%' AND created_at BETWEEN $1 AND $2
          AND user_id = $3
          AND amount = $4::numeric
        ORDER BY id`, [from, to, userId, amount]);
  const candidates = [];
  for (const c of ops.rows) {
    candidates.push({
      reference_id: c.reference_id,
      legacy_approver_id: (String(c.reference_id).match(/^REF-(\d+)-(\d+)$/) || [])[1]
        ? Number(String(c.reference_id).match(/^REF-(\d+)-(\d+)$/)[1]) : null,
      operation_type: c.operation_type,
      status: c.status,
      user_id: Number(c.user_id),
      amount: Number(c.amount),
      transaction_id: c.transaction_id,
      created_at: iso(c.created_at),
      journal: await journalEvidence(client, c.reference_id),
      audit: await auditEvidence(client, c.reference_id),
    });
  }

  // Find orphan legacy journal groups in the request window, then attribute
  // only groups supported by this request's approver prefix or exact balanced
  // amount. Candidate-linked groups are never counted as orphans.
  const refs = new Set(candidates.map((c) => c.reference_id));
  const legacyPrefix = approverId == null ? null : `REF-${approverId}-`;
  const unlinked = await client.query(
    `SELECT j.reference_id, j.entry_group_id,
            SUM(CASE WHEN j.direction = 'DR' THEN j.amount ELSE 0 END)::numeric AS dr,
            SUM(CASE WHEN j.direction = 'CR' THEN j.amount ELSE 0 END)::numeric AS cr,
            COUNT(*)::int AS n
       FROM journal_entries j
      WHERE j.posted_at BETWEEN $1 AND $2
        AND (j.reference_id LIKE 'REF-%' OR j.entry_group_id LIKE 'REF-%')
      GROUP BY j.reference_id, j.entry_group_id`, [from, to]);
  const unlinkedRefs = unlinked.rows
    .filter((u) => {
      const values = [u.reference_id, u.entry_group_id].filter((value) => value != null);
      if (values.some((value) => refs.has(value))) return false;
      const matchesApprover = legacyPrefix != null &&
        values.some((value) => String(value).startsWith(legacyPrefix));
      const matchesRequestAmount =
        Math.abs(Number(u.dr) - amount) < 0.005 &&
        Math.abs(Number(u.cr) - amount) < 0.005;
      return (candidates.length === 0 && matchesApprover) || matchesRequestAmount;
    })
    .map((u) => ({
      reference_id: u.reference_id,
      entry_group_id: u.entry_group_id,
      dr_total: Number(u.dr),
      cr_total: Number(u.cr),
      lines: Number(u.n),
    }));

  const reasons = [];
  if (candidates.length === 0 && unlinkedRefs.length === 0) {
    return { ...base, classification: 'UNEXECUTED', reasons: ['no REF- operation and no unlinked journal evidence in window'], candidates, unlinked_journal_refs: unlinkedRefs };
  }
  if (candidates.length === 1 && unlinkedRefs.length === 0) {
    const c = candidates[0];
    const j = c.journal;
    if (c.operation_type !== 'CREDIT') reasons.push(`operation_type ${c.operation_type}, expected CREDIT`);
    if (c.status !== 'SUCCESS') reasons.push(`operation status ${c.status}, expected SUCCESS`);
    if (c.user_id !== userId || Math.abs(c.amount - amount) >= 0.005) reasons.push('operation user or amount differs from request payload');

    const legacyApproverId = c.legacy_approver_id;
    const expectedActor = legacyApproverId == null ? null : `four-eyes:${legacyApproverId}`;
    if (legacyApproverId !== Number(approverId)) {
      reasons.push(`legacy REF approver ${legacyApproverId} differs from latest APPROVE approver ${approverId}`);
    }
    const transactionExact =
      j.transaction_ids.length === 1 &&
      j.transaction_ids[0] === (c.transaction_id == null ? null : String(c.transaction_id));
    const groupExact =
      j.entry_group_ids.length === 1 &&
      j.entry_group_ids[0] === String(c.reference_id);
    const journalExact =
      legacyApproverId != null &&
      expectedActor != null &&
      j.lines === 2 &&
      j.balanced &&
      Math.abs(j.dr_total - amount) < 0.005 &&
      Math.abs(j.cr_total - amount) < 0.005 &&
      groupExact &&
      transactionExact &&
      j.line_evidence.length === 2 &&
      j.line_evidence.every((x) =>
        x.reference_id === c.reference_id &&
        x.entry_group_id === String(c.reference_id)
      ) &&
      j.line_evidence.some((x) =>
        x.direction === 'DR' &&
        x.account_code === 'SUSPENSE' &&
        Math.abs(x.amount - amount) < 0.005 &&
        x.posted_by === expectedActor &&
        x.description === LEGACY_DESCRIPTION
      ) &&
      j.line_evidence.some((x) =>
        x.direction === 'CR' &&
        x.account_code === 'CUSTOMER_WALLET' &&
        Math.abs(x.amount - amount) < 0.005 &&
        x.posted_by === expectedActor &&
        x.description === LEGACY_DESCRIPTION
      );

    if (!journalExact) {
      reasons.push('journal evidence differs from expected SUSPENSE DR / CUSTOMER_WALLET CR, actor or legacy description');
    }

    const auditRow = c.audit.rows === 1 ? c.audit.entries[0] : null;
    const auditExact =
      c.audit.rows === 1 &&
      auditRow &&
      auditRow.account_kind === 'USER_BALANCE' &&
      auditRow.account_id === userId &&
      auditRow.operation === 'credit' &&
      Math.abs(auditRow.amount - amount) < 0.005 &&
      auditRow.balance_before != null &&
      auditRow.balance_after != null &&
      Math.abs((auditRow.balance_after - auditRow.balance_before) - amount) < 0.005 &&
      auditRow.reference_id === c.reference_id &&
      expectedActor != null &&
      auditRow.actor === expectedActor;

    if (!auditExact) {
      reasons.push('financial_audit_log evidence is missing or differs from expected USER_BALANCE credit');
    }

    if (reasons.length === 0) {
      return { ...base, classification: 'EXECUTED', reasons: ['single SUCCESS CREDIT with exact legacy journal group, transaction linkage and financial audit evidence', 'legacy REF actor matches the latest APPROVE approver'], candidates, unlinked_journal_refs: [] };
    }
    return { ...base, classification: 'INDETERMINATE', reasons, candidates, unlinked_journal_refs: [] };
  }
  if (candidates.length > 1) reasons.push(`${candidates.length} REF- operations fall within the request time window; attribution is ambiguous`);
  if (unlinkedRefs.length > 0) reasons.push(`${unlinkedRefs.length} unlinked journal REF- posting(s) fall within the request time window`);
  return { ...base, classification: 'INDETERMINATE', reasons, candidates, unlinked_journal_refs: unlinkedRefs };
}

async function main() {
  if (process.env.RECONCILE_CONFIRM !== 'read-only') {
    console.error('REFUSING: set RECONCILE_CONFIRM=read-only to run this read-only reconciliation.');
    process.exit(2);
  }
  const outPath = process.env.RECONCILE_OUTPUT;
  if (!outPath) {
    console.error('REFUSING: RECONCILE_OUTPUT must name the evidence file.');
    process.exit(2);
  }

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query('BEGIN READ ONLY');
    const meta = (await client.query('SELECT current_database() AS db, now() AS snapshot_at, version() AS pg_version')).rows[0];
    const ro = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    if (ro !== 'on') throw new Error('transaction is not read-only; refusing');

    const population = await client.query(
      `SELECT id, requester_id, payload, status, created_at, updated_at
         FROM four_eyes_requests
        WHERE action_code = 'ADMIN_LARGE_REFUND' AND status = 'APPROVED'
        ORDER BY id`);
    const requests = [];
    for (const r of population.rows) requests.push(await classify(client, r));

    const summary = { EXECUTED: 0, UNEXECUTED: 0, INDETERMINATE: 0 };
    for (const r of requests) summary[r.classification] += 1;

    const result = {
      report: 'legacy-admin-large-refund-reconciliation',
      script_sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
      database: meta.db,
      snapshot_at: iso(meta.snapshot_at),
      pg_version: meta.pg_version,
      transaction_read_only: ro,
      population: requests.length,
      summary,
      requests,
    };
    const text = JSON.stringify(result, null, 2);
    fs.writeFileSync(outPath, text, { flag: 'wx' });
    const fileSha = crypto.createHash('sha256').update(text).digest('hex');
    console.log(`RECONCILE_OK database=${meta.db} population=${requests.length} EXECUTED=${summary.EXECUTED} UNEXECUTED=${summary.UNEXECUTED} INDETERMINATE=${summary.INDETERMINATE} transaction_read_only=${ro}`);
    console.log(`OUTPUT=${outPath} sha256=${fileSha}`);
  } finally {
    if (connected) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('RECONCILE_FAILED', e && e.message);
  process.exit(1);
});
