/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - MEMBER EXIT &
 * SETTLEMENT (increment 10, suite 54)
 *
 * An ACTIVE member (never the OWNER) settles book value atomically
 * and exits: savings creditWallet (DR SACCOS<id>_SAVINGS_LIABILITY /
 * CR wallet, SXC-*-:SAV), share redemption (DR SACCOS<id>_SHARES_CAPITAL
 * / CR wallet at holdings book value, SXC-*-:SHR, holdings zeroed),
 * and payout of PENDING dividends on DECLARED runs (on each DIVP-*
 * reference, marked PAID so a later board distribution pays only
 * remaining members). One settlement per member; membership -> EXITED.
 * Self-only, RBAC 403 for non-members, cross-entity 404, ADMIN oversight.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++; failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label); else fail(label, extra);
}
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method, headers,
    body: !isGet && body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}
async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id };
  }

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (110_saccos_exits)');
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_member_exits'`);
  await expect(['savings_settled', 'share_count_settled', 'share_redemption_amount', 'dividend_settled', 'total_settlement', 'settled_by'].every((c) => cols.rows.some((r) => r.column_name === c)),
    'saccos_member_exits columns present');

  // ---------- 2. Setup: shares + savings + declared dividend ----------
  await section('Setup: shares + savings + declared dividend');
  const ownerReg = await register(phone(7700), 'Mkuu Wa Kila Mtu');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Kuondoka Yetu ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const m1 = await member(7701, 'Natoka 1');
  const m2 = await member(7702, 'Nakaa 2');

  await fundWallet(m1.userId, 120000);
  await fundWallet(m2.userId, 500000);
  const s1 = await api('POST', `/api/saccos/${orgId}/shares/purchase`, m1.tok, { shares: 2 });
  const s2 = await api('POST', `/api/saccos/${orgId}/shares/purchase`, m2.tok, { shares: 1 });
  await expect(s1.status === 201 && s2.status === 201, 'm1 buys 2 shares, m2 buys 1 (20000/10000)');
  const dep = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 50000 });
  await expect(dep.status === 201, 'm1 deposits 50000 savings');

  const period = await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Mwaka' });
  const periodId = period.data.result.id;
  await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'INCOME', amount: 400000, description: 'Faida ya mwaka' });
  const close = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodId}/close`, ownerTok);
  await expect(close.status === 200 && close.data.result.status === 'CLOSED', 'closed period');
  const decl = await api('POST', `/api/saccos/${orgId}/dividends`, ownerTok, { periodId, totalAmount: 30000, title: 'Mgawanyo kabla ya kuondoka' });
  await expect(decl.status === 201 && decl.data.result.eligible_share_count === 3 && decl.data.result.per_share === 10000,
    'declare dividend 30000 -> per-share 10000 across 3 shares');
  const runId = decl.data.result.id;
  const payouts = await api('GET', `/api/saccos/${orgId}/dividends/runs/${runId}/payouts`, ownerTok);
  await expect(payouts.data.result.length === 2 && payouts.data.result.every((p) => p.status === 'PENDING'),
    '2 PENDING dividend payouts (m1 20000, m2 10000)');

  // ---------- 3. Settlement ----------
  await section('Settlement (atomic savings + shares + dividend -> EXITED)');
  const ownerSettle = await api('POST', `/api/saccos/${orgId}/exits/settle`, ownerTok);
  await expect(ownerSettle.status === 403 && ownerSettle.data.code === 'SACCOS_RBAC', 'OWNER cannot settle -> 403');

  const settle = await api('POST', `/api/saccos/${orgId}/exits/settle`, m1.tok);
  await expect(settle.status === 201 && String(settle.data.result.reference_id).startsWith('SXC-')
    && settle.data.result.savings_settled === 50000 && settle.data.result.share_redemption_amount === 20000
    && settle.data.result.dividend_settled === 20000 && settle.data.result.total_settlement === 90000
    && settle.data.result.exited === true,
    'm1 settles 90000 (savings 50000 + shares 20000 + dividend 20000) and exits',
    JSON.stringify(settle.data.result));

  const w1 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.userId]);
  await expect(Number(w1.rows[0].wallet_balance) === 140000, 'm1 wallet 140000 (120000-70000+90000)');

  const mem1 = await pool.query('SELECT status FROM saccos_members WHERE user_id = $1 AND saccos_id = $2', [m1.userId, orgId]);
  await expect(mem1.rows[0].status === 'EXITED', 'm1 membership EXITED');

  const holding1 = await pool.query('SELECT share_count, total_value FROM saccos_share_holdings WHERE saccos_id = $1 AND member_id = (SELECT id FROM saccos_members WHERE user_id = $2 LIMIT 1)', [orgId, m1.userId]);
  await expect(Number(holding1.rows[0].share_count) === 0 && Number(holding1.rows[0].total_value) === 0, 'm1 holdings zeroed');

  const reSettle = await api('POST', `/api/saccos/${orgId}/exits/settle`, m1.tok);
  await expect(reSettle.status === 400 && reSettle.data.code === 'SACCOS_MEMBER_STATUS_INVALID', 're-settle after EXIT -> 400');

  const savingsLedger = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CR' THEN amount ELSE -amount END), 0)::numeric AS bal
     FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id WHERE la.account_code = $1`,
    [`SACCOS${orgId}_SAVINGS_LIABILITY`]
  );
  await expect(Number(savingsLedger.rows[0].bal) === 0, 'savings liability net zero after m1 settlement (only dep + exit)');

  // ---------- 4. Post-settlement dividend distribution on remaining members ----------
  await section('Board distribution pays only remaining members');
  const dist = await api('POST', `/api/saccos/${orgId}/dividends/runs/${runId}/distribute`, ownerTok);
  await expect(dist.status === 200 && dist.data.result.summary.paid === 30000 && dist.data.result.summary.paid_count === 2
    && dist.data.result.summary.pending_count === 0 && dist.data.result.status === 'DISTRIBUTED',
    'distribution completes full 30000 (m1 already PAID via exit + m2 now), 0 pending, run DISTRIBUTED', JSON.stringify(dist.data.result.summary));

  const w1b = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.userId]);
  await expect(Number(w1b.rows[0].wallet_balance) === 140000, 'm1 wallet unchanged (no double dividend payment after exit)');

  const mine = await api('GET', `/api/saccos/${orgId}/exits/mine`, m1.tok);
  await expect(mine.status === 200 && mine.data.result.total_settlement === 90000, 'exited member reads own settlement record');

  // ---------- 5. Reads, isolation, ADMIN oversight, audit ----------
  await section('Reads, isolation, ADMIN oversight, audit');
  const exits = await api('GET', `/api/saccos/${orgId}/exits`, ownerTok);
  const exitsMember = await api('GET', `/api/saccos/${orgId}/exits`, m2.tok);
  await expect(exits.status === 200 && exits.data.result.length === 1 && exits.data.result[0].total_settlement === 90000, 'owner lists exits (1 row)');
  await expect(exitsMember.status === 200 && exitsMember.data.result.length === 1, 'active member lists exits');

  const o2 = await register(phone(7705), 'Kuondoka Pili');
  const o2Tok = o2.data.token;
  const org2 = await api('POST', '/api/v1/saccos', o2Tok, { name: 'Kuondoka Pili ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);
  const crossExits = await api('GET', `/api/saccos/${s2Id}/exits`, ownerTok);
  await expect(crossExits.status === 404, 'S1 owner reading S2 exits -> 404');
  const crossSettle = await api('POST', `/api/saccos/${s2Id}/exits/settle`, m2.tok);
  await expect(crossSettle.status === 404, 'S1 member settling on S2 -> 404');

  const adminTok = await makeAdmin(await register(phone(7706), 'Ododo Kuondoka'));
  const adminExits = await api('GET', `/api/saccos/${orgId}/exits`, adminTok);
  await expect(adminTok && adminExits.status === 200 && adminExits.data.result.length === 1, 'platform ADMIN lists exits');

  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action = 'SACCOS_EXIT_SETTLED'`);
  await expect(audit.rows.length >= 1, 'audit trail has exit settlement action');

  console.log(`\nSACCOS EXITS: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });