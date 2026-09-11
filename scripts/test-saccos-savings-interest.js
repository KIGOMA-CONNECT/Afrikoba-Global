/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - SAVINGS INTEREST
 * ACCRUAL & POSTING (increment 15, suite 59)
 *
 * Periodic interest on member savings (migration 115), one cycle
 * per calendar month, funded from income into member accounts:
 * - prepareCycle (OWNER/BOARD) snapshots ACTIVE members with a
 *   positive savings balance at the annual config rate
 *   `savings.interestRatePercent` (monthly = balance * rate/100/12,
 *   rounded to 2dp) into PENDING awards on a period-unique cycle;
 *   re-preparing the month recomputes (no duplicates).
 * - postCycle (OWNER/BOARD) posts a balanced journal DR
 *   `SACCOS<id>_SAVINGS_INTEREST_EXPENSE` (EXPENSE) / CR
 *   `SACCOS<id>_SAVINGS_LIABILITY` (LIABILITY) totalling awards,
 *   credits each member account + 'INTEREST' APPROVED movement,
 *   marks awards POSTED (txn_reference) and the cycle POSTED.
 * - Members read their own interest history; lineage reconciles
 *   exactly (total_interest = SUM of rounded awards).
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
async function makeAdmin(reg) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }
async function fundWallet(userId, amount) {
  await pool.query('UPDATE users SET wallet_balance = $2 WHERE id = $1', [userId, amount]);
}

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (115_saccos_savings_interest)');
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name IN ('saccos_savings_interest_cycles', 'saccos_savings_interest_awards')`
  );
  await expect(new Set(tables.rows.map((r) => r.table_name)).size === 2, '2 savings-interest tables exist');
  const uq = await pool.query(
    `SELECT contype FROM pg_constraint WHERE conname = 'saccos_savings_interest_awards_cycle_id_member_id_key'`
  );
  await expect(uq.rows.length === 1, 'awards UNIQUE(cycle_id, member_id) exists');

  // ---------- 2. Setup ----------
  await section('Setup: SACCOS + members + deposits');
  const ownerReg = await register(phone(7701), 'Riba Mwenyekiti');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Riba Yetu ' + suffix });
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
  const m1 = await member(7702, 'Riba 1');
  const m2 = await member(7703, 'Riba 2');
  const m3 = await member(7704, 'Riba 3');
  await fundWallet(m1.userId, 500000);
  await fundWallet(m2.userId, 500000);
  const d1 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m1.tok, { amount: 50000 });
  const d2 = await api('POST', `/api/saccos/${orgId}/savings/deposit`, m2.tok, { amount: 30000 });
  await expect(d1.data.success === true, 'm1 deposits 50000', JSON.stringify(d1.data));
  await expect(d2.data.success === true, 'm2 deposits 30000', JSON.stringify(d2.data));

  // ---------- 3. Rate guard + RBAC ----------
  await section('Rate config + RBAC guards');
  const noRate = await api('POST', `/api/saccos/${orgId}/savings-interest/prepare`, ownerTok);
  await expect(noRate.status === 400 && noRate.data.code === 'SACCOS_SAVINGS_INTEREST_RATE', 'prepare without rate -> 400 RATE');
  const memPrep = await api('POST', `/api/saccos/${orgId}/savings-interest/prepare`, m1.tok);
  await expect(memPrep.status === 403 && memPrep.data.code === 'SACCOS_RBAC', 'member prepare -> 403 RBAC');

  // ---------- 4. Prepare cycle ----------
  await section('Prepare: snapshot awards at 6% annual');
  await pool.query(
    `UPDATE saccos SET config = COALESCE(config, '{}') || '{"savings":{"interestRatePercent":6}}'::jsonb WHERE id = $1`,
    [orgId]
  );
  const prep = await api('POST', `/api/saccos/${orgId}/savings-interest/prepare`, ownerTok);
  const cyc = prep.data.result.cycle;
  await expect(prep.status === 200 && cyc.status === 'PENDING' && Number(cyc.rate_percent) === 6
    && prep.data.result.awards === 2 && prep.data.result.total_interest === 400,
    'cycle PENDING @6%, 2 awards, total 400 (250 + 150)',
    JSON.stringify({ status: cyc.status, rate: cyc.rate_percent, awards: prep.data.result.awards, total: prep.data.result.total_interest }));
  const awards = await pool.query(
    `SELECT m.member_number, ia.basis_balance, ia.interest FROM saccos_savings_interest_awards ia
     JOIN saccos_members m ON m.id = ia.member_id WHERE ia.cycle_id = $1 ORDER BY ia.basis_balance DESC`,
    [cyc.id]
  );
  const [a1, a2] = awards.rows;
  await expect(Number(a1.basis_balance) === 50000 && Number(a1.interest) === 250 && Number(a2.basis_balance) === 30000 && Number(a2.interest) === 150,
    'award basis + interest: 50000->250, 30000->150 (m3 no account excluded)', JSON.stringify(awards.rows));

  const prep2 = await api('POST', `/api/saccos/${orgId}/savings-interest/prepare`, ownerTok);
  await expect(prep2.status === 200 && prep2.data.result.awards === 2 && prep2.data.result.total_interest === 400,
    're-prepare recomputes same month (idempotent, same awards)');
  const count = await pool.query(`SELECT COUNT(*)::int AS c FROM saccos_savings_interest_awards WHERE cycle_id = $1`, [cyc.id]);
  await expect(count.rows[0].c === 2, 'no duplicate awards after re-prepare');

  // ---------- 5. Post: journal + member credits ----------
  await section('Post: expense/liability journal + member credits');
  const memPost = await api('POST', `/api/saccos/${orgId}/savings-interest/cycles/${cyc.id}/post`, m1.tok);
  await expect(memPost.status === 403 && memPost.data.code === 'SACCOS_RBAC', 'member post -> 403 RBAC');
  const post = await api('POST', `/api/saccos/${orgId}/savings-interest/cycles/${cyc.id}/post`, ownerTok);
  await expect(post.status === 200 && post.data.result.awards === 2 && post.data.result.total_interest === 400
    && typeof post.data.result.reference === 'string' && post.data.result.reference.startsWith('SVI-'),
    'cycle posted: 2 awards / 400 / SVI-* ref', JSON.stringify(post.data));

  const bal = await pool.query(
    `SELECT m.member_number, b.balance, u.full_name FROM saccos_savings_accounts b
     JOIN saccos_members m ON m.id = b.member_id JOIN users u ON u.id = m.user_id WHERE b.saccos_id = $1 ORDER BY b.id`,
    [orgId]
  );
  await expect(Number(bal.rows[0].balance) === 50250 && Number(bal.rows[1].balance) === 30150,
    'member balances credited: 50250 + 30150', JSON.stringify(bal.rows.map((r) => r.balance)));
  const movements = await pool.query(
    `SELECT type, amount, status FROM saccos_savings_movements WHERE saccos_id = $1 AND type = 'INTEREST' ORDER BY amount DESC`,
    [orgId]
  );
  await expect(movements.rows.length === 2 && movements.rows.every((r) => r.status === 'APPROVED')
    && Number(movements.rows[0].amount) === 250 && Number(movements.rows[1].amount) === 150,
    '2 APPROVED INTEREST movements (250 + 150)');

  const jr = await pool.query(
    `SELECT la.account_code, j.direction, j.amount
     FROM journal_entries j JOIN ledger_accounts la ON la.id = j.account_id
     WHERE j.reference_id = $1 ORDER BY la.account_code`,
    [post.data.result.reference]
  );
  const dr = jr.rows.filter((r) => r.direction === 'DR');
  const cr = jr.rows.filter((r) => r.direction === 'CR');
  await expect(jr.rows.length === 2 && dr.length === 1 && cr.length === 1
    && dr[0].account_code.endsWith('_SAVINGS_INTEREST_EXPENSE') && Number(dr[0].amount) === 400
    && cr[0].account_code.endsWith('_SAVINGS_LIABILITY') && Number(cr[0].amount) === 400,
    'journal balanced: DR SAVINGS_INTEREST_EXPENSE 400 / CR SAVINGS_LIABILITY 400',
    JSON.stringify(jr.rows));
  const fop = await pool.query(`SELECT 1 FROM financial_operations WHERE operation_type = 'SACCOS_SAVINGS_INTEREST' AND reference_id = $1`, [post.data.result.reference]);
  await expect(fop.rows.length === 1, 'SACCOS_SAVINGS_INTEREST operation claimed');

  // ---------- 6. Idempotency + state guards ----------
  await section('State guards + idempotency');
  const repost = await api('POST', `/api/saccos/${orgId}/savings-interest/cycles/${cyc.id}/post`, ownerTok);
  await expect(repost.status === 400 && repost.data.code === 'SACCOS_SAVINGS_INTEREST_STATE', 're-post POSTED cycle -> 400 STATE');
  const rePrep = await api('POST', `/api/saccos/${orgId}/savings-interest/prepare`, ownerTok);
  await expect(rePrep.status === 400 && rePrep.data.code === 'SACCOS_SAVINGS_INTEREST_CYCLE_EXISTS', 'prepare after POSTED -> 400 CYCLE_EXISTS');
  const badCycle = await api('GET', `/api/saccos/${orgId}/savings-interest/cycles/999999`, ownerTok);
  await expect(badCycle.status === 404 && badCycle.data.code === 'SACCOS_SAVINGS_INTEREST_CYCLE_NOT_FOUND', 'unknown cycle -> 404');

  // ---------- 7. Summary + list + detail ----------
  await section('Summary + cycle list/detail + member view');
  const summ = await api('GET', `/api/saccos/${orgId}/savings-interest/summary`, ownerTok);
  await expect(summ.status === 200 && summ.data.result.rate === 6 && summ.data.result.posted_cycles === 1
    && Number(summ.data.result.posted_this_year) === 400 && Number(summ.data.result.pending_total) === 0
    && summ.data.result.latest && summ.data.result.latest.status === 'POSTED',
    'summary: rate 6, 1 posted cycle, 400 this year, latest POSTED', JSON.stringify(summ.data.result));
  const cycles = await api('GET', `/api/saccos/${orgId}/savings-interest/cycles`, ownerTok);
  await expect(cycles.status === 200 && cycles.data.result.length === 1 && cycles.data.result[0].total_awards === 2
    && cycles.data.result[0].posted_awards === 2, 'cycle list: 1 cycle, 2/2 awards posted');
  const detail = await api('GET', `/api/saccos/${orgId}/savings-interest/cycles/${cyc.id}`, ownerTok);
  await expect(detail.status === 200 && detail.data.result.awards.length === 2
    && detail.data.result.awards.every((a) => a.full_name && a.member_number && a.status === 'POSTED'), 'cycle detail: 2-name posted roster');
  const mine = await api('GET', `/api/saccos/${orgId}/savings-interest/mine`, m1.tok);
  await expect(mine.status === 200 && mine.data.result.total_posted === 250 && mine.data.result.awards.length === 1
    && mine.data.result.awards[0].interest === 250, 'm1 sees own interest 250 (posted)');

  // ---------- 8. No-award cycle guard ----------
  await section('PENDING cycle with no eligible savers');
  const emptyCycle = await pool.query(
    `INSERT INTO saccos_savings_interest_cycles (saccos_id, period, rate_percent, created_by)
     VALUES ($1, (CURRENT_DATE + INTERVAL '1 month')::date, 6, $2) RETURNING id`,
    [orgId, ownerReg.data.user.id]
  );
  const postEmpty = await api('POST', `/api/saccos/${orgId}/savings-interest/cycles/${emptyCycle.rows[0].id}/post`, ownerTok);
  await expect(postEmpty.status === 400 && postEmpty.data.code === 'SACCOS_SAVINGS_INTEREST_NO_AWARDS', 'post cycle with no awards -> 400 NO_AWARDS');

  // ---------- 9. Isolation + platform admin ----------
  await section('Cross-entity isolation + platform ADMIN');
  const s2Owner = await register(phone(7705), 'Riba Pili Org');
  const s2Tok = s2Owner.data.token;
  const org2 = await api('POST', '/api/v1/saccos', s2Tok, { name: 'Riba Pili Org ' + suffix });
  const s2Id = org2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, s2Tok);
  const crossPrep = await api('POST', `/api/saccos/${orgId}/savings-interest/prepare`, s2Tok);
  await expect(crossPrep.status === 403 && crossPrep.data.code === 'SACCOS_NOT_MEMBER', 'S2 owner prepare S1 -> 403 NOT_MEMBER');
  const crossList = await api('GET', `/api/saccos/${orgId}/savings-interest/cycles`, s2Tok);
  await expect(crossList.status === 403 && crossList.data.code === 'SACCOS_NOT_MEMBER', 'S2 owner cycle list S1 -> 403 NOT_MEMBER');
  const crossMine = await api('GET', `/api/saccos/${s2Id}/savings-interest/mine`, ownerTok);
  await expect(crossMine.status === 404 && crossMine.data.code === 'SACCOS_NOT_FOUND', 'S1 owner mine on S2 -> 404 NOT_FOUND');
  const adminTok = await makeAdmin(await register(phone(7706), 'Ododo Riba'));
  const adminPost = await api('POST', `/api/saccos/${orgId}/savings-interest/cycles/${cyc.id}/post`, adminTok);
  await expect(adminTok && adminPost.status === 403 && adminPost.data.code === 'SACCOS_NOT_MEMBER', 'platform ADMIN no membership post -> 403 NOT_MEMBER');
  const audit = await pool.query(
    `SELECT DISTINCT action FROM audit_logs WHERE action IN ('SACCOS_SAVINGS_INTEREST_PREPARE', 'SACCOS_SAVINGS_INTEREST_POST')`
  );
  await expect(audit.rows.length === 2, 'PREPARE + POST audit actions recorded');

  console.log(`\nSACCOS SAVINGS INTEREST: ${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });