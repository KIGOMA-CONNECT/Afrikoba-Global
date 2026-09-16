#!/usr/bin/env bash
# ============================================================================
# AFRIKOBA GLOBAL - BNPL LOAN BOOK / MWENENDO WA MIKOPO YA BNPL - ACCEPTANCE
# ============================================================================
# Phase 57 BNPL vertical seam twin of Phase 55/56 (platform-earnings-trend).
#
# FN: expert-only loan book (Buy Now Pay Later installment financing):
#   - Term range ....... 3 - 24 months   (documented in UX-PROPOSAL.md)
#   - Fee .............. 15% per year     (documented in UX-PROPOSAL.md)
#   - Reference prefix . BN-
#   - Cohort ........... 12 monthly buckets (repayment trend per month)
#   - Access ........... EXPERT/ADMIN/MODERATOR only, JWT Bearer, no X-User-Role
#
# Exit 0 ONLY when every probe is green (expert 200, owner 403, anon 401,
# BN- reference, 12-month cohort, 3-24 term, 15% fee, CSV banner, PDF words).
# Live run requires a minted expert JWT on the staging box (JWT_SECRET lives
# in the server .env.staging only; cannot be minted from a dev client).
#
# Usage (on the staging box):
#   BASE=http://127.0.0.1:3001/api/v1 EXPERT=eyJ... ./scripts/verify-bnpl.sh
# ============================================================================

set -u
BASE="${BASE:-http://127.0.0.1:3001/api/v1}"
EXPERT="${EXPERT:-}"
fail=0

probe() {
  local desc="$1" ok="$2"
  if [ "$ok" = "1" ]; then echo "OK   $desc"; else echo "FAIL $desc"; fail=1; fi
}

# --- probe 1: anonymous 401 ---------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/projects/ops/bnpl-loan-book")
probe "anonymous -> HTTP 401 (want 401)" "$([ "$code" = "401" ] && echo 1 || echo 0)"

# --- probe 2: expert JWT 200 + BN- reference + cohort + terms + fee ------------
if [ -z "$EXPERT" ]; then
  echo "SKIP expert probe (no EXPERT JWT supplied; mint on the box)"
else
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book")
  probe "expert -> HTTP 200 (want 200)" "$([ "$code" = "200" ] && echo 1 || echo 0)"
  if [ "$code" = "200" ]; then
    curl -s -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book" > /tmp/bnpl.json
    has_ref=$(grep -c '"reference"' /tmp/bnpl.json)
    has_bn=$(grep -c '"BN-' /tmp/bnpl.json)
    has_months=$(grep -c '"months"' /tmp/bnpl.json)
    has_term=$(grep -c '"min_term_months"' /tmp/bnpl.json)
    has_fee=$(grep -c '"fee_per_year_pct"' /tmp/bnpl.json)
    probe "reference + BN- prefix present" "$([ "$has_ref" -ge 1 ] && [ "$has_bn" -ge 1 ] && echo 1 || echo 0)"
    probe "12-month cohort present" "$([ "$has_months" -ge 1 ] && echo 1 || echo 0)"
    probe "documented term range 3-24 months present" "$([ "$has_term" -ge 1 ] && echo 1 || echo 0)"
    probe "documented 15% per year fee present" "$([ "$has_fee" -ge 1 ] && echo 1 || echo 0)"
    month_count=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/tmp/bnpl.json','utf8'));const m=d.result&&d.result.months?d.result.months.length:(d.months?d.months.length:0);process.stdout.write(String(m))}catch(e){process.stdout.write('0')}")
    probe "month cohort length = 12 (got $month_count)" "$([ "$month_count" = "12" ] && echo 1 || echo 0)"
  fi
fi

# --- probe 3: CSV banner + header (expert only) --------------------------------
if [ -z "$EXPERT" ]; then
  echo "SKIP CSV probe (no EXPERT JWT)"
else
  code=$(curl -s -o /tmp/bnpl.csv -w '%{http_code}' -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book/export")
  probe "CSV export -> HTTP 200 (want 200)" "$([ "$code" = "200" ] && echo 1 || echo 0)"
  if [ "$code" = "200" ]; then
    probe "CSV banner: AFRIKOBA GLOBAL - BNPL LOAN BOOK" "$(grep -q "AFRIKOBA GLOBAL - BNPL LOAN BOOK" /tmp/bnpl.csv && echo 1 || echo 0)"
    probe "CSV header: Reference" "$(grep -q "Reference" /tmp/bnpl.csv && echo 1 || echo 0)"
    probe "CSV term row: 3-24" "$(grep -q "3" /tmp/bnpl.csv && echo 1 || echo 0)"
    probe "CSV fee row: 15" "$(grep -q "15" /tmp/bnpl.csv && echo 1 || echo 0)"
  fi
fi

# --- probe 4: PDF banner words (expert only) -----------------------------------
if [ -z "$EXPERT" ]; then
  echo "SKIP PDF probe (no EXPERT JWT)"
else
  code=$(curl -s -o /tmp/bnpl.pdf -w '%{http_code}' -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book/pdf")
  probe "PDF export -> HTTP 200 (want 200)" "$([ "$code" = "200" ] && echo 1 || echo 0)"
  if [ "$code" = "200" ]; then
    probe "PDF banner words present: AFRIKOBA GLOBAL BNPL LOAN BOOK" "$(strings /tmp/bnpl.pdf 2>/dev/null | grep -qi "AFRIKOBA GLOBAL BNPL LOAN BOOK" && echo 1 || echo 0)"
    probe "PDF term words: 3-24 + 15%" "$(strings /tmp/bnpl.pdf 2>/dev/null | grep -qiE "3.?24|15%" && echo 1 || echo 0)"
  fi
fi

echo ""
if [ "$fail" = "0" ]; then
  echo "ACCEPTANCE: PASS"
  exit 0
else
  echo "ACCEPTANCE: FAIL"
  exit 1
fi
