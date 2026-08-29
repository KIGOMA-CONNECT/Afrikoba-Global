-- 025_auth_hardening.sql
-- Auth strengthening:
--  - auth_version: huhifadhi "generation" ya kikao. Kila mabadiliko ya password
--    huongeza thamani, na tokens zote za zamani (zisizo na av sahihi) zinakataliwa
--    → password change = kufunga vikao vyote vya zamani papo hapo.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;