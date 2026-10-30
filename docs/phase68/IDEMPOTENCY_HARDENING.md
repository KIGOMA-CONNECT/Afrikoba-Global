# Phase 68 — Idempotency Middleware Hardening (finding S3)

**Status: CLOSED (fixed and tested).** No commit, push, or deploy has been made.
Phase 68 remains **OPEN** for the items listed in `SECURITY_REVIEW_EXT.md`.

File: `src/middleware/idempotent.js`
Tests: `tests/idempotency.phase68.test.js` — **10 / 10 PASS**

---

## 1. Finding

The original middleware:

1. looked up Redis, memory and Postgres by the raw `Idempotency-Key`, so a user
   who learned another user's key could receive that user's cached response;
2. only wrote the cache **after** the handler finished, so two concurrent
   requests with the same key both executed the financial mutation.

The withdrawal service had its own `(user_id, key)` reference derivation, but
every other financial route using the middleware (wallet transfer, P2P invest)
still had the race and the cross-user lookup.

## 2. Fix

### 2.1 User-scoped keys

Every storage layer uses `u<userId>:<client key>`:

| Layer | Key |
|---|---|
| memory | `u<userId>:<client key>` |
| Redis | `idem:u<userId>:<client key>` |
| Postgres | `key_value = 'u<userId>:<client key>'` |

The DB lookup also filters `user_id IS NOT DISTINCT FROM $2`. A key from user B
can never resolve to user A's row. Existing unscoped rows expire naturally and
are ignored.

### 2.2 Atomic in-flight claim

Before the handler runs, the middleware claims the key in Postgres:

```sql
INSERT INTO idempotency_keys (key_value, user_id, status_code, response_body, expires_at)
VALUES ($1, $2, 0, '{"claim":"<uuid>"}', NOW() + interval '5 minutes')
ON CONFLICT (key_value) DO NOTHING
RETURNING key_value
```

- Insert succeeded → this request owns the key and executes.
- Row exists with `status_code > 0` → return the cached response.
- Row exists with `status_code = 0` and a live lease → `409
  IDEMPOTENCY_IN_PROGRESS` with `Retry-After` (no execution).
- Row exists with `status_code = 0` and an expired lease → takeover by a new
  owner token (a crashed request cannot block retries forever).

The ownership token lives in `response_body.claim`, so a late response from the
old owner cannot overwrite the new owner's row. No schema migration is needed.

### 2.3 Cache only success

- **2xx** → row updated to the real status/body, `expires_at = now + 24h`,
  Redis/memory populated.
- **4xx / 5xx** → claim released; the client may retry. This avoids caching a
  time-varying refusal (limits, fraud, balance) for 24 hours.
- **Aborted / no response** (`close` before `json`) → claim released.

### 2.4 Authentication

A request with `Idempotency-Key` but no authenticated user is rejected with
`401 IDEMPOTENCY_REQUIRES_AUTH`. Every route that mounts this middleware is
already behind `authRequired`; the check is defence in depth and prevents an
unscoped cache entry.

## 3. Test matrix

All tests run against the disposable database `phase68_amount_guard_d1verify`
(no network, no Redis). Command:

```bash
bash /root/run_depositfix.sh tests/idempotency.phase68.test.js
```

| # | Scenario | Assertion |
|---|---|---|
| 1 | no key | handler runs, no row written |
| 2 | no authenticated user | 401, handler never runs |
| 3 | replay | cached body, handler executes once, scoped row |
| 4 | same key, two users | each executes once, two scoped rows, no leakage |
| 5 | concurrent duplicates | one 200, one 409, one execution, replay works |
| 6 | 429 refusal | claim released, retry executes again |
| 7 | aborted request | claim released, retry works |
| 8 | completed DB row | replayed with no handler execution |
| 9 | completed row of another user | ignored |
| 10 | different keys | execute independently |

Regression: `tests/withdrawal-dispatch-d1.test.js` **12 / 12 PASS** (service-level
concurrency, replay, refusal and cross-user isolation unchanged).

## 4. Residual notes

- The 5-minute claim lease is a trade-off: after a crash, a retry can take over
  once the lease expires. Underlying financial operations remain idempotent on
  their own references (withdrawal derives the reference from `(user_id, key)`).
- Redis is used only as a fast cache; Postgres is authoritative for the claim.
- If Redis is configured, a stale Redis value could outlive a deleted DB row.
  Both expire after 24 hours; no correctness path depends on Redis alone.
- No schema change, migration, production write, or deploy was performed.
