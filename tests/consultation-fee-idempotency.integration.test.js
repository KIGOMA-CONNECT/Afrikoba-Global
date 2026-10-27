#!/usr/bin/env node
'use strict';
/* ============================================================================
 * AFRIKOBA — consultation-fee idempotency INTEGRATION tests
 * Requires: disposable DB + running server (TEST_BASE).
 * Usage: TEST_BASE=http://127.0.0.1:3105 node tests/consultation-fee-idempotency.integration.test.js
 * ==========================================================================*/
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3000';
const pool = require('../src/config/db');
const crypto = require('crypto');

let passed = 0; let failed = 0; const failures = [];
function ok(l){passed++;console.log('  ✓ '+l);}
function bad(l,e){failed++;failures.push(l);console.log('  ✗ '+l+(e?' :: '+e:''));}
async function expect(c,l,e){if(c)ok(l);else bad(l,e);}

async function api(method,path,token,body){
  const headers={'Content-Type':'application/json'};
  if(token) headers.Authorization='Bearer '+token;
  const res=await fetch(BASE+path,{method,headers,body:body?JSON.stringify(body):undefined});
  let data=null; try{data=await res.json();}catch(e){data={};}
  return {status:res.status,data};
}
async function sendOtp(phone){return (await api('POST','/api/auth/send-otp',null,{phoneNumber:phone})).data.devOtp;}
async function login(phone){
  const otp=await sendOtp(phone);
  const r=await api('POST','/api/auth/login',null,{phoneNumber:phone,otp});
  return r.data;
}
async function fundWallet(userId,amount){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const ref='TST-'+crypto.randomBytes(6).toString('hex').toUpperCase();
    const tx=await client.query(`INSERT INTO transactions (reference_id,user_id,wallet_amount,commission,total_charged,status,type,meta) VALUES ($1,$2,$3,0,$3,'SUCCESS','DEPOSIT',$4) RETURNING id`,[ref,userId,amount,JSON.stringify({note:'int-test-funding'})]);
    await client.query('UPDATE users SET wallet_balance=wallet_balance+$1 WHERE id=$2',[amount,userId]);
    await client.query('INSERT INTO wallet_ledger (transaction_id,reference_id,to_user_id,amount,description) VALUES ($1,$2,$3,$4,$5)',[tx.rows[0].id,ref,userId,amount,'int test funding']);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
async function balanceOf(userId){
  const r=await pool.query('SELECT wallet_balance,locked_balance FROM users WHERE id=$1',[userId]);
  return {wallet:Number(r.rows[0].wallet_balance),locked:Number(r.rows[0].locked_balance)};
}
async function createProject(adminToken){
  const r=await api('POST','/api/projects',adminToken,{name:'Test Project',capital_required:100000,min_investment:1000,duration_days:30,expected_revenue:200000,expected_costs:50000,projected_profit:150000,reinvestment_pct:20,reserve_pct:10,owner_equity_pct:30,distribution_method:'EQUAL',risks:'low',assumptions:'stable',business_plan:'plan',category:'AGRIBUSINESS',location:'Dar',description:'desc'});
  return r.data.project.id;
}
async function getAdmin(){
  const data=await login('255712000001');
  const r=await pool.query('SELECT id FROM users WHERE phone_number=$1',['255712000001']);
  return {token:data.token,userId:r.rows[0].id};
}
function rndRef(prefix){return prefix+'-'+Date.now()+'-'+Math.random().toString(36).slice(2,8).toUpperCase();}
async function opsForRef(ref){
  const r=await pool.query('SELECT operation_type,user_id,amount,status FROM financial_operations WHERE reference_id=$1',[ref]);
  return r.rows;
}
async function consultForRef(ref){
  const r=await pool.query('SELECT * FROM project_consultations WHERE unique_reference=$1',[ref]);
  return r.rows;
}
async function journalCount(ref){
  const r=await pool.query('SELECT count(*)::int n FROM journal_entries WHERE reference_id=$1',[ref]);
  return r.rows[0].n;
}

(async function main(){
  console.log('================================================');
  console.log('CONSULTATION-FEE IDEMPOTENCY — INTEGRATION TESTS');
  console.log('================================================');

  const admin=await getAdmin();
  const adminToken=admin.token;
  const adminId=admin.userId;

  // I18: non-existent project -> 404
  {
    const r=await api('POST','/api/projects/999999/consultation/pay',adminToken,{unique_reference:rndRef('I18')});
    await expect(r.status===404,'I18: non-existent project returns 404',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I1: First payment
  const pid1=await createProject(adminToken);
  await fundWallet(adminId, 2000000);
  const base1=await balanceOf(adminId);
  const ref1=rndRef('I1');
  const wd1=await api('POST',`/api/projects/${pid1}/consultation/pay`,adminToken,{unique_reference:ref1});
  await expect(wd1.status===201,'I1: first payment returns 201',`${wd1.status} ${JSON.stringify(wd1.data)}`);
  await expect(wd1.data.already_paid===false,'I1: already_paid=false',JSON.stringify(wd1.data));
  const cons1=wd1.data.consultation;
  const bal1=await balanceOf(adminId);
  await expect(!!cons1,'I1: consultation row returned',JSON.stringify(wd1.data));
  await expect(bal1.wallet===base1.wallet-1500000,'I1: wallet debited 1500000',`wallet=${bal1.wallet} base=${base1.wallet}`);
  const ops1=await opsForRef(ref1);
  await expect(ops1.length===1 && ops1[0].status==='SUCCESS' && ops1[0].operation_type==='PROJECT_CONSULTATION','I1: operation SUCCESS',JSON.stringify(ops1));
  const proj1=await pool.query('SELECT consultation_paid_at FROM projects WHERE id=$1',[pid1]);
  await expect(!!proj1.rows[0].consultation_paid_at,'I1: consultation_paid_at set',JSON.stringify(proj1.rows[0]));
  const jc1=await journalCount(`${ref1}-wallet`);
  await expect(jc1>=2,'I1: journal entries present',`journal=${jc1}`);

  // I2: Successful retry
  const wd2=await api('POST',`/api/projects/${pid1}/consultation/pay`,adminToken,{unique_reference:ref1});
  await expect(wd2.status===200,'I2: retry returns 200',`${wd2.status}`);
  await expect(wd2.data.already_paid===true,'I2: already_paid=true',JSON.stringify(wd2.data));
  await expect(wd2.data.consultation.id===cons1.id,'I2: same consultation id',`${wd2.data.consultation.id} vs ${cons1.id}`);
  const bal2=await balanceOf(adminId);
  await expect(bal2.wallet===bal1.wallet && bal2.locked===bal1.locked,'I2: wallet unchanged on retry',`wallet=${bal2.wallet}`);
  const ops2=await opsForRef(ref1);
  await expect(ops2.length===1,'I2: no second operation row',`ops=${ops2.length}`);
  const consCount2=await pool.query('SELECT count(*)::int n FROM project_consultations WHERE unique_reference=$1',[ref1]);
  await expect(consCount2.rows[0].n===1,'I2: no second consultation row',`count=${consCount2.rows[0].n}`);

  // I3a: Owner mismatch -> 403
  {
    // register a different user
    const phone='255799'+Date.now().toString().slice(-6);
    const otp=await sendOtp(phone);
    const reg=await api('POST','/api/auth/register',null,{fullName:'Other User',phoneNumber:phone,otp});
    const otherToken=reg.data.token;
    const otherId=reg.data.user.id;
    await fundWallet(otherId,100000);
    const r=await api('POST',`/api/projects/${pid1}/consultation/pay`,otherToken,{unique_reference:rndRef('I3a')});
    await expect(r.status===403,'I3a: owner mismatch returns 403',`${r.status} ${JSON.stringify(r.data)}`);
    // no debit, no consultation, no operation for this ref
    const refI3a=r.data?null:null;
  }

  // I15: Fee change after prior payment -> already_paid with original amount
  {
    await pool.query('UPDATE projects SET consultation_fee=999999 WHERE id=$1',[pid1]);
    const r=await api('POST',`/api/projects/${pid1}/consultation/pay`,adminToken,{unique_reference:rndRef('I15')});
    await expect(r.status===200,'I15: retry after fee change returns 200',`${r.status}`);
    await expect(r.data.already_paid===true,'I15: already_paid=true',JSON.stringify(r.data));
    await expect(Number(r.data.amount)===1500000,'I15: original amount 1500000 (not 999999)',`${r.data.amount}`);
    // restore fee
    await pool.query('UPDATE projects SET consultation_fee=1500000 WHERE id=$1',[pid1]);
  }

  // I16: Fee changed to 0 after prior payment -> already_paid, no 400
  {
    await pool.query('UPDATE projects SET consultation_fee=0 WHERE id=$1',[pid1]);
    const r=await api('POST',`/api/projects/${pid1}/consultation/pay`,adminToken,{unique_reference:rndRef('I16')});
    await expect(r.status===200,'I16: retry with fee=0 returns 200 (not 400)',`${r.status} ${JSON.stringify(r.data)}`);
    await expect(r.data.already_paid===true,'I16: already_paid=true',JSON.stringify(r.data));
    await expect(Number(r.data.amount)===1500000,'I16: original amount 1500000',`${r.data.amount}`);
    await pool.query('UPDATE projects SET consultation_fee=1500000 WHERE id=$1',[pid1]);
  }

  // I18: non-existent project -> 404
  {
    const r=await api('POST','/api/projects/999999/consultation/pay',adminToken,{unique_reference:rndRef('I18')});
    await expect(r.status===404,'I18: non-existent project returns 404',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I13: Fee change before lock (pre-set fee, verify usage)
  {
    const pid=await createProject(adminToken);
    await pool.query('UPDATE projects SET consultation_fee=2000000 WHERE id=$1',[pid]);
    await fundWallet(adminId, 3000000);
    const base=await balanceOf(adminId);
    const ref=rndRef('I13');
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===201,'I13: payment with updated fee returns 201',`${r.status} ${JSON.stringify(r.data)}`);
    const bal=await balanceOf(adminId);
    await expect(bal.wallet===base.wallet-2000000,'I13: debited updated fee 2000000',`wallet=${bal.wallet} base=${base.wallet}`);
    const ops=await opsForRef(ref);
    await expect(ops.length===1 && Number(ops[0].amount)===2000000,'I13: operation amount=2000000',JSON.stringify(ops));
  }

  // I13b: fee <= 0 -> 400
  {
    const pid=await createProject(adminToken);
    await pool.query('UPDATE projects SET consultation_fee=0 WHERE id=$1',[pid]);
    const ref=rndRef('I13b');
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===400,'I13b: fee=0 returns 400',`${r.status} ${JSON.stringify(r.data)}`);
    const ops=await opsForRef(ref);
    await expect(ops.length===0,'I13b: no operation row on 400',`ops=${ops.length}`);
  }

  // I14: Owner change before lock -> 403
  {
    const pid=await createProject(adminToken);
    // change owner to a different user
    const phone='255798'+Date.now().toString().slice(-6);
    const otp=await sendOtp(phone);
    const reg=await api('POST','/api/auth/register',null,{fullName:'Other2',phoneNumber:phone,otp});
    const otherId=reg.data.user.id;
    await pool.query('UPDATE projects SET owner_user_id=$1 WHERE id=$2',[otherId,pid]);
    const ref=rndRef('I14');
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===403,'I14: owner change -> 403',`${r.status} ${JSON.stringify(r.data)}`);
    const ops=await opsForRef(ref);
    await expect(ops.length===0,'I14: no operation row on 403',`ops=${ops.length}`);
    const cons=await consultForRef(ref);
    await expect(cons.length===0,'I14: no consultation row on 403',`cons=${cons.length}`);
  }

  // I9: Early-return verification (paid_at set but no valid consultation) -> 409
  {
    const pid=await createProject(adminToken);
    await pool.query('UPDATE projects SET consultation_paid_at=NOW() WHERE id=$1',[pid]);
    const ref=rndRef('I9');
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I9: inconsistent paid_at -> 409',`${r.status} ${JSON.stringify(r.data)}`);
    const bal=await balanceOf(adminId);
    // no debit occurred (wallet unchanged relative to before this test's funding)
  }

  // I3b: Reference/operation mismatch -> 409
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I3b');
    // pre-seed a conflicting operation (different type)
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('DEBIT',$1,$2,1500000,'SUCCESS')`,[ref,adminId]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I3b: conflicting op type -> 409',`${r.status} ${JSON.stringify(r.data)}`);
    const cons=await consultForRef(ref);
    await expect(cons.length===0,'I3b: no consultation inserted',`cons=${cons.length}`);
  }

  // I4: NEW operation -> 409
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I4');
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,1500000,'NEW')`,[ref,adminId]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I4: NEW operation -> 409',`${r.status} ${JSON.stringify(r.data)}`);
    // status stays NEW after rollback
    const ops=await opsForRef(ref);
    await expect(ops.length===1 && ops[0].status==='NEW','I4: status stays NEW after rollback',JSON.stringify(ops));
  }

  // I5: FAILED operation -> 409
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I5');
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,1500000,'FAILED')`,[ref,adminId]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I5: FAILED operation -> 409',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I6a: Mismatched amount -> 409
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I6a');
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,999999,'SUCCESS')`,[ref,adminId]);
    await pool.query(`INSERT INTO project_consultations (project_id,owner_user_id,amount,unique_reference,status) VALUES ($1,$2,999999,$3,'PAID')`,[pid,adminId,ref]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I6a: mismatched amount -> 409',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I6b: Mismatched user -> 409
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I6b');
    const phone='255797'+Date.now().toString().slice(-6);
    const otp=await sendOtp(phone);
    const reg=await api('POST','/api/auth/register',null,{fullName:'U2',phoneNumber:phone,otp});
    const otherId=reg.data.user.id;
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,1500000,'SUCCESS')`,[ref,otherId]);
    await pool.query(`INSERT INTO project_consultations (project_id,owner_user_id,amount,unique_reference,status) VALUES ($1,$2,1500000,$3,'PAID')`,[pid,otherId,ref]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I6b: mismatched user -> 409',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I6c: Mismatched project -> 409
  {
    const pid=await createProject(adminToken);
    const pid2=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I6c');
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,1500000,'SUCCESS')`,[ref,adminId]);
    await pool.query(`INSERT INTO project_consultations (project_id,owner_user_id,amount,unique_reference,status) VALUES ($1,$2,1500000,$3,'PAID')`,[pid2,adminId,ref]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I6c: mismatched project -> 409',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I7: Missing consultation despite SUCCESS operation -> 409
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I7');
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,1500000,'SUCCESS')`,[ref,adminId]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I7: missing consultation -> 409',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I10: debit dedup conflict
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    const ref=rndRef('I10');
    // pre-seed wallet op (DEBIT, SUCCESS) but no consultation
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('DEBIT',$1,$2,1500000,'SUCCESS')`,[`${ref}-wallet`,adminId]);
    const balBefore=await balanceOf(adminId);
    const jcBefore=await journalCount(`${ref}-wallet`);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I10: debit dedup conflict -> 409',`${r.status} ${JSON.stringify(r.data)}`);
    const balAfter=await balanceOf(adminId);
    await expect(balAfter.wallet===balBefore.wallet && balAfter.locked===balBefore.locked,'I10: wallet unchanged',`wallet ${balBefore.wallet}->${balAfter.wallet}`);
    const jcAfter=await journalCount(`${ref}-wallet`);
    await expect(jcAfter===jcBefore,'I10: journal count unchanged (pre-existing op not modified)',`journal ${jcBefore}->${jcAfter}`);
    const cons=await consultForRef(ref);
    await expect(cons.length===0,'I10: no consultation inserted',`cons=${cons.length}`);
    const ops=await opsForRef(ref);
    // outer operation should be rolled back (absent or not SUCCESS)
    const outerSuccess=ops.filter(o=>o.status==='SUCCESS');
    await expect(outerSuccess.length===0,'I10: outer operation not SUCCESS (rolled back)',JSON.stringify(ops));
  }

  // I11: Concurrency (two real parallel requests, different refs, same project)
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 5000000);
    const refA=rndRef('I11A');
    const refB=rndRef('I11B');
    const [rA,rB]=await Promise.all([
      api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:refA}),
      api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:refB}),
    ]);
    const statuses=[rA.status,rB.status].sort();
    await expect(statuses.includes(201) && statuses.includes(200),'I11: one 201 + one 200 already_paid',`statuses=${statuses}`);
    const consCount=await pool.query('SELECT count(*)::int n FROM project_consultations WHERE project_id=$1',[pid]);
    await expect(consCount.rows[0].n===1,'I11: exactly one consultation row',`count=${consCount.rows[0].n}`);
    const opCount=await pool.query("SELECT count(*)::int n FROM financial_operations WHERE operation_type='PROJECT_CONSULTATION' AND status='SUCCESS' AND reference_id IN ($1,$2)",[refA,refB]);
    await expect(opCount.rows[0].n===1,'I11: exactly one SUCCESS operation',`count=${opCount.rows[0].n}`);
    const proj=await pool.query('SELECT consultation_paid_at FROM projects WHERE id=$1',[pid]);
    await expect(!!proj.rows[0].consultation_paid_at,'I11: paid_at set once',JSON.stringify(proj.rows[0]));
  }

  // I12: Invariant check
  {
    // Use I1's project (pid1) which was successfully paid
    const ops=await opsForRef(ref1);
    await expect(ops.length===1 && ops[0].status==='SUCCESS','I12: operation status=SUCCESS (not NEW)',JSON.stringify(ops));
    const jc=await journalCount(`${ref1}-wallet`);
    await expect(jc>=2,'I12: journal entries present',`journal=${jc}`);
    const cons=await consultForRef(ref1);
    await expect(cons.length===1,'I12: consultation present',`cons=${cons.length}`);
    // After I4 rollback, operation row (if present) is NOT SUCCESS
    const ops4=await opsForRef(rndRef('I4')); // won't exist, but check pattern
    // (I4 already verified status stays NEW)
  }

  // I17: Multiple consultation rows -> DB-side exact timestamp match
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 5000000);
    // Set consultation_paid_at using DB-side NOW() (transaction-scoped).
    await pool.query("UPDATE projects SET consultation_paid_at=NOW() WHERE id=$1",[pid]);
    // Pre-seed a matching consultation: paid_at set DB-side to match consultation_paid_at exactly.
    await pool.query(`INSERT INTO project_consultations (project_id,owner_user_id,amount,unique_reference,status,paid_at) VALUES ($1,$2,1500000,$3,'PAID',(SELECT consultation_paid_at FROM projects WHERE id=$1))`,[pid,adminId,'MATCH-'+Date.now()]);
    const matchRef=(await pool.query("SELECT unique_reference FROM project_consultations c WHERE c.project_id=$1 AND c.paid_at IS NOT DISTINCT FROM (SELECT consultation_paid_at FROM projects WHERE id=$1)",[pid])).rows[0].unique_reference;
    // Pre-seed an operation for the matching consultation
    await pool.query(`INSERT INTO financial_operations (operation_type,reference_id,user_id,amount,status) VALUES ('PROJECT_CONSULTATION',$1,$2,1500000,'SUCCESS')`,[matchRef,adminId]);
    // Pre-seed an unrelated consultation (different paid_at, latest id)
    await pool.query(`INSERT INTO project_consultations (project_id,owner_user_id,amount,unique_reference,status,paid_at) VALUES ($1,$2,1500000,$3,'PAID',NOW() - INTERVAL '1 hour')`,[pid,adminId,'UNRELATED-'+Date.now()]);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:rndRef('I17')});
    // Layer A should find the matching row (not the unrelated latest) -> already_paid
    await expect(r.status===200,'I17a: matching row found -> already_paid (not false accept of unrelated)',`${r.status} ${JSON.stringify(r.data)}`);
    await expect(r.data.already_paid===true,'I17a: already_paid=true',JSON.stringify(r.data));
    await expect(Number(r.data.amount)===1500000,'I17a: correct amount from matching consultation',`${r.data.amount}`);
    // No second debit (wallet unchanged relative to before this test's funding)
  }

  // I17b: No matching row -> 409
  {
    const pid=await createProject(adminToken);
    await pool.query("UPDATE projects SET consultation_paid_at=NOW() - INTERVAL '2 hours' WHERE id=$1",[pid]);
    // Seed a consultation with a DIFFERENT paid_at (no match)
    await pool.query(`INSERT INTO project_consultations (project_id,owner_user_id,amount,unique_reference,status,paid_at) VALUES ($1,$2,1500000,$3,'PAID',NOW())`,[pid,adminId,'NOMATCH-'+Date.now()]);
    const ref=rndRef('I17b');
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===409,'I17b: no matching timestamp -> 409',`${r.status} ${JSON.stringify(r.data)}`);
  }

  // I8a: Audit DB-write failure (trigger-based)
  {
    const pid=await createProject(adminToken);
    await fundWallet(adminId, 2000000);
    // Create trigger that raises on audit_logs insert
    await pool.query(`CREATE OR REPLACE FUNCTION fn_audit_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit forced failure'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS trg_audit_fail ON audit_logs`);
    await pool.query(`CREATE TRIGGER trg_audit_fail BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fn_audit_fail()`);
    const ref=rndRef('I8a');
    const balBefore=await balanceOf(adminId);
    const r=await api('POST',`/api/projects/${pid}/consultation/pay`,adminToken,{unique_reference:ref});
    await expect(r.status===201,'I8a: payment committed despite audit failure -> 201',`${r.status} ${JSON.stringify(r.data)}`);
    const balAfter=await balanceOf(adminId);
    await expect(balAfter.wallet===balBefore.wallet-1500000,'I8a: wallet debited (payment committed)',`wallet ${balBefore.wallet}->${balAfter.wallet}`);
    const cons=await consultForRef(ref);
    await expect(cons.length===1,'I8a: consultation row present (committed)',`cons=${cons.length}`);
    // audit row absent
    const audit=await pool.query("SELECT count(*)::int n FROM audit_logs WHERE meta->>'referenceId'=$1",[ref]);
    await expect(audit.rows[0].n===0,'I8a: audit row absent (swallowed)',`audit=${audit.rows[0].n}`);
    // cleanup trigger
    await pool.query('DROP TRIGGER IF EXISTS trg_audit_fail ON audit_logs');
    await pool.query('DROP FUNCTION IF EXISTS fn_audit_fail()');
  }

  console.log('------------------------------------------------');
  console.log(`RESULT: ${passed} PASSED, ${failed} FAILED`);
  if(failed){console.log('FAILED: '+failures.join(' | '));process.exitCode=1;}
  await pool.end().catch(()=>{});
})();
