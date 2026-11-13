'use strict';
/* R37 (2) / R38 R-1: the shipped DEFAULT_JWT fallback may apply ONLY when NODE_ENV is exactly 'test' or
 * 'development'. Any other value (unset, empty, 'Production', 'prod', 'staging', ...) is treated as production:
 *  - validateConfig() refuses a missing / short / default JWT_SECRET;
 *  - the real src/server.js refuses to start (exits, never listens);
 *  - config.security.jwtSecret and auth.js never fall back to DEFAULT_JWT, so a token forged with
 *    DEFAULT_JWT does not verify and signToken() never signs with it.
 * auth.js must read only the validated config value (no fallback of its own).
 * No database. No secret value is printed. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'r37-2-'));
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };

// Child: loads config + auth in a fresh process and reports booleans only.
const CHILD = `
  const R = ${JSON.stringify(ROOT)};
  const out = {};
  let cfg;
  try { cfg = require(R + '/src/config/index.js'); } catch (e) { process.stdout.write(JSON.stringify({ loadError: true })); process.exit(0); }
  try { cfg.validateConfig(); out.started = true; } catch (e) { out.started = false; out.jwtRefusal = /JWT_SECRET haikubaliki/.test(e.message); }
  out.configIsDefault = cfg.security.jwtSecret === cfg.DEFAULT_JWT;
  const auth = require(R + '/src/middleware/auth.js');
  out.authIsDefault = auth.JWT_SECRET === cfg.DEFAULT_JWT;
  out.authEqualsConfig = auth.JWT_SECRET === cfg.security.jwtSecret;
  const jwt = require(R + '/node_modules/jsonwebtoken');
  const { hardenedVerify } = require(R + '/src/middleware/jwtHardening.js');
  const forged = jwt.sign({ id: 1, role: 'admin' }, cfg.DEFAULT_JWT, { algorithm: 'HS256', expiresIn: '5m' });
  try { hardenedVerify(forged, auth.JWT_SECRET); out.forgedVerifies = true; } catch (e) { out.forgedVerifies = false; }
  try { const t = auth.signToken({ id: 1, role: 'user', phone_number: '255700000000', auth_version: 0 });
        try { jwt.verify(t, cfg.DEFAULT_JWT, { algorithms: ['HS256'] }); out.signedWithDefault = true; } catch (e) { out.signedWithDefault = false; } }
  catch (e) { out.signedWithDefault = false; out.signThrows = true; }
  process.stdout.write(JSON.stringify(out));`;

function probe(nodeEnv, jwtValue) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  if (jwtValue !== undefined) env.JWT_SECRET = jwtValue;
  const r = spawnSync(process.execPath, ['-e', CHILD], { cwd: EMPTY, env, encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch (e) { return { crashed: true, status: r.status }; }
}

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = (port) => new Promise((res) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); });
async function bootServer(nodeEnv) { // JWT_SECRET unset; DB points at a closed port (the gate runs before any DB use)
  const port = await freePort();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DISABLE_CRON: 'true', DB_HOST: '127.0.0.1', DB_PORT: '1' };
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  let opened = false;
  const poll = setInterval(async () => { if (await portOpen(port)) opened = true; }, 250);
  const exit = await new Promise((res) => { const t = setTimeout(() => res({ timeout: true }), 20000); child.on('exit', (code) => { clearTimeout(t); res({ code }); }); });
  clearInterval(poll);
  if (exit.timeout) child.kill('SIGKILL');
  return { exited: !exit.timeout, code: exit.code, opened, jwtRefusal: /JWT_SECRET haikubaliki/.test(err) };
}

(async () => {
  const DEFAULT_JWT = require(path.join(ROOT, 'src/config/index.js')).DEFAULT_JWT; // never printed
  const short31 = crypto.randomBytes(24).toString('base64').slice(0, 31);
  const good = crypto.randomBytes(32).toString('hex');
  const NON_DEV = [['unset', undefined], ['empty', ''], ['Production', 'Production'], ['PRODUCTION', 'PRODUCTION'], ['prod', 'prod'], ['staging', 'staging'], ['Test (wrong case)', 'Test'], ['production + space', 'production ']];

  console.log('\n[1] NODE_ENV not exactly test/development: treated as production for JWT_SECRET');
  for (const [label, ne] of NON_DEV) {
    for (const [jl, jv] of [['missing', undefined], ['DEFAULT_JWT', DEFAULT_JWT], ['31 chars', short31]]) {
      const r = probe(ne, jv);
      check(`[1] NODE_ENV ${label}, JWT_SECRET ${jl}: validateConfig refuses (JWT reason)`, r.started === false && r.jwtRefusal === true, r);
    }
    const m = probe(ne, undefined);
    check(`[1] NODE_ENV ${label}, JWT_SECRET missing: config and auth.js do NOT fall back to DEFAULT_JWT`, m.configIsDefault === false && m.authIsDefault === false, m);
    check(`[1] NODE_ENV ${label}, JWT_SECRET missing: a token forged with DEFAULT_JWT does not verify`, m.forgedVerifies === false, m);
    check(`[1] NODE_ENV ${label}, JWT_SECRET missing: signToken never signs with DEFAULT_JWT`, m.signedWithDefault === false, m);
    const g = probe(ne, good);
    check(`[1] NODE_ENV ${label}, valid random JWT_SECRET: no JWT refusal; auth.js uses the config value`, g.jwtRefusal !== true && g.authEqualsConfig === true && g.configIsDefault === false, g);
  }

  console.log('\n[2] real src/server.js refuses to start (JWT_SECRET unset)');
  for (const [label, ne] of [['unset', undefined], ['staging', 'staging'], ['Production', 'Production']]) {
    const r = await bootServer(ne);
    check(`[2] NODE_ENV ${label}: server exits non-zero, never listens, refusal names JWT_SECRET`, r.exited && r.code !== 0 && !r.opened && r.jwtRefusal, r);
  }

  console.log('\n[3] controls: explicit test/development keep the documented fallback (unchanged)');
  for (const ne of ['test', 'development']) {
    const r = probe(ne, undefined);
    check(`[3] NODE_ENV=${ne}, JWT_SECRET missing: validateConfig passes and the fallback applies`, r.started === true && r.configIsDefault === true && r.authEqualsConfig === true, r);
  }
  const p = probe('production', good);
  check('[3] NODE_ENV=production with a valid random secret: no JWT refusal, auth.js uses the config value', p.jwtRefusal !== true && p.authEqualsConfig === true, p);

  fs.rmSync(EMPTY, { recursive: true, force: true });
  console.log(`\nR37 (2) JWT fallback only in test/development: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
