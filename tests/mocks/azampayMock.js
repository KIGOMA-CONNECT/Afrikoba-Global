'use strict';
/* ============================================================================
 * AFRIKOBA — AzamPay mock + HARD EGRESS KILL-SWITCH  (test-only)
 * ----------------------------------------------------------------------------
 * Load with:   node -r ./tests/mocks/azampayMock.js <server-or-script>
 *
 * Guarantees:
 *   1. NO real payment request ever leaves this process. Outbound HTTP(S) to
 *      any non-loopback host is blocked (error code EGRESS_BLOCKED) unless the
 *      host is an AzamPay host, which is transparently redirected to a local
 *      mock server on 127.0.0.1.
 *   2. NO real credentials are needed. The mock issues its own access token.
 *   3. Deterministic gateway answers, selected by AZAMPAY_MOCK_SCENARIO:
 *        SUCCESS | FAILED | PENDING | UNKNOWN | TIMEOUT   (default SUCCESS)
 *   4. Every intercepted / blocked call is appended to AZAMPAY_MOCK_LOG
 *        (default /tmp/azampay-mock-calls.jsonl) for idempotency assertions.
 *
 * This file changes NOTHING in production code. It only monkey-patches the
 * transport (http/https) of the process it is preloaded into.
 * ==========================================================================*/
const http = require('http');
const https = require('https');
const fs = require('fs');
const { EventEmitter } = require('events');
const { URL } = require('url');

const SCENARIO = String(process.env.AZAMPAY_MOCK_SCENARIO || 'SUCCESS').toUpperCase();
const LOG_PATH = process.env.AZAMPAY_MOCK_LOG || '/tmp/azampay-mock-calls.jsonl';
const MOCK_PORT = parseInt(process.env.AZAMPAY_MOCK_PORT || '45999', 10);
const VALID = ['SUCCESS', 'FAILED', 'PENDING', 'UNKNOWN', 'TIMEOUT'];
const SHELL = process.env.AZAMPAY_MOCK_ROLE || 'unknown';

if (!VALID.includes(SCENARIO)) {
  throw new Error(`AZAMPAY_MOCK_SCENARIO must be one of ${VALID.join('|')} (got ${SCENARIO})`);
}

function record(entry) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(Object.assign({ t: Date.now(), scenario: SCENARIO, role: SHELL, pid: process.pid }, entry)) + '\n');
  } catch (e) { /* logging must never break the test */ }
}

function isLoopback(host) {
  return !host || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0' || /^127\./.test(host);
}
function isAzamPay(host) {
  return /(^|\.)azampay\.co\.tz$/i.test(host);
}

/* ------------------------------------------------------------------ *
 * Local mock gateway (real HTTP, so axios works unmodified)
 * ------------------------------------------------------------------ */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
    record({ kind: 'gateway', path: req.url, method: req.method, externalId: parsed && parsed.externalId });

    // Auth token — always succeeds (no credentials required).
    if (/AppAuthentication\/Token/i.test(req.url)) {
      return send(res, 200, { success: true, data: { accessToken: 'mock-access-token', expires: '3600' } });
    }

    // Transaction status query (used by reconciliation).
    if (/payment\/query/i.test(req.url)) {
      if (SCENARIO === 'TIMEOUT') {
        setTimeout(() => { try { res.destroy(); } catch (e) {} }, 150);
        return;
      }
      if (SCENARIO === 'UNKNOWN') return send(res, 503, { message: 'mock gateway unavailable' });
      if (SCENARIO === 'FAILED') return send(res, 200, { transactionstatus: 'FAILED' });
      if (SCENARIO === 'PENDING') return send(res, 200, { transactionstatus: 'PENDING' });
      return send(res, 200, { transactionstatus: 'SUCCESS' });
    }

    // USSD push / payout checkout.
    if (/mno\/checkout/i.test(req.url)) {
      if (SCENARIO === 'UNKNOWN') return send(res, 503, { message: 'mock checkout unavailable' });
      if (SCENARIO === 'FAILED') return send(res, 200, { success: false, transactionstatus: 'FAILED', message: 'mock checkout failed' });
      if (SCENARIO === 'TIMEOUT') {
        setTimeout(() => { try { res.destroy(); } catch (e) {} }, 150);
        return;
      }
      return send(res, 200, { success: true, transactionstatus: 'PENDING', message: 'mock checkout accepted' });
    }

    return send(res, 404, { message: 'mock: unknown path' });
  });
});

let listening = false;
server.on('error', (e) => { process.stderr.write(`[azampayMock] server error: ${e.message}\n`); });
server.listen(MOCK_PORT, '127.0.0.1', () => {
  listening = true;
  process.stderr.write(`[azampayMock] role=${SHELL} pid=${process.pid} scenario=${SCENARIO} mock=127.0.0.1:${MOCK_PORT} log=${LOG_PATH} status=READY\n`);
});
server.unref(); // never keep the process alive on its own

/* ------------------------------------------------------------------ *
 * Transport interception
 * ------------------------------------------------------------------ */
const originalHttpRequest = http.request;
const originalHttpsRequest = https.request;

function parseArgs(args) {
  const a0 = args[0];
  let urlStr = null; let options = {}; let cb;
  if (typeof a0 === 'string' || a0 instanceof URL) {
    urlStr = a0;
    if (typeof args[1] === 'function') { cb = args[1]; } else { options = args[1] || {}; cb = args[2]; }
  } else {
    options = a0 || {};
    cb = args[1];
  }
  return { urlStr, options: options || {}, cb };
}

function hostOf(urlStr, options) {
  let host = options.hostname || options.host;
  if (!host && urlStr) { try { host = new URL(urlStr).hostname; } catch (e) {} }
  if (host && host.includes(':')) host = host.split(':')[0];
  return host || '';
}

function pathOf(urlStr, options) {
  if (options.path) return options.path;
  if (urlStr) { try { const u = new URL(urlStr); return u.pathname + (u.search || ''); } catch (e) {} }
  return '/';
}

function makeBlockedRequest(host, path, method) {
  const req = new EventEmitter();
  let ended = false;
  const error = () => Object.assign(new Error(`EGRESS_BLOCKED: refusing outbound request to ${host}${path}`), { code: 'EGRESS_BLOCKED' });
  req.write = () => true;
  req.setHeader = () => {};
  req.getHeader = () => undefined;
  req.removeHeader = () => {};
  req.setTimeout = () => req;
  req.setNoDelay = () => {};
  req.setSocketKeepAlive = () => {};
  req.flushHeaders = () => {};
  req.abort = () => { try { req.emit('abort'); } catch (e) {} };
  req.destroy = (e) => { if (e) setImmediate(() => req.emit('error', e)); return req; };
  req.end = () => {
    if (ended) return req;
    ended = true;
    record({ kind: 'blocked', host, path, method });
    setImmediate(() => { try { req.emit('error', error()); } catch (e) {} });
    return req;
  };
  return req;
}

function guarded(original) {
  return function (...args) {
    const { urlStr, options, cb } = parseArgs(args);
    const host = hostOf(urlStr, options);
    const path = pathOf(urlStr, options);
    const method = options.method || 'GET';

    if (isLoopback(host)) return original.apply(this, args);

    if (isAzamPay(host)) {
      if (listening) {
        record({ kind: 'intercept', host, path, method });
      } else {
        record({ kind: 'intercept-before-ready', host, path, method });
      }
      const redirected = {
        method,
        headers: options.headers || {},
        path,
        hostname: '127.0.0.1',
        host: '127.0.0.1',
        port: MOCK_PORT,
        agent: false,
      };
      return originalHttpRequest(redirected, cb);
    }

    return makeBlockedRequest(host, path, method);
  };
}

http.request = guarded(originalHttpRequest);
https.request = guarded(originalHttpsRequest);
http.get = function (...args) { const req = http.request(...args); req.end(); return req; };
https.get = function (...args) { const req = https.request(...args); req.end(); return req; };

/* ------------------------------------------------------------------ *
 * Node's global fetch (undici) does NOT go through http/https.request,
 * so it must be guarded separately, otherwise egress could still happen
 * (e.g. networkService.js uses fetch(sub.url, ...) for webhook fan-out).
 * ------------------------------------------------------------------ */
const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') {
  globalThis.fetch = async function guardedFetch(input, init) {
    const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^https?:\/\//i.test(urlStr)) return originalFetch(input, init);
    let host = '';
    try { host = new URL(urlStr).hostname; } catch (e) { return originalFetch(input, init); }

    if (isLoopback(host)) return originalFetch(input, init);

    if (isAzamPay(host)) {
      const u = new URL(urlStr);
      const target = `http://127.0.0.1:${MOCK_PORT}${u.pathname}${u.search || ''}`;
      record({ kind: 'intercept', via: 'fetch', host, path: u.pathname + (u.search || ''), method: (init && init.method) || 'GET' });
      return originalFetch(target, init);
    }

    record({ kind: 'blocked', via: 'fetch', host, path: urlStr, method: (init && init.method) || 'GET' });
    throw Object.assign(new TypeError(`EGRESS_BLOCKED: refusing outbound fetch to ${urlStr}`), { code: 'EGRESS_BLOCKED' });
  };
}

module.exports = {
  SCENARIO,
  MOCK_PORT,
  LOG_PATH,
  isAzamPay,
  isLoopback,
  server,
};

globalThis.__AZAMPAY_MOCK__ = { scenario: SCENARIO, port: MOCK_PORT, log: LOG_PATH, active: true };
process.stderr.write(`[azampayMock] kill-switch ACTIVE role=${SHELL} pid=${process.pid} scenario=${SCENARIO}\n`);
