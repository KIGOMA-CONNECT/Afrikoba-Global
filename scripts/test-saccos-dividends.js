/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - DIVIDENDS
 * Increment 8 regression: surplus distribution on the economic
 * loop. Board declares a dividend run (DIV-*) against a CLOSED
 * accounting period (usable once); eligible = ACTIVE members'
 * share holdings. Distribution pays share_count * per_share to
 * each holder's CUSTOMER_WALLET via entity EXPENSE journal
 * (DR SACCOS<id>_DIVIDEND_DISTRIBUTED / CR CUSTOMER_WALLET,
 * idempotent on DIVP-*). Runs distribute once; re-running only
 * pays PENDING rows. Members read own payouts; cross-entity 404,
 * member RBAC 403, ADMIN oversight, audit trail. Suite 52.
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

  async function addMember(ownerTok, orgId, pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return reg;
  }

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (108_saccos_dividends)');
  const runCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_dividend_runs'`);
  await expect(['reference_id', 'period_id', 'per_share', 'total_amount', 'eligible_share_count', 'status'].every((c) => runCols.rows.some((r) => r.column_name === c)),
    'saccos_dividend_runs columns present');
  const payCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_dividend_payouts'`);
  await expect(['reference_id', 'share_count', 'amount', 'status', 'paid_at'].every((c) => payCols.rows.some((r) => r.column_name === c)),
    'saccos_dividend_payouts columns present');

  // ---------- 2. Setup: shares + closed surplus period ----------
  await section('Setup: shares + closed surplus period');
  const ownerReg = await register(phone(8001), 'Mgawanyaji Mkuu');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Mgawanyo Shahada ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const m1 = await addMember(ownerTok, orgId, 8002, 'Mwenye Hisa 1');
  const m2 = await addMember(ownerTok, orgId, 8003, 'Mwenye Hisa 2');

  for (const reg of [m1, m2]) {
    await fundWallet(reg.data.user.id, 500000);
    await api('POST', `/api/saccos/${orgId}/shares/purchase`, reg.data.token, { shares: 3 });
  }
  // owner also holds shares via a personal purchase for a 3rd holder pool
  await fundWallet(ownerReg.data.user.id, 500000);
  await api('POST', `/api/saccos/${orgId}/shares/purchase`, ownerTok, { shares: 4 });

  const holdings = await pool.query(
    `SELECT m.member_number, h.share_count FROM saccos_share_holdings h JOIN saccos_members m ON m.id = h.member_id WHERE h.saccos_id = $1 ORDER BY m.member_number`,
    [orgId]
  );
  const totalShares = holdings.rows.reduce((s, h) => s + h.share_count, 0);
  await expect(totalShares === 10, `10 eligible shares across 3 holders (3+3+4)`, JSON.stringify(holdings.rows));

  await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Msimu Wa Faida' });
  const periodIdOpen = (await api('GET', `/api/saccos/${orgId}/accounting/periods`, ownerTok)).data.result[0].id;
  await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'INCOME', amount: 600000, description: 'Faida ya mwaka' });
  const periodClose = await api('POST', `/api/saccos/${orgId}/accounting/periods/${periodIdOpen}/close`, ownerTok);
  await expect(periodClose.status === 200 && periodClose.data.result.status === 'CLOSED' && periodClose.data.result.snapshot.income_statement.net_income === 600000,
    'closed accounting period with net income 600000');

  // ---------- 3. Declaration ----------
  await section('Declaration');
  const memberDeclare = await api('POST', `/api/saccos/${orgId}/dividends`, m1.data.token, { periodId: periodIdOpen, totalAmount: 100000 });
  await expect(memberDeclare.status === 403 && memberDeclare.data.code === 'SACCOS_RBAC', 'member cannot declare -> 403');

  const declOpenPeriod = await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Wazi' });
  const openPeriodId = declOpenPeriod.data.result.id;
  const onOpen = await api('POST', `/api/saccos/${orgId}/dividends`, ownerTok, { periodId: openPeriodId, totalAmount: 100000 });
  await expect(onOpen.status === 400 && onOpen.data.code === 'SACCOS_DIV_PERIOD_CLOSED', 'declare on OPEN period -> SACCOS_DIV_PERIOD_CLOSED');
  await api('POST', `/api/saccos/${orgId}/accounting/periods/${openPeriodId}/close`, ownerTok);
  const waziDeclare = await api('POST', `/api/saccos/${orgId}/dividends`, ownerTok, { periodId: openPeriodId, totalAmount: 50000, title: 'Mgawanyo wa wazi' });
  await expect(waziDeclare.status === 201 && waziDeclare.data.result.status === 'DECLARED' && waziDeclare.data.result.per_share === 5000,
    'second run declared on closed Wazi period (kept DECLARED, per-share 5000)');

  const declare = await api('POST', `/api/saccos/${orgId}/dividends`, ownerTok, { periodId: periodIdOpen, totalAmount: 100000, title: 'Mgawanyo wa kwanza' });
  await expect(declare.status === 201 && String(declare.data.result.reference_id).startsWith('DIV-') && declare.data.result.status === 'DECLARED'
    && declare.data.result.eligible_share_count === 10 && declare.data.result.total_amount === 100000 && declare.data.result.per_share === 10000,
    'declare -> DIV-* DECLARED, per-share 10000 (100000/10)', JSON.stringify({ ps: declare.data.result.per_share, total: declare.data.result.total_amount }));
  const runId = declare.data.result.id;

  const reDeclare = await api('POST', `/api/saccos/${orgId}/dividends`, ownerTok, { periodId: periodIdOpen, totalAmount: 50000 });
  await expect(reDeclare.status === 400 && reDeclare.data.code === 'SACCOS_DIV_PERIOD_USED', 'period reused -> SACCOS_DIV_PERIOD_USED');

  const payoutsList = await api('GET', `/api/saccos/${orgId}/dividends/runs/${runId}/payouts`, ownerTok);
  await expect(payoutsList.status === 200 && payoutsList.data.result.length === 3
    && payoutsList.data.result.every((p) => p.status === 'PENDING' && p.share_count * 10000 === p.amount),
    'run lists 3 PENDING payouts, each share_count x 10000');

  // ---------- 4. Distribution ----------
  await section('Distribution');
  const memberDist = await api('POST', `/api/saccos/${orgId}/dividends/runs/${runId}/distribute`, m1.data.token);
  await expect(memberDist.status === 403 && memberDist.data.code === 'SACCOS_RBAC', 'member cannot distribute -> 403');

  const dist = await api('POST', `/api/saccos/${orgId}/dividends/runs/${runId}/distribute`, ownerTok);
  await expect(dist.status === 200 && dist.data.result.summary.paid === 100000 && dist.data.result.summary.paid_count === 3
    && dist.data.result.summary.pending_count === 0 && dist.data.result.status === 'DISTRIBUTED',
    'distribute -> 3 PAID, total 100000, run DISTRIBUTED', JSON.stringify(dist.data.result.summary));

  const w1 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m1.data.user.id]);
  const w2 = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [m2.data.user.id]);
  const wO = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [ownerReg.data.user.id]);
  await expect(Number(w1.rows[0].wallet_balance) === 500000 && Number(w2.rows[0].wallet_balance) === 500000 && Number(wO.rows[0].wallet_balance) === 500000,
    'wallets returned to 500000 (purchase 30000/30000/40000 refunded by 30000/30000/40000 dividends)',
    JSON.stringify({ m1: w1.rows[0].wallet_balance, m2: w2.rows[0].wallet_balance, owner: wO.rows[0].wallet_balance }));

  const distAgain = await api('POST', `/api/saccos/${orgId}/dividends/runs/${runId}/distribute`, ownerTok);
  await expect(distAgain.status === 200 && distAgain.data.result.summary.paid === 100000 && distAgain.data.result.summary.paid_count === 3,
    're-distribute -> no double payment (all payouts already PAID)');

  const ledger = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'DR'), 0)::numeric AS dr
    FROM journal_entries je JOIN ledger_accounts la ON la.id = je.account_id
    WHERE la.account_code = $1`, [`SACCOS${orgId}_DIVIDEND_DISTRIBUTED`]);
  await expect(Number(ledger.rows[0].dr) === 100000, 'entity DIVIDEND_DISTRIBUTED expense journal = 100000');

  // ---------- 5. Member visibility + isolation + oversight ----------
  await section('Member visibility + isolation + oversight');
  const mine1 = await api('GET', `/api/saccos/${orgId}/dividends/mine`, m1.data.token);
  const mineO = await api('GET', `/api/saccos/${orgId}/dividends/mine`, ownerTok);
  await expect(mine1.status === 200 && mine1.data.result.length === 2
    && mine1.data.result.some((p) => p.amount === 30000 && p.status === 'PAID')
    && mineO.data.result.some((p) => p.amount === 40000),
    "members see own PAID payout (30000/40000 pro-rata) among their payouts");

  const memberRuns = await api('GET', `/api/saccos/${orgId}/dividends`, m2.data.token);
  await expect(memberRuns.status === 200 && memberRuns.data.result.length === 2, 'member lists all runs');

  const o2 = await register(phone(8004), 'Pili Mgawanyaji');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, { name: 'Mgawanyo Pili ' + suffix });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);

  const crossMine = await api('GET', `/api/saccos/${s2Id}/dividends/mine`, m1.data.token);
  await expect(crossMine.status === 404, 'S1 member cannot read S2 dividends -> 404');
  const crossDeclare = await api('POST', `/api/saccos/${s2Id}/dividends`, ownerTok, { periodId: periodIdOpen, totalAmount: 1000 });
  await expect(crossDeclare.status === 403 && crossDeclare.data.code === 'SACCOS_NOT_MEMBER', 'S1 owner cannot declare on S2 -> 403 SACCOS_NOT_MEMBER');

  const adminTok = await makeAdmin(await register(phone(8005), 'Ododo Mgawanyaji'));
  const adminRuns = await api('GET', `/api/saccos/${orgId}/dividends`, adminTok);
  const adminSummary = await api('GET', `/api/saccos/${orgId}/dividends/summary`, adminTok);
  await expect(adminTok && adminRuns.status === 200 && adminRuns.data.result.length >= 2, 'platform ADMIN lists all runs');
  await expect(adminSummary.status === 200 && adminSummary.data.result.distributed === 1 && adminSummary.data.result.declared === 1
    && adminSummary.data.result.distributed_total === 100000 && adminSummary.data.result.paid_payouts === 3,
    'platform ADMIN reads dividend summary');

  const audit = await pool.query(`SELECT action FROM audit_logs WHERE action LIKE 'SACCOS_DIV%'`);
  await expect(audit.rows.length >= 3, 'audit trail has dividend actions (declared x2 + distributed)');

  console.log(`\nSACCOS DIVIDENDS: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });