-- Stage 5 (Events): multi-currency contributions (amount stays TZS-equivalent, source currency retained)

ALTER TABLE event_contributions ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'TZS';
ALTER TABLE event_contributions ADD COLUMN IF NOT EXISTS currency_amount NUMERIC(15,2);
UPDATE event_contributions SET currency_amount = amount WHERE currency_amount IS NULL;
ALTER TABLE event_contributions ALTER COLUMN currency_amount SET NOT NULL;