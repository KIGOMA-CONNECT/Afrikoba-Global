# Runbook — UNDISPATCHED_WITHDRAWAL and STALE_WITHDRAWAL

Scope: withdrawals (`transactions.type = 'WITHDRAWAL'`) stuck in `PROCESSING`, with an open row in `reconciliation_exceptions`.
Owner: payments on-call. Approver: second person, not the one who investigates.

Hard rules:
1. Never refund, re-dispatch, or pay out without written provider evidence for that reference.
2. Never run `UPDATE` or `DELETE` on `transactions`, `wallet_ledger`, `journal_entries`, `financial_operations`, or `reconciliation_exceptions` by hand. Money moves only through the application's financial engine, and only after approval.
3. Do not edit or delete exception rows to clear the queue. Resolution is recorded as a new audit entry.
4. If the provider is silent, do not guess. Escalate.

## 1. Detection (read-only)

Unresolved withdrawals:

```sql
SELECT t.id, t.reference_id, t.user_id, t.wallet_amount, t.status,
       t.external_tx_id, t.meta->>'dispatch' AS dispatch_state,
       t.created_at, t.updated_at, now() - t.created_at AS age
FROM transactions t
WHERE t.type = 'WITHDRAWAL' AND t.status = 'PROCESSING'
ORDER BY t.created_at;
```

Open exceptions:

```sql
SELECT e.id, e.exception_type, e.reference_id, e.transaction_id, e.detail, e.created_at
FROM reconciliation_exceptions e
WHERE e.exception_type IN ('UNDISPATCHED_WITHDRAWAL', 'STALE_WITHDRAWAL')
ORDER BY e.created_at;
```

Exceptions per reference (should be 1; more than 1 means the dedupe is not deployed):

```sql
SELECT reference_id, exception_type, count(*) AS n
FROM reconciliation_exceptions
WHERE exception_type IN ('UNDISPATCHED_WITHDRAWAL', 'STALE_WITHDRAWAL')
GROUP BY reference_id, exception_type HAVING count(*) > 1;
```

Locked funds that have no matching PROCESSING withdrawal (should be 0 rows):

```sql
SELECT u.id, u.locked_balance
FROM users u
WHERE u.locked_balance > 0
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.user_id = u.id AND t.type = 'WITHDRAWAL' AND t.status = 'PROCESSING'
  );
```

## 2. Classify

| Exception | `dispatch_state` | Meaning |
|---|---|---|
| `UNDISPATCHED_WITHDRAWAL` | `INTENT` or `UNCERTAIN`, no `external_tx_id` | We do not know whether the provider received the payout. Gateway says PENDING or UNKNOWN. |
| `UNDISPATCHED_WITHDRAWAL` | `null` | Legacy row from before the dispatch marker existed. Treat the same way. |
| `STALE_WITHDRAWAL` | `ACCEPTED`, `external_tx_id` set | Provider accepted the payout. It has not reached a final state. |

## 3. Verify with the provider (required before any money action)

1. Open a provider support ticket with the `reference_id` and the `external_tx_id` if present. Include the amount, the timestamp of the request, and the account (masked, last 3 digits only).
2. Ask the questions in `docs/phase68/D1_PROVIDER_CONTRACT.md` section 7.
3. Record the provider's answer as one of: `PAID`, `FAILED`, `NOT_RECEIVED`, `PENDING`, `NO_ANSWER`.
4. Save the ticket ID and the provider's written reply as evidence. Store a SHA-256 of the file in the change record.

Until D1 is verified, the provider check is manual. The application status query is not reliable evidence (see the provider contract document).

## 4. Decide

| Provider answer | Action | Requires |
|---|---|---|
| `PAID` | Capture the hold through the engine (`fin.captureHold`, reference `<ref>-CAPTURE`), then set SUCCESS. | Two approvers. Evidence attached. |
| `FAILED` or `NOT_RECEIVED` | Release the hold through the engine (`fin.releaseHold`, reference `<ref>-RELEASE`), then set FAILED. Notify the customer. | Two approvers. Evidence attached. |
| `PENDING` | Do nothing. Re-check in 24 hours. | Ticket open. |
| `NO_ANSWER` after 2 business days | Escalate to the owner. Do not refund. | Owner decision. |

The engine's references are idempotent. Running the same release twice does not release twice. This is a safety net and not a reason to run it twice.

Any action that moves money must be executed by the engineer on the approved change, through the application's engine code path. Do not write balances directly.

## 5. Reconciliation after action

1. Re-run the detection queries. The row should no longer be `PROCESSING`, and the exception should be resolved in the change record.
2. Check that `users.locked_balance` for the customer equals the sum of their remaining PROCESSING withdrawals.
3. Check `wallet_ledger` and `journal_entries` for the reference. There should be exactly one `RELEASE` or `CAPTURE` entry.

## 6. Audit trail

Record for each case:

- Who detected it, who approved it, who executed it (three different people where possible).
- `reference_id`, `transaction_id`, exception IDs, and the amount.
- Provider ticket ID, provider answer, and SHA-256 of the evidence file.
- The decision and the time it was executed.

Store the record with the change ticket. Do not rely on chat logs.

## 7. Escalation

| Condition | Escalate to | Within |
|---|---|---|
| Any `UNDISPATCHED_WITHDRAWAL` older than 2 hours without a provider ticket | Payments lead | 2 hours |
| Any `STALE_WITHDRAWAL` older than 24 hours | Payments lead | 24 hours |
| Provider does not answer after 2 business days | Owner | 2 business days |
| Two or more references with the same `user_id` in exceptions | Fraud / risk review | Same day |
| Any locked-balance mismatch from query 1.4 | Owner and engineering | Immediately |

## 8. What this runbook does not cover

- Deposit reconciliation (`STALE_DEPOSIT`).
- Changing the reconciliation code or its schedule.
- Any change to the production database schema.

## 9. Test coverage for the behaviour this runbook relies on

`tests/withdrawal-dispatch-d1.test.js` (run in an isolated database):

- S3, S3b: an ambiguous timeout keeps the hold and never releases it automatically.
- S4: no exception inside the 10-minute dispatch grace window. After it, `UNDISPATCHED_WITHDRAWAL` is recorded and the hold is kept.
- S4b: a crash after send is settled by gateway SUCCESS.
- S9: unresolved rows do not starve new withdrawals, and exceptions are not duplicated per pass.
