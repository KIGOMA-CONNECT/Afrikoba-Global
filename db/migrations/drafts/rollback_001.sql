-- ROLLBACK for draft migration A (institution foundation)
DROP TABLE IF EXISTS institution_ownership_approvals;
DROP TABLE IF EXISTS institution_ownership_requests;
DROP TABLE IF EXISTS institution_role_grants;
DROP TABLE IF EXISTS institution_resource_bindings;
DROP TABLE IF EXISTS institution_owners;
DROP TABLE IF EXISTS institutions;
