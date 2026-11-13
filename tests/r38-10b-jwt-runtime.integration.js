'use strict';
/* R38-10 Step 2: runtime JWT path on the REAL server in NODE_ENV=production.
 * Run with the integration runner (R36_PROD=1 R36_PILOT=1): it starts src/server.js with a random
 * JWT_SECRET (>= 64 hex chars) against a disposable DB and exports the same env to this script.
 * Proves, by behaviour (not source text):
 *  [A] the server refuses to start with a missing/short/default JWT_SECRET (process exits, port never opens);
 *  [B] verification: tokens signed with any shipped default (DEFAULT_JWT, the .env.example placeholder,
 *      and the derived refresh key) are REJECTED by every verifying path that is reachable over HTTP
 *      (authRequired, refresh, TOTP login); algorithm confusion is rejected;
 *  [C] signing: tokens the server issues verify only with the runtime JWT_SECRET (not with any default).
 * No secret value is printed: labels name the case only. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(ROOT, 'node_modules/bcryptjs'));
const { Client } = require(path.join(ROOT, 'node_modules/pg'));

const BASE = process.env.TEST_BASE;
if (process.env.NODE_ENV !== 'production' || !BASE || !/^phase71_financial_audit_[a-z0-9_]+$/.test(process.env.DB_NAME || '')
  || process.env.DB_PORT !== '55481' || !process.env.JWT_SECRET) {
  console.error('REFUSING: run via the integration runner with R36_PROD=1 (disposable DB, production-mode server)'); process.exit(2);
}
const RUNTIME = process.env.JWT_SECRET; // never printed
const DEFAULT_JWT = require(path.join(ROOT, 'src/config/index.js')).DEFAULT_JWT; // never printed
const PLACEHOLDER = (() => { // .env.example JWT_SECRET placeholder (never printed)
  const l = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n').find((x) => /^\s*JWT_SECRET\s*=/.test(x));
  return l ? l.replace(/^\s*JWT_SECRET\s*=\s*/, '').replace(/^['"]|['"]\s*$/g, '').trim() : null;
})();
const REFRESH_SUFFIX = (() => { // suffix that sessionManager appends to jwtSecret for refresh tokens (never printed)
  const m = fs.readFileSync(path.join(ROOT, 'src/middleware/sessionManager.js'), 'utf8')
    .match(/config\.security\.jwtSecret\s*\+\s*(['"`])(.*?)\1/); // R37 (4): REFRESH_TOKEN_SECRET line now guards an empty jwtSecret
  return m ? m[2] : null;
})();

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
async function call(method, p, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, code: j && j.code };
}
const verifies = (tok, key) => { try { jwt.verify(tok, key, { algorithms: ['HS256'] }); return true; } catch (e) { return false; } };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const portOpen = (port) => new Promise((res) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); });

async function bootWith(jwtValue, unset) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DISABLE_CRON: 'true' };
  if (unset) delete env.JWT_SECRET; else env.JWT_SECRET = jwtValue;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const exit = await new Promise((res) => { const t = setTimeout(() => res({ timeout: true }), 25000); child.on('exit', (code) => { clearTimeout(t); res({ code }); }); });
  const open = await portOpen(port);
  if (exit.timeout) child.kill('SIGKILL');
  return { exited: !exit.timeout, code: exit.code, open, jwtRefusal: /JWT_SECRET haikubaliki/.test(stderr) }; // stderr itself is never printed
}

(async () => {
  const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  check('[0] runtime JWT_SECRET is not a shipped default and is >= 32 chars (test precondition)', RUNTIME.trim().length >= 32 && RUNTIME !== DEFAULT_JWT && RUNTIME !== PLACEHOLDER);
  check('[0] .env.example placeholder and refresh-key suffix located (values not printed)', !!PLACEHOLDER && !!REFRESH_SUFFIX);

  console.log('\n[A] production startup with a bad JWT_SECRET: the process exits and never listens');
  for (const [label, v, unset] of [['missing', null, true], ['DEFAULT_JWT', DEFAULT_JWT], ['.env.example placeholder', PLACEHOLDER],
    ['31 random chars', crypto.randomBytes(24).toString('base64').slice(0, 31)], ['DEFAULT_JWT padded with spaces', `  ${DEFAULT_JWT}  `]]) {
    const r = await bootWith(v, unset);
    check(`[A] JWT_SECRET ${label}: server exits non-zero, port never opens, refusal names JWT_SECRET`, r.exited && r.code !== 0 && !r.open && r.jwtRefusal, r);
  }
  const health = await fetch(`${BASE}/health`).then((x) => x.status).catch(() => 0);
  check('[A] control: the runner\'s production server with a valid random JWT_SECRET is up', health === 200, health);

  // A real, active user (password login, no TOTP).
  const phone = `2557${String(Date.now()).slice(-8)}`;
  const password = crypto.randomBytes(12).toString('hex');
  const u = (await db.query(`INSERT INTO users (full_name, phone_number, password_hash) VALUES ('R38-10b user', $1, $2) RETURNING id, role, phone_number, auth_version`,
    [phone, bcrypt.hashSync(password, 10)])).rows[0];
  const claims = () => ({ id: u.id, role: u.role, phone: u.phone_number, av: u.auth_version || 0, jti: crypto.randomUUID() });

  console.log('\n[B] verification: shipped defaults are rejected on every reachable verifying path');
  {
    const good = jwt.sign(claims(), RUNTIME, { expiresIn: '10m' });
    const me = await call('GET', '/api/v1/auth/me', good);
    check('[B] control: token signed with the runtime JWT_SECRET -> GET /auth/me 200', me.status === 200, me);
    for (const [label, key] of [['DEFAULT_JWT', DEFAULT_JWT], ['.env.example placeholder', PLACEHOLDER]]) {
      const forged = jwt.sign(claims(), key, { expiresIn: '10m' });
      for (const p of ['/api/v1/auth/me', '/api/auth/me', '/api/v1/wallet/balance', '/api/v1/vicoba/groups']) {
        const r = await call('GET', p, forged);
        check(`[B] token signed with ${label} -> GET ${p} 401`, r.status === 401, r);
      }
      const fr = jwt.sign({ id: u.id, type: 'refresh', jti: crypto.randomUUID(), av: u.auth_version || 0 }, key + REFRESH_SUFFIX, { expiresIn: '1d' });
      const rr = await call('POST', '/api/v1/auth/refresh', null, { refreshToken: fr });
      check(`[B] refresh token signed with ${label} + refresh suffix -> POST /auth/refresh refused (401)`, rr.status === 401, rr);
      const tt = jwt.sign({ ...claims(), totp_pending: true }, key, { expiresIn: '5m' });
      const tl = await call('POST', '/api/v1/auth/totp-login', null, { tempToken: tt, token: '123456' });
      check(`[B] TOTP tempToken signed with ${label} -> POST /auth/totp-login 401`, tl.status === 401, tl);
      const lo = await call('POST', '/api/v1/auth/logout', forged, {});
      check(`[B] token signed with ${label} -> POST /auth/logout not accepted (401)`, lo.status === 401, lo);
    }
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims())).toString('base64url')}.`;
    check('[B] alg=none token -> GET /auth/me 401', (await call('GET', '/api/v1/auth/me', none)).status === 401);
    const hs512 = jwt.sign(claims(), RUNTIME, { algorithm: 'HS512', expiresIn: '10m' });
    check('[B] HS512 token (right key, wrong algorithm) -> GET /auth/me 401 (HS256 lock)', (await call('GET', '/api/v1/auth/me', hs512)).status === 401);
  }

  console.log('\n[C] signing: server-issued tokens verify only with the runtime JWT_SECRET');
  {
    const lr = await fetch(`${BASE}/api/v1/auth/login/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ emailOrPhone: phone, password }) });
    const lj = await lr.json().catch(() => ({}));
    check('[C] POST /auth/login/password -> 200 with access + refresh token', lr.status === 200 && !!lj.token && !!lj.refreshToken, { status: lr.status, hasToken: !!lj.token });
    if (lj.token) {
      check('[C] issued access token verifies with the runtime JWT_SECRET', verifies(lj.token, RUNTIME));
      check('[C] issued access token does NOT verify with DEFAULT_JWT', !verifies(lj.token, DEFAULT_JWT));
      check('[C] issued access token does NOT verify with the .env.example placeholder', !verifies(lj.token, PLACEHOLDER));
      check('[C] issued refresh token verifies with runtime JWT_SECRET + suffix', verifies(lj.refreshToken, RUNTIME + REFRESH_SUFFIX));
      check('[C] issued refresh token does NOT verify with DEFAULT_JWT + suffix', !verifies(lj.refreshToken, DEFAULT_JWT + REFRESH_SUFFIX));
      check('[C] issued access token -> GET /auth/me 200', (await call('GET', '/api/v1/auth/me', lj.token)).status === 200);
      const rf = await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: lj.refreshToken }) });
      const rj = await rf.json().catch(() => ({}));
      check('[C] POST /auth/refresh with the issued refresh token -> 200', rf.status === 200 && !!rj.token, { status: rf.status });
      if (rj.token) {
        check('[C] refreshed access token verifies with the runtime JWT_SECRET, not with DEFAULT_JWT', verifies(rj.token, RUNTIME) && !verifies(rj.token, DEFAULT_JWT));
      }
    }
  }

  await db.end();
  console.log(`\nR38-10b JWT runtime path: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
