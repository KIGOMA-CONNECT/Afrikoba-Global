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
# BN- reference, 12-month cohort axis, 3-24 term, 15% fee, CSV banner, PDF words,
# and the availability-state probes added in Phase 60).
# Live run requires a minted expert JWT on the staging box (JWT_SECRET lives
# in the server .env.staging only; cannot be minted from a dev client).
#
# A NON-EXPERT token is also required as of Phase 60: the 403 probe this header
# has always claimed is now real, and the run reports SKIPPED without it.
#
# Usage (on the staging box):
#   BASE=http://127.0.0.1:3001/api/v1 EXPERT=eyJ... MEMBER=eyJ... ./scripts/verify-bnpl.sh
#
# KNOWN OPEN (Phase 60, deliberately not fixed here - see
# docs/FINDINGS_bnpl_loan_book_acceptance.md defects D5 and D6):
#   - this file carries a UTF-8 BOM, so the ./scripts/verify-bnpl.sh invocation
#     above cannot work as written; it must be run as
#     `bash scripts/verify-bnpl.sh` until the BOM is removed.
#   - the JSON capture path /tmp/bnpl.json is handed to a native node binary,
#     which resolves it to C:\tmp on Windows, so three probes cannot be
#     evaluated off Linux.
#   - the PDF is not a structurally valid PDF (no font, no text objects, wrong
#     startxref); the PDF probes only confirm the banner words are in the bytes.
# ============================================================================

set -u
BASE="${BASE:-http://127.0.0.1:3001/api/v1}"
EXPERT="${EXPERT:-}"
# Phase-60, criterion 4: the header of this file has always claimed an
# owner-403 probe, but no such probe existed. A non-expert token is now
# required to close that gap; without one the run reports SKIPPED rather than
# silently passing an untested authorization gate.
MEMBER="${MEMBER:-}"
fail=0
skipped=0

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
  skipped=1
else
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book")
  probe "expert -> HTTP 200 (want 200)" "$([ "$code" = "200" ] && echo 1 || echo 0)"
  if [ "$code" = "200" ]; then
    curl -s -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book" > /tmp/bnpl.json
    has_ref=$(grep -c '"reference"' /tmp/bnpl.json)
    has_bn=$(node -e "var d=JSON.parse(require('fs').readFileSync('/tmp/bnpl.json','utf8'));var r=d.reference||'';process.stdout.write(/^BN(PL)?-/.test(r)?'1':'0')")
    has_months=$(grep -c '"months"' /tmp/bnpl.json)
    has_term=$(grep -c '"min_term_months"' /tmp/bnpl.json)
    has_fee=$(node -e "var d=JSON.parse(require('fs').readFileSync('/tmp/bnpl.json','utf8'));var v=d.terms&&d.terms.fee_rate_per_year_pct||'';process.stdout.write(v==='15%'?'1':'0')")
    probe "reference + BN- prefix present" "$([ "$has_ref" -ge 1 ] && [ "$has_bn" -ge 1 ] && echo 1 || echo 0)"
    probe "12-month cohort present" "$([ "$has_months" -ge 1 ] && echo 1 || echo 0)"
    probe "documented term range 3-24 months present" "$([ "$has_term" -ge 1 ] && echo 1 || echo 0)"
    probe "documented 15% per year fee present" "$([ "$has_fee" -ge 1 ] && echo 1 || echo 0)"
    month_count=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('/tmp/bnpl.json','utf8'));const m=d.result&&d.result.months?d.result.months:(d.months?d.months:[]);process.stdout.write(String(m.length))}catch(e){process.stdout.write('0')}")
    probe "month cohort axis length = 12 (got $month_count)" "$([ "$month_count" = "12" ] && echo 1 || echo 0)"
    # Phase-60, criterion 3: the cohort probes used to assert only the array
    # length, which the 12 fabricated zero months satisfied. Assert the
    # availability state instead, so the surface cannot pass while presenting an
    # empty series as a real repayment trend.
    avail=$(node -e "
      try{
        const d=JSON.parse(require('fs').readFileSync('/tmp/bnpl.json','utf8'));
        const a=d.dataAvailability||{};
        const m=(d.result&&d.result.months)||d.months||[];
        const nz=m.filter(x=>Object.keys(x).some(k=>k!=='month'&&k!=='month_sw'&&Number(x[k])!==0)).length;
        process.stdout.write([a.state||'MISSING',String(a.records===undefined?'MISSING':a.records),
          String(d.months_populated===undefined?'MISSING':d.months_populated),d.health||'MISSING',String(nz)].join('|'));
      }catch(e){process.stdout.write('ERROR|ERROR|ERROR|ERROR|ERROR')}
    ")
    state=$(printf '%s' "$avail" | cut -d'|' -f1)
    records=$(printf '%s' "$avail" | cut -d'|' -f2)
    populated=$(printf '%s' "$avail" | cut -d'|' -f3)
    health=$(printf '%s' "$avail" | cut -d'|' -f4)
    nonzero=$(printf '%s' "$avail" | cut -d'|' -f5)
    probe "dataAvailability.state is NO_RECORDS or AVAILABLE (got $state)" \
      "$([ "$state" = "NO_RECORDS" ] || [ "$state" = "AVAILABLE" ] && echo 1 || echo 0)"
    probe "months_populated is present and boolean (got $populated)" \
      "$([ "$populated" = "true" ] || [ "$populated" = "false" ] && echo 1 || echo 0)"
    if [ "$state" = "NO_RECORDS" ]; then
      # An empty source must be declared empty everywhere, and must never be
      # dressed up as a healthy portfolio.
      probe "NO_RECORDS: records = 0 (got $records)" "$([ "$records" = "0" ] && echo 1 || echo 0)"
      probe "NO_RECORDS: months_populated = false (got $populated)" "$([ "$populated" = "false" ] && echo 1 || echo 0)"
      probe "NO_RECORDS: health is not CLEAN (got $health)" \
        "$([ "$health" != "CLEAN" ] && [ "$health" != "MISSING" ] && echo 1 || echo 0)"
    elif [ "$state" = "AVAILABLE" ]; then
      probe "AVAILABLE: records > 0 (got $records)" \
        "$([ -n "$records" ] && [ "$records" != "MISSING" ] && [ "$records" -gt 0 ] 2>/dev/null && echo 1 || echo 0)"
      probe "AVAILABLE: months_populated = true (got $populated)" "$([ "$populated" = "true" ] && echo 1 || echo 0)"
      probe "AVAILABLE: at least one month carries data (got $nonzero)" \
        "$([ -n "$nonzero" ] && [ "$nonzero" -gt 0 ] 2>/dev/null && echo 1 || echo 0)"
    fi
  fi
fi

# --- probe 3: CSV banner + header (expert only) --------------------------------
if [ -z "$EXPERT" ]; then
  echo "SKIP CSV probe (no EXPERT JWT)"
  skipped=1
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
  skipped=1
else
  code=$(curl -s -o /tmp/bnpl.pdf -w '%{http_code}' -H "Authorization: Bearer $EXPERT" "$BASE/projects/ops/bnpl-loan-book/pdf")
  probe "PDF export -> HTTP 200 (want 200)" "$([ "$code" = "200" ] && echo 1 || echo 0)"
  if [ "$code" = "200" ]; then
    probe "PDF banner words present: AFRIKOBA GLOBAL BNPL LOAN BOOK" "$(strings /tmp/bnpl.pdf 2>/dev/null | grep -qiE "AFRIKOBA GLOBAL[[:space:]]*-[[:space:]]*BNPL LOAN BOOK" && echo 1 || echo 0)"
    probe "PDF term words: 3-24 + 15%" "$(strings /tmp/bnpl.pdf 2>/dev/null | grep -qiE "3.?24|15%" && echo 1 || echo 0)"
  fi
fi

echo ""
echo "--- probe 5: non-expert (owner/member) must be refused with 403 ----------"
if [ -z "$MEMBER" ]; then
  echo "SKIP 403 probe (no MEMBER token supplied; the header has always promised this probe)"
  skipped=1
else
  for p in "" "/export" "/pdf"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MEMBER" "$BASE/projects/ops/bnpl-loan-book$p")
    probe "non-expert -> HTTP 403 on ${p:-/} (want 403)" "$([ "$code" = "403" ] && echo 1 || echo 0)"
  done
fi

echo ""
if [ "$fail" != "0" ]; then
  echo "ACCEPTANCE: FAIL"
  exit 1
elif [ "$skipped" != "0" ]; then
  echo "ACCEPTANCE: SKIPPED (expert/CSV/PDF probes not run - no EXPERT JWT)"
  exit 2
else
  echo "ACCEPTANCE: PASS"
  exit 0
fi
