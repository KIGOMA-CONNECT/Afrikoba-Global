-- ============================================================================
-- 044 PROJECT CAPITAL & CONTROLLED PROJECT FINANCE
-- Implements the Afrikoba "Project Fundraising & Controlled Project Finance"
-- module (developer directive phases 5-7).
-- Every funded project gets its own ledger-controlled project account; funds are
-- released only against approved milestones; revenue flows back into the project
-- account; distributions are computed per the accepted investor agreement.
-- Non-negotiable: personal wallets are never used as project custody; completed
-- financial records are never deleted (append/update-only, auditable).
-- ============================================================================

-- Ledger account type for project funds (shared liability classification).
INSERT INTO ledger_accounts (account_code, name, account_type) VALUES
  ('PROJECT_FUND', 'Project Fund Liability', 'LIABILITY'),
  ('PROJECT_REVENUE_RECEIVABLE', 'Project Revenue Receivable', 'ASSET')
ON CONFLICT (account_code) DO NOTHING;

-- The transactions.type CHECK enum is extended across many migrations and is a
-- maintenance trap; project allocations add several more types. Relax it so any
-- future product type is representable while auditability is preserved via the
-- dedicated project tables + audit_logs.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;

-- ------------------------- PROJECTS ----------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id                 SERIAL PRIMARY KEY,
  owner_user_id      INTEGER NOT NULL REFERENCES users(id),
  name               VARCHAR(160) NOT NULL,
  description        TEXT,
  category           VARCHAR(80),
  location           VARCHAR(160),
  capital_required   NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (capital_required >= 0),
  amount_raised      NUMERIC(19,2) NOT NULL DEFAULT 0 CHECK (amount_raised >= 0),
  min_investment     NUMERIC(19,2) NOT NULL DEFAULT 0,
  duration_days      INTEGER,
  expected_revenue   NUMERIC(19,2),
  expected_costs     NUMERIC(19,2),
  projected_profit   NUMERIC(19,2),
  reinvestment_pct   NUMERIC(5,2) DEFAULT 0,
  reserve_pct        NUMERIC(5,2) DEFAULT 0,
  owner_equity_pct   NUMERIC(5,2) DEFAULT 0,
  distribution_method TEXT,
  risks              TEXT,
  assumptions        TEXT,
  business_plan      TEXT,
  status             VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN
                       ('DRAFT','SUBMITTED','INITIAL_REVIEW','DUE_DILIGENCE',
                        'RISK_ASSESSMENT','GOVERNANCE_REVIEW','APPROVED','REJECTED',
                        'PUBLISHED','FUNDING','ACTIVE','COMPLETED','CANCELLED')),
  current_stage      VARCHAR(40) DEFAULT 'DRAFT',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_owner  ON projects(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- ------------------------- PROJECT DOCUMENTS -------------------------------
CREATE TABLE IF NOT EXISTS project_documents (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  doc_type   VARCHAR(40),
  title      VARCHAR(200),
  url        TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- APPROVAL WORKFLOW -------------------------------
-- Every decision in the workflow is recorded (reviewer, decision, reason,
-- risk classification, evidence) and is append-only.
CREATE TABLE IF NOT EXISTS project_approvals (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  stage               VARCHAR(40) NOT NULL,
  decision            VARCHAR(20) NOT NULL,           -- APPROVED / REJECTED / RETURNED
  reviewer_user_id    INTEGER NOT NULL REFERENCES users(id),
  reason              TEXT,
  risk_classification VARCHAR(40),
  evidence            TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- INVESTMENT AGREEMENTS ----------------------------
-- Versioned, auditable terms that an investor must accept before investing.
CREATE TABLE IF NOT EXISTS project_agreements (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  version           INTEGER NOT NULL DEFAULT 1,
  terms             JSONB NOT NULL,
  accepted_user_id  INTEGER REFERENCES users(id),
  accepted_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, version)
);

-- ------------------------- INVESTMENTS --------------------------------------
CREATE TABLE IF NOT EXISTS project_investments (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  investor_user_id    INTEGER NOT NULL REFERENCES users(id),
  amount              NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  participation_pct   NUMERIC(9,6),
  agreement_version   INTEGER,
  status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','CONFIRMED','CANCELLED')),
  unique_reference    VARCHAR(64) UNIQUE,               -- idempotency key
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, investor_user_id, status, agreement_version)
);

-- ------------------------- PROJECT BUDGET -----------------------------------
CREATE TABLE IF NOT EXISTS project_budget (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  category         VARCHAR(120) NOT NULL,
  phase            VARCHAR(80),
  approved_amount  NUMERIC(19,2) NOT NULL DEFAULT 0,
  actual_amount    NUMERIC(19,2) NOT NULL DEFAULT 0,
  responsible      VARCHAR(160),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- MILESTONES / PHASES ------------------------------
CREATE TABLE IF NOT EXISTS project_milestones (
  id                  SERIAL PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id),
  phase               VARCHAR(80),
  name                VARCHAR(160),
  budget              NUMERIC(19,2) NOT NULL DEFAULT 0,
  start_date          DATE,
  expected_end_date   DATE,
  actual_end_date     DATE,
  deliverables        TEXT,
  status              VARCHAR(20) NOT NULL DEFAULT 'NOT_STARTED'
                      CHECK (status IN ('NOT_STARTED','IN_PROGRESS','COMPLETED')),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, name)
);

-- ------------------------- CONTROLLED DISBURSEMENTS -------------------------
CREATE TABLE IF NOT EXISTS project_disbursements (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  milestone_id     INTEGER REFERENCES project_milestones(id),
  amount           NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','AUTHORIZED','RELEASED','REJECTED')),
  authorized_by    INTEGER REFERENCES users(id),
  reason           TEXT,
  unique_reference VARCHAR(64) UNIQUE,                 -- idempotency key
  txn_id           INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- PROGRESS REPORTS (append-only) -------------------
CREATE TABLE IF NOT EXISTS project_progress_reports (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  version           INTEGER NOT NULL,
  completion_pct    NUMERIC(5,2),
  expenditure       NUMERIC(19,2),
  details           JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, version)
);

-- ------------------------- PROJECT REVENUE ----------------------------------
CREATE TABLE IF NOT EXISTS project_revenue (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  revenue_type      VARCHAR(40),
  amount            NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  reconciled        BOOLEAN DEFAULT FALSE,
  unique_reference  VARCHAR(64) UNIQUE,                -- idempotency key
  txn_id            INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- PROJECT PAYROLL ----------------------------------
CREATE TABLE IF NOT EXISTS project_payroll (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id),
  payee_user_id     INTEGER NOT NULL REFERENCES users(id),
  role              VARCHAR(80),
  amount            NUMERIC(19,2) NOT NULL CHECK (amount > 0),
  unique_reference  VARCHAR(64) UNIQUE,                -- idempotency key
  txn_id            INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- DISTRIBUTIONS ------------------------------------
CREATE TABLE IF NOT EXISTS project_distributions (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  investor_user_id INTEGER NOT NULL REFERENCES users(id),
  period_label     VARCHAR(40),
  gross_profit     NUMERIC(19,2),
  investor_pct     NUMERIC(9,6),
  amount           NUMERIC(19,2) NOT NULL CHECK (amount >= 0),
  status           VARCHAR(20) NOT NULL DEFAULT 'CALCULATED'
                   CHECK (status IN ('CALCULATED','PAID','FAILED')),
  unique_reference VARCHAR(64) UNIQUE,                -- idempotency key
  txn_id           INTEGER,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------- PROJECT RESERVES ---------------------------------
CREATE TABLE IF NOT EXISTS project_reserves (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id),
  reserve_type     VARCHAR(40) NOT NULL,               -- OPERATIONAL / MAINTENANCE / EMERGENCY / TAX / REINVESTMENT
  amount           NUMERIC(19,2) NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, reserve_type)
);
