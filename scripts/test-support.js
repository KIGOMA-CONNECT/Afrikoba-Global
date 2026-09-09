/* ============================================================
 * AFRIKOBA GLOBAL - SUPPORT TICKET LIFECYCLE REGRESSION
 * Member: create/list/detail/thread; ownership + authorization
 * guards (cross-user 404, stranger reply 403, missing fields 400
 * with machine-readable codes); agent auto-assign; reopen-on-message.
 * Admin: queue (+status filter), stats math, status transitions
 * with resolution + resolved_at, admin reply, invalid status 400,
 * unknown ticket 404, non-admin 403. Runs against /api/advanced/*
 * (v1 + legacy aliases) — the endpoints the dashboard surfaces.
 * ============================================================ */
const BASE = process.env.SUPPORT_TEST_BASE || 'http://127.0.0.1:3000';
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
  for (let i = 0; i < 4; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }

(async () => {
  const suffix = nowSuffix();
  const member = await register(`255740${suffix}`, 'Ticket Member');
  const stranger = await register(`255741${suffix}`, 'Ticket Stranger');
  const adm = await register(`255742${suffix}`, 'Ticket Admin');
  await expect(member.data.token && stranger.data.token && adm.data.token, 'Users registered');
  const memTok = member.data.token;
  const memId = member.data.user.id;
  const strTok = stranger.data.token;
  const admin = await makeAdmin(adm);
  const adminId = adm.data.user.id;
  await expect(!!admin, 'Admin promoted');

  const adminIds = (await pool.query(`SELECT id FROM users WHERE role = 'ADMIN'`)).rows.map((r) => r.id);

  await section('Schema evidence');
  const sTickets = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'support_tickets'`);
  const sMsgs = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'support_messages'`);
  const tkCols = sTickets.rows.map((r) => r.column_name);
  const mgCols = sMsgs.rows.map((r) => r.column_name);
  await expect(['ticket_id', 'category', 'priority', 'subject', 'description', 'status', 'assigned_to', 'resolution', 'resolved_at'].every((c) => tkCols.includes(c)), 'support_tickets schema (subject/description/status/assigned_to/resolution/resolved_at)');
  await expect(['ticket_id', 'sender_id', 'message', 'is_internal'].every((c) => mgCols.includes(c)), 'support_messages schema (sender_id/message/is_internal)');

  await section('Member — create + guards');
  const c1 = await api('POST', '/api/v1/advanced/support/tickets', memTok, { category: 'ACCOUNT', priority: 'MEDIUM', subject: 'Salio halijakisiwa', description: 'Nalipa lakini salio halibadiliki.' });
  await expect(c1.status === 200 && c1.data.ticket && c1.data.ticket.ticket_id.startsWith('TKT-') && c1.data.ticket.status === 'OPEN' && c1.data.ticket.category === 'ACCOUNT', 'Ticket created (TKT-*, OPEN, ACCOUNT)', `status=${c1.status} ${JSON.stringify(c1.data).slice(0, 140)}`);
  const t1 = c1.data.ticket;
  await expect(Number.isInteger(t1.assigned_to) && adminIds.includes(t1.assigned_to), 'Auto-assigned to an ADMIN agent');
  const c2 = await api('POST', '/api/v1/advanced/support/tickets', memTok, { category: 'TRANSACTION', priority: 'HIGH', subject: 'Muamala maradufu', description: 'Nilitozwa mara mbili.' });
  await expect(c2.status === 200 && c2.data.ticket.ticket_id.startsWith('TKT-'), 'Second ticket created');
  const t2 = c2.data.ticket;
  const coerced = await api('POST', '/api/v1/advanced/support/tickets', memTok, { category: 'KYC', priority: 'ZZZ', subject: 'Priority coercion', description: 'x' });
  await expect(coerced.status === 200 && coerced.data.ticket.priority === 'MEDIUM', 'Invalid priority coerced to MEDIUM', `priority=${coerced.data.ticket?.priority}`);
  const badCat = await api('POST', '/api/v1/advanced/support/tickets', memTok, { category: 'NOPE', priority: 'MEDIUM', subject: 'x', description: 'x' });
  await expect(badCat.status === 400 && badCat.data.code === 'SUPPORT_CATEGORY_INVALID', 'Invalid category → 400 SUPPORT_CATEGORY_INVALID', `status=${badCat.status}`);
  const noSubj = await api('POST', '/api/v1/advanced/support/tickets', memTok, { category: 'OTHER', priority: 'LOW', description: 'x' });
  await expect(noSubj.status === 400 && noSubj.data.code === 'SUPPORT_SUBJECT_REQUIRED', 'Missing subject → 400 SUPPORT_SUBJECT_REQUIRED', `status=${noSubj.status}`);
  const noDesc = await api('POST', '/api/v1/advanced/support/tickets', memTok, { category: 'OTHER', priority: 'LOW', subject: 'x' });
  await expect(noDesc.status === 400 && noDesc.data.code === 'SUPPORT_DESCRIPTION_REQUIRED', 'Missing description → 400 SUPPORT_DESCRIPTION_REQUIRED', `status=${noDesc.status}`);

  await section('Member — list + detail + thread');
  const list = await api('GET', '/api/v1/advanced/support/tickets', memTok);
  await expect(list.status === 200 && Array.isArray(list.data.tickets) && list.data.tickets.length >= 3 && list.data.tickets.some((x) => x.ticket_id === t1.ticket_id), 'My tickets listed (newest first)', `n=${list.data.tickets?.length}`);
  const listOpen = await api('GET', '/api/v1/advanced/support/tickets?status=OPEN', memTok);
  await expect(listOpen.status === 200 && listOpen.data.tickets.every((x) => x.status === 'OPEN'), 'Status filter (OPEN) applied');
  const listRes = await api('GET', '/api/v1/advanced/support/tickets?status=RESOLVED', memTok);
  await expect(listRes.status === 200 && listRes.data.tickets.length === 0, 'Status filter (RESOLVED) empty before resolution');
  const leg = await api('GET', '/api/advanced/support/tickets', memTok);
  await expect(leg.status === 200 && Array.isArray(leg.data.tickets), 'Legacy /api prefix alias works (dashboard baseURL)');
  const detail = await api('GET', `/api/v1/advanced/support/tickets/${t1.id}`, memTok);
  await expect(detail.status === 200 && detail.data.ticket.id === t1.id && Array.isArray(detail.data.messages) && detail.data.messages.length === 0, 'Owner detail (empty thread)', `msgs=${detail.data.messages?.length}`);
  const msg1 = await api('POST', `/api/v1/advanced/support/tickets/${t1.id}/messages`, memTok, { message: 'Naomba msaada' });
  await expect(msg1.status === 200 && msg1.data.message && msg1.data.message.message === 'Naomba msaada', 'Owner reply appended', `status=${msg1.status}`);
  const detail2 = await api('GET', `/api/v1/advanced/support/tickets/${t1.id}`, memTok);
  await expect(detail2.data.messages.length === 1 && detail2.data.messages[0].sender_phone === member.data.user.phone_number, 'Thread shows sender_phone join');
  const noMsg = await api('POST', `/api/v1/advanced/support/tickets/${t1.id}/messages`, memTok, { message: '' });
  await expect(noMsg.status === 400, 'Empty message rejected', `status=${noMsg.status}`);

  await section('Ownership & authorization guards');
  const cross = await api('GET', `/api/v1/advanced/support/tickets/${t1.id}`, strTok);
  await expect(cross.status === 404 && cross.data.code === 'SUPPORT_TICKET_NOT_FOUND', 'Cross-user detail → 404 (no enumeration)', `status=${cross.status}`);
  const strangerReply = await api('POST', `/api/v1/advanced/support/tickets/${t1.id}/messages`, strTok, { message: 'hack' });
  await expect(strangerReply.status === 403 && strangerReply.data.code === 'AUTH_INSUFFICIENT_SCOPE', 'Stranger reply → 403 AUTH_INSUFFICIENT_SCOPE', `status=${strangerReply.status}`);
  const missing = await api('GET', '/api/v1/advanced/support/tickets/99999999', memTok);
  await expect(missing.status === 404 && missing.data.code === 'SUPPORT_TICKET_NOT_FOUND', 'Unknown detail → 404');
  const missingMsg = await api('POST', '/api/v1/advanced/support/tickets/99999999/messages', memTok, { message: 'x' });
  await expect(missingMsg.status === 404 && missingMsg.data.code === 'SUPPORT_TICKET_NOT_FOUND', 'Message on unknown ticket → 404');

  await section('Admin — queue + stats + transitions');
  const anonQueue = await api('GET', '/api/v1/advanced/admin/support/tickets', memTok);
  await expect(anonQueue.status === 403, 'Non-admin queue → 403', `status=${anonQueue.status}`);
  const anonStats = await api('GET', '/api/v1/advanced/admin/support/stats', memTok);
  await expect(anonStats.status === 403, 'Non-admin stats → 403', `status=${anonStats.status}`);
  const anonUpd = await api('PUT', `/api/v1/advanced/admin/support/tickets/${t1.id}/status`, memTok, { status: 'CLOSED' });
  await expect(anonUpd.status === 403, 'Non-admin status update → 403', `status=${anonUpd.status}`);
  const queue = await api('GET', '/api/v1/advanced/admin/support/tickets', admin);
  await expect(queue.status === 200 && queue.data.tickets.some((x) => x.ticket_id === t1.ticket_id && x.user_phone === member.data.user.phone_number), 'Admin queue shows all with user_phone join', `status=${queue.status}`);
  const qOpen = await api('GET', '/api/v1/advanced/admin/support/tickets?status=OPEN', admin);
  await expect(qOpen.status === 200 && qOpen.data.tickets.every((x) => x.status === 'OPEN'), 'Admin status filter (OPEN)');
  const stats0 = await api('GET', '/api/v1/advanced/admin/support/stats', admin);
  await expect(stats0.status === 200 && stats0.data.stats.total >= 3 && typeof stats0.data.stats.open === 'number', 'Stats baseline captured (total>=3)', JSON.stringify(stats0.data.stats));
  const badStatus = await api('PUT', `/api/v1/advanced/admin/support/tickets/${t1.id}/status`, admin, { status: 'BOGUS' });
  await expect(badStatus.status === 400 && badStatus.data.code === 'SUPPORT_STATUS_INVALID', 'Invalid status → 400 SUPPORT_STATUS_INVALID', `status=${badStatus.status}`);
  const missingUpd = await api('PUT', '/api/v1/advanced/admin/support/tickets/99999999/status', admin, { status: 'CLOSED' });
  await expect(missingUpd.status === 404 && missingUpd.data.code === 'SUPPORT_TICKET_NOT_FOUND', 'Status update on unknown ticket → 404');
  const inProg = await api('PUT', `/api/v1/advanced/admin/support/tickets/${t1.id}/status`, admin, { status: 'IN_PROGRESS' });
  await expect(inProg.status === 200 && inProg.data.ticket.status === 'IN_PROGRESS' && inProg.data.ticket.resolved_at === null, 'IN_PROGRESS transition (no resolved_at)');
  const resolve = await api('PUT', `/api/v1/advanced/admin/support/tickets/${t1.id}/status`, admin, { status: 'RESOLVED', resolution: 'FIXED' });
  await expect(resolve.status === 200 && resolve.data.ticket.status === 'RESOLVED' && resolve.data.ticket.resolution === 'FIXED' && !!resolve.data.ticket.resolved_at, 'RESOLVED with resolution + resolved_at');
  const stats1 = await api('GET', '/api/v1/advanced/admin/support/stats', admin);
  await expect(stats1.data.stats.resolved === stats0.data.stats.resolved + 1, 'Stats resolved +1', JSON.stringify(stats1.data.stats));

  await section('Reopen-on-message + admin reply');
  const reopen = await api('POST', `/api/v1/advanced/support/tickets/${t1.id}/messages`, memTok, { message: 'Bado sijaridhika' });
  const reopened = await api('GET', `/api/v1/advanced/support/tickets/${t1.id}`, memTok);
  await expect(reopen.status === 200 && reopened.data.ticket.status === 'OPEN', 'Reply after RESOLVED reopens ticket (→ OPEN)', `status=${reopened.data.ticket.status}`);
  const adminMsg = await api('POST', `/api/v1/advanced/admin/support/tickets/${t1.id}/messages`, admin, { message: 'Tumekisahihisha' });
  await expect(adminMsg.status === 200 && adminMsg.data.message.message === 'Tumekisahihisha', 'Admin reply appended');
  const thread = await api('GET', `/api/v1/advanced/support/tickets/${t1.id}`, memTok);
  await expect(thread.data.messages.length === 3, 'Thread has member+member+admin messages (3)', `n=${thread.data.messages?.length}`);
  const close = await api('PUT', `/api/v1/advanced/admin/support/tickets/${t1.id}/status`, admin, { status: 'CLOSED', resolution: 'FIXED' });
  await expect(close.status === 200 && close.data.ticket.status === 'CLOSED', 'CLOSED transition');
  const stats2 = await api('GET', '/api/v1/advanced/admin/support/stats', admin);
  await expect(stats2.data.stats.closed === stats0.data.stats.closed + 1, 'Stats closed +1', JSON.stringify(stats2.data.stats));

  process.exit(failed === 0 ? 0 : 1);
})();