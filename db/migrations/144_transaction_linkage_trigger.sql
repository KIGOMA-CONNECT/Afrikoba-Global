-- Phase 68: Automatic transaction linkage trigger
-- Links financial_operations and journal_entries to business transactions
-- based on reference_id matching when a transaction row is inserted.

CREATE OR REPLACE FUNCTION link_transaction_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  -- Link financial_operations
  -- Use starts_with() instead of LIKE to avoid wildcard injection
  -- when reference_id contains '%' or '_' characters.
  UPDATE financial_operations
  SET transaction_id = NEW.id
  WHERE (reference_id = NEW.reference_id
         OR starts_with(reference_id, NEW.reference_id || ':'))
    AND transaction_id IS NULL;

  -- Link journal_entries
  UPDATE journal_entries
  SET transaction_id = NEW.id
  WHERE (reference_id = NEW.reference_id
         OR starts_with(reference_id, NEW.reference_id || ':'))
    AND transaction_id IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_link_transaction ON transactions;
CREATE TRIGGER trg_link_transaction
  AFTER INSERT ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION link_transaction_on_insert();
