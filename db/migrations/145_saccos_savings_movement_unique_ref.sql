-- Migration 145: Add unique constraint on saccos_savings_movements.reference_id
-- Purpose: Defense-in-depth for savings movement idempotency
-- Pre-check: SELECT reference_id, count(*) FROM saccos_savings_movements GROUP BY reference_id HAVING count(*) > 1;
-- Rollback: ALTER TABLE saccos_savings_movements DROP CONSTRAINT uq_saccos_savings_movements_ref;

ALTER TABLE saccos_savings_movements
ADD CONSTRAINT uq_saccos_savings_movements_ref
UNIQUE (reference_id);
