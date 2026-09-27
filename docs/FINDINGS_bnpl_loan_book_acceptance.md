# Findings: Phase 57 BNPL loan book - live acceptance run (Phase 60)

**Status:** defects recorded. **No acceptance is claimed.**
**Date:** 2026-09-27
**Runs against:** local `node src/server.js` on port 3001, `DISABLE_CRON=true`,
database `localhost:5432/afrikoba_global` (the dev instance on this host).
**Supersedes:** commit `5852d83`, which stated the BNPL surface does not claim
acceptance because a live expert-JWT harness run had never been done on a box.
That gap is now closed. The surface still does not pass acceptance, for the
reasons below.

**Phase 58 freeze untouched.** `src/services/financialEngine.js` still hashes to
`1c5e80cdb199e4275086f1c928d0fc3814c818542e8abb0c530abe66391593cc`, and all 11
entries of `tests/zz_engine_freeze.sha256` verify with 0 drift. Nothing in this
phase touched the financial engine, and completing this work must not.

---

## 1. Verdict

`scripts/verify-bnpl.sh` printed **`ACCEPTANCE: FAIL`** (exit code 1).

That verdict is real and is preserved verbatim in
`tests/zz_out_bnpl_acceptance.txt`. It is **not** caused by a broken application,
though. Of the 15 probes:

- **12 OK** - including the two that matter most: expert `200` and CSV/PDF `200`.
- **3 FAIL** - and all three are caused by a bug *inside the harness* (defect D6
  below), not by the application. All three were re-evaluated independently
  against the live endpoint and all three are **OK**.

So the honest reading is: **the application behaves correctly on every probe, and
the acceptance still cannot be signed off** - because the probes that pass are
measuring far less than they appear to. Section 4 explains why.

---

## 2. What was fixed (2 changes, 10 insertions, 3 deletions)

### F1 - The application could not boot at all (committed SyntaxErrors)

This was found while trying to start the server, and it is not a BNPL problem.

`src/services/projectFinanceService.js` contained two JavaScript SyntaxErrors
**in committed state**, recorded in `tests/zz_bnpl_syntax_error_before.txt`:

```
line 6518:  const capitalReturned = round2(escrowReturned + dividendsPaid women_still);
line 6634:  doc.moveDown(0.3 MJ);
```

`women_still` and `MJ` are stray tokens, the signature of a botched find/replace.
`node --check` fails, therefore `require()` throws, therefore `src/server.js`
cannot start. `projectFinanceService` is required by `projectService.js:28`, which
`server.js` loads at boot - so **every route in the application was unreachable**,
and no endpoint test of any kind could have been passing on this tree.

Each broken line is immediately followed by the correct one, and an independent
analogous block at line 6693 computes the same quantity the same way:

```
6693:  const capitalReturned = round2(Number(V.escrow_returned || 0) + Number(V.dividends_paid || 0));
```

So each defect is a corrupted duplicate of the line beneath it. There is no
scenario in which keeping them is correct, and the fix has no behavioural
ambiguity: 6518 was replaced by the correct `const` form, 6634 was deleted. Both
old lines were unparseable and therefore had never executed.

**After the fix:** `node --check` passes on all 234 files under `src/`, and the
server boots.

### F2 - Every BNPL endpoint returned 500 (route/service contract mismatch)

`src/routes/projectRoutes.js:1118-1137` calls
`bnplFinance.getPlatformBnplLoanBook`, `exportPlatformBnplLoanBookCsv`,
`preparePlatformBnplLoanBookPdf` and `renderPlatformBnplLoanBookPdf`.

`src/services/bnplService.js` exported none of them. It exported
`getPlatformBnplPortfolio`, `exportPlatformBnplPortfolioCsv`,
`preparePlatformBnplPortfolioPdf` and `renderPlatformBnplPortfolioPdf`.

A direct `require()` check confirmed **4 of 4 called names missing**. Every expert
request hit `TypeError: ... is not a function` and returned 500. This is the same
class of route/service naming drift found in the quarantined reconciliation work.

**Fix:** four export aliases were added, mapping the route's `*LoanBook*` names
onto the existing `*Portfolio*` implementations. No logic was touched.

**After the fix:** all three endpoints return `200` for an expert token.

---

## 3. Defects recorded, not fixed (per explicit instruction)

### D1 - `dataAvailability` is computed and then thrown away

`bnplService.js:126` builds a careful `dataAvailability` object, including a
Swahili note explaining that no BNPL records exist yet. The function's return
statement (line 157) never includes it.

Live confirmation - the response keys are:

```
success, reference, generated_at, currency, terms, months, totals, health
dataAvailability present = false
```

The honesty signal exists in code and is dead on arrival. A client cannot
distinguish "no data" from "zero disbursements".

### D2 - Twelve fabricated zero months are reported as `health: CLEAN`

The comment at `bnplService.js:119-122` states the rule explicitly:

> if the authoritative source has NO records, the trend MUST NOT be rendered as a
> fabricated filled cohort. It is surfaced as an explicit NO_RECORDS availability
> state instead.

`sourceRows` is hard-coded to `[]` with the note "currently 0 records on staging".
`buildCohort([])` nevertheless returns **12 months**, every metric zero. Because
D1 drops `dataAvailability`, the client receives:

```
months returned          = 12
months with ANY non-zero = 0 / 12
totals.disbursements     = 0
totals.active_contracts  = 0
health                   = CLEAN
```

A 12-month repayment trend holding literally nothing, labelled `CLEAN`. The
documented rule and the shipped behaviour are opposite.

### D3 - The "PDF" is not a usable PDF

`renderPlatformBnplPortfolioPdf` hand-assembles a 629-byte file. Structural check
of the live download:

| Property | Value | Meaning |
|---|---|---|
| size | 629 bytes | tiny, plausible |
| `/Font` resource | **0** | no font is defined |
| `BT` (begin text) | **0** | no text object is ever opened |
| `Tj` (show text) | **0** | no glyph is ever drawn |
| declared `startxref` | 240 | hard-coded constant |
| actual byte offset of `xref` | **467** | off by 227 bytes |

The content stream contains the banner text as raw ASCII but never opens a text
object, so **no PDF viewer will render any visible text**; the cross-reference
table also points 227 bytes before the real one, so conformant readers reject the
file outright. The harness probe passes only because `strings /tmp/bnpl.pdf | grep`
finds the words in the raw bytes. The comment at `bnplService.js:248-251` calls
this a "real downloadable artifact"; it is not one.

### D4 - The harness claims a 403 probe that does not exist

The header of `scripts/verify-bnpl.sh` line 14 states:

> Exit 0 ONLY when every probe is green (expert 200, **owner 403**, anon 401, ...)

The script contains probes for anonymous-401, expert-200, CSV and PDF. **There is
no 403 probe anywhere in it.** The gate therefore is never tested, and the
harness would report PASS with the authorisation check entirely removed.

Independently verified by hand: a `MJUMBE` (member) token receives `403` on all
three endpoints, and anonymous receives `401`. **The gate works.** It is simply
unprotected by the harness, so a future regression in it would not be caught.

### D5 - UTF-8 BOM breaks the harness shebang

`scripts/verify-bnpl.sh` begins with a UTF-8 byte-order mark, so line 1 is read as
`\xEF\xBB\xBF#!/usr/bin/env` and the shebang is not recognised:

```
scripts/verify-bnpl.sh: line 1: <U+FEFF>#!/usr/bin/env: No such file or directory
```

(`<U+FEFF>` stands for the raw BOM bytes `EF BB BF` at the start of line 1.)

The usage comment at line 20 tells the operator to run `./scripts/verify-bnpl.sh`.
That invocation cannot work on a BOM-marked file. The run above only succeeded
because the script was invoked explicitly as `bash scripts/verify-bnpl.sh`.

A census of all 754 git-tracked files found exactly 2 with a BOM:
`scripts/verify-bnpl.sh` and `src/routes/networkRoutes.js`. The second is
harmless - Node strips a BOM when loading CommonJS, and the server boots - but the
first is a live landmine in the operator-facing entry point.

### D6 - The harness cannot evaluate three of its own probes on Windows

`verify-bnpl.sh` writes its capture to `/tmp/bnpl.json` (line 46) and then hands
that literal path to `node -e` (lines 48, 51, 56). Under Git Bash, `curl` writes
to the MSYS `/tmp`, but `node` is a native Windows binary that resolves `/tmp` to
`C:\tmp`, which does not exist:

```
Error: ENOENT: no such file or directory, open 'C:\tmp\bnpl.json'
```

All three `node` probes then produce empty output, and the two `[: : integer
expected` errors at lines 52 and 55 follow. This is a portability defect, not an
application defect - on Linux staging the paths would agree - but it means the
three affected probes have never been executed on any host that is not Linux, and
a Windows run yields a FAIL verdict that says nothing about the application.

This is the fourth time a harness in this repository has produced a verdict
unrelated to the code under test (Phase 58 probes 1 and 9, the reference
collision and the CR-DR/operation_type mismatch, and the static-only
reconciliation test in Phase 59).

---

## 4. Why acceptance still cannot be signed off

Every probe passes, and the feature is still not accepted:

1. **The data is fabricated.** 12 months of zeros are served as a repayment trend
   and labelled `CLEAN` (D2), with the intended `NO_RECORDS` signal discarded (D1).
2. **Probe 6 rewards the fabrication.** `verify-bnpl.sh` line 57 asserts
   `month_count = 12`. With zero source records, the 12 months returned *are* the
   fabricated set the source comment forbids. The probe is satisfied by precisely
   the behaviour the code says must not ship.
3. **The PDF probe rewards a fake.** The words are in the bytes, so `strings`
   finds them, while the file renders nothing (D3).
4. **The 403 gate is untested** by the harness that claims to test it (D4).

A green harness here would mean: the route is wired, the numbers match the
documented constants, and a text file with `.pdf` in its name contains some ASCII.
That is a wiring test, not a product acceptance.

---

## 5. Authorisation observation (factual, not a defect)

`BNPL_EXPERT_ROLES = ['ADMIN', 'MODERATOR', 'EXPERT']` at `bnplService.js:35`.
The `users` table in the dev database:

| role | total | active |
|---|---|---|
| MJUMBE | 7476 | 7476 |
| ADMIN | 373 | 373 |
| OPS | 25 | 25 |
| COMPLIANCE | 11 | 11 |
| AGRONOMIST | 6 | 6 |
| FIELD_PARTNER | 4 | 4 |
| **EXPERT** | **0** | **0** |
| **MODERATOR** | **0** | **0** |

Total users 7895. There is no `EXPERT` or `MODERATOR` account, so the
"expert-only" surface is reachable by `ADMIN` only, which is 373 users or 4.7% of
the user base. The product owner listed all three roles in the functional
notes, so allowing `ADMIN` is by design; the observation is that the primary
intended persona cannot be exercised at all, and the acceptance run can only
speak for the admin case.

---

## 6. Method and reproducibility

- Server: `PORT=3001 DISABLE_CRON=true node src/server.js`. The server does not run
  migrations at boot, and cron was disabled, so the run neither migrated nor
  wrote anything. Confirmed from `src/server.js:422`.
- Database: the dev instance already on this host at `localhost:5432`. **No
  production or staging database was contacted, and no user row was created,
  modified or deleted.**
- Tokens: HS256, signed with `JWT_SECRET` from the local `.env`, for two
  **pre-existing active users** - id 1 `ADMIN` and id 2 `MJUMBE`. Claims satisfy
  the full validation chain in `src/middleware/auth.js`: `id` present, `av` matched
  against `users.auth_version` (both 0), unique random `jti` not present in
  `revoked_tokens`, `iat`/`exp` valid, HS256 only. Tokens were written to a
  temp file and passed to the harness by environment variable, so no token
  appears in this document, in the evidence file, or in any command line.
- `strings` is not present on this host (no binutils). A minimal `strings` shim
  was placed in a temp directory on `PATH` for the run. Without it, the PDF
  probes fail on tooling, not on the product.

Evidence artifacts:

| File | Contents |
|---|---|
| `tests/zz_out_bnpl_acceptance.txt` | verbatim harness output plus supplementary probes |
| `tests/zz_bnpl_syntax_error_before.txt` | the two committed SyntaxErrors as they exist in HEAD |

---

## 7. Exit criteria for a future phase

Do not re-run the harness and call it accepted. Before this surface can be
accepted:

1. **Return `dataAvailability`.** The `NO_RECORDS` state must reach the client
   (D1).
2. **Do not serve a fabricated cohort.** Either suppress the 12 months when
   `recordCount === 0`, or render them explicitly as an empty series. `health`
   must not read `CLEAN` for a portfolio with no records (D2).
3. **Make probe 6 assert the availability state**, not just the array length, so
   the harness stops rewarding fabrication (D2/D4 in section 4).
4. **Add the missing 403 probe** the header already promises, using a
   non-expert token (D4).
5. **Replace the PDF with a real one** - a font resource, proper text objects,
   correct xref offsets - or stop claiming a PDF deliverable (D3).
6. **Remove the BOM from `scripts/verify-bnpl.sh`** so the documented
   `./scripts/verify-bnpl.sh` invocation works, and make the capture path
   portable instead of hard-coding `/tmp` (D5, D6).
7. **Decide the intended persona.** If `EXPERT` is a real role, seed one; if not,
   drop `EXPERT` from the FN and the constant so the code matches reality
   (section 5).
8. **Do not modify `src/services/financialEngine.js`.** The Phase 58 contract
   stays exactly as committed in `8f0647c`.
