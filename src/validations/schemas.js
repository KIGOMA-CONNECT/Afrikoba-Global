const { z } = require('zod');
const { normalizeToE164 } = require('../utils/phone');

// Multi-country phone: national (07xx→255 normalisation per hint/default TZ)
// au E.164 kwa nchi yoyote iliyowashwa (254, 256, 250…). Canonical: 2550712345678.
const toIntlPhone = (v, ctx) => {
  const p = normalizeToE164(v, 'TZ');
  if (!p) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nambari ya simu si sahihi (mf: 071x xxx xxx)' });
    return z.NEVER;
  }
  return p;
};
const PHONE = z.string().transform(toIntlPhone);
const POSITIVE_INT = z.coerce.number().int().positive();
const POSITIVE_NUM = z.coerce.number().positive();
const DATE_STR = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const MONTH_STR = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM');
const PIN_4 = z.string().regex(/^\d{4}$/, 'PIN lazima iwe nambari 4');

// Password policy: angalau 10 chars, lazima iwe na herufi NA namba.
const STRONG_PASSWORD = z.string().min(10).regex(/^(?=.*[A-Za-z])(?=.*\d).{10,}$/,
  'Nenosiri lazima liwe na angalau herufi moja na namba moja, na urefu wa 10+.');

const auth = {
  sendOtp: z.object({
    phoneNumber: PHONE,
  }),
  login: z.object({
    phoneNumber: PHONE,
    otp: z.string().min(4).max(6),
  }),
  register: z.object({
    fullName: z.string().min(2).max(100),
    phoneNumber: PHONE,
    email: z.string().email().optional().nullable(),
    password: STRONG_PASSWORD.optional(),
    otp: z.string().min(4).max(6),
    nidaNumber: z.string().max(30).optional().nullable(),
  }),
  changePassword: z.object({
    currentPassword: z.string().min(1),
    newPassword: STRONG_PASSWORD,
  }),
  loginPassword: z.object({
    emailOrPhone: z.string().min(1),
    password: z.string().min(1),
  }),
  pin: z.object({ pin: PIN_4 }),
  kyc: z.object({
    nidaNumber: z.string().max(30).optional().nullable(),
    residentialAddress: z.string().max(255).optional().nullable(),
    idDocumentUrl: z.string().url().optional().nullable(),
  }),
};

const wallet = {
  deposit: z.object({
    amount: POSITIVE_NUM.refine((v) => v >= 1000, 'Kiasi kidogo ni TZS 1,000'),
    provider: z.enum(['Mpesa', 'Tigo', 'Airtel', 'Halopesa']),
  }),
  transfer: z.object({
    toPhoneNumber: PHONE,
    amount: POSITIVE_NUM,
    note: z.string().max(255).optional().nullable(),
  }),
  withdraw: z.object({
    amount: POSITIVE_NUM.refine((v) => v >= 1000, 'Kiasi kidogo ni TZS 1,000'),
    provider: z.enum(['Mpesa', 'Tigo', 'Airtel', 'Halopesa']),
  }),
};

const vicoba = {
  createGroup: z.object({
    groupName: z.string().min(2).max(100),
    cycleType: z.string().max(50),
    shareValue: POSITIVE_NUM,
    monthlyMaintenanceFee: POSITIVE_NUM.optional(),
  }),
  join: z.object({
    joinCode: z.string().min(1).max(20),
  }),
  invite: z.object({
    phoneNumbers: z.array(PHONE).min(1).max(50),
  }),
  addMember: z.object({
    userId: POSITIVE_INT,
    roleInGroup: z.string().max(50).optional(),
  }),
  contribute: z.object({
    amount: POSITIVE_NUM.optional(),
    sharesCount: POSITIVE_INT.optional(),
  }),
  requestLoan: z.object({
    applicantUserId: POSITIVE_INT,
    requestedAmount: POSITIVE_NUM,
    interestRate: POSITIVE_NUM.optional(),
    repaymentMonths: POSITIVE_INT.optional(),
  }),
  approveLoan: z.object({
    approvedAmount: POSITIVE_NUM.optional(),
  }),
  createSchedule: z.object({
    cycleNumber: POSITIVE_INT,
    dueDate: DATE_STR,
  }),
  payContribution: z.object({
    amount: POSITIVE_NUM,
    sharesCount: POSITIVE_INT.optional(),
  }),
  socialFund: z.object({
    monthlyContribution: POSITIVE_NUM,
  }),
  socialFundContribute: z.object({
    month: MONTH_STR,
  }),
  socialFundRequest: z.object({
    reasonType: z.string().min(1).max(50),
    reasonDetail: z.string().min(1).max(500),
    requestedAmount: POSITIVE_NUM,
  }),
  socialFundApprove: z.object({
    approvedAmount: POSITIVE_NUM.optional(),
  }),
  repayLoan: z.object({
    amount: POSITIVE_NUM,
    note: z.string().max(255).optional().nullable(),
  }),
};

const rosca = {
  createPool: z.object({
    poolName: z.string().min(2).max(100),
    contributionAmount: POSITIVE_NUM,
    cycleFrequency: z.string().max(50),
    totalMembers: POSITIVE_INT,
    poolType: z.string().max(50).optional(),
  }),
  joinPool: z.object({
    wantEarlySlot: z.boolean().optional(),
    queueNumber: POSITIVE_INT.optional(),
  }),
};

const p2p = {
  createProject: z.object({
    title: z.string().min(3).max(200),
    sector: z.string().min(2).max(100),
    description: z.string().min(10).max(5000),
    targetAmount: POSITIVE_NUM,
    sharePrice: POSITIVE_NUM,
    roiPercentage: POSITIVE_NUM,
    tenureMonths: POSITIVE_INT,
    paybackStartMonths: POSITIVE_INT,
    businessPlan: z.string().min(10),
    teamInfo: z.string().min(5),
    businessRegistrationUrl: z.string().url().optional().nullable(),
    financialProjectionUrl: z.string().url().optional().nullable(),
    minInvestmentAmount: POSITIVE_NUM.optional(),
    maxInvestmentPerInvestor: POSITIVE_NUM.optional(),
  }),
  invest: z.object({
    shares: POSITIVE_INT,
  }),
  review: z.object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().max(1000).optional().nullable(),
  }),
  audit: z.object({
    stepName: z.enum(['KYC_KYB_VERIFICATION', 'FINANCIAL_AUDIT', 'ESCROW_SETUP', 'LEGAL_PRE_APPROVAL']),
    passed: z.boolean(),
    notes: z.string().max(1000).optional().nullable(),
  }),
  milestones: z.object({
    milestones: z.array(z.object({
      title: z.string().min(1).max(200),
      amount: POSITIVE_NUM,
    })).min(1).max(20),
  }),
  revenue: z.object({
    amount: POSITIVE_NUM,
    description: z.string().max(500).optional().nullable(),
  }),
};

const admin = {
  transactionLimit: z.object({
    limit: POSITIVE_INT.max(1000).optional(),
  }),
};

const mkoba = {
  constitution: z.object({
    sharePrice: POSITIVE_NUM,
    maxSharesPerMember: POSITIVE_INT,
    loanInterestRate: POSITIVE_NUM.optional(),
    finePerAbsence: POSITIVE_NUM.optional(),
    finePerLateArrival: POSITIVE_NUM.optional(),
    meetingDay: z.string().max(20).optional(),
    require3TierApproval: z.boolean().optional(),
    shareRollover: z.boolean().optional(),
  }),
  buyShares: z.object({
    sharesCount: POSITIVE_INT,
  }),
  profit: z.object({
    cycleNumber: POSITIVE_INT,
    totalProfit: POSITIVE_NUM,
  }),
  transfer: z.object({
    transferType: z.string().min(1).max(50),
    recipientUserId: POSITIVE_INT,
    amount: POSITIVE_NUM,
    note: z.string().max(255).optional().nullable(),
  }),
  topup: z.object({
    amount: POSITIVE_NUM,
    provider: z.enum(['AIRTEL', 'HALOPESA', 'TIGO', 'MPESA']),
    phone: PHONE,
  }),
  meeting: z.object({
    meetingDate: DATE_STR,
    meetingTime: z.string().max(10).optional(),
    agenda: z.string().max(500).optional(),
  }),
  attendance: z.object({
    userId: POSITIVE_INT,
    status: z.enum(['PRESENT', 'LATE', 'ABSENT']),
    arrivalTime: z.string().max(10).optional(),
    fineAmount: POSITIVE_NUM.optional(),
  }),
};

module.exports = { auth, wallet, vicoba, rosca, p2p, admin, mkoba };
