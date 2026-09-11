-- ============================================================
-- SACCOS DIGITAL CORE - MEETINGS, ATTENDANCE & MINUTES
-- (increment 14)
-- Entity-scoped meeting lifecycle layered over the governance
-- module: DRAFT -> OPEN -> CLOSED -> MINUTES_PUBLISHED.
--   - Agenda items are structured rows (positioned, completable)
--     resolved when the board publishes the minutes.
--   - Attendance is per-member (UNIQUE(meeting_id, member_id)):
--     members self check-in (PRESENT) while OPEN, the board can
--     mark any member PRESENT/ABSENT/EXCUSED.
--   - Closing computes quorum (PRESENT + EXCUSED) against ACTIVE
--     members and the meeting's quorum_pct and records quorum_met.
-- Owners/BOARD create/open/close and publish minutes; all ACTIVE
-- members may list/view meetings and check in. Cross-entity 404.
-- ============================================================

CREATE TABLE IF NOT EXISTS saccos_meetings (
  id SERIAL PRIMARY KEY,
  saccos_id INT NOT NULL REFERENCES saccos(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  location VARCHAR(160),
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED', 'MINUTES_PUBLISHED')),
  quorum_pct INT NOT NULL DEFAULT 50
    CHECK (quorum_pct BETWEEN 1 AND 100),
  quorum_met BOOLEAN,
  minutes TEXT,
  published_at TIMESTAMPTZ,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saccos_meeting_agenda_items (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES saccos_meetings(id) ON DELETE CASCADE,
  position INT NOT NULL,
  title VARCHAR(200) NOT NULL,
  notes TEXT,
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (meeting_id, position)
);

CREATE TABLE IF NOT EXISTS saccos_meeting_attendance (
  id SERIAL PRIMARY KEY,
  meeting_id INT NOT NULL REFERENCES saccos_meetings(id) ON DELETE CASCADE,
  member_id INT NOT NULL REFERENCES saccos_members(id) ON DELETE CASCADE,
  status VARCHAR(12) NOT NULL DEFAULT 'PRESENT'
    CHECK (status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
  marked_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (meeting_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_saccos_meetings_saccos
  ON saccos_meetings (saccos_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_saccos_meeting_agenda_meeting
  ON saccos_meeting_agenda_items (meeting_id, position);
CREATE INDEX IF NOT EXISTS idx_saccos_meeting_attendance_meeting
  ON saccos_meeting_attendance (meeting_id, status);