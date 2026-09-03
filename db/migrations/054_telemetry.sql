-- Migration 054: Trace-level observability & request telemetry table

CREATE TABLE IF NOT EXISTS request_telemetry (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(64) NOT NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(255) NOT NULL,
  status_code INT NOT NULL,
  duration_ms INT NOT NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_trace ON request_telemetry(trace_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_path ON request_telemetry(path);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON request_telemetry(created_at);
