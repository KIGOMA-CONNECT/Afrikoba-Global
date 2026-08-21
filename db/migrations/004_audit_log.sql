-- ============================================
-- AUDIT LOG - Immutable trail for all money movements & admin actions
-- ============================================
-- PCI-DSS / SOC2 requirement: every financial mutation must be traceable

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  event_type    VARCHAR(50) NOT NULL,        -- DEPOSIT, WITHDRAWAL, TRANSFER, INVESTMENT, VICOBA_SHARE, etc.
  action        VARCHAR(50) NOT NULL,        -- CREATE, UPDATE, DELETE, APPROVE, REJECT, RELEASE
  entity_type   VARCHAR(50) NOT NULL,        -- USER, TRANSACTION, PROJECT, VICOBA_GROUP, etc.
  entity_id     INTEGER,
  user_id       INTEGER,                     -- who performed the action
  actor_role    VARCHAR(30),                 -- ADMIN, USER, SYSTEM, CRON
  before_data   JSONB,                       -- state before (for UPDATE/DELETE)
  after_data    JSONB,                       -- state after (for CREATE/UPDATE)
  ip_address    VARCHAR(45),                 -- IPv4/IPv6
  user_agent    VARCHAR(255),
  reference_id  VARCHAR(30),                 -- links to transactions.reference_id
  amount        NUMERIC(15,2),               -- monetary amount if applicable
  currency      VARCHAR(3) DEFAULT 'TZS',
  status        VARCHAR(20) DEFAULT 'SUCCESS', -- SUCCESS, FAILED, PENDING
  error_message TEXT,
  metadata      JSONB,                       -- additional context
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Indexes for querying audit trail
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_log(event_type, action);
CREATE INDEX IF NOT EXISTS idx_audit_log_reference ON audit_log(reference_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
