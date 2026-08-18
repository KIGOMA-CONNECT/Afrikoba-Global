-- =====================================================
-- AFRIKOBA GLOBAL - SEED DATA
-- =====================================================

-- Super Admin
INSERT INTO users (full_name, phone_number, email, role, nida_number, kyc_level, trust_score)
VALUES
('Afrikoba Super Admin', '255712000001', 'admin@afrikoba.com', 'ADMIN', '19900101123456789', 2, 100)
ON CONFLICT (phone_number) DO NOTHING;

-- Sample members (Asha & Juma have KYC L2 for P2P testing)
INSERT INTO users (full_name, phone_number, email, role, wallet_balance, trust_score, kyc_level, nida_number)
VALUES
('Asha Mohamed', '255713100001', 'asha@example.com', 'MJUMBE', 150000.00, 95, 2, '19880101123456789'),
('Juma Hassan', '255714100002', 'juma@example.com', 'MJUMBE', 200000.00, 90, 2, '19870101123456790'),
('Neema Kimaro', '255715100003', 'neema@example.com', 'MJUMBE', 85000.00, 88, 1, NULL),
('Baraka Mushi', '255716100004', 'baraka@example.com', 'MJUMBE', 50000.00, 92, 1, NULL)
ON CONFLICT (phone_number) DO NOTHING;

-- =====================================================
-- SERVICE SUBSCRIPTIONS (choose-your-services model)
-- Wallet ni ya msingi - kila mtumiaji anafunguliwa automatically
-- =====================================================
INSERT INTO user_service_subscriptions (user_id, service_key)
SELECT id, 'WALLET' FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM user_service_subscriptions s
    WHERE s.user_id = u.id AND s.service_key = 'WALLET'
);

-- Demo users already use the other services
INSERT INTO user_service_subscriptions (user_id, service_key)
SELECT u.id, s.service_key
FROM users u
CROSS JOIN (VALUES ('VICOBA'), ('ROSCA'), ('P2P')) AS s(service_key)
WHERE u.phone_number IN (
    '255712000001', '255713100001', '255714100002',
    '255715100003', '255716100004'
)
AND NOT EXISTS (
    SELECT 1 FROM user_service_subscriptions x
    WHERE x.user_id = u.id AND x.service_key = s.service_key
);

-- Sample VICOBA Group
INSERT INTO vicoba_groups (group_name, cycle_type, share_value, monthly_maintenance_fee, created_by_user_id, join_code)
SELECT 'Mwanzo Mpya VICOBA', 'MONTHLY', 20000.00, 10000.00, id, 'MWANZO2026'
FROM users WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;

-- Group officers
INSERT INTO vicoba_members (group_id, user_id, role_in_group)
SELECT g.id, u.id, 'MWENYEKITI'
FROM vicoba_groups g, users u
WHERE g.group_name = 'Mwanzo Mpya VICOBA' AND u.phone_number = '255713100001'
ON CONFLICT DO NOTHING;

INSERT INTO vicoba_members (group_id, user_id, role_in_group)
SELECT g.id, u.id, 'MWEKAHAZINA'
FROM vicoba_groups g, users u
WHERE g.group_name = 'Mwanzo Mpya VICOBA' AND u.phone_number = '255714100002'
ON CONFLICT DO NOTHING;

INSERT INTO vicoba_members (group_id, user_id, role_in_group)
SELECT g.id, u.id, 'KATIBU'
FROM vicoba_groups g, users u
WHERE g.group_name = 'Mwanzo Mpya VICOBA' AND u.phone_number = '255715100003'
ON CONFLICT DO NOTHING;

INSERT INTO vicoba_members (group_id, user_id, role_in_group)
SELECT g.id, u.id, 'MJUMBE'
FROM vicoba_groups g, users u
WHERE g.group_name = 'Mwanzo Mpya VICOBA' AND u.phone_number = '255716100004'
ON CONFLICT DO NOTHING;

-- Sample ROSCA Public Pool (kikoba cha wazi)
INSERT INTO rosca_pools (pool_name, contribution_amount, cycle_frequency, total_members, pool_type, created_by_user_id)
SELECT 'Upatu wa Wiki 10 - 50k', 50000.00, 'WEEKLY', 10, 'PUBLIC', id
FROM users WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;

-- Sample P2P Project (TAINFUND: business_plan + team_info required, starts as SUBMITTED)
INSERT INTO investment_projects
(owner_user_id, title, sector, description, target_amount, share_price, roi_percentage, tenure_months, payback_start_months,
 business_plan, team_info, min_investment_amount, status)
SELECT id, 'Kuku wa Mayai - Kibaha', 'KILIMO',
       'Mradi wa ufugaji wa kuku wa mayai wenye uwezo wa kutaga mayai 5,000 kwa siku.',
       5000000.00, 100000.00, 18.00, 12, 4,
       'Mpango wa biashara: Ufugaji wa kuku 2,000, malipo ya bei ya soko TZS 300 kwa yai, mzunguko wa mapato TZS 150,000 kwa siku.',
       'Timu: Mjasiriamali mwenye uzoefu wa miaka 5 katika ufugaji, msaidizi wa veterinari, muuzaji wa mazao.',
       50000.00, 'SUBMITTED'
FROM users WHERE role = 'ADMIN'
ON CONFLICT DO NOTHING;

-- Audit steps for the sample project
INSERT INTO project_audit_steps (project_id, step_name)
SELECT id, 'KYC_KYB_VERIFICATION' FROM investment_projects WHERE title = 'Kuku wa Mayai - Kibaha'
ON CONFLICT DO NOTHING;
INSERT INTO project_audit_steps (project_id, step_name)
SELECT id, 'FINANCIAL_AUDIT' FROM investment_projects WHERE title = 'Kuku wa Mayai - Kibaha'
ON CONFLICT DO NOTHING;
INSERT INTO project_audit_steps (project_id, step_name)
SELECT id, 'ESCROW_SETUP' FROM investment_projects WHERE title = 'Kuku wa Mayai - Kibaha'
ON CONFLICT DO NOTHING;
INSERT INTO project_audit_steps (project_id, step_name)
SELECT id, 'LEGAL_PRE_APPROVAL' FROM investment_projects WHERE title = 'Kuku wa Mayai - Kibaha'
ON CONFLICT DO NOTHING;

-- Project Business Wallet & Settlement Rules (70/28/2) kwa sample project
INSERT INTO project_business_wallets (project_id)
SELECT id FROM investment_projects WHERE title = 'Kuku wa Mayai - Kibaha'
ON CONFLICT DO NOTHING;

INSERT INTO project_settlement_rules (project_id)
SELECT id FROM investment_projects WHERE title = 'Kuku wa Mayai - Kibaha'
ON CONFLICT DO NOTHING;
