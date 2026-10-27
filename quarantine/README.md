# Quarantine

In this directory sits work that was started but **cannot be landed in its current
state**. Files are stored with a `.quarantined` suffix rather than `.sql`/`.js` so
that no filename glob anywhere in the repo can pick them up as live code, live
migrations, or live tests.

## What is here and why

| Quarantined file | Original path | Reason |
|---|---|---|
| `db/migrations/138_legacy_bridge_reconciliation.sql.quarantined` | `db/migrations/138_legacy_bridge_reconciliation.sql` | Duplicate migration number 138. Redundant second unique index on the same column. Orphan: nothing referenced it. |
| `db/migrations/138_legacy_p2p_reconciliation_bridge.sql.quarantined` | `db/migrations/138_legacy_p2p_reconciliation_bridge.sql` | The richer of the two 138 files, but incomplete: it does not create the column its service writes. |
| `src/services/projectReconciliationService.js.quarantined` | `src/services/projectReconciliationService.js` | Crashes on first call: writes `authoritative_bridged_at`, which no migration creates. |
| `tests/reconciliation.test.js.quarantined` | `tests/reconciliation.test.js` | Static-only test (reads files, never opens a database), so it passed 8/8 while the service it guards was non-functional. |

Full defect analysis with evidence: `docs/FINDINGS_project_reconciliation_bridge.md`.

All four files are preserved **byte-for-byte**; see the SHA-256 values recorded in
that findings document.

## Rules for this directory

- Nothing here is executed, migrated, required, or tested.
- Do not rename these files back to `.sql`/`.js` while they remain incomplete.
- Restoring work means completing it, not copying files back. Follow the
  "Exit criteria for a future phase" section of the findings document.

## How this thread started

The `financialEngine.js` transaction-safety scope was frozen and committed as
`8f0647c` (Phase 58). While looking for the next workstream, these untracked files
from 2026-09-18 were found sitting in the tree and were investigated.
