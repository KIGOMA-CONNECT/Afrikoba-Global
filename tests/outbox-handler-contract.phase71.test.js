#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — Phase 71 / Step A: outbox handler contract
 *
 *  1. Every eventType passed to enqueueOutbox() anywhere in src/ has a
 *     registered handler. Dynamic expressions (e.g. meta.eventType) must be
 *     resolved to concrete names, or the test FAILS explicitly.
 *  2. The registered handler set equals the HEAD snapshot
 *     (tests/fixtures/phase71-outbox-handlers.before.json) plus exactly
 *     PROJECT_COMPLETED, PROJECT_LIQUIDATED, PROJECT_RESERVE_RELEASED,
 *     PROJECT_RESIDUAL_RELEASED — nothing lost, nothing unexpected.
 *  3. src/server.js registers handlers only via src/outbox/handlers.js.
 *  4. The misspelled split-SMS event type (PROJECT_SPLIT_SMS without the
 *     final "S") appears nowhere in src/, db/, scripts/ or tests/.
 *
 * Requires a DISPOSABLE database named phase71_financial_audit_<suffix>.
 * Usage:
 *   DB_NAME=phase71_financial_audit_<suffix> DB_USER=... DB_PASSWORD=... \
 *     node tests/outbox-handler-contract.phase71.test.js
 * ==========================================================================*/

const DB_GUARD = /^phase71_financial_audit_[a-z0-9_]+$/;
const targetDb = process.env.DB_NAME || '';
if (!DB_GUARD.test(targetDb)) {
  console.error(`REFUSING: DB_NAME must match ${DB_GUARD} (got '${targetDb || '<unset>'}').`);
  process.exit(2);
}

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const NEW_HANDLERS = [
  'PROJECT_COMPLETED',
  'PROJECT_LIQUIDATED',
  'PROJECT_RESERVE_RELEASED',
  'PROJECT_RESIDUAL_RELEASED',
];
// Built by concatenation so this file does not match its own scan.
const MISSPELLED = 'PROJECT_SPLIT_' + 'SM';
const MISSPELLED_RE = new RegExp(MISSPELLED + '(?![A-Z0-9_])');

let passed = 0;
let failed = 0;
const failures = [];
function ok(label) { passed++; console.log('  ✓ ' + label); }
function bad(label, extra) {
  failed++;
  failures.push(label);
  console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + extra : ''));
}
function expect(cond, label, extra) { if (cond) ok(label); else bad(label, extra); }
function section(label) { console.log('\n--- ' + label + ' ---'); }

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(ROOT, p);
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// Returns the text between the '(' at openIdx and its matching ')'.
function balanced(text, openIdx, open = '(', close = ')') {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

// Resolves `<id>.eventType` via `const <id> = <MAP>[...]` and `const <MAP> = { ... }`.
function resolveDynamic(fileText, expr) {
  const m = /^([A-Za-z_$][\w$]*)\.eventType$/.exec(expr);
  if (!m) return { error: `unsupported eventType expression '${expr}'` };
  const id = m[1];
  const assign = new RegExp(`const\\s+${id}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\[`).exec(fileText);
  if (!assign) return { error: `cannot find 'const ${id} = <MAP>[...]' for '${expr}'` };
  const mapName = assign[1];
  const decl = new RegExp(`const\\s+${mapName}\\s*=\\s*\\{`).exec(fileText);
  if (!decl) return { error: `cannot find object literal 'const ${mapName} = {' for '${expr}'` };
  const body = balanced(fileText, decl.index + decl[0].length - 1, '{', '}');
  if (body === null) return { error: `unbalanced object literal ${mapName}` };
  const names = [...body.matchAll(/eventType\s*:\s*'([A-Z0-9_]+)'/g)].map((x) => x[1]);
  if (names.length === 0) return { error: `${mapName} contains no literal eventType values` };
  return { names, via: mapName };
}

function scanEnqueueCalls() {
  const calls = [];
  const unresolved = [];
  for (const file of walk(SRC).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    const re = /\benqueueOutbox\s*\(/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 20), m.index);
      if (/function\s+$/.test(before)) continue; // the definition itself
      const where = `${rel(file)}:${lineOf(text, m.index)}`;
      const args = balanced(text, m.index + m[0].length - 1);
      if (args === null) { unresolved.push(`${where}: unbalanced call`); continue; }
      const et = /eventType\s*:\s*([^,\n}]+)/.exec(args);
      if (!et) { unresolved.push(`${where}: no 'eventType:' property`); continue; }
      const expr = et[1].trim();
      const lit = /^['"]([A-Z0-9_]+)['"]$/.exec(expr);
      if (lit) { calls.push({ where, eventType: lit[1], expr }); continue; }
      const r = resolveDynamic(text, expr);
      if (r.error) { unresolved.push(`${where}: ${r.error}`); continue; }
      for (const n of r.names) calls.push({ where, eventType: n, expr: `${expr} (via ${r.via})` });
    }
  }
  return { calls, unresolved };
}

function loadRegistry() {
  const outbox = require('../src/services/outboxService');
  let handlersModule = null;
  let loadError = null;
  try {
    handlersModule = require('../src/outbox/handlers');
  } catch (e) {
    loadError = e;
  }
  if (handlersModule && typeof handlersModule.registerAll === 'function') {
    handlersModule.registerAll(outbox);
  }
  const listFn = outbox.listRegisteredHandlers;
  const registered = typeof listFn === 'function' ? listFn() : null;
  return { handlersModule, loadError, registered };
}

// Static fallback so the contract still reports precise gaps if the module is missing.
function staticRegisteredNames() {
  const names = new Set();
  for (const file of walk(SRC).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/registerHandler\(\s*'([A-Z0-9_]+)'/g)) names.add(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------

async function main() {
  const pool = require('../src/config/db');
  try {
    const r = await pool.query(
      `SELECT current_database() AS db, current_user AS usr,
              inet_server_addr()::text AS addr, inet_server_port() AS port`
    );
    const { db, usr, addr, port } = r.rows[0];
    console.log(`DB identity: database=${db} user=${usr} server_addr=${addr} server_port=${port}`);
    if (db !== targetDb || !DB_GUARD.test(db)) throw new Error(`REFUSING: connected to '${db}'`);

    section('0. Scanner self-test (unresolvable dynamic eventType and misspelling are detected)');
    const noAssign = resolveDynamic('const x = 1;', 'meta.eventType');
    expect(noAssign.error && /cannot find 'const meta/.test(noAssign.error),
      'meta.eventType without a map assignment -> explicit error', JSON.stringify(noAssign));
    const noMap = resolveDynamic('const meta = FUNDS[t];', 'meta.eventType');
    expect(noMap.error && /cannot find object literal/.test(noMap.error),
      'map name without object literal -> explicit error', JSON.stringify(noMap));
    const emptyMap = resolveDynamic("const meta = FUNDS[t];\nconst FUNDS = { A: { step: 'A' } };", 'meta.eventType');
    expect(emptyMap.error && /no literal eventType/.test(emptyMap.error),
      'map without eventType values -> explicit error', JSON.stringify(emptyMap));
    const good = resolveDynamic(
      "const meta = FUNDS[t];\nconst FUNDS = { A: { eventType: 'X_ONE' }, B: { eventType: 'X_TWO' } };", 'meta.eventType');
    expect(good.names && good.names.join(',') === 'X_ONE,X_TWO', 'resolvable map -> concrete names', JSON.stringify(good));
    const other = resolveDynamic('', 'getType()');
    expect(other.error && /unsupported/.test(other.error), 'unsupported expression -> explicit error', JSON.stringify(other));
    expect(MISSPELLED_RE.test(`eventType: '${MISSPELLED}'`) && !MISSPELLED_RE.test("eventType: 'PROJECT_SPLIT_SMS'"),
      `misspelling regex matches ${MISSPELLED} but not PROJECT_SPLIT_SMS`);

    section('1. Handler module and registry API');
    const { handlersModule, loadError, registered } = loadRegistry();
    expect(handlersModule && typeof handlersModule.registerAll === 'function',
      'src/outbox/handlers.js exports registerAll(outbox)',
      loadError ? loadError.code || loadError.message : 'registerAll missing');
    expect(Array.isArray(registered), 'outboxService.listRegisteredHandlers() returns an array',
      typeof registered);

    let registeredSet;
    if (handlersModule && Array.isArray(registered)) {
      registeredSet = new Set(registered);
      console.log('  registered (runtime): ' + [...registeredSet].sort().join(', '));
    } else {
      registeredSet = staticRegisteredNames();
      console.log('  registered (STATIC FALLBACK): ' + [...registeredSet].sort().join(', '));
    }

    section('2. Contract: every enqueued eventType has a registered handler');
    const { calls, unresolved } = scanEnqueueCalls();
    console.log(`  enqueueOutbox call sites resolved: ${calls.length}`);
    for (const c of calls) console.log(`    ${c.where}  ${c.eventType}${c.expr.startsWith("'") ? '' : '  <- ' + c.expr}`);
    expect(calls.length >= 9, 'scanner found the known call sites (>= 9)', calls.length);
    expect(unresolved.length === 0, 'every eventType expression resolved to a concrete name',
      unresolved.join(' | '));
    const enqueued = [...new Set(calls.map((c) => c.eventType))].sort();
    for (const et of enqueued) {
      expect(registeredSet.has(et), `handler registered for ${et}`,
        calls.filter((c) => c.eventType === et).map((c) => c.where).join(', '));
    }

    section('3. Registered set == HEAD snapshot + 4 new handlers');
    const snapshot = JSON.parse(fs.readFileSync(
      path.join(__dirname, 'fixtures', 'phase71-outbox-handlers.before.json'), 'utf8'));
    console.log(`  snapshot @ ${snapshot.sourceCommit.slice(0, 7)}: ${snapshot.handlers.join(', ')}`);
    const expected = new Set([...snapshot.handlers, ...NEW_HANDLERS]);
    const missing = [...expected].filter((h) => !registeredSet.has(h));
    const unexpected = [...registeredSet].filter((h) => !expected.has(h));
    for (const h of snapshot.handlers) {
      expect(registeredSet.has(h), `pre-refactor handler kept: ${h}`);
    }
    for (const h of NEW_HANDLERS) {
      expect(registeredSet.has(h), `new handler registered: ${h}`);
    }
    expect(missing.length === 0, 'no handler missing', missing.join(', '));
    expect(unexpected.length === 0, 'no unexpected handler', unexpected.join(', '));

    section('4. server.js wiring');
    const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    const direct = [...server.matchAll(/outbox\.registerHandler\(\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
    expect(direct.length === 0, 'server.js has no direct outbox.registerHandler(...) calls', direct.join(', '));
    expect(/require\(\s*['"]\.\/outbox\/handlers['"]\s*\)/.test(server),
      "server.js requires './outbox/handlers'");
    expect(/registerAll\(\s*outbox\s*[,)]/.test(server), 'server.js calls registerAll(outbox)');

    section(`5. ${MISSPELLED} appears nowhere`);
    const scanned = ['src', 'db', 'scripts', 'tests']
      .flatMap((d) => walk(path.join(ROOT, d)))
      .filter((f) => /\.(js|sql|json|md)$/.test(f));
    const hits = [];
    for (const f of scanned) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => { if (MISSPELLED_RE.test(l)) hits.push(`${rel(f)}:${i + 1}`); });
    }
    expect(hits.length === 0, `no occurrence of ${MISSPELLED} in src/db/scripts/tests (${scanned.length} files)`,
      hits.join(', '));
  } catch (e) {
    bad('unexpected error', e && e.stack || e);
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main();
