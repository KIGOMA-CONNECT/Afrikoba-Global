-- 030_audit_logs.sql
-- Append-only audit trail for sensitive administrative and financial actions

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id UUID, -- Action performer (NULL for system actions)
    action VARCHAR(100) NOT NULL, -- e.g., 'LOAN_APPROVED', 'ROLE_CHANGED'
    entity_type VARCHAR(50), -- e.g., 'USER', 'VICOBA', 'LOAN'
    entity_id UUID,
    changes JSONB, -- Previous state vs New state
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
