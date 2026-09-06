/* ============================================================
 * AFRIKOBA GLOBAL - DISPUTE LIFECYCLE REGRESSION
 * Full resolution workflow: open, ownership guard, duplicate
 * guard, reviewer queue (ADMIN/SUPPORT/COMPLIANCE), review ->
 * escalation -> typed decision (REFUND via ledger / REJECT),
 * notes timeline, stats, and 403 ownership checks.
 * ============================================================ */
const BASE = process.env.DISPUTES_TEST_BASE || 'http://127.0.0.1:3000';
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
  const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
  return refresh.data.token;
}
function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const agg = await register(`255730${suffix}`, 'Aggrieved Member');
  const other = await register(`255731${suffix}`, 'Other Member');
  const adm = await register(`255732${suffix}`, 'Dispute Admin');
  await expect(agg.data.token && other.data.token && adm.data.token, 'Users registered');
  const aggTok = agg.data.token;
  const aggId = agg.data.user.id;
  const otherTok = other.data.token;
  const admin = await makeAdmin(adm);
  await expect(!!admin, 'Admin promoted');

  // Create three real transactions (legacy table) to dispute.
  const insTx = (amt, tag) => pool.query(
    `INSERT INTO transactions (user_id, type, total_charged, wallet_amount, commission, status, reference_id, meta)
     VALUES ($1, 'TRANSFER', $2, $2, 0, 'SUCCESS', $3, $4::jsonb)
     RETURNING id`,
    [aggId, amt, `DPT:${tag}:${suffix}:${Date.now()}:${Math.random()}`, JSON.stringify({ feature: 'dispute_test' })]
  );
  const [ta, tb, tc] = await Promise.all([insTx(10000, 'A'), insTx(15000, 'B'), insTx(20000, 'C')]);
  const tx1 = ta.rows[0].id;
  const tx2 = tb.rows[0].id;
  const tx3 = tc.rows[0].id;
  await expect(!!tx1 && !!tx2 && !!tx3, 'Transactions created for disputes');

  // ---------- open + guards ----------
  await section('Open dispute & guards');
  let created = await api('POST', '/api/v1/disputes', aggTok, { transaction_id: tx1, reason: 'DUPLICATE', description: 'Billed twice', amount_disputed: 8000 });
  await expect(created.status === 201 && created.data.dispute.status === 'OPEN' && Number(created.data.dispute.amount_disputed) === 8000, 'Dispute opened', `status=${created.status}`);
  const d1 = created.data.dispute.id;

  let dup = await api('POST', '/api/v1/disputes', aggTok, { transaction_id: tx1, reason: 'WRONG_AMOUNT', description: 'dup' });
  await expect(dup.status === 409, 'Duplicate dispute blocked', `status=${dup.status}`);

  let badReason = await api('POST', '/api/v1/disputes', aggTok, { transaction_id: tx2, reason: 'NOPE', description: 'x' });
  await expect(badReason.status === 400, 'Invalid reason rejected', `status=${badReason.status}`);

  let missingTx = await api('POST', '/api/v1/disputes', aggTok, { transaction_id: 999999999, reason: 'OTHER', description: 'x' });
  await expect(missingTx.status === 404, 'Unknown transaction rejected', `status=${missingTx.status}`);

  let otherCreate = await api('POST', '/api/v1/disputes', otherTok, { transaction_id: tx1, reason: 'FRAUD', description: 'not yours' });
  await expect(otherCreate.status === 403, 'Cannot dispute someone elses transaction', `status=${otherCreate.status}`);

  // ---------- user visibility ----------
  await section('User my-disputes & ownership');
  let mine = await api('GET', '/api/v1/disputes', aggTok);
  await expect(mine.status === 200 && mine.data.disputes.some((d) => d.id === d1), 'My disputes listed', `status=${mine.status}`);

  let ownerDetail = await api('GET', `/api/v1/disputes/${d1}`, aggTok);
  await expect(ownerDetail.status === 200 && ownerDetail.data.dispute.id === d1, 'Owner can view detail', `status=${ownerDetail.status}`);

  let stolenDetail = await api('GET', `/api/v1/disputes/${d1}`, otherTok);
  await expect(stolenDetail.status === 403, 'Non-owner blocked from detail', `status=${stolenDetail.status}`);

  let userNote = await api('POST', `/api/v1/disputes/${d1}/notes`, aggTok, { note: 'Naomba msaada' });
  await expect(userNote.status === 200 && (userNote.data.dispute.notes || []).length >= 1, 'Owner note appended', `notes=${(userNote.data.dispute.notes || []).length}`);

  // ---------- reviewer access ----------
  await section('Reviewer access control');
  let anonQueue = await api('GET', '/api/v1/disputes/admin/all');
  await expect(anonQueue.status === 401, 'Anonymous blocked from queue', `status=${anonQueue.status}`);

  let memberQueue = await api('GET', '/api/v1/disputes/admin/all', aggTok);
  await expect(memberQueue.status === 403, 'MJUMBE blocked from queue', `status=${memberQueue.status}`);

  let adminQueue = await api('GET', '/api/v1/disputes/admin/all', admin);
  await expect(adminQueue.status === 200 && adminQueue.data.disputes.some((d) => d.id === d1 && d.user_name), 'Admin sees queue with join data', `status=${adminQueue.status}`);

  let stats = await api('GET', '/api/v1/disputes/admin/stats', admin);
  await expect(stats.status === 200 && stats.data.open >= 1, 'Stats include OPEN count', `open=${stats.data.open}`);

  // ---------- review workflow ----------
  await section('Review -> mediation escalation -> decision');
  let review = await api('POST', `/api/v1/disputes/admin/${d1}/review`, admin, { note: 'Nimechukua hili' });
  await expect(review.status === 200 && review.data.dispute.status === 'UNDER_REVIEW', 'Review started (UNDER_REVIEW)', `status=${review.status}`);

  let reReview = await api('POST', `/api/v1/disputes/admin/${d1}/review`, admin, {});
  await expect(reReview.status === 409, 'Non-OPEN dispute cannot be re-reviewed', `status=${reReview.status}`);

  let escalate = await api('POST', `/api/v1/disputes/admin/${d1}/escalate`, admin, { note: 'Escalated to mediation' });
  await expect(escalate.status === 200 && escalate.data.dispute.status === 'MEDIATION', 'Escalated to MEDIATION', `status=${escalate.status}`);

  let missing = await api('GET', `/api/v1/disputes/admin/999999999`, admin);
  await expect(missing.status === 404, 'Unknown dispute detail -> 404', `status=${missing.status}`);

  let badAction = await api('POST', `/api/v1/disputes/admin/${d1}/decision`, admin, { action: 'WHATEVER' });
  await expect(badAction.status === 400, 'Invalid decision action rejected', `status=${badAction.status}`);

  // ---------- REJECT path (B) ----------
  let created2 = await api('POST', '/api/v1/disputes', aggTok, { transaction_id: tx2, reason: 'WRONG_AMOUNT', description: 'Too high', amount_disputed: 15000 });
  const d2 = created2.data.dispute.id;
  await api('POST', `/api/v1/disputes/admin/${d2}/review`, admin, {});
  const balBefore = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [aggId])).rows[0].b);
  let reject = await api('POST', `/api/v1/disputes/admin/${d2}/decision`, admin, { action: 'REJECT', note: 'Muamala sahihi' });
  await expect(reject.status === 200 && reject.data.dispute.status === 'REJECTED' && reject.data.dispute.resolution_type === 'REJECTED', 'Decision REJECT', `status=${reject.status}`);
  const balAfterReject = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [aggId])).rows[0].b);
  await expect(balAfterReject === balBefore, 'REJECT moved no money');

  // ---------- REFUND path (C) via ledger ----------
  await section('REFUND decision via ledger');
  const balPre = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [aggId])).rows[0].b);
  let created3 = await api('POST', '/api/v1/disputes', aggTok, { transaction_id: tx3, reason: 'NOT_RECEIVED', description: 'Never landed', amount_disputed: 8000 });
  const d3 = created3.data.dispute.id;
  await api('POST', `/api/v1/disputes/admin/${d3}/review`, admin, {});
  await api('POST', `/api/v1/disputes/admin/${d3}/escalate`, admin, { note: 'Mediation: confirm' });
  let refund = await api('POST', `/api/v1/disputes/admin/${d3}/decision`, admin, { action: 'REFUND', amount: 8000, note: 'Confirmed not received' });
  await expect(refund.status === 200 && refund.data.dispute.status === 'RESOLVED' && refund.data.dispute.resolution_type === 'REFUND' && Number(refund.data.dispute.resolved_amount) === 8000, 'Decision REFUND', `status=${refund.status}`);
  const balPost = Number((await pool.query('SELECT wallet_balance::numeric AS b FROM users WHERE id = $1', [aggId])).rows[0].b);
  await expect(balPost - balPre === 8000, `Wallet credited exactly 8000 (delta=${balPost - balPre})`);
  const refundTx = await pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1 AND meta->>'feature' = 'dispute_refund'`, [aggId]);
  await expect(refundTx.rows[0].n >= 1, 'DISPUTE_REFUND transaction recorded', `n=${refundTx.rows[0].n}`);

  let reDecide = await api('POST', `/api/v1/disputes/admin/${d3}/decision`, admin, { action: 'REFUND' });
  await expect(reDecide.status === 409, 'Resolved dispute cannot be re-decided', `status=${reDecide.status}`);

  // ---------- audit ----------
  const audit = await pool.query("SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_type = 'DISPUTE' AND entity_id = $1", [d1]);
  await expect(audit.rows[0].n >= 2, 'Dispute actions audited', `n=${audit.rows[0].n}`);

  console.log(`\n===== DISPUTES: ${passed} passed, ${failed} failed =====`);
  if (failed > 0) {
    console.log('FAILURES:', failures.join(' | '));
    process.exit(1);
  }
  await pool.end();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});