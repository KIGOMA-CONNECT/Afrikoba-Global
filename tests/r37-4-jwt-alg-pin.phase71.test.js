'use strict';
/* R37 (4) / R38 R-4: every JWT verification pins HS256. Behavioural, no database: each check runs in a fresh
 * child process with src/config/db.js replaced by a recording stub pool, so we can see whether a token got
 * past verification (the function goes on to query the DB) or was refused at verify (no query).
 * For every verifying function in src/middleware/sessionManager.js:
 *   - control: an HS256 token signed with the right key passes verify (>= 1 DB query);
 *   - an HS512 / HS384 token signed with the SAME right key is refused at verify (0 DB queries).
 * Also: with an empty jwtSecret (non-dev NODE_ENV, JWT_SECRET unset) the refresh key is not reduced to the
 * public suffix: a refresh token signed with the suffix alone is refused at verify.
 * No secret value is printed. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'r37-4-'));
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };

// The suffix sessionManager appends to jwtSecret for refresh tokens (read from source, never printed).
const SUFFIX = (fs.readFileSync(path.join(ROOT, 'src/middleware/sessionManager.js'), 'utf8')
  .match(/config\.security\.jwtSecret\s*\+\s*(['"`])(.*?)\1/) || [])[2];

const CHILD = `
  const R = process.env.R37_ROOT;
  const queries = [];
  const dbPath = require.resolve(R + '/src/config/db.js');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { query: async (sql) => { queries.push(String(sql).slice(0, 20)); return { rows: [], rowCount: 0 }; },
               connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) } };
  const jwt = require(R + '/node_modules/jsonwebtoken');
  const sm = require(R + '/src/middleware/sessionManager.js');
  const { fn, alg, keyKind } = JSON.parse(process.env.R37_CASE);
  const secret = process.env.JWT_SECRET || '';
  const key = keyKind === 'access' ? secret : keyKind === 'refresh' ? secret + process.env.R37_SUFFIX : process.env.R37_SUFFIX;
  const payload = { id: 1, type: keyKind === 'access' ? undefined : 'refresh', av: 0, jti: require('crypto').randomUUID() };
  const token = jwt.sign(payload, key, { algorithm: alg, expiresIn: '10m' });
  (async () => {
    let threw = false;
    try {
      if (fn === 'validateSession') {
        await new Promise((res) => { const r = sm.validateSession({ headers: { authorization: 'Bearer ' + token } }, { status() { return this; }, json() { res(); } }, () => res()); if (r && r.then) r.then(res, res); });
      } else { await sm[fn](token); }
    } catch (e) { threw = true; }
    process.stdout.write(JSON.stringify({ queries: queries.length, threw }));
  })();`;

function run(c, env) {
  const r = spawnSync(process.execPath, ['-e', CHILD], {
    cwd: EMPTY, encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, R37_ROOT: ROOT, R37_SUFFIX: SUFFIX, R37_CASE: JSON.stringify(c), ...env },
  });
  try { return JSON.parse(r.stdout); } catch (e) { return { crashed: true, status: r.status }; }
}

const SECRET = crypto.randomBytes(32).toString('hex');
const ENV = { NODE_ENV: 'test', JWT_SECRET: SECRET };
check('[0] refresh-key suffix located in sessionManager.js (value not printed)', !!SUFFIX);

console.log('\n[1] every sessionManager verify path pins HS256');
for (const [fn, keyKind] of [['refreshAccessToken', 'refresh'], ['revokeRefreshToken', 'refresh'], ['revokeToken', 'access'], ['validateSession', 'access']]) {
  const ctl = run({ fn, alg: 'HS256', keyKind }, ENV);
  check(`[1] control: ${fn} with an HS256 token (right key) passes verify and reaches the DB`, ctl.queries >= 1, ctl);
  for (const alg of ['HS512', 'HS384']) {
    const r = run({ fn, alg, keyKind }, ENV);
    check(`[1] ${fn} with an ${alg} token signed with the right key is refused at verify (no DB query)`, r.queries === 0, r);
  }
}

console.log('\n[2] empty jwtSecret: the refresh key is not reduced to the public suffix');
for (const ne of ['staging', 'Production']) {
  const r = run({ fn: 'refreshAccessToken', alg: 'HS256', keyKind: 'suffixOnly' }, { NODE_ENV: ne });
  check(`[2] NODE_ENV=${ne}, JWT_SECRET unset: a refresh token signed with the suffix alone is refused at verify`, r.queries === 0 && r.threw === true, r);
  const v = run({ fn: 'revokeRefreshToken', alg: 'HS256', keyKind: 'suffixOnly' }, { NODE_ENV: ne });
  check(`[2] NODE_ENV=${ne}, JWT_SECRET unset: revokeRefreshToken refuses the suffix-only token (no DB query)`, v.queries === 0, v);
}

fs.rmSync(EMPTY, { recursive: true, force: true });
console.log(`\nR37 (4) HS256 pin on every verify: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
