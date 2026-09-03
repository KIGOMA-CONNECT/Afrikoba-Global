-- ============================================================================
-- 047 COMMERCE / PROCUREMENT / SUPPLIER NETWORK (Phase 9)
-- Builds on the existing marketplace + escrow modules with:
--  1) suppliers          - supplier onboarding/verification profiles
--  2) procurement_requests - buyer RFQs (category, quantity, budget cap, deadline)
--  3) procurement_bids   - supplier offers; buyer accepts -> prices the award
--  4) supplier_financing - working-capital advance against an awarded request,
--                          tracked via the financial engine and a unique ref.
-- Non-negotiable: finances move only through the ledger, idempotent on a unique
-- reference, and are never deleted (status updates only).
-- ============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id             SERIAL PRIMARY KEY,
  owner_user_id  INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name  VARCHAR(200) NOT NULL,
  category       VARCHAR(80),
  description    TEXT,
  rating         NUMERIC(3,2) DEFAULT 0,
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_user_id, business_name)
);

CREATE TABLE IF NOT EXISTS procurement_requests (
  id           SERIAL PRIMARY KEY,
  buyer_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  category     VARCHAR(80),
  quantity     NUMERIC(15,2) NOT NULL DEFAULT 1,
  budget_cap   NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (budget_cap >= 0),
  deadline     DATE,
  status       VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT','OPEN','ACCEPTING_BIDS','CLOSED','AWARDED','CANCELLED')),
  selected_bid_id INT,
  created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_proc_req_buyer ON procurement_requests(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_proc_req_status ON procurement_requests(status);

CREATE TABLE IF NOT EXISTS procurement_bids (
  id            SERIAL PRIMARY KEY,
  request_id    INT NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  supplier_id   INT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  amount        NUMERIC(19,2) NOT NULL CHECK (amount >= 0),
  delivery_days INT,
  note          TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','ACCEPTED','REJECTED','WITHDRAWN')),
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (request_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS supplier_financing (
  id               SERIAL PRIMARY KEY,
  supplier_id      INT NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  request_id       INT REFERENCES procurement_requests(id) ON DELETE SET NULL,
  amount           NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  term_months      INT,
  annual_rate      NUMERIC(5,2) DEFAULT 10.00,
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','DISBURSED','REPAID','DEFAULTED')),
  unique_reference VARCHAR(64) UNIQUE,
  txn_id           INT,
  created_at       TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
