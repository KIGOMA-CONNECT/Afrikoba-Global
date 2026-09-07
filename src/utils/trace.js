/**
 * TRACE SPAN UTILITY (OpenTelemetry-style parent/child tracing)
 *
 * Lightweight, zero-dependency span capture using Node's AsyncLocalStorage to
 * propagate trace context across asynchronous call boundaries WITHOUT threading
 * `req` through every service. Each HTTP request creates a ROOT span; internal
 * operations (ledger postings, wallet movement, auth) spawn CHILD spans
 * automatically nested under the current context's parent span. All spans share
 * a trace_id and link via parent_span_id, persisted to trace_spans (migration
 * 094) and surfaced by the Ops tracing endpoint.
 *
 * Usage:
 *   const { instrumentation } = require('./trace');
 *   instrumentation.run({ traceId, parentSpanId }, () => { handler(...) });
 *
 *   const { startSpan } = require('./trace');
 *   const span = startSpan('fin.postJournal');
 *   try { ... } finally { span.end(); }
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const pool = require('../config/db');

const SERVICE = 'afrikoba-backend';

const als = new AsyncLocalStorage();

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Run a function within a trace context. `ctx = { traceId, parentSpanId }`.
 * Child spans started inside (synchronously or via awaited promises) will nest
 * under parentSpanId.
 */
function run(ctx, fn) {
  return als.run(ctx || {}, fn);
}

function currentContext() {
  return als.getStore() || {};
}

/**
 * Create a trace context on req (idempotent). The HTTP middleware calls this
 * once per request to establish trace_id + the ROOT span_id.
 */
function initTrace(req) {
  if (req.trace) return req.trace;
  const traceId = req.get('x-trace-id') || ('tr_' + randomId(8));
  const spanId = randomId(8);
  req.trace = {
    traceId,
    rootSpanId: spanId,
    spans: [],
  };
  return req.trace;
}

/**
 * Start a span. If called within a run() context, nests under the current
 * parent. Pass `req` to explicitly set trace/root (HTTP root spans).
 *
 * @param {object} opts
 * @param {object} [opts.req] express request (binds trace context + root)
 * @param {string} [opts.traceId] explicit trace id (overrides context)
 * @param {string} [opts.parentSpanId] explicit parent (overrides context)
 * @param {string} opts.name        operation name
 * @param {'ROOT'|'INTERNAL'|'SERVER'|'CLIENT'} [opts.kind='INTERNAL']
 * @returns {{spanId:string, end:(status?:string, extra?:object)=>void, child:Function}}
 */
function startSpan(optsOrName, kindOverride) {
  const opts = typeof optsOrName === 'string' ? { name: optsOrName, kind: kindOverride } : (optsOrName || {});
  const req = opts.req;
  const trace = req && req.trace ? req.trace : null;
  const ctx = currentContext();

  const traceId = opts.traceId || (trace ? trace.traceId : ctx.traceId) || ('tr_' + randomId(8));
  const spanId = randomId(8);
  const parentSpanId = opts.parentSpanId || (trace ? trace.rootSpanId : ctx.parentSpanId) || null;
  const start = Date.now();
  const via = opts.viaPool || pool;
  const kind = opts.kind || 'INTERNAL';

  // Make this span the active parent for any nested startSpan calls.
  const childRun = (fn) => run({ traceId, parentSpanId: spanId }, fn);

  const record = (status, extra) => {
    const durationMs = Date.now() - start;
    const payload = {
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      span_kind: kind,
      service_name: SERVICE,
      operation: opts.name || 'span',
      start_ms: start,
      duration_ms: durationMs,
      status: status || 'OK',
      user_id: req && req.user ? req.user.id : null,
      ip_address: req && (req.ip || req.connection && req.connection.remoteAddress) || null,
      attributes: extra ? JSON.stringify(extra) : null,
    };
    via.query(
      `INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, span_kind, service_name, operation,
         start_ms, duration_ms, status, user_id, ip_address, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [payload.trace_id, payload.span_id, payload.parent_span_id, payload.span_kind,
       payload.service_name, payload.operation, payload.start_ms, payload.duration_ms,
       payload.status, payload.user_id, payload.ip_address, payload.attributes]
    ).catch(() => {});

    if (trace) trace.spans.push({ spanId, parentSpanId, name: opts.name, kind });
  };

  if (trace) trace.spans.push({ spanId, parentSpanId, name: opts.name, kind });

  return {
    spanId,
    end: (status, extra) => { record(status, extra); },
    child: childRun,
  };
}

/**
 * Retrieve the full span tree for a trace_id, ordered by start time, for the
 * Ops tracing endpoint.
 */
async function getTraceTree(traceId) {
  const r = await pool.query(
    `SELECT span_id, parent_span_id, span_kind, service_name, operation,
            start_ms, duration_ms, status, user_id, ip_address, attributes
       FROM trace_spans
      WHERE trace_id = $1
      ORDER BY start_ms, id`,
    [traceId]
  );
  return r.rows;
}

module.exports = { startSpan, initTrace, getTraceTree, run, currentContext, SERVICE };
