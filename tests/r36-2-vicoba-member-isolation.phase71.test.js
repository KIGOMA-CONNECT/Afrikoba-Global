#!/usr/bin/env node
'use strict';
/* R36 Task 2 (F-R34-1) — server-side VICOBA group-membership isolation and data minimisation.
 *  [1] member of A: GET /vicoba/groups/A -> 200; GET /vicoba/groups/B -> 403 VICOBA_NOT_GROUP_MEMBER,
 *      and the 403 body carries no B data (no member names / phone numbers).
 *  [2] EVERY GET route with :groupId on the VICOBA routers (enumerated from the router stacks, so a new
 *      route is covered automatically): A-member on B -> 403; A-member on A -> not 403.
 *  [3] :loanId and :meetingId GET routes resolve the owning group: B's loan / meeting -> 403 for A-member.
 *  [4] unknown group id and non-numeric id -> the same 403 (no existence oracle).
 *  [5] minimisation for a non-leader: other members' phone_number, social_fund_balance,
 *      contribution_balance are absent; the viewer's own row keeps them; a leader still sees them.
 *      Loans list: another applicant's phone_number is hidden from a non-leader.
 *  [6] service level: getGroupDetails(B, A-member) refuses 403 too (not only the route).
 *  [7] both prefixes /api/v1 and /api enforce the same.
 */
const h = require('./r36-harness');
const { check, call, group, q1, attempt } = h;
const vicoba = require(h.path.join(h.ROOT, 'src/services/vicobaService'));

function getRoutes(router, param) {
  return router.stack.filter((l) => l.route && l.route.methods.get && l.route.path.includes(`:${param}`)).map((l) => l.route.path);
}
const fill = (p, ids) => p.replace(/:groupId/g, ids.g).replace(/:loanId/g, ids.loan).replace(/:meetingId/g, ids.meeting).replace(/:cycleNumber/g, '1');
const notGuarded = (r) => !(r.status === 403 && r.body && r.body.code === 'VICOBA_NOT_GROUP_MEMBER');
const noLeak = (body, s) => { const t = JSON.stringify(body || {}); return !t.includes(s.leader.phone) && !t.includes(s.m.phone) && !t.includes('R36 leader'); };

(async () => {
  await h.listen(h.buildApp());
  const A = await group([['leader', 'MWENYEKITI'], ['a', 'MJUMBE'], ['a2', 'MJUMBE']]);
  const B = await group([['leader', 'MWENYEKITI'], ['m', 'MJUMBE']]);
  await h.pool.query('UPDATE vicoba_members SET contribution_balance = 7777, social_fund_balance = 3333 WHERE group_id = ANY($1)', [[A.g, B.g]]);
  const loanOf = async (s, who) => (await q1(`INSERT INTO vicoba_loan_requests (group_id, applicant_user_id, requested_amount, status) VALUES ($1,$2,30000,'PENDING') RETURNING id`, [s.g, who.id])).id;
  const meetingOf = async (s) => (await q1(`INSERT INTO vicoba_meetings (group_id, meeting_date) VALUES ($1, CURRENT_DATE) RETURNING id`, [s.g])).id;
  const idsA = { g: A.g, loan: await loanOf(A, A.a2), meeting: await meetingOf(A) };
  const idsB = { g: B.g, loan: await loanOf(B, B.m), meeting: await meetingOf(B) };

  console.log('\n[1] own group vs other group');
  {
    const own = await call('GET', `/api/v1/vicoba/groups/${A.g}`, A.a);
    const other = await call('GET', `/api/v1/vicoba/groups/${B.g}`, A.a);
    check('[1] A-member GET A -> 200 with members', own.status === 200 && Array.isArray(own.body.group.members) && own.body.group.members.length === 3, own);
    check('[1] A-member GET B -> 403 VICOBA_NOT_GROUP_MEMBER', other.status === 403 && other.body.code === 'VICOBA_NOT_GROUP_MEMBER', other);
    check('[1] the 403 body leaks no B member data', noLeak(other.body, B), other.body);
  }

  const vr = require(h.path.join(h.ROOT, 'src/routes/vicobaRoutes'));
  const mr = require(h.path.join(h.ROOT, 'src/routes/mkobaRoutes'));
  const groupRoutes = [...getRoutes(vr, 'groupId'), ...getRoutes(mr, 'groupId')];
  console.log(`\n[2] every GET :groupId route (${groupRoutes.length} enumerated)`);
  const KNOWN = ['/groups/:groupId/loans', '/groups/:groupId', '/groups/:groupId/schedules', '/groups/:groupId/penalties', '/groups/:groupId/social-fund',
    '/groups/:groupId/withdrawals', '/groups/:groupId/bonuses', '/groups/:groupId/transactions', '/groups/:groupId/constitution', '/groups/:groupId/shares',
    '/groups/:groupId/shares/my', '/groups/:groupId/shares/summary', '/groups/:groupId/profits', '/groups/:groupId/transfers', '/groups/:groupId/attendance/my',
    '/groups/:groupId/attendance/report', '/groups/:groupId/reports/financial', '/groups/:groupId/reports/member', '/groups/:groupId/reports/loan-aging'];
  check('[2] enumeration contains all 19 known GET :groupId routes', KNOWN.every((k) => groupRoutes.includes(k)), KNOWN.filter((k) => !groupRoutes.includes(k)));
  for (const prefix of ['/api/v1', '/api']) {
    for (const p of groupRoutes) {
      const foreign = await call('GET', `${prefix}/vicoba${fill(p, idsB)}`, A.a);
      const own = await call('GET', `${prefix}/vicoba${fill(p, idsA)}`, A.a);
      check(`[2] ${prefix} ${p}: B -> 403, A -> passes the membership guard`, foreign.status === 403 && foreign.body.code === 'VICOBA_NOT_GROUP_MEMBER' && noLeak(foreign.body, B) && notGuarded(own),
        { foreign: foreign.status, own: own.status, ob: notGuarded(own) ? undefined : own.body });
    }
  }

  console.log('\n[3] loan and meeting routes resolve the owning group');
  for (const p of [...getRoutes(vr, 'loanId'), ...getRoutes(mr, 'loanId'), ...getRoutes(vr, 'meetingId'), ...getRoutes(mr, 'meetingId')]) {
    const foreign = await call('GET', `/api/v1/vicoba${fill(p, idsB)}`, A.a);
    const own = await call('GET', `/api/v1/vicoba${fill(p, idsA)}`, A.a);
    check(`[3] ${p}: B's -> 403, A's -> passes the membership guard`, foreign.status === 403 && foreign.body.code === 'VICOBA_NOT_GROUP_MEMBER' && notGuarded(own), { foreign: foreign.status, own: own.status });
  }

  console.log('\n[4] no existence oracle');
  {
    const missing = await call('GET', '/api/v1/vicoba/groups/987654321', A.a);
    const junk = await call('GET', '/api/v1/vicoba/groups/1abc/loans', A.a);
    const missingLoan = await call('GET', '/api/v1/vicoba/loans/987654321/schedule', A.a);
    check('[4] unknown group -> same 403', missing.status === 403 && missing.body.code === 'VICOBA_NOT_GROUP_MEMBER', missing);
    check('[4] non-numeric id -> same 403', junk.status === 403 && junk.body.code === 'VICOBA_NOT_GROUP_MEMBER', junk);
    check('[4] unknown loan -> same 403', missingLoan.status === 403 && missingLoan.body.code === 'VICOBA_NOT_GROUP_MEMBER', missingLoan);
  }

  console.log('\n[5] minimisation');
  {
    const r = await call('GET', `/api/v1/vicoba/groups/${A.g}`, A.a);
    const rows = r.body.group.members;
    const mine = rows.find((x) => x.user_id === A.a.id);
    const others = rows.filter((x) => x.user_id !== A.a.id);
    check('[5] non-leader: others have no phone_number / social_fund_balance / contribution_balance',
      others.length === 2 && others.every((x) => !('phone_number' in x) && !('social_fund_balance' in x) && !('contribution_balance' in x)), others);
    check('[5] non-leader: no other member phone anywhere in the body', !JSON.stringify(r.body).includes(A.leader.phone) && !JSON.stringify(r.body).includes(A.a2.phone));
    check('[5] non-leader: own row keeps phone and balances', mine && mine.phone_number === A.a.phone && Number(mine.contribution_balance) === 7777, mine);
    const l = await call('GET', `/api/v1/vicoba/groups/${A.g}`, A.leader);
    check('[5] leader still sees members\' phone numbers', l.body.group.members.filter((x) => x.phone_number).length === 3, l.body.group.members);
    const loans = await call('GET', `/api/v1/vicoba/groups/${A.g}/loans`, A.a);
    check('[5] loans list: other applicant phone hidden from non-leader', loans.status === 200 && loans.body.loans.length === 1 && !('phone_number' in loans.body.loans[0]) && !JSON.stringify(loans.body).includes(A.a2.phone), loans.body);
    const loansL = await call('GET', `/api/v1/vicoba/groups/${A.g}/loans`, A.leader);
    check('[5] loans list: leader sees applicant phone', loansL.body.loans[0].phone_number === A.a2.phone, loansL.body);
  }

  console.log('\n[6] service-level refusal');
  {
    const r = await attempt(() => vicoba.getGroupDetails(B.g, A.a.id));
    check('[6] getGroupDetails(B, A-member) -> 403', !r.ok && r.status === 403 && r.code === 'VICOBA_NOT_GROUP_MEMBER', r);
    const ok = await attempt(() => vicoba.getGroupDetails(A.g, A.a.id));
    check('[6] getGroupDetails(A, A-member) -> ok', ok.ok, ok);
  }

  await h.finish('R36 (2) VICOBA member isolation');
})().catch(h.fatal);
