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
  const adminToken = await login('255712000001');
  const ashaToken = await login('255713100001');

  // 1. Admin angalia miradi inayosubiri ukaguzi
  const pending = await api('GET', '/api/admin/projects/pending', adminToken);
  console.log('PENDING PROJECTS:', pending.data.projects.length);
  const project = pending.data.projects.find((p) => p.title === 'Kuku wa Mayai - Kibaha');
  if (!project) {
    console.log('No pending project found.');
    return;
  }
  console.log('PROJECT STATUS:', project.status, '| target:', project.target_amount);

  // 2. Admin weka chini ya ukaguzi (SUBMITTED → UNDER_REVIEW)
  const startReview = await api('POST', `/api/admin/projects/${project.id}/review/start`, adminToken, {});
  console.log('START REVIEW:', startReview.status, startReview.data.success);

  // 3. Admin kagua na KUTHIBITISHA
  const approve = await api('POST', `/api/admin/projects/${project.id}/review`, adminToken, { decision: 'APPROVED' });
  console.log('APPROVE:', approve.status, approve.data.success);

  // 4. Asha ona mradi sasa (ACTIVE)
  const projects = await api('GET', '/api/p2p/projects', ashaToken);
  const activeProject = projects.data.projects.find((p) => p.id === project.id);
  console.log('INVESTOR VIEW:', activeProject ? activeProject.status : 'NOT FOUND');

  // 5. Admin apange Escrow Milestones
  const milestones = await api('POST', `/api/admin/projects/${project.id}/milestones`, adminToken, {
    milestones: [
      { title: 'Awamu ya 1 - Ununuzi wa vifaranga', amount: 2000000 },
      { title: 'Awamu ya 2 - Chakula na madawa', amount: 2000000 },
      { title: 'Awamu ya 3 - Kujenga banda', amount: 1000000 },
    ],
  });
  console.log('MILESTONES:', milestones.status, milestones.data.success);

  // 6. Asha anawekeza hisa 1
  const invest = await api('POST', `/api/p2p/projects/${project.id}/invest`, ashaToken, { shares: 1 });
  console.log('INVEST:', invest.status, JSON.stringify(invest.data, null, 2));

  // 7. Angalia salio la Asha
  const me = await api('GET', '/api/auth/me', ashaToken);
  console.log('ASHA NEW BALANCE:', me.data.user.wallet_balance);

  // 8. Portfolio ya mwekezaji
  const portfolio = await api('GET', '/api/p2p/portfolio', ashaToken);
  console.log('PORTFOLIO:', portfolio.status, '| total:', portfolio.data.portfolio.totalInvested, '| projects:', portfolio.data.portfolio.projectsCount);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('TEST ERROR', e.message);
  process.exit(1);
});
