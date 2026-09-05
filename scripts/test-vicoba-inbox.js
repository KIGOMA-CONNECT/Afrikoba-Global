/* ============================================================
 * AFRIKOBA GLOBAL - VICOBA INVITATION INBOX REGRESSION
 * listMyInvitations, accept (bila msimbo), reject, ownership guard.
 * ============================================================ */
const BASE = process.env.VICOBA_TEST_BASE || 'http://127.0.0.1:3000';

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
async function section(label) { console.log('\n--- ' + label + ' ---'); }

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

async function sendOtp(phoneNumber) {
  const r = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return r.data.devOtp;
}
async function register(phoneNumber, fullName) {
  const otp = await sendOtp(phoneNumber);
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp });
}
async function subscribeVicoba(token) {
  return api('POST', '/api/services/subscribe', token, { serviceKey: 'VICOBA' });
}

(async () => {
  const suffix = String(Date.now()).slice(-6);
  const ownerPhone = `255741${suffix}`;
  const alicePhone = `255742${suffix}`;
  const bobPhone = `255743${suffix}`;

  const owner = await register(ownerPhone, 'Vicoba Chair');
  const ownerToken = owner.data.token;
  const alice = await register(alicePhone, 'Invite Alice');
  const aliceToken = alice.data.token;
  const bob = await register(bobPhone, 'Invite Bob');
  const bobToken = bob.data.token;

  await subscribeVicoba(ownerToken);
  await subscribeVicoba(aliceToken);
  await subscribeVicoba(bobToken);

  let groupId = null;
  let inviteId = null;

  await section('1. UNDA KIKUNDI + TUUMA MIALIKO');
  {
    const g = await api('POST', '/api/vicoba/groups', ownerToken, {
      groupName: `JikundiInbox ${suffix}`, cycleType: 'WEEKLY', shareValue: 20000, monthlyMaintenanceFee: 5000,
    });
    await expect(g.status === 201 && g.data.group.id && g.data.group.join_code, 'Kikundi kinaundwa na join_code', `${g.status}`);
    groupId = g.data.group.id;

    const inv = await api('POST', `/api/vicoba/groups/${groupId}/invite`, ownerToken, { phoneNumbers: [alicePhone] });
    await expect(inv.status === 200 && inv.data.invited === 1 && inv.data.joinCode, 'Mwaliko wa SMS umetumwa (1 namba)', `${inv.status}`);
  }

  await section('2. INVITATION INBOX (list + reject)');
  {
    const mine = await api('GET', '/api/vicoba/invitations', aliceToken, null);
    const list = mine.data.invitations || [];
    await expect(mine.status === 200 && list.length === 1, 'Alice anaona mwaliko 1 kwenye inbox', `${mine.status} n=${list.length}`);
    await expect(!!list[0] && list[0].group_name && list[0].status === 'SENT', 'Inbox lina jina la kikundi + status SENT', JSON.stringify(list).slice(0, 200));
    inviteId = list[0] && list[0].id;

    const outsider = await api('POST', `/api/vicoba/invitations/${inviteId}/reject`, bobToken, null);
    await expect(outsider.status === 403, 'Bob hawezi kukataa mwaliko wa Alice (403)', `${outsider.status}`);

    const rej = await api('POST', `/api/vicoba/invitations/${inviteId}/reject`, aliceToken, null);
    await expect(rej.status === 200 && rej.data.status === 'DECLINED', 'Alice anakataa mwaliko', `${rej.status}: ${JSON.stringify(rej.data).slice(0, 100)}`);

    const after = await api('GET', '/api/vicoba/invitations', aliceToken, null);
    await expect((after.data.invitations || []).length === 0, 'Mkuu, inbox haionyeshi tena mwaliko uliokataliwa', `${(after.data.invitations || []).length}`);

    const rej2 = await api('POST', `/api/vicoba/invitations/${inviteId}/reject`, aliceToken, null);
    await expect(rej2.status === 400, 'Kukataliwa mara ya pili -> 400 (umechakatwa)', `${rej2.status}`);
  }

  await section('3. ACCEPT (bila msimbo)');
  {
    const inv = await api('POST', `/api/vicoba/groups/${groupId}/invite`, ownerToken, { phoneNumbers: [alicePhone, bobPhone] });
    await expect(inv.status === 200 && inv.data.invited === 2, 'Mialiko 2 mpya yametumwa', `${inv.status}`);

    const mine = await api('GET', '/api/vicoba/invitations', aliceToken, null);
    const aliceInvite = (mine.data.invitations || [])[0];
    await expect(!!aliceInvite && Number(aliceInvite.group_id) === groupId, 'Alice anaona mwaliko mpya wa kikundi hicho', `${mine.status}`);
    inviteId = aliceInvite.id;

    const acc = await api('POST', `/api/vicoba/invitations/${inviteId}/accept`, aliceToken, null);
    await expect(acc.status === 200 && acc.data.status === 'ACCEPTED' && Number(acc.data.group.id) === groupId, 'Alice anakubali na anaongezwa kwenye kikundi', `${acc.status}: ${JSON.stringify(acc.data).slice(0, 120)}`);

    const acc2 = await api('POST', `/api/vicoba/invitations/${inviteId}/accept`, aliceToken, null);
    await expect(acc2.status === 400, 'Kukubaliwa mara ya pili -> 400 (umechakatwa)', `${acc2.status}`);

    const inbox = await api('GET', '/api/vicoba/invitations', aliceToken, null);
    await expect((inbox.data.invitations || []).length === 0, 'Inbox sasa iko tupu baada ya kukubali', `${(inbox.data.invitations || []).length}`);

    const groups = await api('GET', '/api/vicoba/groups', aliceToken, null);
    const grp = (groups.data.groups || []).find((x) => Number(x.id) === groupId);
    await expect(!!grp, 'Kikundi kinaonekana kwenye orodha ya Alice', `${groups.status}`);

    const details = await api('GET', `/api/vicoba/groups/${groupId}`, ownerToken, null);
    const member = (details.data.group.members || []).find((m) => m.phone_number === alicePhone);
    await expect(!!member && member.role_in_group === 'MJUMBE', 'Alice yupo kama MJUMBE kwenye members list', JSON.stringify(member || {}).slice(0, 120));
  }

  console.log(`\nVICOBA Inbox: passed=${passed} failed=${failed}`);
  if (failed > 0) {
    console.log('Failures:', failures.join(' | '));
    process.exitCode = 1;
  }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
})().catch((e) => {
  console.error('VICOBA INBOX FATAL', e);
  console.error((e.stack || '').slice(0, 1200));
  setTimeout(() => process.exit(1), 300);
});