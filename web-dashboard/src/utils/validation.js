/**
 * Frontend Form Validation Helpers
 * Live validation with green checkmarks, matching backend rules.
 */

// Phone: Tanzanian / International format
export const PHONE_RE = /^\+?[0-9]{9,15}$/;

// NIDA number: 20-digit Tanzanian ID
export const NIDA_RE = /^[0-9]{20}$/;

// 6-digit OTP
export const OTP_RE = /^[0-9]{6}$/;

// Email
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Passwords: min 8 chars, at least one letter + one number
export const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d@$!%*#?&._-]{8,}$/;

export function validatePhone(v) {
  return PHONE_RE.test((v || '').replace(/\s/g, ''));
}

export function validateNida(v) {
  return NIDA_RE.test((v || '').replace(/\s/g, ''));
}

export function validateOtp(v) {
  return OTP_RE.test((v || '').replace(/\s/g, ''));
}

export function validateEmail(v) {
  return EMAIL_RE.test((v || '').trim());
}

export function validatePassword(v) {
  return PASSWORD_RE.test(v || '');
}

// Returns { ok: bool, message: string|null }
export function validateField(name, value) {
  switch (name) {
    case 'phoneNumber': return validatePhone(value) ? { ok: true } : { ok: false, message: 'checkPhone' };
    case 'nidaNumber': return validateNida(value) ? { ok: true } : { ok: false, message: 'checkNida' };
    case 'otp': return validateOtp(value) ? { ok: true } : { ok: false, message: 'checkOtp' };
    case 'email': return validateEmail(value) ? { ok: true } : { ok: false, message: 'checkEmail' };
    case 'password': return validatePassword(value) ? { ok: true } : { ok: false, message: 'checkPassword' };
    default: return { ok: true };
  }
}