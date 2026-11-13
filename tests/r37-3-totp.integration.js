'use strict';
/* R37 (3) / R38 R-2 + R-3: TOTP 2FA on the REAL production-mode server (integration runner, R36_PROD=1).
 *  R-3: enrolment and verification follow the API of the pinned otplib (package-lock: 13.5.0):
 *       POST /totp/setup -> 200, POST /totp/verify with a valid code enables 2FA; malformed codes are a 403, not a 500.
 *  R-2: the 5-minute tempToken issued after the password step carries totp_pending and is REFUSED by every route
 *       except POST /auth/totp-login (Authorization header on /api/*, refresh endpoint); /totp-login with a valid
 *       code returns a full session; an ordinary access token cannot stand in for a tempToken; a tempToken issued
 *       before a password change (auth_version bump) is refused.
 * No secret value is printed. */
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const jwt = require(path.join(ROOT, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(ROOT, 'node_modules/bcryptjs'));
const otp = require(path.join(ROOT, 'node_modules/otplib'));
const { Client } = require(path.join(ROOT, 'node_modules/pg'));

const BASE = process.env.TEST_BASE;
if (process.env.NODE_ENV !== 'production' || !BASE || !/^phase71_financial_audit_[a-z0-9_]+$/.test(process.env.DB_NAME || '')
  || process.env.DB_PORT !== '55481') { console.error('REFUSING: run via the integration runner with R36_PROD=1'); process.exit(2); }

let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };
async function call(method, p, token, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, body: j };
}
const codeFor = (secret) => otp.generateSync({ secret });
const otherCode = (secret) => { const c = codeFor(secret); return String((Number(c) + 1) % 1000000).padStart(6, '0'); };

(async () => {
  const db = new Client({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await db.connect();
  const mkUser = async (label) => {
    const phone = `2556${crypto.randomInt(10000000, 99999999)}`; const password = crypto.randomBytes(12).toString('hex');
    const id = (await db.query(`INSERT INTO users (full_name, phone_number, password_hash) VALUES ($1, $2, $3) RETURNING id`, [label, phone, bcrypt.hashSync(password, 10)])).rows[0].id;
    return { id, phone, password };
  };
  const login = (u) => call('POST', '/api/v1/auth/login/password', null, { emailOrPhone: u.phone, password: u.password });

  console.log('\n[0] R-3: enrolment through the API (both route families)');
  const u = await mkUser('R37-3 2FA user');
  let secret = null;
  {
    const l0 = await login(u);
    check('[0] control: password login before enrolment -> 200 with access token', l0.status === 200 && !!(l0.body && l0.body.token), { status: l0.status });
    const tok = l0.body && l0.body.token;
    const s1 = await call('POST', '/api/v1/auth/totp/setup', tok, {});
    check('[0] POST /api/v1/auth/totp/setup -> 200 with otpauth URL', s1.status === 200 && /^otpauth:\/\/totp\//.test(JSON.stringify(s1.body).match(/otpauth:[^"]*/)?.[0] || ''), { status: s1.status });
    const s2 = await call('POST', '/api/v1/totp/setup', tok, {});
    check('[0] POST /api/v1/totp/setup -> 200', s2.status === 200, { status: s2.status });
    const row = (await db.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [u.id])).rows[0];
    secret = row && row.totp_secret;
    check('[0] secret stored, 2FA not yet enabled', !!secret && row.totp_enabled === false, { stored: !!secret, enabled: row && row.totp_enabled });
    if (secret) {
      const bad = await call('POST', '/api/v1/totp/verify', tok, { token: otherCode(secret) });
      check('[0] /totp/verify with a wrong code -> 403, still disabled', bad.status === 403, { status: bad.status });
      const mal = await call('POST', '/api/v1/totp/verify', tok, { token: 'abc' });
      check('[0] /totp/verify with a malformed code -> 4xx, not 500', mal.status >= 400 && mal.status < 500, { status: mal.status });
      const ok = await call('POST', '/api/v1/totp/verify', tok, { token: codeFor(secret) });
      const en = (await db.query('SELECT totp_enabled FROM users WHERE id = $1', [u.id])).rows[0].totp_enabled;
      check('[0] /totp/verify with the valid code -> 200 and 2FA enabled', ok.status === 200 && en === true, { status: ok.status, enabled: en });
    }
  }

  console.log('\n[1] password step for the enrolled user');
  const l1 = await login(u);
  const temp = l1.body && l1.body.tempToken;
  check('[1] login/password -> 200 requires2FA, tempToken, NO access/refresh token', l1.status === 200 && l1.body.requires2FA === true && !!temp && !l1.body.token && !l1.body.refreshToken, { status: l1.status });
  if (!temp) { await db.end(); console.log(`\nR37 (3) TOTP: ${passed} passed, ${failed} failed`); process.exit(1); }
  const dec = jwt.decode(temp) || {};
  check('[1] tempToken carries totp_pending and lives <= 5 minutes', dec.totp_pending === true && dec.exp - dec.iat <= 300, { claims: Object.keys(dec) });

  console.log('\n[2] R-2: the tempToken is refused everywhere except the TOTP step');
  for (const [m, p] of [['GET', '/api/v1/auth/me'], ['GET', '/api/auth/me'], ['GET', '/api/v1/wallet/balance'], ['GET', '/api/v1/vicoba/groups'],
    ['GET', '/api/v1/rosca/trust/summary'], ['POST', '/api/v1/auth/totp/setup'], ['POST', '/api/v1/totp/disable'], ['POST', '/api/v1/auth/logout']]) {
    const r = await call(m, p, temp, m === 'POST' ? {} : undefined);
    check(`[2] tempToken as Bearer -> ${m} ${p} 401`, r.status === 401, { status: r.status });
  }
  const asRefresh = await call('POST', '/api/v1/auth/refresh', null, { refreshToken: temp });
  check('[2] tempToken as refreshToken -> /auth/refresh 401', asRefresh.status === 401, { status: asRefresh.status });

  console.log('\n[3] the second step');
  const wrong = await call('POST', '/api/v1/auth/totp-login', null, { tempToken: temp, token: otherCode(secret) });
  check('[3] /totp-login with a wrong code -> 403', wrong.status === 403, { status: wrong.status });
  const mal = await call('POST', '/api/v1/auth/totp-login', null, { tempToken: temp, token: 'abc' });
  check('[3] /totp-login with a malformed code -> 403, not 500', mal.status === 403, { status: mal.status });
  const ok = await call('POST', '/api/v1/auth/totp-login', null, { tempToken: temp, token: codeFor(secret) });
  check('[3] /totp-login with the valid code -> 200 with access + refresh token', ok.status === 200 && !!(ok.body && ok.body.token && ok.body.refreshToken), { status: ok.status });
  if (ok.body && ok.body.token) {
    check('[3] access token from /totp-login -> GET /auth/me 200', (await call('GET', '/api/v1/auth/me', ok.body.token)).status === 200);
    check('[3] access token from /totp-login carries no totp_pending', !(jwt.decode(ok.body.token) || {}).totp_pending);
    // The enrolled user's own full access token, with a VALID code, must not be accepted as a tempToken.
    const asTemp = await call('POST', '/api/v1/auth/totp-login', null, { tempToken: ok.body.token, token: codeFor(secret) });
    check('[3] an ordinary access token (same user, valid code) used as tempToken -> /totp-login 400', asTemp.status === 400, { status: asTemp.status });
  }

  console.log('\n[4] a tempToken issued before a password change is refused');
  {
    const l4 = await login(u); const t4 = l4.body && l4.body.tempToken;
    await db.query('UPDATE users SET auth_version = COALESCE(auth_version,0) + 1 WHERE id = $1', [u.id]);
    const r = await call('POST', '/api/v1/auth/totp-login', null, { tempToken: t4, token: codeFor(secret) });
    check('[4] stale tempToken (auth_version bumped) -> /totp-login 401', r.status === 401, { status: r.status });
  }

  await db.end();
  console.log(`\nR37 (3) TOTP: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
