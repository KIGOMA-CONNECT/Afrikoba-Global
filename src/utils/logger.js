const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVEL_NUM = ORDER.hasOwnProperty(LEVEL) ? ORDER[LEVEL] : ORDER.info;

// Per-request access logs (HTTP/REQUEST_LOG) can be switched off for soak runs:
// two synchronous console.log writes per request are the biggest single-node
// throughput limiter under sustained load.
const requestsEnabled = (process.env.LOG_REQUESTS || 'true').toLowerCase() !== 'false';

// Async, capped buffering: batches info/debug lines and flushes them on an
// interval so backpressure on stdout never blocks the event loop. Errors and
// warnings flush the buffer and write immediately so crash diagnostics survive.
let buffer = [];
let flusher = null;
const MAX_BUFFER = 500;
const FLUSH_MS = 150;

function flush() {
  if (!buffer.length) return;
  const lines = buffer.join('\n') + '\n';
  buffer = [];
  try {
    process.stdout.write(lines);
  } catch (e) {
    /* never let logging take the process down */
  }
}

function queue(line) {
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push(line);
  if (!flusher) {
    flusher = setInterval(flush, FLUSH_MS);
    if (flusher.unref) flusher.unref();
  }
}

function serialize(extra) {
  if (extra === undefined) return '';
  let s;
  try {
    s = JSON.stringify(extra);
  } catch (e) {
    s = String(extra);
  }
  return s !== undefined ? ` ${s}` : '';
}

function log(level, tag, message, extra) {
  if (LEVEL_NUM < ORDER[level]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${message}${serialize(extra)}`;
  if (level === 'warn' || level === 'error') {
    flush();
    try {
      process.stdout.write(line + '\n');
    } catch (e) { /* no-op */ }
  } else {
    queue(line);
  }
}

module.exports = {
  info: (tag, msg, extra) => log('info', tag, msg, extra),
  warn: (tag, msg, extra) => log('warn', tag, msg, extra),
  error: (tag, msg, extra) => log('error', tag, msg, extra),
  debug: (tag, msg, extra) => log('debug', tag, msg, extra),
  reqEnabled: requestsEnabled,
};