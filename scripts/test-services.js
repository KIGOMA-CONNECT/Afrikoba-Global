const BASE = 'http://localhost:3000';

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function login(phoneNumber) {
  const otp = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  const login = await api('POST', '/api/auth/login', null, { phoneNumber, otp: otp.data.devOtp });
  return login.data;
}

async function register(phoneNumber, fullName) {
  const otp = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  return api('POST', '/api/auth/register', null, { fullName, phoneNumber, otp: otp.data.devOtp });
}

async function main() {
  const phone = `255718${String(Date.now()).slice(-6)}`; // namba mpya kila wakati
  console.log('=== NEW USER:', phone, '===');

  const reg = await register(phone, 'Mwanachama Mpya');
  console.log('1. REGISTER:', reg.status, '| services =', reg.data.user.services);

  const token = reg.data.token;

  const blocked = await api('POST', '/api/vicoba/groups', token, {
    groupName: 'Kikundi cha Jaribio',
    cycleType: 'WEEKLY',
    shareValue: 5000,
  });
  console.log('2. VICOBA before subscribe:', blocked.status, '|', blocked.data.code, '-', blocked.data.message);

  const sub = await api('POST', '/api/services/subscribe', token, { serviceKey: 'VICOBA' });
  console.log('3. Subscribe VICOBA:', sub.status, '|', sub.data.message || sub.data.subscription?.service_key);

  const ros = await api('POST', '/api/services/subscribe', token, { serviceKey: 'ROSCA' });
  console.log('4. Subscribe ROSCA (KYC L1):', ros.status, '|', ros.data.message);

  const created = await api('POST', '/api/vicoba/groups', token, {
    groupName: 'Kikundi cha Jaribio',
    cycleType: 'WEEKLY',
    shareValue: 5000,
  });
  console.log('5. CREATE GROUP:', created.status, '| join_code =', created.data.group?.join_code);

  if (!created.data.success) throw new Error('Haukuweza kuunda kikundi');

  const groupId = created.data.group.id;
  const joinCode = created.data.group.join_code;

  // Mwanachama mwingine mpya ajiunge kwa msimbo
  const phone2 = `255719${String(Date.now()).slice(-6)}`;
  const reg2 = await register(phone2, 'Mwanachama wa Pili');
  const token2 = reg2.data.token;
  await api('POST', '/api/services/subscribe', token2, { serviceKey: 'VICOBA' });

  const joined = await api('POST', '/api/vicoba/groups/join', token2, { joinCode });
  console.log('6. JOIN BY CODE:', joined.status, '|', joined.data.message);

  const details = await api('GET', `/api/vicoba/groups/${groupId}`, token2);
  const memberCount = details.data.group.members.length;
  const seesCode = 'join_code' in details.data.group;
  console.log('7. GROUP DETAILS (member): members =', memberCount, '| sees join_code =', seesCode);

  const details2 = await api('GET', `/api/vicoba/groups/${groupId}`, token);
  console.log('8. GROUP DETAILS (chairman): sees join_code =', 'join_code' in details2.data.group);

  const invite = await api('POST', `/api/vicoba/groups/${groupId}/invite`, token, {
    phoneNumbers: ['255720123456', '255721123456'],
  });
  console.log('9. INVITE BY SMS:', invite.status, '| invited =', invite.data.invited, '| code =', invite.data.joinCode);

  const catalog = await api('GET', '/api/services/catalog', token);
  console.log('10. CATALOG:', catalog.data.catalog.map((c) => `${c.key}:${c.active ? 'ON' : 'OFF'}`).join(' '));
}

main().catch((e) => {
  console.error('TEST ERROR', e.message);
  process.exit(1);
});
