/**
 * Input Length Validation Middleware
 * Prevents abuse via oversized inputs.
 */

const MAX_LENGTHS = {
  phoneNumber: 20,
  fullName: 100,
  email: 254,
  password: 128,
  pin: 6,
  otp: 10,
  message: 5000,
  description: 2000,
  name: 200,
  title: 200,
  address: 500,
  nidaNumber: 30,
  amount: 20,
  currency: 10,
  serviceKey: 30,
  joinCode: 20,
  default: 1000,
};

function inputLengthGuard(req, res, next) {
  const data = req.body;
  if (!data || typeof data !== 'object') return next();

  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') continue;
    const maxLen = MAX_LENGTHS[key] || MAX_LENGTHS.default;
    if (value.length > maxLen) {
      return res.status(400).json({
        success: false,
        message: `Ujumbe mrefu sana. Kiwango cha juu ni herufi ${maxLen}.`,
        code: 'INPUT_TOO_LONG',
        details: { field: key, maxLength: maxLen, actualLength: value.length },
      });
    }
  }
  next();
}

module.exports = { inputLengthGuard, MAX_LENGTHS };