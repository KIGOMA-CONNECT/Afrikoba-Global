/* ============================================================
 * AFRIKOBA GLOBAL - SOCIAL EVENTS STAGE 4 REGRESSION
 * Ripoti (JSON/CSV/PDF), Templates, Series, Public share/join,
 * Withdrawals (direct + four-eyes), Admin oversight.
 * ============================================================ */
const BASE = process.env.EVENTS_TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, extra) {
  failed++;
  failures.push(label);
  console.log(`  ✗ ${label}${extra ? ' :: ' + extra : ''}`);
}
async function expect(cond, label, extra) {
  if (cond) ok(label);
  else fail(label, extra);
}

async function section(label) {
  console.log('\n--- ' + label + ' ---');
}

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const isGet = method === 'GET' || method === 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: !isGet && body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

async function apiRaw(method, path, token, headersExt) {
  const headers = headersExt || {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct: res.headers.get('content-type') || '', text: buf.toString('utf8'), buf };
}

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}

async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}

async function login(phoneNumber) {
  const otp = await sendOtp(phoneNumber);
  const r = await api('POST', '/api/auth/login', null, { phoneNumber, otp });
  return r.data;
}

async function fundWallet(userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = 'TST-' + Math.random().toString(36).slice(2, 10).toUpperCase();
    const tx = await client.query(
      `INSERT INTO transactions (reference_id, user_id, wallet_amount, commission, total_charged, status, type, meta)
       VALUES ($1, $2, $3, 0, $3, 'SUCCESS', 'DEPOSIT', $4) RETURNING id`,
      [ref, userId, amount, JSON.stringify({ note: 'events-stage4-funding' })]
    );
    await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
    await client.query(
      'INSERT INTO wallet_ledger (transaction_id, reference_id, to_user_id, amount, description) VALUES ($1, $2, $3, $4, $5)',
      [tx.rows[0].id, ref, userId, amount, 'Test funding']
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function balanceOf(userId) {
  const r = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].wallet_balance);
}

function nowSuffix() { return String(Date.now()).slice(-6); }

function d10(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return String(value);
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

function addDaysUtc(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

(async () => {
  const suffix = nowSuffix();
  const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // kesho (UTC) — siku za baadaye
  const base = addDaysUtc(today, 45);

  const ownerPhone = `255730${suffix}`;
  const alicePhone = `255731${suffix}`;
  const bobPhone = `255732${suffix}`;
  const outsiderPhone = `255733${suffix}`;

  const owner = await register(ownerPhone, 'Events Owner');
  const ownerId = owner.data.user.id;
  const ownerToken = owner.data.token;
  const alice = await register(alicePhone, 'Alice Changia');
  const aliceId = alice.data.user.id;
  const aliceToken = alice.data.token;
  const bob = await register(bobPhone, 'Bob Jiunge');
  const bobId = bob.data.user.id;
  const bobToken = bob.data.token;
  const outsider = await register(outsiderPhone, 'Outsider');
  const outsiderToken = outsider.data.token;

  let eventId = null;

  const adminLogin = await login('255712000001');
  const adminToken = adminLogin.token;

  await fundWallet(aliceId, 4000000);
  await fundWallet(bobId, 4000000);

  const TARGET = 6000000;
  const eventName = `Harusi Stage4 ${suffix}`;

  // ------------------------------------------------------------
  await section('1. PUBLIC SHARE + JOIN-BY-LINK');
  // ------------------------------------------------------------
  {
    const noToken = await api('GET', '/api/events/public/wrongtoken', null, null);
    await expect(noToken.status === 404 && noToken.data.code === 'VALIDATION_ERROR', 'GET /events/public/wrongtoken -> 404 (bila auth, si 401)', JSON.stringify(noToken.data).slice(0, 120));

    const noAuthJoin = await api('POST', '/api/events/public/wrongtoken/join', null, {});
    await expect(noAuthJoin.status === 401, 'JOIN via public link bila auth -> 401', `${noAuthJoin.status}`);

    const created = await api('POST', '/api/events', ownerToken, {
      name: eventName, eventType: 'HARUSI', ownerType: 'INDIVIDUAL',
      targetAmount: TARGET, eventDate: base, contributionDeadline: addDaysUtc(base, 14),
      description: 'Kipimo cha Stage 4', rules: { perk: 'chai' },
    });
    await expect(created.status === 201 && created.data.event.id, 'Tukio linaundwa (201)', `${created.status}`);
    eventId = created.data.event.id;
    await expect(created.data.event.public_token == null, 'public_token haipo kabla ya share', `${created.data.event.public_token}`);

    const share = await api('GET', `/api/events/${eventId}/share`, ownerToken, null);
    const token = share.data.share && share.data.share.token;
    await expect(share.status === 200 && !!token && typeof token === 'string' && token.length >= 10, 'ensurePublicShare inatoa token', `${share.status}`);
    await expect(share.data.share.url.includes(`/p/${token}`) && share.data.share.whatsapp.startsWith('https://wa.me/'), 'share url + whatsapp link', `${share.data.share.url}`);

    const pub = await api('GET', `/api/events/public/${token}`, null, null);
    await expect(pub.status === 200 && pub.data.event.name === eventName && Number(pub.data.event.targetAmount) === TARGET, 'GET public (bila auth) -> 200 na maelezo', `${pub.status}`);

    const joinBob = await api('POST', `/api/events/public/${token}/join`, bobToken, {});
    await expect(joinBob.status === 200 && joinBob.data.event && joinBob.data.event.id === eventId, 'Bob anajiunga kupitia public link', `${joinBob.status}`);
    const joinBob2 = await api('POST', `/api/events/public/${token}/join`, bobToken, {});
    await expect(joinBob2.status === 200, 'Join ya pili idempotent (hakuna duplicate)', `${joinBob2.status}`);
  }

  // ------------------------------------------------------------
  await section('2. BUDGET + INVITE CODE + MEMBERS');
  // ------------------------------------------------------------
  {
    const budget = await api('POST', `/api/events/${eventId}/budget`, ownerToken, {
      category: 'Chakula', amount: 2000000, description: 'Miloya ya harusi',
    });
    await expect(budget.status === 201 && budget.data.item.id, 'Budget item inaongezwa (201)', `${budget.status}`);

    const invite = await api('POST', `/api/events/${eventId}/invites`, ownerToken, { maxUses: 5, expiresDays: 30 });
    const code = invite.data.invite && invite.data.invite.code;
    await expect(invite.status === 201 && !!code, 'Invite code inazalishwa (201)', `${invite.status}`);
    const inviteFromAlice = await api('POST', '/api/events/join', aliceToken, { code });
    await expect(inviteFromAlice.status === 200 && inviteFromAlice.data.success, 'Alice anajiunga kwa kodi ya mwaliko', `${inviteFromAlice.status}: ${inviteFromAlice.data.message || ''}`);

    const members = await api('GET', `/api/events/${eventId}/members`, ownerToken, null);
    const active = (members.data.members || []).filter((m) => m.status === 'ACTIVE');
    await expect(members.status === 200 && active.length >= 3, 'Wanachama walio aktifu >= 3 (owner+alice+bob)', `${members.status} count=${active.length}`);
  }

  // ------------------------------------------------------------
  await section('3. MICHANGO + DASHBOARD');
  // ------------------------------------------------------------
  {
    const c1 = await api('POST', `/api/events/${eventId}/contributions`, aliceToken, { amount: 3000000, mode: 'FUNDRAISING' });
    await expect(c1.status === 200 && c1.data.success && Number(c1.data.collected) === 3000000, 'Alice anachangia 3,000,000', `${c1.status} ${JSON.stringify(c1.data)}`);
    const c2 = await api('POST', `/api/events/${eventId}/contributions`, bobToken, { amount: 3000000, mode: 'FUNDRAISING' });
    await expect(c2.status === 200 && Number(c2.data.collected) === TARGET, 'Bob anachangia 3,000,000 (pool = 6M)', `${c2.status}`);

    const aliceBal = await balanceOf(aliceId);
    const bobBal = await balanceOf(bobId);
    await expect(aliceBal === 1000000 && bobBal === 1000000, 'Mikoba ya michango imedebitwa (1M kila mmoja)', `alice=${aliceBal} bob=${bobBal}`);

    const list = await api('GET', `/api/events/${eventId}/contributions`, ownerToken, null);
    await expect(list.status === 200 && list.data.contributions.length === 2, 'Contributions zimeorodheshwa (2)', `${list.status}`);

    const dash = await api('GET', `/api/events/${eventId}/dashboard`, ownerToken, null);
    await expect(dash.status === 200 && dash.data.dashboard && dash.data.dashboard.event.id === eventId, 'Dashboard inarudisha tukio', `${dash.status}`);
    await expect(Number(dash.data.dashboard.summary.collected.total) === TARGET && dash.data.dashboard.stats.contributors === 2, 'Dashboard: collected 6M, contributors 2', JSON.stringify(dash.data.dashboard && dash.data.dashboard.summary));
  }

  // ------------------------------------------------------------
  await section('4. WITHDRAWALS (direct + four-eyes) + ADMIN OVERSIGHT');
  // ------------------------------------------------------------
  let fourEyesId = null;
  let fourEyesFlowId = null;
  {
    const w1 = await api('POST', `/api/events/${eventId}/withdrawals`, ownerToken, { amount: 1000000, mode: 'FUNDRAISING' });
    await expect(w1.status === 200 && w1.data.requiresApproval === false, 'Uondoaji mdogo (1M) ni direct (hakuna approval)', `${w1.status} reqApp=${w1.data.requiresApproval}`);
    const wl1 = await api('GET', `/api/events/${eventId}/withdrawals`, ownerToken, null);
    const paid1 = (wl1.data.withdrawals || []).find((w) => Number(w.amount) === 1000000);
    await expect(!!paid1 && paid1.status === 'PAID', 'Uondoaji wa 1M umelipwa (PAID)', paid1 ? paid1.status : 'missing');

    const w2 = await api('POST', `/api/events/${eventId}/withdrawals`, ownerToken, { amount: 5000000, mode: 'FUNDRAISING' });
    await expect(w2.status === 200 && w2.data.requiresApproval === true && !!w2.data.approvalFlowId, 'Uondoaji mkubwa (5M) unahitaji aproval (four-eyes)', `${w2.status} flow=${w2.data.approvalFlowId}`);
    fourEyesFlowId = w2.data.approvalFlowId;
    fourEyesId = w2.data.withdrawal && w2.data.withdrawal.id;

    const wl2 = await api('GET', `/api/events/${eventId}/withdrawals`, ownerToken, {});
    const pend5 = (wl2.data.withdrawals || []).find((w) => Number(w.amount) === 5000000);
    await expect(!!pend5 && pend5.requires_approval === true && pend5.status === 'PENDING', 'Withdrawal ya 5M iko PENDING + requires_approval=true', pend5 ? `${pend5.status} ra=${pend5.requires_approval}` : 'missing');

    const outsiderAdmin = await api('GET', '/api/admin/events', outsiderToken, null);
    await expect(outsiderAdmin.status === 403, 'Mtu asiye ADMIN hawezi kuona admin/events (403)', `${outsiderAdmin.status}`);

    const ov = await api('GET', '/api/admin/events/withdrawals?status=PENDING', adminToken, null);
    const flagHit = (ov.data.flags.requiresApproval || []).includes(fourEyesId);
    await expect(ov.status === 200 && flagHit, 'Admin overview inaflag withdrawal ya 5M (requiresApproval)', `${ov.status} flags=${ov.data.flags.requiresApproval}`);

    const dec = await api('POST', `/api/admin/approvals/${fourEyesFlowId}/decide`, adminToken, { action: 'APPROVE', comment: 'Imekubaliwa na msimamizi' });
    await expect(dec.status === 200 && dec.data.flow && dec.data.flow.status === 'APPROVED' && dec.data.execution && dec.data.execution.success, 'Admin anaidhinisha 5M -> imetekelezwa (PAID)', `${dec.status}`);
    // Kati ya make-chakler: mdai (owner) ameaji prevent? Hapa approver ni admin seeded tofauti — thibitisha flow ilipita.

    const wl3 = await api('GET', `/api/events/${eventId}/withdrawals`, ownerToken, null);
    const paid5 = (wl3.data.withdrawals || []).find((w) => Number(w.amount) === 5000000);
    await expect(!!paid5 && paid5.status === 'PAID' && !!paid5.paid_at, 'Baada ya approval, 5M imelipwa (status PAID)', paid5 ? paid5.status : 'missing');

    const ownerBal = await balanceOf(ownerId);
    await expect(ownerBal === 6000000, 'Mmiliki amepokea 6M kwenye mkoba (1M+5M)', `wallet=${ownerBal}`);

    const search = await api('GET', `/api/admin/events?search=${encodeURIComponent(suffix)}`, adminToken, null);
    const hit = (search.data.events || []).find((e) => e.id === eventId);
    await expect(search.status === 200 && !!hit && hit.status === 'ACTIVE', 'Admin search inapata tukio (search + status)', hit ? hit.status : 'missing');
  }

  // ------------------------------------------------------------
  await section('5. TEMPLATES (hifadhi / lista / tumia / futa)');
  // ------------------------------------------------------------
  let templateId = null;
  {
    const tpl = await api('POST', `/api/events/${eventId}/template`, ownerToken, { name: `Template ${suffix}` });
    templateId = tpl.data.template && tpl.data.template.id;
    await expect(tpl.status === 201 && !!templateId && Number(tpl.data.template.target_amount) === TARGET, 'Tukio linahifadhiwa kama template (201)', `${tpl.status}`);

    const tpls = await api('GET', '/api/events/templates', ownerToken, null);
    await expect(tpls.status === 200 && (tpls.data.templates || []).some((t) => t.id === templateId), 'Template iko kwenye lista', `${tpls.status}`);

    const used = await api('POST', `/api/events/templates/${templateId}/use`, ownerToken, {});
    await expect(used.status === 201 && used.data.event.id && used.data.event.name.includes('Template'), 'Tukio jipya linaanzishwa kutoka template (201)', `${used.status}: ${used.data.message || ''}`);
    const usedBudget = await api('GET', `/api/events/${used.data.event.id}/budget`, ownerToken, null);
    await expect((usedBudget.data.items || []).length === 1 && Number(usedBudget.data.items[0].amount) === 2000000, 'Template inabeba budget (1M item 2M)', `items=${usedBudget.data.items ? usedBudget.data.items.length : 0}`);

    const del = await api('DELETE', `/api/events/templates/${templateId}`, ownerToken, null);
    await expect(del.status === 200 && del.data.success === true, 'Template inafutwa', `${del.status} ${JSON.stringify(del.data).slice(0, 200)}`);
  }

  // ------------------------------------------------------------
  await section('6. SERIES (mfululizo)');
  // ------------------------------------------------------------
  {
    const series = await api('POST', '/api/events/series', ownerToken, {
      name: `Vikao ${suffix}`, cadence: 'WEEKLY', eventType: 'HARUSI', targetAmount: 500000, startDate: base,
    });
    const seriesId = series.data.series && series.data.series.id;
    await expect(series.status === 201 && !!seriesId && d10(series.data.series.next_run_at) === base, 'Mfululizo umeundwa na next_run_at = base', `${series.status} next=${series.data.series.next_run_at}`);

    const s0 = await api('GET', '/api/events/series', ownerToken, null);
    const s0row = (s0.data.series || []).find((s) => s.id === seriesId);
    await expect(!!s0row && Number(s0row.events_count) === 0, 'events_count = 0 kabla ya generate', s0row ? String(s0row.events_count) : 'missing');

    const g1 = await api('POST', `/api/events/series/${seriesId}/generate`, ownerToken, {});
    await expect(g1.status === 201 && g1.data.event.id && d10(g1.data.event.event_date) === base, 'Generate #1: tukio la kwanza siku = base', `${g1.status} d=${g1.data.event.event_date}`);

    const g2 = await api('POST', `/api/events/series/${seriesId}/generate`, ownerToken, {});
    await expect(g2.status === 201 && d10(g2.data.event.event_date) === addDaysUtc(base, 7), 'Generate #2: tukio la pili +7 siku', `${g2.status} d=${g2.data.event.event_date}`);

    const s2 = await api('GET', '/api/events/series', ownerToken, null);
    const s2row = (s2.data.series || []).find((s) => s.id === seriesId);
    await expect(Number(s2row.events_count) === 2 && d10(s2row.next_run_at) === addDaysUtc(base, 14), 'events_count = 2, next_run_at = +14 siku', s2row ? `count=${s2row.events_count} next=${s2row.next_run_at}` : 'missing');

    const listEv = await api('GET', `/api/events/series/${seriesId}/events`, ownerToken, null);
    await expect(listEv.status === 200 && listEv.data.events.length === 2, 'Matukio ya mfululizo yameorodheshwa (2)', `${listEv.status}`);
  }

  // ------------------------------------------------------------
  await section('7. REPORTS & EXPORTS (JSON/CSV/PDF) + ACCESS CONTROL');
  // ------------------------------------------------------------
  {
    const rep = await api('GET', `/api/events/${eventId}/report`, ownerToken, null);
    await expect(rep.status === 200 && rep.data.report.event.id === eventId, 'Ripoti ya JSON (owner) 200', `${rep.status}`);
    await expect(Number(rep.data.report.summary.collected.fundraising) === TARGET && Number(rep.data.report.summary.donations) === 2, 'Ripoti: fundraising 6M, donations 2', JSON.stringify(rep.data.report.summary));

    const repMember = await api('GET', `/api/events/${eventId}/report`, aliceToken, null);
    await expect(repMember.status === 200, 'Ripoti ya JSON (mwanachama) 200', `${repMember.status}`);

    const repOut = await api('GET', `/api/events/${eventId}/report`, outsiderToken, null);
    await expect(repOut.status === 403, 'Mtu asiye member na si ADMIN: 403', `${repOut.status}`);

    const csvC = await apiRaw('GET', `/api/events/${eventId}/report/csv?section=contributions`, ownerToken);
    await expect(csvC.status === 200 && csvC.ct.includes('text/csv') && csvC.text.includes('reference_id') && csvC.text.includes('FUNDRAISING'), 'CSV section=contributions (text/csv, na data)', `${csvC.status} ct=${csvC.ct}`);

    const csvAll = await apiRaw('GET', `/api/events/${eventId}/report/csv`, adminToken);
    await expect(csvAll.status === 200 && csvAll.text.includes('SECTION:') && csvAll.text.includes('CONTRIBUTIONS'), 'CSV zote (admin) zina sections', `${csvAll.status}`);

    const pdf = await apiRaw('GET', `/api/events/${eventId}/report/pdf`, ownerToken);
    await expect(pdf.status === 200 && pdf.ct.includes('application/pdf') && pdf.buf.slice(0, 5).toString('utf8').startsWith('%PDF'), 'Ripoti ya PDF inatolewa (%PDF)', `${pdf.status} ct=${pdf.ct} head=${pdf.buf.slice(0, 8).toString('utf8')}`);

    const pdfOut = await apiRaw('GET', `/api/events/${eventId}/report/pdf`, outsiderToken);
    await expect(pdfOut.status === 403, 'PDF pia inazuia mtu asiye na ruhusa (403)', `${pdfOut.status}`);
  }

  console.log('\n==============================');
  console.log(`RESULT: ${passed} PASSED, ${failed} FAILED`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('==============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(2);
});
