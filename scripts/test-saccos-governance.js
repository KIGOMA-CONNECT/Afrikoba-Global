/* ============================================================
 * AFRIKOBA GLOBAL - SACCOS DIGITAL CORE - GOVERNANCE
 * Increment 5 regression: entity-scoped resolutions + voting.
 * OWNER/BOARD propose/open/close/cancel; ACTIVE members vote
 * FOR/AGAINST/ABSTAIN once per resolution while OPEN; closing
 * tallies quorum (cast/ACTIVE) and decision threshold (FOR/cast)
 * into PASSED/REJECTED; allowMemberVoting gating, cross-entity
 * isolation 404, platform ADMIN oversight, audit trail.
 * Config saccos.config.governance {allowMemberVoting,
 * quorumPercent, decisionThresholdPercent, votingDays}. Suite 49.
 * ============================================================ */
const BASE = process.env.SACCOS_TEST_BASE || 'http://127.0.0.1:3000';
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
async function makeAdmin(reg, depth = 0) {
  await pool.query('UPDATE users SET role = $2, updated_at = NOW() WHERE id = $1', [reg.data.user.id, 'ADMIN']);
  for (let i = 0; i < 8; i++) {
    const refresh = await api('POST', '/api/auth/refresh', null, { refreshToken: reg.data.refreshToken });
    if (refresh.data.token) return refresh.data.token;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (depth < 1) {
    const backup = await register('255679' + nowSuffix(), 'Gov Admin Backup');
    return makeAdmin(backup, depth + 1);
  }
  return null;
}
function nowSuffix() { return String(Date.now()).slice(-6); }

async function main() {
  const suffix = nowSuffix();
  const phone = (n) => `255${suffix.slice(-3)}${String(n).padStart(4, '0')}`;

  async function addMember(ownerTok, orgId, pn, fullName) {
    const reg = await register(phone(pn), fullName);
    const inv = await api('POST', `/api/saccos/${orgId}/members`, ownerTok, { phoneNumber: phone(pn) });
    await api('POST', `/api/saccos/${orgId}/members/${inv.data.result.id}/accept`, reg.data.token);
    return reg;
  }

  // ---------- 1. Schema evidence ----------
  await section('Schema evidence (105_saccos_governance)');
  const resCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_resolutions'`);
  const resOk = ['reference_id', 'title', 'status', 'voting_deadline', 'quorum_percent', 'decision_threshold_percent'].every((c) => resCols.rows.some((r) => r.column_name === c));
  await expect(resOk, 'saccos_resolutions columns present');
  const voteCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'saccos_resolution_votes'`);
  await expect(voteCols.rows.length >= 6, 'saccos_resolution_votes columns present');

  // ---------- 2. Setup + proposal ----------
  await section('Setup + proposal guards');
  const ownerReg = await register(phone(5001), 'Uongozi Haya');
  const ownerTok = ownerReg.data.token;
  const create = await api('POST', '/api/v1/saccos', ownerTok, { name: 'Asasi Uongozi ' + suffix });
  await expect(create.status === 201, 'owner creates SACCOS (governance defaults 50% quorum / 60% threshold)');
  const orgId = create.data.result.saccos.id;
  await api('POST', `/api/saccos/${orgId}/activate`, ownerTok);

  const m1 = await addMember(ownerTok, orgId, 5002, 'Kura 1');
  const m2 = await addMember(ownerTok, orgId, 5003, 'Kura 2');
  const m3 = await addMember(ownerTok, orgId, 5004, 'Kura 3');

  const memberCreate = await api('POST', `/api/saccos/${orgId}/governance/resolutions`, m1.data.token, { title: 'Sijaruhusiwa' });
  await expect(memberCreate.status === 403 && memberCreate.data.code === 'SACCOS_RBAC', 'plain MEMBER cannot propose -> 403');

  const createRes = await api('POST', `/api/saccos/${orgId}/governance/resolutions`, ownerTok, {
    title: 'Nunua gari la chama', category: 'FINANCE', description: 'Idhini ya ununuzi wa gari.',
  });
  await expect(createRes.status === 201 && String(createRes.data.result.reference_id).startsWith('RES-') && createRes.data.result.status === 'DRAFT',
    'OWNER proposes -> RES-* DRAFT', `${createRes.status}/${createRes.data.code || ''}`);
  const res1 = createRes.data.result.id;

  // ---------- 3. Open + vote + pass ----------
  await section('Open + voting + PASSED');
  const voteDraft = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, m1.data.token, { choice: 'FOR' });
  await expect(voteDraft.status === 400 && voteDraft.data.code === 'SACCOS_GOV_RESOLUTION_STATE', 'vote while DRAFT -> SACCOS_GOV_RESOLUTION_STATE');

  const open = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/open`, ownerTok);
  await expect(open.status === 200 && open.data.result.status === 'OPEN' && new Date(open.data.result.voting_deadline) > new Date(),
    'OWNER opens -> OPEN + future voting_deadline');

  const reOpen = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/open`, ownerTok);
  await expect(reOpen.status === 400 && reOpen.data.code === 'SACCOS_GOV_RESOLUTION_STATE', 're-open OPEN -> SACCOS_GOV_RESOLUTION_STATE');

  const badChoice = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, m1.data.token, { choice: 'MAYBE' });
  await expect(badChoice.status === 400 && badChoice.data.code === 'SACCOS_GOV_VOTE_INVALID', 'choice MAYBE -> SACCOS_GOV_VOTE_INVALID');

  const v1 = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, m1.data.token, { choice: 'FOR' });
  await expect(v1.status === 201 && v1.data.result.choice === 'FOR', 'member1 votes FOR');
  const dupVote = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, m1.data.token, { choice: 'ABSTAIN' });
  await expect(dupVote.status === 400 && dupVote.data.code === 'SACCOS_GOV_VOTE_ALREADY', 'member1 second vote -> SACCOS_GOV_VOTE_ALREADY');
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, m2.data.token, { choice: 'FOR' });
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, m3.data.token, { choice: 'AGAINST' });

  const memberClose = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/close`, m1.data.token);
  await expect(memberClose.status === 403 && memberClose.data.code === 'SACCOS_RBAC', 'member cannot close -> 403');

  const close = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/close`, ownerTok);
  await expect(close.status === 200 && close.data.result.outcome === 'PASSED'
    && close.data.result.tally.cast_votes === 3 && close.data.result.tally.for_votes === 2
    && close.data.result.tally.against_votes === 1 && close.data.result.tally.quorum_met === true
    && close.data.result.tally.passed === true,
    'close -> PASSED (quorum 3/4, FOR 2/3 >= 60%)', JSON.stringify(close.data.result.tally));

  const voteClosed = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/vote`, ownerTok, { choice: 'FOR' });
  await expect(voteClosed.status === 400 && voteClosed.data.code === 'SACCOS_GOV_RESOLUTION_STATE', 'vote after close -> SACCOS_GOV_RESOLUTION_STATE');

  const detail = await api('GET', `/api/saccos/${orgId}/governance/resolutions/${res1}`, m1.data.token);
  await expect(detail.status === 200 && detail.data.result.resolution.status === 'PASSED'
    && detail.data.result.tally.for_votes === 2 && detail.data.result.myVote === 'FOR' && detail.data.result.votes.length === 3,
    'member detail shows tally + myVote + vote list');

  // ---------- 4. Reject (quorum + threshold) ----------
  await section('Reject paths');
  const res2 = (await api('POST', `/api/saccos/${orgId}/governance/resolutions`, ownerTok, { title: 'Quorum kutokuwepo' })).data.result.id;
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res2}/open`, ownerTok);
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res2}/vote`, m1.data.token, { choice: 'FOR' });
  const closeQuorum = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res2}/close`, ownerTok);
  await expect(closeQuorum.status === 200 && closeQuorum.data.result.outcome === 'REJECTED' && closeQuorum.data.result.tally.quorum_met === false,
    'close with 1/4 cast -> REJECTED (quorum missed)', JSON.stringify(closeQuorum.data.result.tally));

  const res3 = (await api('POST', `/api/saccos/${orgId}/governance/resolutions`, ownerTok, { title: 'Kiwango kisichopatikana' })).data.result.id;
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res3}/open`, ownerTok);
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res3}/vote`, m1.data.token, { choice: 'FOR' });
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res3}/vote`, m2.data.token, { choice: 'AGAINST' });
  const closeThreshold = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res3}/close`, ownerTok);
  await expect(closeThreshold.status === 200 && closeThreshold.data.result.outcome === 'REJECTED'
    && closeThreshold.data.result.tally.quorum_met === true && closeThreshold.data.result.tally.passed === false
    && closeThreshold.data.result.tally.for_votes === 1 && closeThreshold.data.result.tally.cast_votes === 2,
    'close 1/2 FOR (quorum 50% met, threshold 50% < 60%) -> REJECTED');

  // ---------- 5. Cancel ----------
  await section('Cancel + admin-bounded does not override turnout');
  const res4 = (await api('POST', `/api/saccos/${orgId}/governance/resolutions`, ownerTok, { title: 'Bati' })).data.result.id;
  const cancelDraft = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res4}/cancel`, ownerTok);
  await expect(cancelDraft.status === 200 && cancelDraft.data.result.status === 'CANCELLED', 'cancel DRAFT -> CANCELLED');

  const res5 = (await api('POST', `/api/saccos/${orgId}/governance/resolutions`, ownerTok, { title: 'Bati baadae' })).data.result.id;
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res5}/open`, ownerTok);
  await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res5}/cancel`, ownerTok);
  const cancelClosed = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res1}/cancel`, ownerTok);
  await expect(cancelClosed.status === 400 && cancelClosed.data.code === 'SACCOS_GOV_RESOLUTION_STATE', 'cancel PASSED -> SACCOS_GOV_RESOLUTION_STATE');

  // ---------- 6. allowMemberVoting=false ----------
  await section('allowMemberVoting=false (officers-only voting)');
  const o2 = await register(phone(5005), 'S2 Uongozi');
  const o2Tok = o2.data.token;
  const s2 = await api('POST', '/api/v1/saccos', o2Tok, {
    name: 'Uongozi Makini ' + suffix,
    config: { governance: { allowMemberVoting: false, quorumPercent: 50, decisionThresholdPercent: 60 } },
  });
  const s2Id = s2.data.result.saccos.id;
  await api('POST', `/api/saccos/${s2Id}/activate`, o2Tok);
  const fReg = await addMember(o2Tok, s2Id, 5006, 'F Uongozi');

  const res6 = (await api('POST', `/api/saccos/${s2Id}/governance/resolutions`, o2Tok, { title: 'Zawadi' })).data.result.id;
  await api('POST', `/api/saccos/${s2Id}/governance/resolutions/${res6}/open`, o2Tok);
  const memberVoteOff = await api('POST', `/api/saccos/${s2Id}/governance/resolutions/${res6}/vote`, fReg.data.token, { choice: 'FOR' });
  await expect(memberVoteOff.status === 403 && memberVoteOff.data.code === 'SACCOS_RBAC', 'allowMemberVoting=false: member vote -> 403');
  await api('POST', `/api/saccos/${s2Id}/governance/resolutions/${res6}/vote`, o2Tok, { choice: 'FOR' });
  const closeOff = await api('POST', `/api/saccos/${s2Id}/governance/resolutions/${res6}/close`, o2Tok);
  await expect(closeOff.status === 200 && closeOff.data.result.outcome === 'PASSED', 'officers-only 1/1 cast passes');

  // ---------- 7. Isolation + oversight ----------
  await section('Isolation + oversight');
  const crossVote = await api('POST', `/api/saccos/${orgId}/governance/resolutions/${res3}/vote`, fReg.data.token, { choice: 'FOR' });
  await expect(crossVote.status === 404, 'S2 member cannot vote S1 resolution -> 404');
  const crossDetail = await api('GET', `/api/saccos/${s2Id}/governance/resolutions/${res6}`, ownerTok);
  await expect(crossDetail.status === 404, 'S1 owner cannot read S2 resolution -> 404');

  const adminTok = await makeAdmin(await register(phone(5007), 'O Uongozi'));
  const adminList = await api('GET', `/api/saccos/${orgId}/governance/resolutions`, adminTok);
  await expect(adminTok && adminList.status === 200 && adminList.data.result.resolutions.length >= 5, 'platform ADMIN lists all S1 resolutions');
  const adminSummary = await api('GET', `/api/saccos/${orgId}/governance/summary`, adminTok);
  await expect(adminSummary.status === 200 && adminSummary.data.result.passed >= 1 && adminSummary.data.result.rejected >= 1
    && adminSummary.data.result.votes >= 6, 'platform ADMIN reads governance summary');

  const summary = await api('GET', `/api/saccos/${orgId}/governance/summary`, ownerTok);
  await expect(summary.status === 200 && summary.data.result.total >= 5 && summary.data.result.open === 0, 'owner governance summary totals');

  const memberList = await api('GET', `/api/saccos/${orgId}/governance/resolutions`, m1.data.token);
  await expect(memberList.status === 200 && memberList.data.result.resolutions.length >= 5, 'member lists org resolutions (no admin endpoints)');

  const audit = await pool.query(`SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'SACCOS_GOV%'`);
  await expect(audit.rows.length >= 4, 'audit trail has governance actions');

  console.log(`\nSACCOS GOVERNANCE: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });