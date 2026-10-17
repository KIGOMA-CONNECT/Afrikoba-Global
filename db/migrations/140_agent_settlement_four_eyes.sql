-- Four-Eyes approval is required before agent settlement changes balances.
INSERT INTO four_eyes_policies
  (action_code, description, required_approvers, approver_roles, enabled, allow_self_approve)
VALUES
  ('AGENT_SETTLEMENT', 'Approve agent float settlement before posting financial effects', 1, ARRAY['ADMIN'], TRUE, FALSE)
ON CONFLICT (action_code) DO NOTHING;
