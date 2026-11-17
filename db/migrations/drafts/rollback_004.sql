-- rollback 004
DROP TABLE IF EXISTS gsf_governance_audit_events;
DROP TABLE IF EXISTS gsf_campaign_institution_links;
DROP TABLE IF EXISTS gsf_ownership_change_approvals;
DROP TABLE IF EXISTS gsf_ownership_change_requests;
DROP TABLE IF EXISTS gsf_governance_grants;
DROP TABLE IF EXISTS gsf_governance_permissions;
DROP TABLE IF EXISTS gsf_institution_members;
DROP TABLE IF EXISTS gsf_institution_owners;
DROP TABLE IF EXISTS gsf_institution_evidence;
-- institutions table is owned by draft 001; not dropped here
