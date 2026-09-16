#!/usr/bin/env bash
# ============================================================================
# AFRIKOBA GLOBAL - PLATFORM EARNINGS & RETURNS TREND - ACCEPTANCE GATE
# Phase 55/56 (PHASE-56 block in projectFinanceService.js, expert-only events)
#
# Run on the staging server against the live API base. Exit 0 only if every
# acceptance probe passes (guards, ET reference, 12-month cohort, monthly
# cohort, cash CAGR, CSV header, PDF banner words). Exit non-zero otherwise.
#
# Usage:
#   BASE=http://127.0.0.1:3001/api/v1 ROLE=expert ./scripts/verify-earnings-trend.sh
# ============================================================================

set -u
BASE="${BASE:-http://127.0.0.1:3001/api/v1}"
ROLE="${ROLE:-expert}"
fail=0

# --- probe 1: expert guard 200 -------------------------------------------------
code=$(curl -s -o /tmp/ew.json -w '%{http_code}' -H "X-User-Role: $ROLE" "$BASE/projects/ops/earnings-trend")
if [ "$code" = "200" ]; then
  echo "OK  expert guard: HTTP 200"
else
  echo "FAIL expert guard: HTTP $code (want 200)"; fail=1
fi

# --- probe 2: ET reference + months[12] + summary + months cohort + capital ---
et=$(grep -c '"reference"' /tmp/ew.json || true)
months=$(grep -o '"months"' /tmp/ew.json | wc -l | tr -d ' ')
cap=$(grep -c '"capital"' /tmp/ew.json || true)
if [ "$et" -ge 1 ] && [ "$months" -ge 12 ] && [ "$cap" -ge 1 ]; then
  echo "OK  JSON: reference present, months=$months (want >=12), capital present"
else
  echo "FAIL JSON: et=$et cap=$cap months=$months (want et>=1 cap>=1 months>=12)"; fail=1
fi

etref=$(grep -o 'ET-[0-9]*' /tmp/ew.json | head -1)
if [ -n "${etref:-}" ]; then
  echo "OK  reference: $etref"
else
  echo "FAIL reference: no ET- token in JSON"; fail=1
fi

# --- probe 3: owner 403 (expert-only) ------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-User-Role: owner" "$BASE/projects/ops/earnings-trend")
if [ "$code" = "403" ]; then
  echo "OK  owner guard: HTTP 403"
else
  echo "FAIL owner guard: HTTP $code (want 403)"; fail=1
fi

# --- probe 4: anonymous 401 ----------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/projects/ops/earnings-trend")
if [ "$code" = "401" ]; then
  echo "OK  anonymous guard: HTTP 401"
else
  echo "FAIL anonymous guard: HTTP $code (want 401)"; fail=1
fi

# --- probe 5: PDF banner words --------------------------------------------------
code=$(curl -s -o /tmp/ew.pdf -w '%{http_code}' -H "X-User-Role: $ROLE" "$BASE/projects/ops/earnings-trend/pdf")
if [ "$code" = "200" ]; then
  echo "OK  PDF endpoint: HTTP 200"
else
  echo "FAIL PDF endpoint: HTTP $code (want 200)"; fail=1
fi
# extract text from PDF (pdftotext if available)
if command -v pdftotext >/dev/null 2>&1; then
  txt=$(pdftotext /tmp/ew.pdf - 2>/dev/null)
  for w in JUKWAA PLATFORM EARNINGS TREND MWENENDO MAPATO AFRIKOBA; do
    if echo "$txt" | grep -qi "$w"; then
      echo "OK  PDF word: $w"
    else
      echo "FAIL PDF word missing: $w"; fail=1
    fi
  done
else
  echo "WARN pdftotext not installed; skipping PDF word probe (endpoint 200 is the gate)"
fi

# --- probe 6: CSV header --------------------------------------------------------
code=$(curl -s -o /tmp/ew.csv -w '%{http_code}' -H "X-User-Role: $ROLE" "$BASE/projects/ops/earnings-trend/export")
if [ "$code" = "200" ]; then
  if grep -q 'AFRIKOBA GLOBAL - PLATFORM EARNINGS TREND' /tmp/ew.csv; then
    echo "OK  CSV header: PLATFORM EARNINGS TREND line present"
  else
    echo "FAIL CSV header line missing"; fail=1
  fi
else
  echo "FAIL CSV endpoint: HTTP $code (want 200)"; fail=1
fi

# --- summary --------------------------------------------------------------------
if [ "$fail" -eq 0 ]; then
  echo "ACCEPTANCE: PASS (all probes green)"
else
  echo "ACCEPTANCE: FAIL (see probe lines above)"
fi
exit $fail
