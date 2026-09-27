# Findings: legacy P2P -> authoritative project reconciliation bridge

**Status:** QUARANTINED - not landed, not runtime code, not a migration.
**Date of investigation:** 2026-09-27
**Origin:** untracked work dated 2026-09-18, found while selecting the next
workstream after the `financialEngine.js` transaction-safety scope was frozen and
committed as `8f0647c` (Phase 58).
**Frozen-artifact constraint:** `src/services/financialEngine.js` is frozen at
SHA-256 `1c5e80cdb199e4275086f1c928d0fc3814c818542e8abb0c530abe66391593cc`.
Nothing in this thread modified it, and completing this work must not either.

---

## 1. Summary

The intended feature is a guarded, idempotent reconciliation of legacy P2P
projects (`investment_projects`) into the authoritative `projects` domain, writing
an audit record in the same transaction.

The work is **not near completion**. It cannot be landed as-is: the service throws
on its first statement, and its audit provenance names a file that does not exist.
It was moved to `quarantine/` rather than committed, and no schema was touched.

---

## 2. Defects

### D1 - The service cannot execute (blocking)

`reconcileLegacyProject()` writes a column that no migration creates:

```
UPDATE investment_projects
   SET authoritative_project_id = $2,
       authoritative_bridged_at = NOW()
 WHERE id = $1 AND authoritative_project_id IS NULL
```

`authoritative_bridged_at` does not exist in any file under `db/`:

```
SELECT-STRING db/**/*.sql -Pattern 'authoritative_bridged_at'  ->  NOT FOUND
```

Neither 138 migration adds it; neither does `db/schema.sql`. On a real database
this raises `column "authoritative_bridged_at" of relation "investment_projects"
does not exist`, so the reconciliation transaction always rolls back.

### D2 - Audit provenance names a migration that does not exist

- Module comment: "tracked/applied on the staging box as
  `db/migrations/138_project_identity_bridge.sql`"
- `DEFAULT_MIGRATION_BRIDGE = '138_project_identity_bridge'`, written into every
  `PROJECT_IDENTITY_RECONCILIATION` audit row as `meta.sourceMigration`

No such file exists in the repository. The two files present are
`138_legacy_bridge_reconciliation.sql` and
`138_legacy_p2p_reconciliation_bridge.sql`. Every audit row this service writes
would carry a false provenance, which is precisely the field an auditor relies on.

### D3 - Migration B creates schema the service never uses

`138_legacy_p2p_reconciliation_bridge.sql` adds three reconciliation-identity
columns to `project_agreements` and describes them as being "for audit/idempotency
across re-runs":

- `legacy_project_id`
- `source_system` (default `LEGACY_P2P`)
- `reconciliation_reference` (UNIQUE)

The service's only `project_agreements` INSERT writes
`(project_id, terms_version, terms, created_by)` and never touches those three.
So the column the service uses for idempotency (`reconciliation_reference`) is
never populated, and the idempotency guarantee is carried entirely by the
`authoritative_project_id IS NULL` check instead. The migration and the service
disagree about where reconciliation identity lives.

### D4 - Two migrations share number 138

| File | Unique index created | `project_agreements` columns |
|---|---|---|
| `138_legacy_bridge_reconciliation.sql` | `uq_investment_projects_authoritative_project` | none |
| `138_legacy_p2p_reconciliation_bridge.sql` | `uq_investment_projects_authoritative_legacy` | all three |

Both create a `UNIQUE` partial index over the **same** column and predicate:
`investment_projects (authoritative_project_id) WHERE authoritative_project_id IS NOT NULL`.

Because the index *names* differ, `CREATE UNIQUE INDEX IF NOT EXISTS` does **not**
skip the second one. Postgres will happily create a second, redundant unique index
over identical keys. The duplicate *number* alone is harmless in this repo because
`schema_migrations.version` is keyed on the full filename, not the number - but the
redundant index is real waste, and two files claiming one migration number is a
maintenance trap for the next reader.

`138_legacy_bridge_reconciliation.sql` is an orphan: no code or test references it.

### D5 - The guard test cannot detect D1

`tests/reconciliation.test.js` passed `8 passed, 0 failed`. It asserts ASCII
purity, absence of forbidden call-sites, and the presence of `IF NOT EXISTS`
string literals in the migration. It **never opens a database**, so it cannot
observe that the service's UPDATE targets a nonexistent column. A green result
from this test is not evidence the feature works.

### D6 - The service is not wired to any route

Nothing in `src/routes/` or `src/server.js` references
`createReconciliationService`. There is no expert-only endpoint, no RBAC gate, and
no HTTP surface. The reconciliation cannot be invoked except by direct
construction with a pool.

### D7 - Phase-number collision

`138_legacy_bridge_reconciliation.sql` line 1 begins `Phase 58 -`. Phase 58 is now
the committed `financialEngine.js` transaction-safety freeze (`8f0647c`). The
abandoned work was drafted against a phase number that has since been consumed by
unrelated scope.

---

## 3. What was done in this thread

- The four files were moved to `quarantine/` with a `.quarantined` suffix,
  byte-for-byte identical (SHA-256 below). They are not executed, migrated,
  required, or tested.
- No migration was applied. No database was touched. `db/migrations/` is back to a
  clean state: 137 files, highest number 137, zero `138_*` entries.
- No route, service, or test was modified. `src/services/financialEngine.js` is
  untouched and still hashes to the frozen value.

### Preserved SHA-256

| File | SHA-256 |
|---|---|
| `quarantine/db/migrations/138_legacy_bridge_reconciliation.sql.quarantined` | `e49c9d2eadaaf7786668cf570f2c95af02d045212b500692b518f124ae882e9e` |
| `quarantine/db/migrations/138_legacy_p2p_reconciliation_bridge.sql.quarantined` | `9157308e2f2b5c8763853ad8b5ff359c0dc65ba817555ef25f9dceee4f3cea07` |
| `quarantine/src/services/projectReconciliationService.js.quarantined` | `7e1d7266406dfbbe7fe0f1f9b2f4ff3b65e7c2b8d3640efa6fe137e3f8d18590` |
| `quarantine/tests/reconciliation.test.js.quarantined` | `bc15be86f12a33cf2cfadac8ce720d02547acdb8b5f9521f5bcc5e91096ef8e7` |

---

## 4. Exit criteria for a future phase

Do not restore these files. Complete the feature. A future phase may lift this
quarantine only when **all** of the following hold:

1. **One** migration, one number, that creates everything the service needs:
   `investment_projects.authoritative_project_id` (FK + partial unique index),
   `investment_projects.authoritative_bridged_at`, and whichever
   `project_agreements` reconciliation-identity columns are actually used.
2. Exactly one decision on where reconciliation identity lives - either the
   service populates `reconciliation_reference` / `source_system` /
   `legacy_project_id`, or the migration stops creating them. Not both, not
   neither.
3. `meta.sourceMigration` names a migration file that exists in the repository.
4. An expert-only route exists, with RBAC consistent with the other expert
   surfaces in this codebase.
5. A **database-backed** test proves the service actually executes: reconcile once
   then reconcile again against the same legacy row, and assert exactly one
   authoritative project, one agreement, no duplicate financial effect, and an
   audit row in the same transaction. Run it against the isolated regression
   database only.
6. `src/services/financialEngine.js` is not modified. The frozen transaction-safety
   contract stays as committed in `8f0647c`.

---

## 5. Open question for the product owner

The service's premise is that the bridge column `authoritative_project_id` is
"already applied on the staging box". That premise could not be verified from this
repository. Before this work resumes, confirm against staging whether the column
and index already exist there, and whether any legacy rows are already bridged -
because a partial pre-existing bridge changes the correct migration strategy from
"create" to "backfill".
