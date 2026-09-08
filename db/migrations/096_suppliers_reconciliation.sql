-- ============================================================================
-- 096 SUPPLIERS SCHEMA RECONCILIATION (Gap C1)
-- Migration 047 (procurement) declared `CREATE TABLE IF NOT EXISTS suppliers`
-- with the procurement shape (owner_user_id, business_name, category ...). On
-- databases where migration 020 (commerce) ran first, that statement was a
-- silent no-op, so the procurement columns never materialised and
-- procurementService.js queries would fail at runtime.
--
-- This migration unions the procurement columns onto the existing commerce
-- `suppliers` table (idempotent, additive, no data moves):
--   * 020 commerce rows keep business_id / name / phone / total_paid.
--   * 047 procurement profiles add owner_user_id / business_name / category /
--     description / rating / verified.
--   * FK from supplier_payments / supplier_financing to suppliers(id) is
--     untouched -> live rows (42 commerce suppliers, financing row id 3)
--     remain valid.
--   * A PARTIAL unique index restores 047's UNIQUE(owner_user_id,business_name)
--     only among procurement profiles (commerce rows have NULL owner_user_id).
-- Non-negotiable: additive only; never deletes rows or drops constraints.
-- ============================================================================

-- Procurement profile columns (047 shape), additive on the existing table.
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS owner_user_id INT REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS business_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS category VARCHAR(80),
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS rating NUMERIC(3,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;

-- 020 declared business_id + name NOT NULL (commerce caller always supplies
-- them). Procurement-only profiles (owner_user_id + business_name) must be
-- insertable on the same table, so relax the two commerce NOT NULL columns.
-- Commerce inserts are unaffected (they always pass business_id + name).
ALTER TABLE suppliers ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE suppliers ALTER COLUMN name DROP NOT NULL;

-- A commerce row and a procurement row share the same table; enforce 047's
-- uniqueness only among procurement profiles (owner_user_id IS NOT NULL), so
-- no commerce row is affected and NULL owner rows never collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_procurement_profile
  ON suppliers (owner_user_id, business_name)
  WHERE owner_user_id IS NOT NULL AND business_name IS NOT NULL;

-- 020 commerce index (already exists when 020 ran first; safe no-op otherwise).
CREATE INDEX IF NOT EXISTS idx_suppliers_business ON suppliers(business_id);