# Security review — Phase 68 Extended (withdrawal, callbacks, dependencies, secrets)

Date: 2026-10-29. Scope: code review of the paths named below, plus execution where stated. Each item says whether it was verified by execution, verified by reading the config, or only reviewed.

Status legend: **VERIFIED** (executed), **CONFIG** (read from the running environment, names only), **REVIEW** (code reading only), **UNVERIFIED** (could not confirm).

## 1. Summary

| # | Area | Severity | Status | Phase 68 state |
|---|---|---|---|---|
| S1 | Deposit callback trusts body status, gated by shared secret | High | REVIEW + CONFIG | **CLOSED (mitigated)** — callback now gateway-verified; auto-credit gated closed until the provider contract is verified. See `DEPOSIT_ATOMICITY.md`. |
| S2 | AzamPay status query endpoint unverified | High | REVIEW | OPEN (provider blocker) |
| S3 | `Idempotency-Key` middleware: no in-flight lock; cache lookup not scoped by user | Medium | REVIEW | **CLOSED (fixed)** — user-scoped keys + atomic DB claim; 10/10 tests. See `IDEMPOTENCY_HARDENING.md`. |
| S4 | Webhook replay cache is in-memory and keyed on an optional header | Low | REVIEW | OPEN |
| S5 | Public client IP path (`trust proxy = 1`) not mapped | Medium | UNVERIFIED | OPEN (topology) |
| S6 | proxy-addr CVE-2026-90711 | Critical advisory | VERIFIED: not applicable to this config; fixed in installed tree | CLOSED for backend |
| S7 | web-dashboard dependencies (4 remain) | Medium | VERIFIED | OPEN (major bumps) |
| S8 | CI DB credential printed in output; DB contains production-derived data | High | CONFIG | OPEN (rotation not executed) |
| S9 | No four-eyes on self-service wallet withdrawal | Owner decision | REVIEW | OPEN (owner) |
| S10 | Withdrawal route authorization and controls | — | REVIEW + CONFIG | Present |
| S11 | Audit logging on withdrawal paths | — | REVIEW | Present |
| S12 | Non-AzamPay money-path integrity (funding, SACCOS redemption, ledger coverage) | High | VERIFIED | **PARTIAL (increments 1–2 fixed)** — funding, SACCOS redemption, ledger coverage and engine shape validation closed; 14/14 + 5/5 tests. See `MONEY_PATH_INTEGRITY.md`. |

## 2. Findings

### S1. Deposit callback credits on body status alone

**Update 2026-10-30: CLOSED (mitigated).** The callback no longer decides the
outcome from the body. `processDepositCallback` queries the gateway and
classifies the answer; body and gateway disagreement leaves the deposit
`PENDING` and records an exception. Because the status-query schema is still
unverified (S2), auto-credit is gated closed by
`AZAMPAY_STATUS_CONTRACT_VERIFIED` (default false). Deterministic tests:
`tests/deposit-atomicity.phase68.test.js` (25/25) and
`tests/deposit-verification.phase68.test.js` (35/35). Full record:
`docs/phase68/DEPOSIT_ATOMICITY.md`. The original review text is kept below.

- Route: `POST /payments/azampay-callback` (`src/routes/callbackRoutes.js`), mounted behind `verifyWebhookSecurity`, `verifyWebhookHmac`, `webhookReplayProtection` (`src/server.js:338`).
- `processDepositCallback` (`src/services/walletService.js`) reads `utilityref` and `transactionstatus` from the body. If the status is `success` and the transaction is PENDING, it posts the deposit. It does not query the gateway first.
- Gates in production (CONFIG): `WEBHOOK_SECRET` is set. `ALLOWED_WEBHOOK_IPS` is set. Both are names-only checks.
- Consequence: anyone who knows the shared secret, or who can make the allowlisted IP send a request, can credit a PENDING deposit. The amount is not taken from the body (it is the stored `wallet_amount`), so the attacker cannot choose the amount. They can still turn a PENDING deposit into a credit without a real payment, and they can choose which pending reference to credit.
- The IP allowlist is only as strong as `req.ip` (see S5).
- Recommended: before crediting, re-verify the reference with the gateway status query. This depends on S2 being resolved. Owner decision whether to block deposits from confirming until then.

### S2. Status query endpoint is unverified

- `queryTransactionStatus` posts to `/azampay/payment/query` (`src/services/azampayService.js`). No checked source documents that path. See `docs/phase68/D1_PROVIDER_CONTRACT.md` section 3.
- Affects: deposit reconciliation (`settleDeposit`), withdrawal settlement (`settleWithdrawal`), and the re-verification proposed in S1.
- The reconciliation code treats any response that is not SUCCESS or FAILED as PENDING/UNKNOWN, so a wrong endpoint fails safe (exceptions, no automatic money movement). It does not verify anything either.

### S3. Idempotency middleware

**Update 2026-10-30: CLOSED (fixed).** `src/middleware/idempotent.js` now:

- scopes every key to the authenticated user in memory, Redis and Postgres
  (`u<userId>:<client key>`), so a key learned by another user cannot return the
  first user's cached body;
- claims the key atomically in Postgres (`INSERT ... ON CONFLICT DO NOTHING`)
  before the handler runs, so concurrent duplicates execute once and the loser
  receives `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After`;
- caches only 2xx responses and releases the claim on a refusal or an aborted
  request, so retries are not blocked by a cached error;
- refuses a keyed request with no authenticated user
  (`401 IDEMPOTENCY_REQUIRES_AUTH`).

No schema change is required: the scoped key fits the existing `key_value`
primary key, and an in-flight row uses `status_code = 0` with an ownership token
in `response_body.claim`. A crashed request's claim is taken over only after its
5-minute lease expires. Deterministic tests:
`tests/idempotency.phase68.test.js` (10/10). Full record:
`docs/phase68/IDEMPOTENCY_HARDENING.md`.

The original review text is kept below.

- `src/middleware/idempotent.js` checks Redis, then memory, then DB for a key, and only stores the response after it finishes. Two requests with the same key that arrive before the first finishes both execute.
- The DB lookup `SELECT ... FROM idempotency_keys WHERE key_value = $1` is not scoped by `user_id`. A user who learns another user's key can receive that user's cached response body.
- Withdrawal: fixed by deriving the reference from `(user_id, key)`. `holdFunds` dedupes on the UNIQUE reference, so the second request cannot create a second hold or dispatch (tests S5 to S8 in `withdrawal-dispatch-d1`).
- Other financial routes that use the middleware still have the race and the scoping issue. Recommended: scope by `user_id` and add an in-flight marker. Owner decision because it affects every financial mutation.

### S4. Webhook replay protection

- `webhookReplayProtection` keeps processed IDs in process memory for 24 hours. It only runs when `x-webhook-id` or `x-request-id` is present. Multiple replicas or a restart would lose the cache.
- The deposit callback is also protected by state: a second callback for a non-PENDING transaction returns `duplicate: true` without crediting. So a replay does not double-credit. Low risk.

### S5. Client IP and `trust proxy`

- `src/server.js:169`: `app.set('trust proxy', 1)`. With a numeric hop count, Express takes the right-most `X-Forwarded-For` entry as `req.ip`. That is correct only if exactly one trusted proxy appends the real client address.
- Host review (CONFIG/REVIEW):
  - Docker publishes the app on `127.0.0.1:3000` only.
  - Host nginx listens on 80 and 443. The `afrikoba` site on port 80 returns 404 for everything except ACME. The 443 default site serves `/var/www/html`.
  - `nginx -T` shows no `proxy_pass` to `127.0.0.1:3000`. `proxy_params` sets `X-Forwarded-For $proxy_add_x_forwarded_for`, but no included file was found that uses it.
  - A request to nginx on 443 with `Host: app.afrikoba.com` returned the application's JSON health body. So some path reaches the app, but I could not map it from the host configuration.
  - No Cloudflare tunnel, Caddy, Traefik, or HAProxy process was found on the host.
- Status: UNVERIFIED. If the public path has no proxy that appends `X-Forwarded-For`, a client can send its own header and `req.ip` becomes client-controlled. That would weaken the webhook IP allowlist, rate limits, and fraud checks. Operator action: map the public request path (for example, `curl -v` with the real hostname, and the nginx `access_log` `$remote_addr` vs `$http_x_forwarded_for`).

### S6. proxy-addr CVE-2026-90711 (advisory: critical, affects `proxy-addr` 1.1.0 to 2.0.7)

Verified by execution in an isolated clone with proxy-addr 2.0.7 and 2.0.8:

| Case | 2.0.7 result | 2.0.8 result | Relevant to Afrikoba |
|---|---|---|---|
| Advisory case: subnet `::ffff:10.0.0.0/8` (short prefix), client sends `X-Forwarded-For: 203.0.113.99`, socket `198.51.100.23` | `203.0.113.99` (spoofed) | `198.51.100.23` (correct) | Not used. Afrikoba does not use subnet trust. |
| Correct form `::ffff:10.0.0.0/104` | `198.51.100.23` | `198.51.100.23` | — |
| `trust proxy = 1` (Afrikoba config), same header | `203.0.113.99` | `203.0.113.99` | Behaves the same in both versions. This is the hop-count behaviour (S5), not the CVE. |

- Conclusion: the CVE's vulnerable path (IPv4-mapped subnet trust) is not reachable with the current `trust proxy = 1` configuration. The installed backend tree is 2.0.8 (verified with `npm ls` and `npm ci` in the clone). Any future change to subnet-based trust must use the correct prefix form.
- Caution: an earlier run in this session compared 2.0.8 against the clone's `node_modules`, which still held 2.0.7. That result was wrong and was corrected by `npm ci` and re-running the comparison.

### S7. web-dashboard dependencies

After `npm audit fix` (non-force) in an isolated clone, `npm run build` exit 0. Remaining (VERIFIED with `npm audit --json`):

| Package | Severity | Direct | Dependency type | Fix | Note |
|---|---|---|---|---|---|
| vite <=6.4.3 | high | yes | devDependency | vite 8.3.5 (major) | Build tool. Affects the dev server. Not in the production bundle. Risk if `vite dev` is run on a network-reachable host. |
| esbuild <=0.24.2 | moderate | no | via vite | via vite 8 (major) | Same as vite. |
| react-router, react-router-dom 6.0.0-7.17.0 | moderate | yes (react-router-dom) | runtime | react-router-dom 7.18.5 (major) | Runtime. Needs a router v7 migration review. |

Applied (lock only, `package.json` unchanged, commit `8eb83bf`): axios 1.19 to 1.21.0, follow-redirects 1.16.0 to 1.16.2, source-map-js 1.2.1 to 1.2.2, react-router 6.30.6.

### S8. CI database credential and data

- The password of container `p68-ci-verify-db` was printed in tool output during earlier work in this session. It must be treated as exposed.
- Status (CONFIG): the container is up, publishes only `127.0.0.1:55457`, runs `postgres:16-alpine`, and started on 2026-10-27. Its environment value has not changed since that start. Test runs today in this session authenticated with the environment value. So the exposed credential is still valid for that container.
- Data: the database was restored from `/root/phase68-closeout/db-backups/pre_apply_prod_20261016_134640.dump` and then seeded. It therefore contains production-derived data. Network exposure is limited to localhost, but any local user on the host can read it.
- Not done in this session: rotation, container recreation, or re-seeding (needs authorization).

Rotation plan (for approval, not executed):

1. Generate a new random password. Store it in the host's secret store or a root-only file. Do not paste it into chat or tool output.
2. Recreate `p68-ci-verify-db` with the new value, or run `ALTER USER afrikoba PASSWORD` from a root-only session with the value read from file. Do not restart production containers.
3. Update the test runner's environment source (`/root/run_d1.sh` reads it from the container). Re-run the D1, classification, and backup suites. Record exit codes.
4. Replace the production-derived restore with a synthetic seed. Remove the old database. Record the SHA-256 of the removed dump file, not the content.
5. Confirm the old password fails to authenticate.

### S9. Four-eyes on wallet withdrawal

- `walletRoutes.js` does not call the four-eyes service for `POST /wallet/withdraw`. Four-eyes exists for other flows (for example SACCO withdrawals, `saccosRoutes.js:428`).
- Whether a self-service withdrawal needs an approval above a threshold is a product and risk decision. Recorded for the owner. Not a code defect on its own.

### S10. Withdrawal authorization and controls (verified by reading and config)

- `router.use(authRequired)` on the wallet router (`walletRoutes.js:16`). The route also requires `enforceDeviceTrust`, `requireKycLevel(1)`, request validation, limits (`limitService.checkLimits`), a wallet freeze check, and fraud checks.
- `POST /wallet/withdraw` also accepts `Idempotency-Key` (S3).
- Production config: `AZAMPAY_PAYOUT_CONTRACT_VERIFIED` is unset. The new gate defaults to closed when the new image is deployed. The currently running image (started 2026-10-27) predates the gate.

### S11. Audit logging

- `logAudit` is called on withdrawal creation (`CREATE`), dispatch refusal (`DISPATCH_FAILED`), and dispatch uncertainty (`DISPATCH_UNCERTAIN`). The post-commit SMS failure is logged and not swallowed.
- Reconciliation exceptions are written to `reconciliation_exceptions`. Duplicates per reference and type are now suppressed.

### S12. Non-AzamPay money-path integrity (verified by execution)

Increments 1 and 2 fixed and proved:

- `fieldPartnerService.fundPartner` and `bapService.fundPartner` claim on a
  reference (and accept/propose one) so replays cannot double-fund.
- `saccosInvestmentsService.redeemInvestment` uses a deterministic reference,
  claims inside the transaction, accepts `ACTIVE`/`MATURED`, and checks the
  guarded `UPDATE` rowCount so concurrent redemptions cannot double-credit.
- SACCOS dividend and exit payouts now finalize `financial_operations` to
  `SUCCESS`.
- Every direct `wallet_ledger` writer is transaction-scoped and engine-backed
  (static parity + `reconciliation-coverage` suite); `balanceReconciliation`
  flags `wallet_ledger` rows without a journal group as `LEDGER_ORPHAN`.
- `claimOperation` supports opt-in shape validation. All engine primitives
  reject a reused reference with a different operation type, user, amount or
  transaction id with `OPERATION_SHAPE_MISMATCH` (409); the deposit path keeps
  its richer `DEPOSIT_IDEMPOTENCY_CONFLICT` handling.

Evidence: `tests/money-path-integrity.phase68.test.js` (14/14),
`tests/reconciliation-coverage.phase68.test.js` (5/5). Residual candidates:
opt-in shape validation for remaining service-level `claimOperation` callers and
P2P/VICOBA/ROSCA/loans/escrow matrix coverage.

## 3. What this review does not establish

- It is not a penetration test. No external traffic was sent to the production host.
- The callback behaviour in S1 was reviewed in code. It was not exercised against production.
- The public request path (S5) is unresolved.
