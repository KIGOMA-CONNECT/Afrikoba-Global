-- ============================================
-- DATABASE OPTIMIZATION - Performance Indexes
-- ============================================

-- Users: frequent lookups
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- OTP: lookup by phone + purpose + used
CREATE INDEX IF NOT EXISTS idx_otp_lookup ON otp_codes(phone_number, purpose, used, created_at DESC);

-- Transactions: high-traffic
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_type_status ON transactions(type, status);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_external ON transactions(external_tx_id);

-- Wallet ledger: double-entry lookups
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_tx ON wallet_ledger(transaction_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_from ON wallet_ledger(from_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_to ON wallet_ledger(to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_ref ON wallet_ledger(reference_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_created ON wallet_ledger(created_at DESC);

-- KYC documents: user lookups
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_status ON kyc_documents(status);
CREATE INDEX IF NOT EXISTS idx_kyc_user_status ON kyc_documents(user_id, status);

-- VICOBA members: group + user lookups
CREATE INDEX IF NOT EXISTS idx_vicoba_members_user ON vicoba_members(user_id);
CREATE INDEX IF NOT EXISTS idx_vicoba_members_group_role ON vicoba_members(group_id, role_in_group);

-- VICOBA groups
CREATE INDEX IF NOT EXISTS idx_vicoba_groups_status ON vicoba_groups(status);
CREATE INDEX IF NOT EXISTS idx_vicoba_groups_created ON vicoba_groups(created_at DESC);

-- VICOBA loan requests
CREATE INDEX IF NOT EXISTS idx_vicoba_loans_group ON vicoba_loan_requests(group_id, status);
CREATE INDEX IF NOT EXISTS idx_vicoba_loans_applicant ON vicoba_loan_requests(applicant_user_id);
CREATE INDEX IF NOT EXISTS idx_vicoba_loans_status ON vicoba_loan_requests(status);

-- VICOBA meetings
CREATE INDEX IF NOT EXISTS idx_vicoba_meetings_group_date ON vicoba_meetings(group_id, meeting_date DESC);

-- ROSCA pools
CREATE INDEX IF NOT EXISTS idx_rosca_pools_status ON rosca_pools(status);
CREATE INDEX IF NOT EXISTS idx_rosca_pools_created ON rosca_pools(created_at DESC);

-- ROSCA members
CREATE INDEX IF NOT EXISTS idx_rosca_members_user ON rosca_members(user_id);
CREATE INDEX IF NOT EXISTS idx_rosca_members_pool ON rosca_members(pool_id);

-- ROSCA schedules
CREATE INDEX IF NOT EXISTS idx_rosca_schedules_pool_status ON rosca_schedules(pool_id, status);
CREATE INDEX IF NOT EXISTS idx_rosca_schedules_date ON rosca_schedules(scheduled_date);

-- P2P investment projects
CREATE INDEX IF NOT EXISTS idx_p2p_projects_status ON investment_projects(status);
CREATE INDEX IF NOT EXISTS idx_p2p_projects_owner ON investment_projects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_p2p_projects_sector ON investment_projects(sector);
CREATE INDEX IF NOT EXISTS idx_p2p_projects_created ON investment_projects(created_at DESC);

-- P2P investments
CREATE INDEX IF NOT EXISTS idx_p2p_investments_investor ON investments(investor_user_id);
CREATE INDEX IF NOT EXISTS idx_p2p_investments_project ON investments(project_id);
CREATE INDEX IF NOT EXISTS idx_p2p_investments_project_status ON investments(project_id, status);

-- P2P escrow milestones
CREATE INDEX IF NOT EXISTS idx_p2p_milestones_project ON escrow_milestones(project_id, status);

-- P2P project audit steps
CREATE INDEX IF NOT EXISTS idx_p2p_audit_steps_project ON project_audit_steps(project_id);

-- P2P revenue split runs
CREATE INDEX IF NOT EXISTS idx_p2p_split_runs_project ON revenue_split_runs(project_id);

-- Audit logs: already has indexes, add a few more
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_created ON audit_log(entity_type, entity_id, created_at DESC);

-- Idempotency keys: cleanup query
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON idempotency_keys(key_value);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_user ON idempotency_keys(user_id);
