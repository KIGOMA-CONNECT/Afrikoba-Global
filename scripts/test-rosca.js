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
  let otp = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  if (otp.status === 429) {
    await new Promise((r) => setTimeout(r, 6000));
    otp = await api('POST', '/api/auth/send-otp', null, { phoneNumber });
  }
  const login = await api('POST', '/api/auth/login', null, { phoneNumber, otp: otp.data.devOtp });
  return login.data.token;
}

async function main() {
  const ashaToken = await login('255713100001');   // user 2
  const jumaToken = await login('255714100002');   // user 3
  const neemaToken = await login('255715100003');  // user 4

  // 0. Upgrade KYC Level 2 (NIDA) kwa wote
  for (const token of [ashaToken, jumaToken, neemaToken]) {
    const kyc = await api('POST', '/api/auth/kyc', token, {
      nidaNumber: '198' + String(Math.floor(Math.random() * 1e15)).padStart(15, '0'),
      residentialAddress: 'Dar es Salaam',
    });
    console.log('KYC UPGRADE:', kyc.status, kyc.data.message);
  }

  // 1. Unda Private Pool ya wanachama 3 (mchango wa 50,000)
  const pool = await api('POST', '/api/rosca/pools', ashaToken, {
    poolName: 'Kikoba cha Majaribio',
    contributionAmount: 50000,
    cycleFrequency: 'WEEKLY',
    totalMembers: 3,
    poolType: 'PRIVATE_KIKOBA',
  });
  console.log('CREATE POOL:', pool.status, JSON.stringify(pool.data));
  const poolId = pool.data.pool.id;

  // 2. Wote wanajiunga (queue numbers 1,2,3)
  for (const token of [ashaToken, jumaToken, neemaToken]) {
    const join = await api('POST', `/api/rosca/pools/${poolId}/join`, token, {});
    console.log('JOIN:', join.status, JSON.stringify(join.data));
  }

  // 3. Pool ikijaa - schedules zinazalishwa
  const details = await api('GET', `/api/rosca/pools/${poolId}`, ashaToken);
  console.log('POOL STATUS:', details.data.pool.status);
  console.log('SCHEDULES:', JSON.stringify(details.data.pool.schedules, null, 2));
  console.log('MEMBERS:', JSON.stringify(details.data.pool.members, null, 2));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('TEST ERROR', e.message);
  process.exit(1);
});
