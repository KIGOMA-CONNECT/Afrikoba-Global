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
  return login.data.token;
}

async function main() {
  const ashaToken = await login('255713100001');   // MWENYEKITI
  const jumaToken = await login('255714100002');   // MWEKAHAZINA
  const barakaToken = await login('255716100004'); // MJUMBE (mgombaji)

  // 0. Asha anatoa hisa kujaza Group Wallet (wallet 250k -> group wallet)
  const contrib = await api('POST', '/api/vicoba/groups/1/contribute', ashaToken, {
    amount: 100000,
    sharesCount: 5,
  });
  console.log('SHARE CONTRIBUTION:', contrib.status, JSON.stringify(contrib.data));

  // 1. Asha (Chair) anaongeza ombi la mkopo kwa Baraka (user 5)
  const loanReq = await api('POST', '/api/vicoba/groups/1/loans', ashaToken, {
    applicantUserId: 5,
    requestedAmount: 50000,
    interestRate: 10,
    repaymentMonths: 3,
  });
  console.log('LOAN REQUEST:', loanReq.status, JSON.stringify(loanReq.data));

  if (loanReq.data.success) {
    const loanId = loanReq.data.loan.id;

    // 2. Juma (Treasurer) anaidhinisha kiasi
    const approve = await api('POST', `/api/vicoba/loans/${loanId}/approve`, jumaToken, {
      approvedAmount: 50000,
    });
    console.log('LOAN APPROVE:', approve.status, JSON.stringify(approve.data));

    // 3. Angalia salio la Baraka baada ya mkopo kutolewa
    const me = await api('GET', '/api/auth/me', barakaToken);
    console.log('BARAKA BALANCE:', me.data.user.wallet_balance);
  }
}

main().catch((e) => {
  console.error('TEST ERROR', e.message);
  process.exit(1);
});
