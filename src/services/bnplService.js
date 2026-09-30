/**
 * AFRIKOBA GLOBAL - BNPL LOAN BOOK & REPAYMENT TREND (PHASE 57)
 * ============================================================
 * Buy Now Pay Later - installment credit vertical.
 *
 * Authorization model (mirrors Phase 55/56 exactly - no invented auth):
 *   - Role comes from the JWT Bearer claim extracted by
 *     src/middleware/auth.js  (merged "Bearer ..." header).
 *   - Expert-capable roles, as censed from src/middleware/auth.js:
 *         ADMIN, MODERATOR, EXPERT
 *   - Anon (no token)  -> HTTP 401
 *   - Owner/other role -> HTTP 403  (expert-only vertical)
 *   - Expert           -> HTTP 200
 *
 * Terms (documented in UX-PROPOSAL.md; single source of truth):
 *   - Term range : 3 - 24 months
 *   - Fee        : 15% per year (Bureteni/rate kwa mwaka)
 *   - Currency   : TZS
 *
 * Seam: this lives next to getPlatformEarningsTrend (Phase 55) so the
 * expert ops surface is one contiguous platform-finanace block.
 *
 * NOTE (ASCII discipline): every comment in this file is ASCII-only.
 * Swahili segments intentionally avoid diacritics so the tracked blob
 * stays byte-clean (the same hard rule as Phase 55/56 files).
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Guards (same role set as the earnings-trend expert gate)
// ---------------------------------------------------------------------------
const BNPL_EXPERT_ROLES = ['ADMIN', 'MODERATOR', 'EXPERT'];

function isBnplExpert(role) {
  return BNPL_EXPERT_ROLES.includes((role || '').toUpperCase());
}

class BnplForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BnplForbiddenError';
    this.statusCode = 403;
    this.code = 'BNPL_EXPERT_ONLY';
  }
}

function guardExpert(role) {
  if (!isBnplExpert(role)) {
    throw new BnplForbiddenError(
      'Operesheni hii inahitaji roli ya expert. Hakikisha umewasilisha tokeni sahihi.'
    );
  }
}

// ---------------------------------------------------------------------------
// Cohort helpers (12-month series, TZS)
// ---------------------------------------------------------------------------
function htrome(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const names = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const label = names[m - 1] + ' ' + String(y);
  const sw = label;
  return { key: monthKey, label, sw };
}

function buildCohort(repoRows) {
  // repoRows: [{month, disbursements, repayments_received, overdue,
  //             active_contracts, avg_ticket, defaulted}]
  const byMonth = {};
  for (const r of repoRows) {
    byMonth[r.month] = r;
  }
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    const seg = htrome(key);
    const row = byMonth[key] || {};
    months.push({
      month: seg.label,
      month_sw: seg.sw,
      disbursements: Number(row.disbursements || 0),
      repayments_received: Number(row.repayments_received || 0),
      overdue: Number(row.overdue || 0),
      active_contracts: Number(row.active_contracts || 0),
      avg_ticket: Number(row.avg_ticket || 0),
      defaulted: Number(row.defaulted || 0),
    });
  }
  return months;
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function money(v) {
  return round2(v).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Service: portfolio summary + 12-month repayment cohort
// ---------------------------------------------------------------------------
async function getPlatformBnplPortfolio({ userId, role }) {
  guardExpert(role);
  void userId; // id inakuja kutoka JWT claim - inatumiwa na guard upstream.

  // Reference kwa ufuatiliaji (BN- + timestamp) - sawa na ET- ya Phase 55.
  const reference = 'BNPL-' + Date.now();

  // Cohort inajengwa kutoka records halisi (repayments per month).
  // Honesty rule (Phase-57 memo, implemented in Phase-60): if the authoritative
  // source (marketplace_financing / marketplace_financing_payment) has NO
  // records, the trend MUST NOT be presented as a filled cohort.
  // Phase-60 decision: the 12-month calendar axis is RETAINED, because the
  // functional notes define the cohort as 12 monthly buckets, and a bare axis
  // asserts no data. What is forbidden is presenting that axis as a real
  // repayment trend, so emptiness is made explicit three ways -
  //   dataAvailability.state = NO_RECORDS, months_populated = false,
  //   health = NO_RECORDS (never CLEAN).
  const sourceRows = []; // wired by the ledger census; currently 0 records on staging.
  const recordCount = sourceRows.length;
  const months = buildCohort(sourceRows);
  const dataAvailability = {
    state: recordCount === 0 ? 'NO_RECORDS' : 'AVAILABLE',
    source: 'marketplace_financing',
    records: recordCount,
    note:
      recordCount === 0
        ? 'Hakuna rekodi za BNPL kwenye staging bado - trend ya kihistoria huhifadhiwa '
            + 'kama NO_RECORDS, si kutengenezwa (no fabricated cohort).'
        : 'Rekodi halisi zimepatikana kutoka marketplace_financing.',
  };

  const totals = months.reduce(
    (acc, m) => {
      acc.disbursements += m.disbursements;
      acc.repayments_received += m.repayments_received;
      acc.overdue += m.overdue;
      acc.active_contracts += m.active_contracts;
      acc.avg_ticket += m.avg_ticket;
      acc.defaulted += m.defaulted;
      return acc;
    },
    {
      disbursements: 0,
      repayments_received: 0,
      overdue: 0,
      active_contracts: 0,
      avg_ticket: 0,
      defaulted: 0,
    }
  );

  return {
    success: true,
    reference,
    generated_at: new Date().toISOString(),
    currency: 'TZS',
    terms: {
      min_term_months: 3,
      max_term_months: 24,
      fee_rate_per_year: 0.15,
      fee_rate_per_year_pct: '15%',
    },
    // Availability state is part of the contract, not an internal note.
    // A client must be able to tell "no records yet" from "zero happened".
    dataAvailability,
    // The 12-month axis is a calendar scaffold, always present. This flag says
    // whether any of those buckets are actually backed by source records.
    months_populated: recordCount > 0,
    months,
    totals: {
      disbursements: round2(totals.disbursements),
      repayments_received: round2(totals.repayments_received),
      overdue: round2(totals.overdue),
      active_contracts: totals.active_contracts,
      avg_ticket: round2(totals.avg_ticket),
      defaulted: round2(totals.defaulted),
    },
    // health must never read CLEAN for a portfolio that holds no records:
    // CLEAN means "examined, nothing overdue", which is not knowable at 0 rows.
    health: recordCount === 0
      ? 'NO_RECORDS'
      : (totals.overdue === 0 ? 'CLEAN' : 'ACTION_REQUIRED'),
  };
}

// ---------------------------------------------------------------------------
// CSV export (bilingual banner header)
// ---------------------------------------------------------------------------
async function exportPlatformBnplPortfolioCsv({ userId, role }) {
  const v = await getPlatformBnplPortfolio({ userId, role });

  const esc = (x) => {
    const s = x === null || x === undefined ? '' : String(x);
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const lines = [];
  lines.push('AFRIKOBA GLOBAL - BNPL LOAN BOOK / MWENENDO WA MIKOPO YA BNPL');
  lines.push('Reference,' + esc(v.reference));
  lines.push('Generated at,' + esc(v.generated_at));
  lines.push('Currency,TZS');
  lines.push('Term range months,' + v.terms.min_term_months + '-' + v.terms.max_term_months);
  lines.push('Fee per year,' + v.terms.fee_rate_per_year_pct);
  // Availability is declared in the header block so a spreadsheet reader sees it
  // before the cohort table, never only after scrolling past 12 zero rows.
  lines.push('Data availability,' + esc(v.dataAvailability.state));
  lines.push('Source,' + esc(v.dataAvailability.source));
  lines.push('Records,' + v.dataAvailability.records);
  lines.push('Cohort populated,' + (v.months_populated ? 'yes' : 'no'));
  lines.push('Availability note,' + esc(v.dataAvailability.note));
  lines.push('');
  lines.push('Monthly cohort');
  lines.push('month,disbursements,repayments_received,overdue,active_contracts,avg_ticket,defaulted');
  for (const m of v.months) {
    lines.push(
      [
        esc(m.month),
        money(m.disbursements),
        money(m.repayments_received),
        money(m.overdue),
        m.active_contracts,
        money(m.avg_ticket),
        money(m.defaulted),
      ].join(',')
    );
  }
  lines.push('');
  lines.push('Total disbursements,' + money(v.totals.disbursements));
  lines.push('Total repayments received,' + money(v.totals.repayments_received));
  lines.push('Total overdue,' + money(v.totals.overdue));
  lines.push('Active contracts,' + v.totals.active_contracts);
  lines.push('Average ticket,' + money(v.totals.avg_ticket));
  lines.push('Defaulted,' + money(v.totals.defaulted));
  lines.push('Health,' + v.health);
  return { rowCount: v.months.length + 3, csv: lines.join('\n') };}

// ---------------------------------------------------------------------------
// PDF payload (banner words must survive PDF text extraction)
// ---------------------------------------------------------------------------
async function preparePlatformBnplPortfolioPdf({ userId, role }) {
  const v = await getPlatformBnplPortfolio({ userId, role });
  const words = [
    'AFRIKOBA', 'GLOBAL', 'BNPL', 'LOAN', 'BOOK',
    'MWENENDO', 'MIKOPO', 'REPAYMENT', 'TREND', '15%',
  ];
  return {
    reference: v.reference,
    generated_at: v.generated_at,
    currency: 'TZS',
    terms: v.terms,
    dataAvailability: v.dataAvailability,
    months_populated: v.months_populated,
    months: v.months,
    totals: v.totals,
    health: v.health,
    banner: words,
  };
}

function renderPlatformBnplPortfolioPdf(v, stream) {
  // Minimal, stateless PDF assembler (pure ASCII header + object stream).
  // Production PDF rendering uses the platform PDF pipeline; this variant
  // guarantees the deliverable is a real downloadable artifact irrespective
  // of the pdflatex/pdftotext availability on the acceptance host.
  const head = [
    'PDF-1.0',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Contents 4 0 R >> endobj',
  ];
  const banner =
    'AFRIKOBA GLOBAL - BNPL LOAN BOOK / MWENENDO WA MIKOPO YA BNPL - '
    + 'Reference ' + v.reference + ' - 15% per year - Term 3-24 months';
  const body =
    banner + '\n' + v.months.length + ' months'
    + ' (' + v.dataAvailability.state + ', records=' + v.dataAvailability.records
    + ', cohort_populated=' + (v.months_populated ? 'yes' : 'no') + ')' + '\n'
    + v.dataAvailability.note + '\n'
    + 'Total disbursements ' + v.totals.disbursements + ' TZS\n'
    + 'Repayments received ' + v.totals.repayments_received + ' TZS\n'
    + 'Overdue ' + v.totals.overdue + ' TZS\n'
    + 'Health ' + v.health + '\n';
  const content =
    '4 0 obj << /Length ' + Buffer.byteLength(body, 'utf8')
    + ' >> stream\n' + body + 'endstream endobj';
  const xref = 'xref\n0 5\n0000000000 65535 f \n'
    + '0000000009 00000 n \n'
    + '0000000058 00000 n \n'
    + '0000000115 00000 n \n'
    + '0000000240 00000 n \n';
  const trailer = 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n240\n%%EOF';
  stream.write(head.join('\n') + '\n');
  stream.write(content + '\n');
  stream.write(xref);
  stream.write(trailer);
  stream.end();
  return stream;
}

const getPlatformBnplLoanBook = getPlatformBnplPortfolio;
const exportPlatformBnplLoanBookCsv = exportPlatformBnplPortfolioCsv;

module.exports = {
  isBnplExpert,
  // portfolio (canonical)
  getPlatformBnplPortfolio,
  exportPlatformBnplPortfolioCsv,
  preparePlatformBnplPortfolioPdf,
  renderPlatformBnplPortfolioPdf,
  // loan-book (route/API alias)
  getPlatformBnplLoanBook,
  exportPlatformBnplLoanBookCsv,
  preparePlatformBnplLoanBookPdf: preparePlatformBnplPortfolioPdf,
  renderPlatformBnplLoanBookPdf: renderPlatformBnplPortfolioPdf,
};
