'use strict';
/* R38 (10): in production (NODE_ENV=production) the app must refuse to start when JWT_SECRET is missing,
 * shorter than 32 characters (after trimming), or equal to a default value written in the code or in
 * the shipped templates. The startup gate is config.validateConfig() (src/server.js calls it before
 * listening). Each case runs in a fresh child process from an empty directory (no .env is read), with
 * every other production requirement satisfied, so a refusal can only come from the JWT rule.
 * No secret value is ever printed: labels name the case or the file:line it came from.
 * No database is used. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-10-'));
let passed = 0; let failed = 0;
const check = (l, c, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? ` — ${JSON.stringify(d)}` : ''}`); } };

const PROD_OK = {
  NODE_ENV: 'production', PILOT_MODE: 'true',
  DB_PASSWORD: crypto.randomBytes(18).toString('hex'), WEBHOOK_SECRET: crypto.randomBytes(18).toString('hex'),
  BEEM_API_KEY: 'k', BEEM_SECRET_KEY: 's', CORS_ORIGINS: 'https://pilot.example.test', CONTRACT_BASE_URL: 'https://pilot.example.test/contracts',
  AZAMPAY_ENABLED: 'false',
};
const CHILD = `
  const cfg = require(${JSON.stringify(path.join(ROOT, 'src/config/index.js'))});
  try { cfg.validateConfig(); process.stdout.write(JSON.stringify({ started: true })); }
  catch (e) { process.stdout.write(JSON.stringify({ started: false, jwt: /JWT_SECRET/.test(e.message), other: e.message.split('\\n').filter((l) => l.startsWith('- ') && !/JWT_SECRET/.test(l)).length })); }`;

function boot(extraEnv, unsetJwt) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...PROD_OK, ...extraEnv };
  if (unsetJwt) delete env.JWT_SECRET;
  const r = spawnSync(process.execPath, ['-e', CHILD], { cwd: EMPTY, env, encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch (e) { return { crashed: true, status: r.status, stderrLines: (r.stderr || '').split('\n').length }; }
}
const refusedForJwt = (r) => r && r.started === false && r.jwt === true;

// Defaults written in the code / templates (values read here, never printed).
const DEFAULT_JWT = require(path.join(ROOT, 'src/config/index.js')).DEFAULT_JWT;
const literals = [];
// Files to scan: git-tracked files when .git exists, otherwise a walk of the tree (regression copies have no .git).
function filesToScan() {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  } catch (e) {
    const out = [];
    (function walk(rel) {
      for (const d of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { if (!['node_modules', '.git'].includes(d.name)) walk(r); } else out.push(r);
      }
    })('');
    return out;
  }
}
const tracked = [];
for (const f of filesToScan()) {
  if (f.startsWith('tests/') || f.startsWith('node_modules/')) continue;
  let text; try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
  if (text.includes('\0')) continue; // binary
  text.split('\n').forEach((l, i) => { if (/(JWT_SECRET|jwtSecret|DEFAULT_JWT)\s*[:=]+/.test(l)) tracked.push(`${f}:${i + 1}:${l}`); });
}
for (const line of tracked) {
  const m = line.match(/^([^:]+):(\d+):(.*)$/); if (!m) continue;
  if (/\$\{JWT_SECRET[:?}-]/.test(m[3])) continue; // compose `${JWT_SECRET:?…}` requires the variable; not a default
  const v = (m[3].match(/(?:JWT_SECRET|jwtSecret|DEFAULT_JWT)\s*[:=]+\s*(['"`]?)([^'"`\s$,;{}()]+)\1/) || [])[2];
  if (!v || /^(process\.env|config\.|crypto|require|DEFAULT_JWT$|randomBytes)/.test(v)) continue;
  literals.push({ where: `${m[1]}:${m[2]}`, v });
}

console.log('\n[1] production refuses a weak or default JWT_SECRET');
{
  const ok = boot({ JWT_SECRET: crypto.randomBytes(32).toString('hex') });
  check('[1] control: 64-hex random JWT_SECRET -> app starts (every other production requirement is met)', ok.started === true, ok);
  check('[1] JWT_SECRET missing -> refused', refusedForJwt(boot({}, true)));
  check('[1] JWT_SECRET empty -> refused', refusedForJwt(boot({ JWT_SECRET: '' })));
  check('[1] JWT_SECRET = DEFAULT_JWT (src/config/index.js) -> refused', refusedForJwt(boot({ JWT_SECRET: DEFAULT_JWT })));
  check('[1] JWT_SECRET = DEFAULT_JWT padded with spaces -> refused', refusedForJwt(boot({ JWT_SECRET: `  ${DEFAULT_JWT}      ` })));
  check('[1] JWT_SECRET of 31 random characters -> refused (minimum 32)', refusedForJwt(boot({ JWT_SECRET: crypto.randomBytes(24).toString('base64').slice(0, 31) })));
  check('[1] JWT_SECRET of 40 spaces -> refused (length counted after trim)', refusedForJwt(boot({ JWT_SECRET: ' '.repeat(40) })));
  const exactly32 = crypto.randomBytes(24).toString('base64').slice(0, 32);
  check('[1] JWT_SECRET of exactly 32 random characters -> starts (boundary)', boot({ JWT_SECRET: exactly32 }).started === true);
  check('[1] at least one default literal found in tracked files (scan works)', literals.length >= 2, literals.map((l) => l.where));
  for (const { where, v } of literals) {
    check(`[1] JWT_SECRET = default literal from ${where} -> refused`, refusedForJwt(boot({ JWT_SECRET: v })));
  }
}

console.log('\n[1b] the refusal names the right reason (the defaults are also short, so length alone would hide a broken default check)');
{
  const { jwtSecretProblem, JWT_MIN_LENGTH } = require(path.join(ROOT, 'src/config/index.js'));
  check('[1b] JWT_MIN_LENGTH is 32', JWT_MIN_LENGTH === 32);
  for (const [label, v] of [['missing (undefined)', undefined], ['empty', ''], ['spaces only', '   ']]) {
    check(`[1b] ${label} -> reason "haipo"`, jwtSecretProblem(v) === 'haipo');
  }
  for (const { where, v } of [{ where: 'DEFAULT_JWT', v: DEFAULT_JWT }, ...literals]) {
    check(`[1b] default literal from ${where} -> reason "thamani ya akiba"`, /akiba/.test(jwtSecretProblem(v) || ''));
    check(`[1b] default literal from ${where} with surrounding spaces -> reason "thamani ya akiba"`, /akiba/.test(jwtSecretProblem(` ${v} `) || ''));
  }
  check('[1b] 31 random characters -> reason "fupi"', /fupi/.test(jwtSecretProblem(crypto.randomBytes(24).toString('base64').slice(0, 31)) || ''));
  check('[1b] 64-hex random -> no problem', jwtSecretProblem(crypto.randomBytes(32).toString('hex')) === null);
}

console.log('\n[2] outside production the rule does not apply (unchanged)');
{
  for (const env of ['test', 'development']) {
    const r = boot({ NODE_ENV: env, JWT_SECRET: DEFAULT_JWT });
    check(`[2] NODE_ENV=${env} with DEFAULT_JWT -> validateConfig passes (control)`, r.started === true, r);
  }
}

console.log('\n[3] the gate runs before the server listens');
{
  const src = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const v = src.indexOf('config.validateConfig();'); const l = src.indexOf('server.listen(');
  check('[3] src/server.js calls config.validateConfig() before server.listen', v > 0 && l > v);
}

fs.rmSync(EMPTY, { recursive: true, force: true });
console.log(`\nR38 (10) JWT secret: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
