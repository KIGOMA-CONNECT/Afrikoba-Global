/**
 * READ-THROUGH CACHE (pluggable, zero-dependency default)
 * - Redis: inahitaji REDIS_URL; ikiwa set, inatumia ioredis (available dep).
 * - Memory: default backend — TTL Map yenye LRU eviction cap (no infra needed).
 * API: get/set/del/flush/stats (+ bust prefix helper).
 * CI hatumii REDIS_URL, kwa hivyo backend ya memory ndiyo default → deterministic.
 */
let Redis = null;
try {
  Redis = require('ioredis');
} catch (e) {
  Redis = null;
}

const BACKEND = process.env.REDIS_URL ? 'redis' : 'memory';
const MAX_KEYS = parseInt(process.env.CACHE_MAX_KEYS || '5000', 10);
const DEFAULT_TTL_MS = parseInt(process.env.CACHE_DEFAULT_TTL_MS || '30000', 10);

const stats = { hits: 0, misses: 0, sets: 0, deletes: 0, evictions: 0, flushes: 0 };

let redisClient = null;
if (BACKEND === 'redis' && Redis) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  redisClient.on('error', () => {});
  redisClient.connect().catch(() => {});
}

// ---- memory backend -----------------------------------------------------
const store = new Map(); // key -> { value, expiresAt }
const touchOrder = [];   // LRU order (front = most recent)

function now() { return Date.now(); }

function memoryGet(key) {
  const entry = store.get(key);
  if (!entry) {
    stats.misses += 1;
    return undefined;
  }
  if (entry.expiresAt <= now()) {
    store.delete(key);
    const idx = touchOrder.indexOf(key);
    if (idx >= 0) touchOrder.splice(idx, 1);
    stats.misses += 1;
    return undefined;
  }
  // move to front (MRU)
  const idx = touchOrder.indexOf(key);
  if (idx > 0) touchOrder.splice(idx, 1);
  touchOrder.unshift(key);
  stats.hits += 1;
  return entry.value;
}

function memorySet(key, value, ttlMs) {
  if (!store.has(key) && store.size >= MAX_KEYS) {
    // evict LRU tail
    const lru = touchOrder.pop();
    if (lru != null) {
      store.delete(lru);
      stats.evictions += 1;
    }
  }
  const expiry = now() + (ttlMs || DEFAULT_TTL_MS);
  if (!store.has(key)) {
    const idx = touchOrder.indexOf(key);
    if (idx >= 0) touchOrder.splice(idx, 1);
    touchOrder.unshift(key);
  }
  store.set(key, { value, expiresAt: expiry });
  stats.sets += 1;
}

function memoryDel(key) {
  const existed = store.delete(key);
  const idx = touchOrder.indexOf(key);
  if (idx >= 0) touchOrder.splice(idx, 1);
  if (existed) stats.deletes += 1;
  return existed;
}

function memoryFlush(keyPattern) {
  if (!keyPattern) {
    store.clear();
    touchOrder.length = 0;
    resetCounters();
    return;
  }
  const re = new RegExp('^' + keyPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*'));
  let removed = 0;
  for (const key of store.keys()) {
    if (re.test(key)) {
      store.delete(key);
      removed += 1;
    }
  }
  touchOrder.length = 0;
  touchOrder.push(...store.keys());
  if (removed > 0) stats.deletes += removed;
  return removed;
}

// ---- redis backend ------------------------------------------------------
async function redisGet(key) {
  if (!redisClient || redisClient.status !== 'ready') { stats.misses += 1; return undefined; }
  try {
    const raw = await redisClient.get(key);
    if (raw == null) { stats.misses += 1; return undefined; }
    stats.hits += 1;
    return JSON.parse(raw);
  } catch (e) {
    stats.misses += 1;
    return undefined;
  }
}

async function redisSet(key, value, ttlMs) {
  try {
    await redisClient.set(key, JSON.stringify(value), 'PX', ttlMs || DEFAULT_TTL_MS);
    stats.sets += 1;
  } catch (e) { /* best effort */ }
}

async function redisDel(key) {
  try {
    await redisClient.del(key);
    stats.deletes += 1;
  } catch (e) { /* best effort */ }
}

async function redisFlush(pattern) {
  try {
    const keys = await redisClient.keys(pattern ? `*${pattern.replace(/^\*/g, '')}` : '*');
    if (keys.length) await redisClient.del(...keys);
    stats.flushes += 1;
    resetCounters();
    return keys.length;
  } catch (e) { return 0; }
}

function resetCounters() {
  stats.hits = 0;
  stats.misses = 0;
  stats.sets = 0;
  stats.deletes = 0;
  stats.evictions = 0;
  stats.flushes += 1;
}

// ---- public API ---------------------------------------------------------
async function get(key) {
  if (BACKEND === 'redis') return redisGet(key);
  return memoryGet(key);
}

async function set(key, value, ttlMs) {
  if (BACKEND === 'redis') return redisSet(key, value, ttlMs);
  return memorySet(key, value, ttlMs);
}

async function del(key) {
  if (BACKEND === 'redis') return redisDel(key);
  return memoryDel(key);
}

/** Futa keys zote au zile zilizofanana na prefix (e.g. 'vaults:user:'). */
async function bust(keyPrefix) {
  if (BACKEND === 'redis') return redisFlush(keyPrefix);
  return memoryFlush(keyPrefix);
}

async function flush() {
  if (BACKEND === 'redis') return redisFlush('');
  return memoryFlush('');
}

function getStats() {
  return {
    backend: BACKEND,
    maxKeys: MAX_KEYS,
    ...stats,
    keys: BACKEND === 'redis' ? 0 : store.size,
  };
}

module.exports = { get, set, del, bust, flush, getStats, _memoryStore: store }; // eslint-disable-line no-underscore-dangle