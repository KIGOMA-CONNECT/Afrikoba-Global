'use strict';

const AMOUNT_TOLERANCE = 0.005;

/**
 * AzamPay transaction-status response contract.
 *
 * Evidence status: UNVERIFIED (checked 2026-10-29).
 * `docs/phase68/D1_PROVIDER_CONTRACT.md` section 3 records that no checked
 * source documents the `/azampay/payment/query` response. Only the status field
 * is established by the existing integration code (`azampayService` reads
 * `d.transactionstatus`). The reference and amount echo field names below are
 * *candidates*, not a confirmed contract.
 *
 * Because of that, the classifier never treats these candidates as proof on
 * their own: `classifyGatewayDeposit` refuses to return SUCCESS/FAILED unless the
 * caller passes `contractVerified: true`, which comes from
 * `config.azampay.statusContractVerified` (`AZAMPAY_STATUS_CONTRACT_VERIFIED`).
 * While the flag is false every deposit stays PENDING and an exception is
 * recorded, so a forged or misparsed callback can never move money.
 */
const STATUS_CONTRACT = Object.freeze({
  evidenceStatus: 'UNVERIFIED',
  evidence: 'docs/phase68/D1_PROVIDER_CONTRACT.md#3',
  statusField: 'transactionstatus',
  referenceFields: Object.freeze(['externalId', 'externalReferenceId', 'reference']),
  amountFields: Object.freeze(['amount', 'transactionAmount']),
});

function firstPresent(data, fields) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    const value = data[field];
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
}

/**
 * Decide a deposit outcome from the GATEWAY answer, never from the callback body.
 * Pure function: no I/O.
 *
 * Decisions:
 *   SUCCESS    gateway SUCCESS, contract verified, reference matches, amount matches.
 *   FAILED     gateway FAILED, contract verified, reference matches.
 *   CONFLICT   gateway answer contradicts our record (reference or amount differs).
 *   UNVERIFIED gateway unavailable, contract unverified, still pending, unknown,
 *              or the response is missing a required field.
 */
function classifyGatewayDeposit(gateway, {
  referenceId,
  expectedTotal,
  contractVerified = false,
  contract = STATUS_CONTRACT,
}) {
  if (!gateway || gateway.success !== true) {
    return { decision: 'UNVERIFIED', reason: 'GATEWAY_UNAVAILABLE' };
  }

  // No credit, failure transition or hold release may be derived from a
  // response schema that has not been verified with the provider.
  if (contractVerified !== true) {
    return { decision: 'UNVERIFIED', reason: 'STATUS_CONTRACT_UNVERIFIED' };
  }

  const data = gateway.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { decision: 'UNVERIFIED', reason: 'GATEWAY_DATA_MISSING' };
  }

  const gatewayRef = firstPresent(data, contract.referenceFields);

  if (
    referenceId == null ||
    String(referenceId).trim() === '' ||
    gatewayRef == null
  ) {
    return { decision: 'UNVERIFIED', reason: 'GATEWAY_REFERENCE_MISSING' };
  }

  if (String(gatewayRef) !== String(referenceId)) {
    return { decision: 'CONFLICT', reason: 'REFERENCE_MISMATCH' };
  }

  const status = String(gateway.status || '').toUpperCase();

  if (status === 'FAILED') {
    return { decision: 'FAILED', reason: 'GATEWAY_FAILED' };
  }

  if (status !== 'SUCCESS') {
    return { decision: 'UNVERIFIED', reason: 'GATEWAY_NOT_FINAL' };
  }

  const rawAmount = firstPresent(data, contract.amountFields);

  if (rawAmount === null) {
    return { decision: 'UNVERIFIED', reason: 'GATEWAY_AMOUNT_MISSING' };
  }

  const gatewayAmount = Number(rawAmount);
  const expected = Number(expectedTotal);

  if (
    !Number.isFinite(gatewayAmount) ||
    !Number.isFinite(expected) ||
    gatewayAmount < 0 ||
    expected <= 0
  ) {
    return { decision: 'CONFLICT', reason: 'AMOUNT_NOT_NUMERIC' };
  }

  if (Math.abs(gatewayAmount - expected) > AMOUNT_TOLERANCE) {
    return { decision: 'CONFLICT', reason: 'AMOUNT_MISMATCH' };
  }

  return { decision: 'SUCCESS', reason: null };
}

/**
 * Validate that a previously-claimed deposit reference really carries a complete,
 * balanced deposit journal for THIS transaction.
 *
 * `rows` is the grouped result of journal_entries joined to ledger_accounts:
 *   { entry_group_id, account_code, direction, amount, line_count,
 *     mismatched_transaction_rows }
 *
 * A duplicate deposit is only "verified" when this returns true. The existence
 * of a financial_operations row or a journal row on its own is never enough.
 */
function verifyDepositJournal(rows, {
  referenceId,
  transactionId = null,
  amount,
  commission = 0
}) {
  if (!Array.isArray(rows) || !referenceId) return false;

  const depositAmount = Number(amount);
  const commissionAmount = Number(commission);

  if (
    !Number.isFinite(depositAmount) ||
    depositAmount <= 0 ||
    !Number.isFinite(commissionAmount) ||
    commissionAmount < 0
  ) {
    return false;
  }

  const expected = new Map([
    ['MNO_CLEARING:DR', depositAmount + commissionAmount],
    ['CUSTOMER_WALLET:CR', depositAmount]
  ]);

  if (commissionAmount > 0) {
    expected.set('COMMISSION:CR', commissionAmount);
  }

  if (rows.length !== expected.size) return false;

  const seen = new Set();

  for (const row of rows) {
    if (!row || row.entry_group_id !== referenceId) return false;

    const key = `${row.account_code}:${row.direction}`;
    const expectedAmount = expected.get(key);

    if (expectedAmount === undefined || seen.has(key)) return false;
    seen.add(key);

    const actualAmount = Number(row.amount);
    if (
      Number(row.line_count) !== 1 ||
      Number(row.mismatched_transaction_rows) !== 0 ||
      !Number.isFinite(actualAmount) ||
      Math.abs(actualAmount - expectedAmount) >= AMOUNT_TOLERANCE
    ) {
      return false;
    }
  }

  return seen.size === expected.size;
}

/**
 * Validate the single wallet_ledger row a deposit settlement must have created.
 */
function verifyWalletLedgerRows(rows, {
  referenceId,
  transactionId,
  userId,
  amount
}) {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  if (referenceId == null || String(referenceId).trim() === '') return false;
  if (transactionId == null || userId == null) return false;

  const expectedAmount = Number(amount);
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) return false;

  const row = rows[0];
  if (!row) return false;

  if (String(row.transaction_id) !== String(transactionId)) return false;
  if (String(row.to_user_id) !== String(userId)) return false;
  if (row.reference_id == null ||
      String(row.reference_id) !== String(referenceId)) return false;

  const actualAmount = Number(row.amount);
  if (!Number.isFinite(actualAmount)) return false;

  return Math.abs(actualAmount - expectedAmount) < AMOUNT_TOLERANCE;
}

module.exports = {
  STATUS_CONTRACT,
  classifyGatewayDeposit,
  verifyDepositJournal,
  verifyWalletLedgerRows,
  AMOUNT_TOLERANCE
};
