'use strict';

const assert = require('node:assert/strict');
const {
  STATUS_CONTRACT,
  classifyGatewayDeposit,
  verifyDepositJournal,
  verifyWalletLedgerRows,
  AMOUNT_TOLERANCE
} = require('../src/services/depositVerification');

const referenceId = 'DP-TEST-001';
const expectedTotal = 10500;

function gateway(status, data, success = true) {
  return { success, status, data };
}

function classify(response, overrides = {}) {
  return classifyGatewayDeposit(response, {
    referenceId,
    expectedTotal,
    contractVerified: true,
    ...overrides
  });
}

function expectDecision(name, response, decision, reason, overrides) {
  const result = classify(response, overrides);
  assert.equal(result.decision, decision, `${name}: decision`);
  assert.equal(result.reason, reason, `${name}: reason`);
  console.log(`PASS ${name}`);
}

expectDecision(
  'valid matching reference and amount',
  gateway('SUCCESS', { externalId: referenceId, amount: expectedTotal }),
  'SUCCESS',
  null
);

expectDecision(
  'missing reference is not accepted',
  gateway('SUCCESS', { amount: expectedTotal }),
  'UNVERIFIED',
  'GATEWAY_REFERENCE_MISSING'
);

expectDecision(
  'mismatched reference is rejected',
  gateway('SUCCESS', { externalId: 'OTHER-REF', amount: expectedTotal }),
  'CONFLICT',
  'REFERENCE_MISMATCH'
);

expectDecision(
  'missing amount is not accepted',
  gateway('SUCCESS', { externalId: referenceId }),
  'UNVERIFIED',
  'GATEWAY_AMOUNT_MISSING'
);

expectDecision(
  'mismatched amount is rejected',
  gateway('SUCCESS', { externalId: referenceId, amount: 10499 }),
  'CONFLICT',
  'AMOUNT_MISMATCH'
);

expectDecision(
  'non-numeric amount is rejected',
  gateway('SUCCESS', { externalId: referenceId, amount: 'invalid' }),
  'CONFLICT',
  'AMOUNT_NOT_NUMERIC'
);

expectDecision(
  'gateway failure without matching reference is unverified',
  gateway('FAILED', {}),
  'UNVERIFIED',
  'GATEWAY_REFERENCE_MISSING'
);

expectDecision(
  'gateway failure with matching reference is classified failed',
  gateway('FAILED', { externalId: referenceId }),
  'FAILED',
  'GATEWAY_FAILED'
);

expectDecision(
  'pending status remains unverified',
  gateway('PENDING', { externalId: referenceId }),
  'UNVERIFIED',
  'GATEWAY_NOT_FINAL'
);

expectDecision(
  'unavailable gateway is unverified',
  gateway('SUCCESS', { externalId: referenceId, amount: expectedTotal }, false),
  'UNVERIFIED',
  'GATEWAY_UNAVAILABLE'
);

expectDecision(
  'invalid expected amount is rejected',
  gateway('SUCCESS', { externalId: referenceId, amount: expectedTotal }),
  'CONFLICT',
  'AMOUNT_NOT_NUMERIC',
  { expectedTotal: 0 }
);

// ---- Provider-contract gate (D1) ----
// The status-query schema is not verified. Until it is, no decision other than
// UNVERIFIED is allowed, even when every candidate field looks correct.
expectDecision(
  'unverified contract blocks an otherwise valid success',
  gateway('SUCCESS', { externalId: referenceId, amount: expectedTotal }),
  'UNVERIFIED',
  'STATUS_CONTRACT_UNVERIFIED',
  { contractVerified: false }
);
expectDecision(
  'unverified contract blocks a failed outcome',
  gateway('FAILED', { externalId: referenceId }),
  'UNVERIFIED',
  'STATUS_CONTRACT_UNVERIFIED',
  { contractVerified: false }
);
expectDecision(
  'unverified contract does not mask gateway unavailability',
  gateway('SUCCESS', { externalId: referenceId, amount: expectedTotal }, false),
  'UNVERIFIED',
  'GATEWAY_UNAVAILABLE',
  { contractVerified: false }
);

assert.equal(STATUS_CONTRACT.evidenceStatus, 'UNVERIFIED', 'contract evidence status');
assert.equal(STATUS_CONTRACT.statusField, 'transactionstatus', 'status field');
console.log('PASS provider contract metadata is explicitly unverified');



function journalRow(account_code, direction, amount, overrides = {}) {
  return {
    entry_group_id: referenceId,
    account_code,
    direction,
    amount: String(amount),
    line_count: 1,
    mismatched_transaction_rows: 0,
    ...overrides
  };
}

const journalOptions = {
  referenceId,
  transactionId: 77,
  amount: 10000,
  commission: 500
};

const validJournal = [
  journalRow('MNO_CLEARING', 'DR', 10500),
  journalRow('CUSTOMER_WALLET', 'CR', 10000),
  journalRow('COMMISSION', 'CR', 500)
];

function expectJournal(name, rows, expected, overrides = {}) {
  assert.equal(
    verifyDepositJournal(rows, { ...journalOptions, ...overrides }),
    expected,
    name
  );
  console.log(`PASS ${name}`);
}

expectJournal('complete deposit journal accepted', validJournal, true);
expectJournal('missing journal line rejected', validJournal.slice(0, 2), false);
expectJournal(
  'wrong account rejected',
  [journalRow('OTHER_ACCOUNT', 'DR', 10500), ...validJournal.slice(1)],
  false
);
expectJournal(
  'wrong direction rejected',
  [journalRow('MNO_CLEARING', 'CR', 10500), ...validJournal.slice(1)],
  false
);
expectJournal(
  'wrong amount rejected',
  [journalRow('MNO_CLEARING', 'DR', 10400), ...validJournal.slice(1)],
  false
);
expectJournal(
  'extra journal line rejected',
  [...validJournal, journalRow('OTHER_ACCOUNT', 'CR', 1)],
  false
);
expectJournal(
  'wrong entry group rejected',
  [journalRow('MNO_CLEARING', 'DR', 10500, { entry_group_id: 'OTHER-REF' }), ...validJournal.slice(1)],
  false
);
expectJournal(
  'transaction mismatch rejected',
  [journalRow('MNO_CLEARING', 'DR', 10500, { mismatched_transaction_rows: 1 }), ...validJournal.slice(1)],
  false
);
expectJournal(
  'duplicate account-direction line rejected',
  [validJournal[0], validJournal[0], validJournal[2]],
  false
);
expectJournal(
  'journal without commission accepted when commission is zero',
  [
    journalRow('MNO_CLEARING', 'DR', 10000),
    journalRow('CUSTOMER_WALLET', 'CR', 10000)
  ],
  true,
  { commission: 0, amount: 10000 }
);

const validWalletLedger = [{
  transaction_id: 77,
  reference_id: referenceId,
  to_user_id: 42,
  amount: '10000.00'
}];

const walletLedgerOptions = {
  referenceId,
  transactionId: 77,
  userId: 42,
  amount: 10000
};

function expectWalletLedger(name, rows, expected, overrides = {}) {
  assert.equal(
    verifyWalletLedgerRows(rows, { ...walletLedgerOptions, ...overrides }),
    expected,
    name
  );
  console.log(`PASS ${name}`);
}

expectWalletLedger('single matching wallet-ledger row accepted', validWalletLedger, true);
expectWalletLedger('missing wallet-ledger row rejected', [], false);
expectWalletLedger(
  'duplicate wallet-ledger rows rejected',
  [...validWalletLedger, ...validWalletLedger],
  false
);
expectWalletLedger(
  'wrong transaction rejected',
  [{ ...validWalletLedger[0], transaction_id: 78 }],
  false
);
expectWalletLedger(
  'wrong user rejected',
  [{ ...validWalletLedger[0], to_user_id: 43 }],
  false
);
expectWalletLedger(
  'wrong reference rejected',
  [{ ...validWalletLedger[0], reference_id: 'OTHER-REF' }],
  false
);
expectWalletLedger(
  'wrong amount rejected',
  [{ ...validWalletLedger[0], amount: '9999.00' }],
  false
);
expectWalletLedger(
  'non-numeric amount rejected',
  [{ ...validWalletLedger[0], amount: 'invalid' }],
  false
);
expectWalletLedger(
  'missing transaction identity rejected',
  validWalletLedger,
  false,
  { transactionId: null }
);

assert.equal(AMOUNT_TOLERANCE, 0.005);
console.log('PASS amount tolerance constant');
console.log('All deposit verification unit tests passed.');
