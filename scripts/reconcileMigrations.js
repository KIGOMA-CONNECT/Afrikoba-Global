/**
 * MTC-29 / G2 — Controlled migration-ledger reconciliation.
 *
 * Scope (owner-authorized, 2026-11-16):
 *   Reconcile ONLY migrations 152, 153 and 154 in the disposable local PG16
 *   database. Their effects already exist. This tool verifies the existing
 *   database definitions against the migration definitions, then records a
 *   ledger row for each file whose evidence is complete.
 *
 * Hard constraints enforced here:
 *   - The reconciliation set is a fixed allowlist of exactly 3 files. Any other
 *     version (including 155) is refused before any write.
 *   - Migration bodies are NEVER executed and are not read by this tool. The
 *     checks below are declarative catalog assertions derived from the reviewed
 *     definitions; the run performs SELECT/catalog reads plus the three ledger
 *     INSERTs only.
 *   - Evidence must be complete for every target. Missing/mismatched evidence
 *     blocks the whole run; there is no partial apply.
 *   - Migration 155 must remain absent from the ledger and its objects absent
 *     from the database (quarantine pre-condition).
 *   - `--apply` requires the explicit authorization token MTC-29-G2. Default
 *     mode is a genuinely read-only assessment.
 *   - The ledger write is one transaction. Inside the transaction the full
 *     version set is re-read and compared: if anything other than exactly the
 *     target rows was added/removed, the transaction is rolled back.
 *
 * This tool does not touch OD-10, does not execute any migration, does not
 * create the database or schema_migrations, and does not reconcile anything
 * outside 152/153/154.
 */
'use strict';

const path = require('path');
const guard = require('./runMigrations');

const RECONCILIATION_ALLOWLIST = Object.freeze({
  '152_social_fund_case_permissions.sql': 'case permissions table, indexes and active-permissions view',
  '153_social_fund_clearing_account.sql': 'SOCIAL_FUND_CLEARING ledger account and product-mapping functions',
  '154_journal_posting_registry.sql': 'journal posting registry table/index and journal immutability trigger',
});

const RECONCILIATION_SET = Object.freeze(Object.keys(RECONCILIATION_ALLOWLIST));
const RECONCILIATION_AUTHORIZATION = 'MTC-29-G2';
const M155 = '155_social_fund_institution_binding.sql';

class ReconciliationRefusal extends Error {
  constructor(code, message, evidence = null) {
    super(message);
    this.name = 'ReconciliationRefusal';
    this.code = code;
    this.evidence = evidence;
  }
}

const norm = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

function identical(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// ---------------------------------------------------------------------------
// Declarative definition checks (catalog reads only)
// ---------------------------------------------------------------------------

function tableCheck(table) {
  return {
    id: `table:${table}`,
    sql: 'SELECT to_regclass($1)::text AS o',
    params: [`public.${table}`],
    verify(rows) {
      const o = rows[0] && rows[0].o;
      return { ok: Boolean(o), detail: o ? `table present (${o})` : 'table absent' };
    },
  };
}

function columnsCheck(table, expected) {
  return {
    id: `columns:${table}`,
    sql: `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale,
                 is_nullable, column_default
            FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1
           ORDER BY ordinal_position`,
    params: [table],
    verify(rows) {
      const errors = [];
      if (rows.length !== expected.length) {
        errors.push(`expected ${expected.length} columns, found ${rows.length}`);
      }
      expected.forEach((want, i) => {
        const got = rows[i];
        if (!got) {
          errors.push(`missing column '${want.name}'`);
          return;
        }
        if (got.column_name !== want.name) errors.push(`position ${i + 1}: '${got.column_name}' != '${want.name}'`);
        if (got.data_type !== want.type) errors.push(`${want.name}: type '${got.data_type}' != '${want.type}'`);
        if (want.len !== undefined && got.character_maximum_length !== want.len) {
          errors.push(`${want.name}: length ${got.character_maximum_length} != ${want.len}`);
        }
        if (want.precision !== undefined && got.numeric_precision !== want.precision) {
          errors.push(`${want.name}: precision ${got.numeric_precision} != ${want.precision}`);
        }
        if (want.scale !== undefined && got.numeric_scale !== want.scale) {
          errors.push(`${want.name}: scale ${got.numeric_scale} != ${want.scale}`);
        }
        if (got.is_nullable !== want.nullable) errors.push(`${want.name}: nullable '${got.is_nullable}' != '${want.nullable}'`);
        if (want.default === 'nextval') {
          if (!/^nextval\(/.test(norm(got.column_default))) errors.push(`${want.name}: expected a sequence default`);
        } else if (want.default !== undefined && norm(got.column_default) !== want.default) {
          errors.push(`${want.name}: default '${norm(got.column_default)}' != '${want.default}'`);
        }
      });
      return { ok: errors.length === 0, detail: errors.length ? errors.join('; ') : `${rows.length} columns match` };
    },
  };
}

function constraintsCheck(table, expected) {
  return {
    id: `constraints:${table}`,
    sql: `SELECT contype, pg_get_constraintdef(oid) AS def
            FROM pg_constraint WHERE conrelid = $1::regclass
           ORDER BY contype, def`,
    params: [`public.${table}`],
    verify(rows) {
      const actual = rows.map((r) => `${r.contype}|${norm(r.def)}`).sort();
      const want = expected.map((e) => norm(e)).sort();
      const missing = want.filter((w) => !actual.includes(w));
      const extra = actual.filter((a) => !want.includes(a));
      const ok = missing.length === 0 && extra.length === 0;
      return {
        ok,
        detail: ok
          ? `${actual.length} constraints match`
          : `missing=[${missing.join(' ; ')}] extra=[${extra.join(' ; ')}]`,
      };
    },
  };
}

function indexCheck(name, pattern) {
  return {
    id: `index:${name}`,
    sql: `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    params: [name],
    verify(rows) {
      if (rows.length !== 1) return { ok: false, detail: `expected 1 index named ${name}, found ${rows.length}` };
      const def = norm(rows[0].indexdef);
      const ok = pattern.test(def);
      return { ok, detail: ok ? def : `${def} does not match ${pattern}` };
    },
  };
}

function viewCheck(view, expectedDef) {
  return {
    id: `view:${view}`,
    sql: `SELECT c.relkind::text AS kind, pg_get_viewdef(c.oid, true) AS def
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = $1`,
    params: [view],
    verify(rows) {
      if (rows.length !== 1) return { ok: false, detail: `view ${view} absent` };
      if (rows[0].kind !== 'v') return { ok: false, detail: `relkind ${rows[0].kind} != v` };
      const def = norm(rows[0].def);
      const ok = def === norm(expectedDef);
      return { ok, detail: ok ? 'view definition matches' : `definition mismatch: ${def}` };
    },
  };
}

function viewColumnsCheck(view, expected) {
  return {
    id: `view:columns:${view}`,
    sql: `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    params: [view],
    verify(rows) {
      const actual = rows.map((r) => `${r.column_name}:${r.data_type}`);
      const want = expected.map((e) => `${e.name}:${e.type}`);
      const ok = identical(actual, want);
      return { ok, detail: ok ? `${rows.length} view columns match` : `actual=[${actual.join(', ')}]` };
    },
  };
}

function functionCheck(name, expected) {
  return {
    id: `function:${name}`,
    sql: `SELECT pg_get_function_identity_arguments(p.oid) AS args,
                 pg_get_function_result(p.oid) AS result,
                 l.lanname AS language,
                 CASE p.provolatile WHEN 'i' THEN 'IMMUTABLE' WHEN 's' THEN 'STABLE' ELSE 'VOLATILE' END AS volatility,
                 pg_get_functiondef(p.oid) AS def
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            JOIN pg_language l ON l.oid = p.prolang
           WHERE n.nspname = 'public' AND p.proname = $1`,
    params: [name],
    verify(rows) {
      if (rows.length !== 1) return { ok: false, detail: `expected 1 function ${name}, found ${rows.length}` };
      const got = rows[0];
      const errors = [];
      if (got.args !== expected.args) errors.push(`args '${got.args}' != '${expected.args}'`);
      if (got.result !== expected.result) errors.push(`result '${got.result}' != '${expected.result}'`);
      if (got.language !== expected.language) errors.push(`language '${got.language}' != '${expected.language}'`);
      if (got.volatility !== expected.volatility) errors.push(`volatility '${got.volatility}' != '${expected.volatility}'`);
      if (norm(got.def) !== norm(expected.def)) errors.push('function definition mismatch');
      return { ok: errors.length === 0, detail: errors.length ? errors.join('; ') : 'function definition matches' };
    },
  };
}

function scalarCheck(id, sql, expected, describe) {
  return {
    id,
    sql,
    params: [],
    verify(rows) {
      if (rows.length !== 1) return { ok: false, detail: 'expected exactly one row' };
      const errors = [];
      for (const [key, want] of Object.entries(expected)) {
        const got = rows[0][key];
        if (got !== want) errors.push(`${key}='${got}' != '${want}'`);
      }
      return { ok: errors.length === 0, detail: errors.length ? errors.join('; ') : describe };
    },
  };
}

const QUARANTINE_CHECKS = Object.freeze([
  scalarCheck(
    '155:quarantine',
    `SELECT to_regclass('public.institutions')::text AS institutions,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema='public' AND table_name='social_fund_cases' AND column_name='institution_id') AS case_col,
            (SELECT count(*)::int FROM information_schema.columns
              WHERE table_schema='public' AND table_name='social_fund_case_permissions' AND column_name='institution_id') AS perm_col,
            (SELECT count(*)::int FROM pg_indexes
              WHERE schemaname='public' AND indexname='idx_sf_case_perms_institution') AS idx`,
    { institutions: null, case_col: 0, perm_col: 0, idx: 0 },
    'migration 155 effects remain absent'
  ),
]);

const M152_CHECKS = Object.freeze([
  tableCheck('social_fund_case_permissions'),
  columnsCheck('social_fund_case_permissions', [
    { name: 'id', type: 'integer', nullable: 'NO', default: 'nextval' },
    { name: 'case_id', type: 'integer', nullable: 'NO' },
    { name: 'user_id', type: 'integer', nullable: 'NO' },
    { name: 'permission', type: 'character varying', len: 50, nullable: 'NO' },
    { name: 'granted_by', type: 'integer', nullable: 'YES' },
    { name: 'granted_at', type: 'timestamp with time zone', nullable: 'YES', default: 'now()' },
    { name: 'revoked_at', type: 'timestamp with time zone', nullable: 'YES' },
  ]),
  constraintsCheck('social_fund_case_permissions', [
    'p|PRIMARY KEY (id)',
    'u|UNIQUE (case_id, user_id, permission)',
    'f|FOREIGN KEY (case_id) REFERENCES social_fund_cases(id) ON DELETE CASCADE',
    'f|FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
    'f|FOREIGN KEY (granted_by) REFERENCES users(id)',
  ]),
  indexCheck(
    'idx_sf_case_perms_user',
    /^CREATE INDEX idx_sf_case_perms_user ON public\.social_fund_case_permissions USING btree \(user_id, permission\) WHERE \(revoked_at IS NULL\)$/
  ),
  indexCheck(
    'idx_sf_case_perms_case',
    /^CREATE INDEX idx_sf_case_perms_case ON public\.social_fund_case_permissions USING btree \(case_id, permission\) WHERE \(revoked_at IS NULL\)$/
  ),
  viewCheck(
    'social_fund_active_case_permissions',
    'SELECT id, case_id, user_id, permission, granted_by, granted_at, revoked_at FROM social_fund_case_permissions WHERE revoked_at IS NULL;'
  ),
  viewColumnsCheck('social_fund_active_case_permissions', [
    { name: 'id', type: 'integer' },
    { name: 'case_id', type: 'integer' },
    { name: 'user_id', type: 'integer' },
    { name: 'permission', type: 'character varying' },
    { name: 'granted_by', type: 'integer' },
    { name: 'granted_at', type: 'timestamp with time zone' },
    { name: 'revoked_at', type: 'timestamp with time zone' },
  ]),
]);

const FN_PRODUCT_NAMESPACE_DEF = `
CREATE OR REPLACE FUNCTION public.fn_product_namespace(p_code text)
 RETURNS character varying
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_code IS NULL THEN NULL
    WHEN p_code = 'VICOBA_GROUP'          OR p_code LIKE 'VICOBA%'     THEN 'VICOBA'
    WHEN p_code = 'ROSICA_POOL'           OR p_code LIKE 'ROSCA%'      THEN 'ROSCA'
    WHEN p_code LIKE 'SACCOS%'                                         THEN 'SACCOS'
    WHEN p_code LIKE 'MARKETPLACE%'                                     THEN 'MARKETPLACE'
    WHEN p_code = 'FAMILY_WALLET'         OR p_code LIKE 'FAMILY%'     THEN 'FAMILY'
    WHEN p_code LIKE 'EVENT_%'                                         THEN 'EVENTS'
    WHEN p_code LIKE 'LENDING_CIRCLE%'    OR p_code LIKE 'CIRCLE%'
         OR p_code LIKE 'CROWD%'                                      THEN 'LENDING_CIRCLES'
    WHEN p_code LIKE 'PROJECT_ACCOUNT%'                                THEN 'PROJECTS'
    WHEN p_code LIKE 'TREASURY%'                                       THEN 'TREASURY'
    WHEN p_code = 'SOCIAL_FUND_CLEARING'  OR p_code LIKE 'SOCIAL_FUND%' THEN 'SOCIAL_FUND'
    ELSE 'WALLET'
  END;
$function$
`;

const FN_PRODUCT_FROM_TX_TYPE_DEF = `
CREATE OR REPLACE FUNCTION public.fn_product_from_tx_type(p_type text)
 RETURNS character varying
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_type IS NULL THEN NULL
    WHEN p_type LIKE 'VICOBA\\_%'    THEN 'VICOBA'
    WHEN p_type LIKE 'ROSCA\\_%'     THEN 'ROSCA'
    WHEN p_type LIKE 'SACCOS\\_%'    THEN 'SACCOS'
    WHEN p_type LIKE 'MARKETPLACE\\_%' THEN 'MARKETPLACE'
    WHEN p_type LIKE 'FAMILY\\_%'    THEN 'FAMILY'
    WHEN p_type LIKE 'EVENT\\_%'     THEN 'EVENTS'
    WHEN p_type LIKE 'LENDING\\_%' OR p_type LIKE 'CIRCLE\\_%' OR p_type LIKE 'CROWD\\_%' THEN 'LENDING_CIRCLES'
    WHEN p_type LIKE 'PROJECT\\_%'   THEN 'PROJECTS'
    WHEN p_type LIKE 'SOCIAL_FUND\\_%' THEN 'SOCIAL_FUND'
    ELSE 'WALLET'
  END;
$function$
`;

const M153_CHECKS = Object.freeze([
  {
    id: 'seed:social_fund_clearing',
    sql: `SELECT account_code, name, account_type, currency_code
            FROM ledger_accounts WHERE account_code = 'SOCIAL_FUND_CLEARING'`,
    params: [],
    verify(rows) {
      if (rows.length !== 1) return { ok: false, detail: `expected 1 seed row, found ${rows.length}` };
      const got = rows[0];
      const want = { account_code: 'SOCIAL_FUND_CLEARING', name: 'Social Fund Clearing', account_type: 'LIABILITY', currency_code: 'TZS' };
      const ok = identical(got, want);
      return { ok, detail: ok ? 'seed row matches definition' : `seed row mismatch: ${JSON.stringify(got)}` };
    },
  },
  functionCheck('fn_product_namespace', {
    args: 'p_code text',
    result: 'character varying',
    language: 'sql',
    volatility: 'IMMUTABLE',
    def: FN_PRODUCT_NAMESPACE_DEF,
  }),
  functionCheck('fn_product_from_tx_type', {
    args: 'p_type text',
    result: 'character varying',
    language: 'sql',
    volatility: 'IMMUTABLE',
    def: FN_PRODUCT_FROM_TX_TYPE_DEF,
  }),
  scalarCheck(
    'behavior:product-mapping',
    `SELECT fn_product_namespace(NULL)::text AS ns_null,
            fn_product_namespace('SOCIAL_FUND_CLEARING')::text AS ns_sf,
            fn_product_namespace('SOCIAL_FUND_CONTRIBUTION')::text AS ns_sf_prefix,
            fn_product_namespace('VICOBA_GROUP')::text AS ns_vicoba,
            fn_product_namespace('ROSCA_POOL')::text AS ns_rosca,
            fn_product_namespace('SACCOS_MAIN')::text AS ns_saccos,
            fn_product_namespace('MARKETPLACE_SALE')::text AS ns_market,
            fn_product_namespace('FAMILY_WALLET')::text AS ns_family,
            fn_product_namespace('EVENT_FEE')::text AS ns_event,
            fn_product_namespace('CIRCLE_ONE')::text AS ns_circle,
            fn_product_namespace('PROJECT_ACCOUNT_A')::text AS ns_project,
            fn_product_namespace('TREASURY_MAIN')::text AS ns_treasury,
            fn_product_namespace('WALLET_X')::text AS ns_other,
            fn_product_from_tx_type(NULL)::text AS tx_null,
            fn_product_from_tx_type('SOCIAL_FUND_CONTRIBUTION')::text AS tx_sf,
            fn_product_from_tx_type('VICOBA_CONTRIB')::text AS tx_vicoba,
            fn_product_from_tx_type('ROSCA_CONTRIB')::text AS tx_rosca,
            fn_product_from_tx_type('CIRCLE_PAYOUT')::text AS tx_circle,
            fn_product_from_tx_type('WALLET_TOPUP')::text AS tx_other`,
    {
      ns_null: null, ns_sf: 'SOCIAL_FUND', ns_sf_prefix: 'SOCIAL_FUND', ns_vicoba: 'VICOBA', ns_rosca: 'ROSCA',
      ns_saccos: 'SACCOS', ns_market: 'MARKETPLACE', ns_family: 'FAMILY', ns_event: 'EVENTS',
      ns_circle: 'LENDING_CIRCLES', ns_project: 'PROJECTS', ns_treasury: 'TREASURY', ns_other: 'WALLET',
      tx_null: null, tx_sf: 'SOCIAL_FUND', tx_vicoba: 'VICOBA', tx_rosca: 'ROSCA',
      tx_circle: 'LENDING_CIRCLES', tx_other: 'WALLET',
    },
    '19 product-mapping probes match'
  ),
]);

const JOURNAL_IMMUTABLE_DEF = `
CREATE OR REPLACE FUNCTION public.journal_entries_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entries are immutable: DELETE is not permitted (entry_group_id=%)', OLD.entry_group_id
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Allow only status updates on specific columns? No — full immutability.
    RAISE EXCEPTION 'journal_entries are immutable: UPDATE is not permitted (entry_group_id=%)', OLD.entry_group_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END;
$function$
`;

const M154_CHECKS = Object.freeze([
  tableCheck('journal_posting_registry'),
  columnsCheck('journal_posting_registry', [
    { name: 'posting_id', type: 'character varying', len: 64, nullable: 'NO' },
    { name: 'reference_id', type: 'character varying', len: 50, nullable: 'NO' },
    { name: 'transaction_id', type: 'integer', nullable: 'YES' },
    { name: 'entry_count', type: 'integer', nullable: 'NO', default: '0' },
    { name: 'dr_total', type: 'numeric', precision: 19, scale: 4, nullable: 'NO', default: '0' },
    { name: 'cr_total', type: 'numeric', precision: 19, scale: 4, nullable: 'NO', default: '0' },
    { name: 'status', type: 'character varying', len: 20, nullable: 'NO', default: "'POSTED'::character varying" },
    { name: 'posted_by', type: 'character varying', len: 40, nullable: 'YES' },
    { name: 'posted_at', type: 'timestamp with time zone', nullable: 'YES', default: 'now()' },
    { name: 'payload', type: 'jsonb', nullable: 'NO', default: "'[]'::jsonb" },
    { name: 'payload_hash', type: 'character varying', len: 64, nullable: 'NO', default: "''::character varying" },
    { name: 'metadata', type: 'jsonb', nullable: 'YES', default: "'{}'::jsonb" },
  ]),
  constraintsCheck('journal_posting_registry', ['p|PRIMARY KEY (posting_id)']),
  indexCheck(
    'uq_journal_posting_ref',
    /^CREATE UNIQUE INDEX uq_journal_posting_ref ON public\.journal_posting_registry USING btree \(reference_id\)$/
  ),
  functionCheck('journal_entries_immutable', {
    args: '',
    result: 'trigger',
    language: 'plpgsql',
    volatility: 'VOLATILE',
    def: JOURNAL_IMMUTABLE_DEF,
  }),
  {
    id: 'trigger:parent',
    sql: `SELECT t.tgenabled,
                 pg_get_triggerdef(t.oid) AS def
            FROM pg_trigger t
           WHERE t.tgname = 'trg_journal_entries_immutable'
             AND t.tgrelid = 'public.journal_entries'::regclass`,
    params: [],
    verify(rows) {
      if (rows.length !== 1) return { ok: false, detail: `expected parent trigger, found ${rows.length}` };
      const def = norm(rows[0].def);
      const want = 'CREATE TRIGGER trg_journal_entries_immutable BEFORE DELETE OR UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION journal_entries_immutable()';
      const errors = [];
      if (def !== want) errors.push(`trigger definition: ${def}`);
      if (rows[0].tgenabled !== 'A') errors.push(`tgenabled '${rows[0].tgenabled}' != 'A' (ENABLE ALWAYS)`);
      return { ok: errors.length === 0, detail: errors.length ? errors.join('; ') : 'parent trigger matches and is ENABLE ALWAYS' };
    },
  },
  {
    id: 'trigger:partitions',
    sql: `SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE t.tgenabled = 'A')::int AS enabled,
                 (SELECT count(*)::int
                    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhparent
                   WHERE c.oid = 'public.journal_entries'::regclass) AS partitions
            FROM pg_trigger t
           WHERE t.tgname = 'trg_journal_entries_immutable'
             AND t.tgrelid <> 'public.journal_entries'::regclass`,
    params: [],
    verify(rows) {
      const r = rows[0] || {};
      const ok = r.total === r.partitions && r.enabled === r.total && r.total > 0;
      return {
        ok,
        detail: ok
          ? `${r.total} partition triggers, all ENABLE ALWAYS`
          : `partition triggers total=${r.total} enabled=${r.enabled} partitions=${r.partitions}`,
      };
    },
  },
]);

const EVIDENCE_SPEC = Object.freeze({
  '152_social_fund_case_permissions.sql': M152_CHECKS,
  '153_social_fund_clearing_account.sql': M153_CHECKS,
  '154_journal_posting_registry.sql': M154_CHECKS,
});

// ---------------------------------------------------------------------------
// Evidence collection and evaluation
// ---------------------------------------------------------------------------

async function runChecks(client, checks) {
  const out = [];
  for (const check of checks) {
    try {
      const res = await client.query(check.sql, check.params || []);
      const verdict = check.verify(res.rows);
      out.push({ id: check.id, ok: Boolean(verdict.ok), detail: verdict.detail });
    } catch (err) {
      out.push({ id: check.id, ok: false, detail: `query error: ${err && err.message}` });
    }
  }
  return out;
}

async function collectEvidence(client, files = RECONCILIATION_SET) {
  const evidence = { files: {}, quarantine: [] };
  evidence.quarantine = await runChecks(client, QUARANTINE_CHECKS);
  for (const file of files) {
    evidence.files[file] = await runChecks(client, EVIDENCE_SPEC[file] || []);
  }
  return evidence;
}

/**
 * Pure evidence gate. A file passes only when every declared check ran and
 * passed. Any missing check id, failed check, or quarantine drift refuses the
 * whole reconciliation.
 */
function evaluateEvidence(evidence, files) {
  const missing = [];
  const quarantine = (evidence && evidence.quarantine) || [];
  const quarantineIds = QUARANTINE_CHECKS.map((c) => c.id);
  for (const id of quarantineIds) {
    const hit = quarantine.find((c) => c.id === id);
    if (!hit || !hit.ok) missing.push({ file: '__quarantine__', check: id, detail: hit ? hit.detail : 'check missing' });
  }
  for (const file of files) {
    const spec = EVIDENCE_SPEC[file] || [];
    const got = (evidence && evidence.files && evidence.files[file]) || [];
    for (const check of spec) {
      const hit = got.find((c) => c.id === check.id);
      if (!hit) missing.push({ file, check: check.id, detail: 'check missing' });
      else if (!hit.ok) missing.push({ file, check: check.id, detail: hit.detail });
    }
    for (const c of got) {
      if (!spec.some((s) => s.id === c.id)) missing.push({ file, check: c.id, detail: 'unexpected check id' });
    }
  }
  return { complete: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function resolveReconciliationAuthorization(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.find((a) => typeof a === 'string' && a.startsWith('--authorization='));
  const raw = flag ? flag.slice('--authorization='.length) : env.MTC29_AUTHORIZATION || '';
  const id = String(raw || '').trim();
  return { id: id || null };
}

function validateTargets(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new ReconciliationRefusal('RECONCILIATION_NO_TARGETS', 'no reconciliation targets supplied');
  }
  if (new Set(files).size !== files.length) {
    throw new ReconciliationRefusal('RECONCILIATION_DUPLICATE_TARGET', 'duplicate reconciliation target');
  }
  for (const file of files) {
    if (file === M155) {
      throw new ReconciliationRefusal(
        'RECONCILIATION_155_FORBIDDEN',
        'migration 155 is quarantined under OD-10 and cannot be reconciled or recorded'
      );
    }
    if (!Object.prototype.hasOwnProperty.call(RECONCILIATION_ALLOWLIST, file)) {
      throw new ReconciliationRefusal(
        'RECONCILIATION_FILE_NOT_ALLOWED',
        `'${file}' is outside the authorized MTC-29 reconciliation set (152, 153, 154 only)`
      );
    }
  }
}

/**
 * Reconciles the ledger for the authorized files.
 *
 * - `apply: false` (default): read-only assessment; returns targets without any write.
 * - `apply: true`: requires the MTC-29-G2 authorization token, then inserts the
 *   target rows in one transaction with full-set drift detection.
 *
 * Migration bodies are never read or executed here.
 */
async function reconcileLedger({
  client,
  files = RECONCILIATION_SET,
  evidence,
  apply = false,
  authorization = null,
  log = console.log,
} = {}) {
  if (!client) throw new TypeError('client is required');
  validateTargets(files);

  const verdict = evaluateEvidence(evidence, files);
  if (!verdict.complete) {
    const lines = verdict.missing.map((m) => `  - ${m.file} ${m.check}: ${m.detail}`);
    throw new ReconciliationRefusal(
      'RECONCILIATION_EVIDENCE_INSUFFICIENT',
      ['evidence is incomplete; refusing to reconcile:', ...lines].join('\n'),
      verdict
    );
  }

  const recorded = await guard.readRecorded(client);
  if (!recorded.exists) {
    throw new ReconciliationRefusal('RECONCILIATION_LEDGER_MISSING', 'schema_migrations does not exist; nothing may be created by G2');
  }
  if (recorded.versions.includes(M155)) {
    throw new ReconciliationRefusal('RECONCILIATION_155_RECORDED', 'migration 155 is present in schema_migrations — quarantine drift');
  }

  const before = new Set(recorded.versions);
  const targets = files.filter((f) => !before.has(f)).sort();
  const skipped = files.filter((f) => before.has(f)).sort();
  const base = {
    targets,
    skipped,
    recordedBefore: [...before].sort(),
    evidence,
  };

  if (!apply) {
    log('[MTC-29] DRY RUN — no writes performed.');
    return { ...base, mode: 'assess', applied: 0, recordedAfter: [...before].sort() };
  }

  if (!authorization || authorization.id !== RECONCILIATION_AUTHORIZATION) {
    throw new ReconciliationRefusal(
      'RECONCILIATION_NOT_AUTHORIZED',
      `--apply requires the explicit G2 authorization token '${RECONCILIATION_AUTHORIZATION}'`
    );
  }

  if (targets.length === 0) {
    log('[MTC-29] All authorized migrations are already recorded; nothing to do.');
    return { ...base, mode: 'apply', applied: 0, recordedAfter: [...before].sort() };
  }

  log(`[MTC-29] BEGIN reconciliation of ${targets.length} ledger entr${targets.length === 1 ? 'y' : 'ies'}`);
  try {
    await client.query('BEGIN');
    for (const file of targets) {
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      log(`[MTC-29] ledger INSERT ${file}`);
    }
    const afterRes = await client.query('SELECT version FROM schema_migrations');
    const after = new Set(afterRes.rows.map((r) => r.version));
    const added = [...after].filter((v) => !before.has(v));
    const removed = [...before].filter((v) => !after.has(v));
    const unexpected = added.filter((v) => !targets.includes(v));
    if (added.length !== targets.length || removed.length > 0 || unexpected.length > 0) {
      throw new ReconciliationRefusal(
        'RECONCILIATION_LEDGER_DRIFT',
        `in-transaction drift: added=[${added.join(', ')}] removed=[${removed.join(', ')}] ` +
          `unexpected=[${unexpected.join(', ')}] expected=${targets.length}`
      );
    }
    await client.query('COMMIT');
    log(`[MTC-29] COMMIT verified: added=${added.length} removed=0 unrelated_changes=0`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }

  // Post-commit durability read (evidence only).
  const confirmed = await guard.readRecorded(client);
  const confirmedSet = new Set(confirmed.versions);
  const missing = targets.filter((f) => !confirmedSet.has(f));
  if (missing.length > 0) {
    throw new ReconciliationRefusal(
      'RECONCILIATION_POST_VERIFY_FAILED',
      `post-commit verification failed; missing rows: ${missing.join(', ')}`
    );
  }
  return { ...base, mode: 'apply', applied: targets.length, recordedAfter: [...confirmedSet].sort() };
}

function formatEvidence(evidence, files) {
  const lines = ['[MTC-29] Evidence:'];
  for (const c of evidence.quarantine || []) lines.push(`  ${c.ok ? 'OK  ' : 'FAIL'} __quarantine__ ${c.id} — ${c.detail}`);
  for (const file of files) {
    for (const c of (evidence.files && evidence.files[file]) || []) {
      lines.push(`  ${c.ok ? 'OK  ' : 'FAIL'} ${file} ${c.id} — ${c.detail}`);
    }
  }
  return lines.join('\n');
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  clientFactory = null,
  files = RECONCILIATION_SET,
  evidence = null,
  log = console.log,
} = {}) {
  const apply = argv.includes('--apply');
  const authorization = resolveReconciliationAuthorization(argv, env);
  let client = null;
  try {
    client = clientFactory
      ? await clientFactory({ argv, env })
      : await guard.getWorkingClient({ createDatabase: false, env });

    const resolvedEvidence = evidence || (await collectEvidence(client, files));
    log(formatEvidence(resolvedEvidence, files));

    const result = await reconcileLedger({
      client,
      files,
      evidence: resolvedEvidence,
      apply,
      authorization,
      log,
    });

    log(
      `[MTC-29] Result: mode=${result.mode} applied=${result.applied} ` +
        `skipped=${result.skipped.length} ledger_before=${result.recordedBefore.length} ledger_after=${result.recordedAfter.length}`
    );
    return result;
  } finally {
    if (client && typeof client.end === 'function') await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof ReconciliationRefusal) {
      console.error('[MTC-29 REFUSED] ' + err.message);
      process.exitCode = 3;
    } else if (err instanceof guard.IdentityRefusal) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      console.error('[MTC-29 ERROR]', err && (err.stack || err.message));
      process.exitCode = 1;
    }
  });
}

module.exports = {
  RECONCILIATION_ALLOWLIST,
  RECONCILIATION_SET,
  RECONCILIATION_AUTHORIZATION,
  M155,
  ReconciliationRefusal,
  QUARANTINE_CHECKS,
  EVIDENCE_SPEC,
  // evidence
  runChecks,
  collectEvidence,
  evaluateEvidence,
  // reconciliation
  resolveReconciliationAuthorization,
  validateTargets,
  reconcileLedger,
  formatEvidence,
  main,
};
