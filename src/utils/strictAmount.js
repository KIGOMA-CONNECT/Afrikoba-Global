'use strict';
/**
 * R36 Task 3: strict money input for pilot financial operations (service-level authority, so it also
 * covers routes without a zod schema and non-HTTP callers).
 *
 * Accepted: a JS number that is finite and > 0. Returned value is the SAME number (no rounding, no
 * coercion), so what was validated is exactly what the financial operation uses.
 * Rejected: strings (including "5000" and " 5000 "), booleans, null, undefined (unless optional),
 * NaN, +/-Infinity, 0 and negatives; with integer:true also non-integers.
 */
function strictAmount(value, { field = 'amount', optional = false, integer = false, code = 'AMOUNT_INVALID', message } = {}) {
  if (value === undefined && optional) return undefined;
  const ok = typeof value === 'number' && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value));
  if (!ok) {
    throw Object.assign(
      new Error(message || `${field}: lazima iwe namba halisi kubwa kuliko 0 (si maandishi, si true/null).`),
      { statusCode: 400, code, details: { field } }
    );
  }
  return value;
}

module.exports = { strictAmount };
