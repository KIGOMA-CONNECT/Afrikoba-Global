# D1 — AzamPay payout contract: verification record

Status: **BLOCKED**. The payout contract is not verified against official AzamPay documentation.
Withdrawals stay closed in code. Gate: `AZAMPAY_PAYOUT_CONTRACT_VERIFIED` must be `true` to pass, and it defaults to `false` (`src/config/index.js`, `walletService.withdrawToMno`, `azampayService.triggerPayout`).
Checked: 2026-10-29.

## 1. Sources checked

| Source | Type | What it establishes | What it does not establish |
|---|---|---|---|
| azampay.com/developers, /products/payment-gateway, /products/disbursement | Official marketing and portal pages | Disbursement to mobile money exists ("Pay out to M-Pesa, Tigo Pesa, Airtel Money and HaloPesa"). The portal says it has an interactive API reference. | No endpoint path, method, schema, auth detail, or idempotency rule. The "Read the docs" target was not retrievable from this environment. |
| flexcodelabs/azampay (Node SDK, MIT, third party) | Third-party SDK README | `mnoCheckout` is a collection (customer push) with payload `accountNumber, amount, currency, externalId, provider`. `disburse` takes `source, destination, transferDetails, externalReferenceId, remarks`. `transactionStatus` takes `reference, bankName` and is documented for disbursements. | No endpoint paths. No idempotency semantics. `externalId` is documented only as "unique string, max 128 chars, belongs to calling application". |
| pub.dev `azampay` (Dart SDK) | Third-party SDK docs | `disburse` example uses `bankName` in {Airtel, Tigo, Azampesa}, `transferDetails.type = 'SendMoney'`. | Suggests but does not document the MNO payout path. |
| PHP SDK snippet (dev.to) | Third-party | `mobileCheckout` = collection with `externalId`. | Collection only. |

No source checked documents `/azampay/mno/checkout` as a payout endpoint.

## 2. Finding: current `triggerPayout` is probably the wrong operation

`src/services/azampayService.js` `triggerPayout` posts to `/azampay/mno/checkout` with `{accountNumber, amount, currency, externalId, provider}`.

- That payload matches the **collection** schema (`mnoCheckout`). That call sends a USSD push to the customer's phone asking the customer to pay.
- If it ran in production, a withdrawal could prompt the customer for money instead of paying them out. The customer's balance would stay locked, and the reconciliation path would see an unknown result.
- Endpoint was not changed. Changing it without the documented contract would be a guess.

## 3. Finding: reconciliation endpoint is also unverified

`queryTransactionStatus` posts to `/azampay/payment/query`. No checked source documents that path. The only documented status call is `transactionStatus` for disbursements, which takes `reference` and `bankName`.

Deposit reconciliation, withdrawal settlement, and the callback re-verification idea all depend on this endpoint. It is an open blocker for the same reason as D1.

## 4. Idempotency semantics

No source documents AzamPay idempotency, deduplication, or what happens when the same `externalId` is sent twice. Working assumptions, applied in code:

- A dispatch is **never** retried automatically.
- A timeout, network reset, or 5xx is **ambiguous**. The hold stays, and the outcome is decided by a gateway status query after a grace window.
- A 4xx with a body is a **definitive refusal**. The hold is released once.

## 5. Ambiguous-outcome coverage

| Scenario | Test | Behaviour verified | Automatic re-dispatch? | Automatic hold release? |
|---|---|---|---|---|
| Timeout after provider received request | `withdrawal-dispatch-d1` S3, S3b; `azampay-payout-classification` C5 | UNCERTAIN, hold kept; SUCCESS later captures once | No (payout count stays 1) | No |
| Network reset, no response | C4, S3 | Ambiguous, hold kept | No | No |
| HTTP 5xx | C3 | Ambiguous, hold kept | No | No |
| Crash after send, before response | S4b | Gateway SUCCESS honoured, no stuck row | No | No |
| Crash after commit, before dispatch | S4 | No exception inside 10-min grace; after grace, UNDISPATCHED exception only | No | No |
| Gateway PENDING/UNKNOWN | S4, S9 | Exception only; row stays PROCESSING | No | No |
| Gateway FAILED after ambiguous | S3 | Release once, then no further release | No | Yes (once, idempotent `-RELEASE` reference) |
| Token failure before any request | C1 | Refused, nothing sent | No | Yes (once) |
| Provider refusal (4xx) | C2, S2 | Refused, FAILED, 502 | No | Yes (once) |
| Replay with same Idempotency-Key | S5, S6, S7 | One hold, one dispatch | No | No |
| Contract gate closed | C7, S0 | No HTTP call, no transaction, no hold | No | n/a |

## 6. Client retries and Idempotency-Key

- The route `POST /wallet/withdraw` already accepts `Idempotency-Key` (`src/middleware/idempotent.js`). The header is optional.
- Before this change, the withdrawal reference was random. A concurrent retry could create a second hold and a second dispatch.
- Now, when the header is present, the reference is `WD-` + 32 hex derived from `sha256(userId:key)`. `holdFunds` dedupes on that UNIQUE reference. The API contract is unchanged: same header, same route, same response fields.
- Without the header, behaviour is unchanged.
- Compatibility review: the new `status` value on replay is `FAILED` or the real status, not `PENDING`. This is a response-content change for replays only. Clients that treated every replay as PENDING should be told.
- Residual (other routes, not changed here): `idempotent.js` checks the cache before executing, with no in-flight lock. Two concurrent requests with the same key can both execute. Its DB lookup is also not scoped by `user_id`, so a key from one user can return another user's cached response. Recommended fix is scoping and an in-flight lock, which affects every financial mutation that uses the middleware. Owner decision.

## 7. Questions for AzamPay (send to provider support)

1. What is the endpoint, HTTP method, and authentication for a mobile money payout (disbursement) to a MSISDN in Tanzania? Please include the sandbox base URL.
2. Is the payout a `disburse` call? If yes, what is the exact request schema for `source`, `destination`, `transferDetails`, `externalReferenceId`, and `remarks`? What are the allowed `bankName` values for mobile money, and which `transferDetails.type` applies?
3. What is the response schema for a successful and a refused payout? Is HTTP 200 with `success: false` possible?
4. Is the payout asynchronous? What status values can it return, and do you send a callback? What is the callback payload and signature method?
5. What is the status query for a payout? Please confirm the endpoint and which identifier it accepts: `externalReferenceId`, `transactionId`, or both.
6. Is `externalId` / `externalReferenceId` idempotent? If the same reference is sent twice, is the second request rejected, returned with the original result, or processed again?
7. How long is a reference kept for duplicate checks? What is the maximum length (we use 35 characters)?
8. Is the status query endpoint `/azampay/payment/query` correct for collections? If so, what does it return for a reference that does not exist?
9. What is the recommended handling for a timeout where the outcome is unknown?
10. Please confirm production IP addresses for callbacks, if any, so we can set an allowlist.

## 8. Unblock criteria

D1 moves to READY only when all of these are true:

1. Official AzamPay API documentation (not a third-party SDK) specifies the payout endpoint, method, auth, request schema, response schema, and idempotency behaviour.
2. The status query endpoint for payouts and collections is confirmed the same way.
3. `triggerPayout` and `queryTransactionStatus` are updated to the documented contract, and tests are added with fixtures taken from the documentation.
4. Sandbox test: one payout succeeds, one is refused, one returns an ambiguous result, and each outcome matches section 5.
5. Owner approves enabling the flag in production. The flag stays off until then.

Until then: no push, no deploy, and withdrawals stay closed.
