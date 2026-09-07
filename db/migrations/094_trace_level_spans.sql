-- ============================================================
-- 094 TRACE-LEVEL SPAN TRACING (parent/child OpenTelemetry-style)
-- Advances the existing request_telemetry root-row table into a
-- full parent/child span capture. A single distributed trace is
-- composed of:
--   - a ROOT span (the HTTP request) with span_id + trace_id
--   - zero or more CHILD spans (internal operations such as
--     ledger postings, auth, wallet movement) each referencing
--     its parent span_id and the same trace_id.
-- request_telemetry gains span columns; a dedicated trace_spans
-- table records every span (root + child) so the full tree for a
-- trace_id can be reconstructed and surfaced in the Ops tracing UI.
-- ============================================================

-- Extend the root telemetry table with span context.
ALTER TABLE request_telemetry
  ADD COLUMN IF NOT EXISTS span_id VARCHAR(32),
  ADD COLUMN IF NOT EXISTS span_kind VARCHAR(16) DEFAULT 'ROOT', -- ROOT | INTERNAL | SERVER | CLIENT
  ADD COLUMN IF NOT EXISTS operation VARCHAR(120);

-- Dedicated span table holding every span in the tree (root + children).
CREATE TABLE IF NOT EXISTS trace_spans (
  id            SERIAL PRIMARY KEY,
  trace_id      VARCHAR(64) NOT NULL,
  span_id       VARCHAR(32) NOT NULL,
  parent_span_id VARCHAR(32),
  span_kind     VARCHAR(16) NOT NULL DEFAULT 'ROOT', -- ROOT | INTERNAL | SERVER | CLIENT
  service_name  VARCHAR(80)  DEFAULT 'afrikoba-backend',
  operation     VARCHAR(120) NOT NULL,
  start_ms      BIGINT NOT NULL,
  duration_ms   INT NOT NULL,
  status        VARCHAR(16) DEFAULT 'OK',            -- OK | ERROR
  user_id       INT REFERENCES users(id) ON DELETE SET NULL,
  ip_address    VARCHAR(45),
  attributes    JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trace_spans_trace   ON trace_spans(trace_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_trace_spans_span    ON trace_spans(span_id);
CREATE INDEX IF NOT EXISTS idx_trace_spans_parent  ON trace_spans(parent_span_id);
