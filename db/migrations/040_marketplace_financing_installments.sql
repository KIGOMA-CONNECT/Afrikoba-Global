CREATE TABLE IF NOT EXISTS marketplace_financing_installments (
  id SERIAL PRIMARY KEY,

  financing_id INT NOT NULL
    REFERENCES marketplace_financing(id)
    ON DELETE CASCADE,

  installment_no INT NOT NULL
    CHECK (installment_no >= 1),

  due_date DATE NOT NULL,

  principal_due NUMERIC(15,2) NOT NULL
    CHECK (principal_due >= 0),

  fee_due NUMERIC(15,2) NOT NULL
    CHECK (fee_due >= 0),

  total_due NUMERIC(15,2) NOT NULL
    CHECK (total_due >= 0),

  principal_paid NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (principal_paid >= 0),

  fee_paid NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (fee_paid >= 0),

  total_paid NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (total_paid >= 0),

  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'OVERDUE')),

  days_late INT NOT NULL DEFAULT 0
    CHECK (days_late >= 0),

  late_fee NUMERIC(15,2) NOT NULL DEFAULT 0
    CHECK (late_fee >= 0),

  paid_at TIMESTAMPTZ,

  reference_id VARCHAR(64) UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (financing_id, installment_no)
);

CREATE INDEX IF NOT EXISTS idx_mkt_fin_installments_financing
  ON marketplace_financing_installments (financing_id, installment_no);

CREATE INDEX IF NOT EXISTS idx_mkt_fin_installments_status_due
  ON marketplace_financing_installments (status, due_date);

CREATE INDEX IF NOT EXISTS idx_mkt_fin_installments_due
  ON marketplace_financing_installments (financing_id, due_date);

