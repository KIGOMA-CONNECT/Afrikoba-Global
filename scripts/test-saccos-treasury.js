/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - TREASURY & LIQUIDITY
 * PANEL (increment 20, suite 63)
 *
 * migration 119 adds `saccos_treasury_snapshots` (TRS-*), a dated
 * immutable governing picture keyed (saccos_id, as_of).
 *
 * GET  /:id/treasury          live computation from the shared
 *                             double-entry ledger (per-entity
 *                             `SACCOS<id>_*` accounts):
 *   cash_and_liquid           operating cash + fund buckets +
 *                             welfare kitty
 *   credit                    gross loans receivable, LLR, net
 *   member_deposits           savings + investments + funds +
 *                             welfare (what the SACCOS lends against)
 *   ratios                    funding ratio (loans/deposits),
 *                             LLR coverage %, liquidity buffer %
 *   alerts                    threshold-based, from
 *                             `saccos.config.liquidity` (JSONB,
 *                             defaults: maxFundingRatio 1.0,
 *                             minBufferRatio 0.10,
 *                             minLlrCoveragePercent 5)
 * POST /:id/treasury/snapshot persist today's position (UPSERT by
 *                             (saccos_id, as_of)) + audit
 * GET  /:id/treasury/history  snapshot history
 *
 * Members are denied (SACCOS_RBAC), platform ADMIN may oversee,
 * non-members/cross-entity resolve to 404, unauthenticated 401.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0, failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) { failed++; failures.push(label); console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`); }
async function expect(cond, label, extra) { if (cond) ok(label); else fail(label, extra); }
async function section(label) { console.log('\n--- ' + label + ' ---'); }

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET';
  const res = await fetch(BASE + path, { method, headers, body: !isGet && body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch (e) { data = {}; }
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
function nowSuffix() { return String(Date.now()).slice(-6); }
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}
async function snapshotCount(orgId) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM saccos_treasury_snapshots WHERE saccos_id = $1', [orgId]);
  return r.rows[0].n;
}
async function auditCount(action) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = $1', [action]);
  return r.rows[0].n;
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (119_saccos_treasury)');
  const tbl = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'saccos_treasury_snapshots'`
  );
  await expect(tbl.rows.length === 1, 'saccos_treasury_snapshots table exists');
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_treasury_snapshots'
       AND column_name IN ('saccos_id', 'as_of', 'reference_id', 'snapshot', 'created_by')`
  );
  await expect(cols.rows.length === 5, 'snapshots carry saccos_id/as_of/reference_id/snapshot/created_by');
  const uq = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'saccos_treasury_snapshots_saccos_id_as_of_key'`
  );
  await expect(uq.rows.length === 1, 'UNIQUE(saccos_id, as_of) exists (same-day refresh)');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members + seeded ledger');
  const ownerReg = await register(phone(8001), 'Hazina Mwenyekiti');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Hazina Umoja ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);
  async function member(pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    const mid = inv.data.result.id;
    await api('POST', `/api/saccos/${orgId}/members/${mid}/accept`, reg.data.token);
    return { tok: reg.data.token, userId: reg.data.user.id, memberId: mid };
  }
  const m1 = await member(8002, 'Hazina Mwanachama 1');
  const m2 = await member(8003, 'Hazina Mwanachama 2');
  await fundWallet(m1.userId, 500000);
  await fundWallet(m2.userId, 500000);

  const d1 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 100000 });
  const d2 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m2.tok, { amount: 60000 });
  await expect(d1.data.success === true && d2.data.success === true, 'm1/m2 deposit (savings liability 160000)');

  await api('POST', `/api/saccos/${orgId}/accounting/periods`, ownerTok, { label: 'Treasury month' });
  const inc = await api('POST', `/api/saccos/${orgId}/accounting/entries`, ownerTok, { kind: 'INCOME', amount: 100000, description: 'Msaada kutoka kwa wawekezaji' });
  await expect(inc.data.success === true, 'owner books INCOME 100000 (operating cash 100000)', JSON.stringify(inc.data));

  const fund = await api('POST', `/api/saccos/${orgId}/funds`, ownerTok, { code: 'SAVINGS', name: 'Hifadhi', purpose: 'Emergency kitty', targetAmount: 100000, minimumBalance: 10000 });
  const fundId = fund.data.result.id;
  await api('POST', `/api/saccos/${orgId}/funds/${fundId}/contribute`, m1.tok, { amount: 40000 });
  await api('POST', `/api/saccos/${orgId}/funds/${fundId}/contribute`, m2.tok, { amount: 10000 });

  const wf = await api('POST', `/api/saccos/${orgId}/welfare/schemes`, ownerTok, { name: 'Ustawi', contribution: 25000, payout: 50000 });
  const schemeId = wf.data.result.id;
  const low = await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m1.tok, { schemeId, amount: 20000 });
  await expect(low.status === 400 && low.data.code === 'SACCOS_WELFARE_CONTRIBUTION_LOW', 'welfare guards contribution below scheme minimum');
  await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m1.tok, { schemeId, amount: 25000 });
  await api('POST', `/api/saccos/${orgId}/welfare/contributions`, m2.tok, { schemeId, amount: 25000 });

  // ---------- 3. RBAC + live position ----------
  await section('RBAC + live treasury position');
  const mb = await api('GET', `/api/saccos/${orgId}/treasury`, m1.tok);
  await expect(mb.status === 403, 'member GET treasury -> 403 RBAC');

  const t0 = await api('GET', `/api/saccos/${orgId}/treasury`, ownerTok);
  await expect(t0.status === 200 && !!t0.data.result, 'owner GET treasury -> 200');
  const r0 = t0.data.result;
  await expect(r0.cash_and_liquid.operating_cash === 100000 && r0.cash_and_liquid.funds === 50000
    && r0.cash_and_liquid.welfare_fund === 50000 && r0.cash_and_liquid.total === 200000,
    'cash_and_liquid = operating 100000 + funds 50000 + welfare 50000 (200000)');
  await expect(r0.member_deposits.savings_liability === 160000 && r0.member_deposits.funds === 50000
    && r0.member_deposits.welfare_fund === 50000 && r0.member_deposits.total === 260000,
    'member_deposits = savings 160000 + funds 50000 + welfare 50000 (260000)');
  await expect(r0.credit.gross_loans_receivable === 0 && r0.credit.loan_loss_reserves === 0 && r0.credit.net_loans_receivable === 0,
    'credit empty before lending');
  await expect(r0.ratios.buffer_percent === 76.92 && r0.ratios.funding_ratio === 0 && r0.ratios.llr_coverage_percent === null,
    'ratios: buffer 76.92%, funding 0 (no loans), LLR null');
  await expect(Array.isArray(r0.alerts) && r0.alerts.length === 0, 'no alerts in healthy state');

  const na = await api('GET', `/api/saccos/${orgId}/treasury`, null);
  await expect(na.status === 401, 'unauthenticated GET -> 401');

  const adminReg = await register(phone(8009), 'Hazina Msimamizi');
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [adminReg.data.user.id, 'ADMIN']);
  const adm = await api('GET', `/api/saccos/${orgId}/treasury`, adminReg.data.token);
  await expect(adm.status === 200, 'platform ADMIN oversight -> 200');

  const owner2Reg = await register(phone(8010), 'Hazina Mwingine');
  const create2 = await api('POST', '/api/v1/saccos', owner2Reg.data.token, { name: 'SACCOS Panda ' + suffix });
  const org2 = create2.data.result.saccos.id;
  await api('POST', `/api/saccos/${org2}/activate`, owner2Reg.data.token);
  const cross = await api('GET', `/api/saccos/${org2}/treasury`, m1.tok);
  await expect(cross.status === 404, 'cross-entity member -> 404');

  // ---------- 4. Lending + LLR flow ----------
  await section('Lending: funding ratio + LLR coverage');
  const l1 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m1.tok, { amount: 100000, termMonths: 6, purpose: 'Biashara' });
  const app1 = l1.data.result.id;
  await api('POST', `/api/saccos/${orgId}/loans/applications/${app1}/approve`, ownerTok);

  const t1 = await api('GET', `/api/saccos/${orgId}/treasury`, ownerTok);
  const r1 = t1.data.result;
  await expect(r1.credit.gross_loans_receivable === 100000 && r1.credit.net_loans_receivable === 100000 && r1.credit.loan_loss_reserves === 0,
    'gross loans 100000, reserves 0 after loan1');
  await expect(r1.ratios.funding_ratio === 0.385 && r1.ratios.llr_coverage_percent === 0,
    'funding ratio 0.385, LLR coverage 0%');
  await expect(r1.alerts.some((a) => a.code === 'LIQUIDITY_LLR_LOW' && a.severity === 'WARNING'),
    'LLR_LOW warning fires on un-provisioned loan');

  await api('POST', `/api/saccos/${orgId}/loan-loss/provision`, ownerTok, { loanId: (await pool.query('SELECT id FROM saccos_loans WHERE saccos_id = $1 LIMIT 1', [orgId])).rows[0].id, amount: 5000 });
  const t2 = await api('GET', `/api/saccos/${orgId}/treasury`, ownerTok);
  const r2 = t2.data.result;
  await expect(r2.credit.loan_loss_reserves === 5000 && r2.credit.net_loans_receivable === 95000
    && r2.ratios.llr_coverage_percent === 5,
    'LLR 5000 -> net 95000, coverage 5%');
  await expect(!r2.alerts.some((a) => a.code === 'LIQUIDITY_LLR_LOW'), 'LLR_LOW clears at 5% target');

  const l2 = await api('POST', `/api/saccos/${orgId}/loans/apply`, m2.tok, { amount: 200000, termMonths: 12, purpose: 'Nyumba' });
  const app2 = l2.data.result.id;
  await api('POST', `/api/saccos/${orgId}/loans/applications/${app2}/approve`, ownerTok);

  const t3 = await api('GET', `/api/saccos/${orgId}/treasury`, ownerTok);
  const r3 = t3.data.result;
  await expect(r3.credit.gross_loans_receivable === 300000, 'gross loans 300000 after loan2');
  await expect(r3.ratios.funding_ratio === 1.154, 'funding ratio 1.154 (>1, loan book > deposits)');
  await expect(r3.ratios.llr_coverage_percent === 1.67, 'LLR coverage diluted to 1.67%');
  await expect(r3.alerts.some((a) => a.code === 'LIQUIDITY_FUNDING_RATIO_HIGH' && a.severity === 'CRITICAL')
    && r3.alerts.some((a) => a.code === 'LIQUIDITY_LLR_LOW'),
    'CRITICAL funding alert + LLR warning fire');

  // ---------- 5. Snapshot + history ----------
  await section('Snapshot & history');
  const sn = await api('POST', `/api/saccos/${orgId}/treasury/snapshot`, ownerTok);
  await expect(sn.status === 201 && /^TRS-/.test(sn.data.result.reference_id), 'owner snapshots treasury (TRS-*)');
  await expect(sn.data.result.snapshot.credit.gross_loans_receivable === 300000
    && sn.data.result.snapshot.ratios.funding_ratio === 1.154,
    'snapshot preserves computed position');
  await expect(await snapshotCount(orgId) === 1, 'snapshot persisted keyed (saccos_id, as_of)');
  const sn2 = await api('POST', `/api/saccos/${orgId}/treasury/snapshot`, ownerTok);
  await expect(sn2.status === 201 && (await snapshotCount(orgId)) === 1, 're-snapshot same day refreshes (count stays 1)');
  const memSnap = await api('POST', `/api/saccos/${orgId}/treasury/snapshot`, m1.tok);
  await expect(memSnap.status === 403, 'member snapshot -> 403');
  const hist = await api('GET', `/api/saccos/${orgId}/treasury/history`, ownerTok);
  await expect(hist.status === 200 && hist.data.result.length === 1 && hist.data.result[0].as_of === sn.data.result.snapshot.as_of,
    'history lists the snapshot');
  await expect((await auditCount('SACCOS_TREASURY_SNAPSHOT')) >= 1, 'SACCOS_TREASURY_SNAPSHOT audit recorded');

  // ---------- 6. Config thresholds ----------
  await section('Thresholds from saccos.config.liquidity');
  await pool.query(
    `UPDATE saccos SET config = COALESCE(config, '{}') || '{"liquidity":{"minBufferRatio":0.9}}'::jsonb WHERE id = $1`,
    [orgId]
  );
  const t4 = await api('GET', `/api/saccos/${orgId}/treasury`, ownerTok);
  const r4 = t4.data.result;
  await expect(r4.config.min_buffer_ratio === 0.9 && r4.alerts.some((a) => a.code === 'LIQUIDITY_BUFFER_LOW' && a.severity === 'WARNING'),
    'minBufferRatio 0.9 -> LIQUIDITY_BUFFER_LOW warning (76.92% < 90%)');

  console.log(`\nSACCOS TREASURY: ${passed} passed, ${failed} failed`);
  await pool.end();
  if (failed) { console.log('Failures:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('Suite crashed:', e); process.exit(1); });