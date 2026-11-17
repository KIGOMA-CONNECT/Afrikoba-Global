'use strict';
const assert = require('assert');
const { createPool, createInstitution, addOwner, grantPermission, bindCampaign, governedCampaignStatusChange, submitInstitutionEvidence, reviewInstitution, escalateOwnershipChange } = require('../src/services/gsfGovernanceService');

const pool = createPool({ host: '127.0.0.1', port: 55432, user: 'postgres', password: '', database: process.env.DB_NAME || 'gsf_gov_test' });

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('✓ ' + name); passed++; }
  catch (e) { console.log('✗ ' + name + ' — ' + (e && e.message)); failed++; }
}

async function main() {
  const dbName = process.env.DB_NAME;
  if (!dbName || !/^gsf_[a-z0-9_]+_test$/.test(dbName)) {
    console.error('FATAL: DB_NAME must match ^gsf_[a-z0-9_]+_test$');
    process.exit(1);
  }
  const vp = createPool({ host: '127.0.0.1', port: 55432, user: 'postgres', password: '', database: dbName });
  const vr = await vp.query('SELECT version()');
  if (!/^PostgreSQL 16\./.test(vr.rows[0].version)) { console.error('FATAL: PG16 required'); await vp.end(); process.exit(1); }
  await vp.end();

  await pool.query('TRUNCATE gsf_governance_audit_events, gsf_campaign_institution_links, gsf_ownership_change_requests, gsf_ownership_change_approvals, gsf_governance_grants, gsf_governance_permissions, gsf_institution_owners, gsf_institution_members, gsf_institution_evidence, institutions, social_fund_cases CASCADE');
  await pool.query("INSERT INTO gsf_governance_permissions (code,description) VALUES ('GSF_CAMPAIGN_STATUS_CHANGE','x') ON CONFLICT (code) DO NOTHING");
  // seed a social_fund_case
  await pool.query(`INSERT INTO social_fund_cases (id,initiator_id,context_type,case_type,beneficiary_name,title,target_amount,deadline,status) VALUES (777,1,'GROUP','MEDICAL','B','T',100,NOW()+INTERVAL '1 day','OPEN')`);

  const inst = await createInstitution(pool, { name: 'Inst G', createdBy: 1 });
  await reviewInstitution(pool, { institutionId: inst.id, reviewerId: 2, decision: 'APPROVE' });
  await pool.query('INSERT INTO gsf_institution_members (institution_id,user_id,membership_status) VALUES ($1,5,$2)', [inst.id,'ACTIVE']);
  await addOwner(pool, { institutionId: inst.id, userId: 5, verifiedBy: 1 });
  await grantPermission(pool, { institutionId: inst.id, userId: 5, permissionCode: 'GSF_CAMPAIGN_STATUS_CHANGE', grantedBy: 1 });
  await bindCampaign(pool, { campaignId: 777, institutionId: inst.id, linkStatus: 'VERIFIED', evidence: 'doc', linkedBy: 1 });

  await test('GAP-1 atomic governed status transition', async () => {
    const r = await governedCampaignStatusChange(pool, { actorId: 5, institutionId: inst.id, campaignId: 777, newStatus: 'COLLECTING', correlationId: 'c1' });
    assert.strictEqual(r.updated, true);
    const c = await pool.query('SELECT status FROM social_fund_cases WHERE id=777');
    assert.strictEqual(c.rows[0].status, 'COLLECTING');
    const a = await pool.query("SELECT count(*)::int AS n FROM gsf_governance_audit_events WHERE action='GSF_CAMPAIGN_STATUS_CHANGE'");
    assert.ok(a.rows[0].n > 0);
  });

  await test('GAP-1 rollback on failure (audit failure)', async () => {
    // force failure by using a non-existent institution
    let err = null;
    try { await governedCampaignStatusChange(pool, { actorId: 5, institutionId: '00000000-0000-0000-0000-000000000000', campaignId: 777, newStatus: 'X' }); } catch (e) { err = e; }
    assert.ok(err);
    const c = await pool.query('SELECT status FROM social_fund_cases WHERE id=777');
    assert.strictEqual(c.rows[0].status, 'COLLECTING'); // unchanged
  });

  await test('GAP-3 hybrid evidence submission', async () => {
    const ev = await submitInstitutionEvidence(pool, { institutionId: inst.id, evidenceType: 'doc', evidenceRef: 'ref1', submittedBy: 5 });
    assert.ok(ev && ev.id);
    const instRow = await pool.query('SELECT status FROM institutions WHERE id=$1', [inst.id]);
    assert.strictEqual(instRow.rows[0].status, 'PENDING');
  });

  await test('GAP-3 independent review approval', async () => {
    const r = await reviewInstitution(pool, { institutionId: inst.id, reviewerId: 1, decision: 'APPROVE', note: 'ok' });
    assert.strictEqual(r.status, 'ACTIVE');
  });

  await test('GAP-4 escalation recorded', async () => {
    const r = await escalateOwnershipChange(pool, { requestId: '00000000-0000-0000-0000-000000000001', escalatedBy: 1, reason: 'no second owner' });
    assert.strictEqual(r.escalated, true);
    const a = await pool.query("SELECT count(*)::int AS n FROM gsf_governance_audit_events WHERE action='OWNERSHIP_CHANGE_ESCALATED'");
    assert.ok(a.rows[0].n > 0);
  });

  await test('GAP-5 bridge factory', async () => {
    const { createInstitutionService } = require('../src/services/gsfGovernanceService');
    const svc = createInstitutionService(pool);
    const i = await svc.createInstitution({ name: 'Bridge Inst', createdBy: 1 });
    assert.ok(i && i.id);
  });

  console.log('\nGAP REMEDIATION TESTS: ' + passed + ' passed, ' + failed + ' failed');
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
