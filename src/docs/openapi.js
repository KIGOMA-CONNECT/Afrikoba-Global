/**
 * OpenAPI representative spec (JSDoc @swagger annotations).
 * swagger-jsdoc reads this file (see src/config/swagger.js).
 * Covers the canonical module surface and the three C4 contracts
 * documented in AFK-INST-08 §4: register returns phone_number,
 * transfer omits balance, dismiss returns { dismissed: { id } }.
 *
 * This file is consumed by swagger-jsdoc and does NOT export runtime code.
 */
/* istanbul ignore file */
module.exports = {};

/**
 * @swagger
 * /api/auth/send-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Send OTP to phone number
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phoneNumber]
 *             properties:
 *               phoneNumber:
 *                 type: string
 *                 example: "+250788123456"
 *     responses:
 *       200:
 *         description: OTP sent (dev mode returns devOtp in body)
 *       429:
 *         description: Rate-limited
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register user (OTP + phone verified)
 *     description: |
 *       C4 contract (AFK-INST-08 §4): the response returns `user.phone_number`
 *       (NOT `user.phone`). Clients MUST assert `phone_number`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phoneNumber, otp, fullName]
 *             properties:
 *               phoneNumber:
 *                 type: string
 *               otp:
 *                 type: string
 *               fullName:
 *                 type: string
 *     responses:
 *       201:
 *         description: Registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 token:
 *                   type: string
 *       401:
 *         description: Invalid/expired OTP
 *       422:
 *         description: Validation error (e.g. E.164 phone format, password < 8 chars)
 * /api/wallet/balance:
 *   get:
 *     tags: [Wallet]
 *     summary: Get wallet balance and holdings
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet balance
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/wallet/transfer:
 *   post:
 *     tags: [Wallet]
 *     summary: Peer-to-peer wallet transfer
 *     description: |
 *       C4 contract (AFK-INST-08 §4): the transfer response does NOT include
 *       a `balance` field. Clients must not rely on it. Financial mutations
 *       honour the `Idempotency-Key` header.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - $ref: '#/components/parameters/IdempotencyKey'
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [recipientId, amount]
 *             properties:
 *               recipientId:
 *                 type: integer
 *               amount:
 *                 type: number
 *               reference:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transfer completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 referenceId:
 *                   type: string
 *                 amount:
 *                   type: number
 *                 message:
 *                   type: string
 *       400:
 *         description: Insufficient balance / validation error
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/wallet/statements:
 *   get:
 *     tags: [Wallet]
 *     summary: Paginated wallet transaction history
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: page
 *         in: query
 *         schema:
 *           type: integer
 *           default: 1
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *     responses:
 *       200:
 *         description: Paginated statements
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/ai/insights:
 *   get:
 *     tags: [AI]
 *     summary: Get generated AI financial insights
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Insight list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [AI]
 *     summary: Refresh / regenerate AI insights
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Insights refreshed
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/ai/insights/{id}/dismiss:
 *   post:
 *     tags: [AI]
 *     summary: Dismiss an AI insight
 *     description: |
 *       C4 contract (AFK-INST-08 §4): the response returns
 *       `{ dismissed: { id } }` (NOT a boolean).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Insight dismissed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 dismissed:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/vicoba/groups:
 *   get:
 *     tags: [VICOBA]
 *     summary: List user's VICOBA groups
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Group list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [VICOBA]
 *     summary: Create a VICOBA group
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Group created
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/rosca/pools:
 *   get:
 *     tags: [ROSCA]
 *     summary: List ROSCA pools
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pool list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/p2p/projects:
 *   get:
 *     tags: [P2P]
 *     summary: List P2P projects
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Project list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/merchant/payment-links:
 *   get:
 *     tags: [Merchant]
 *     summary: List merchant payment links
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Link list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/business/invoices:
 *   get:
 *     tags: [Business]
 *     summary: List business invoices
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Invoice list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/payroll/runs:
 *   get:
 *     tags: [Payroll]
 *     summary: List payroll runs
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payroll list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [Payroll]
 *     summary: Create a payroll run
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Payroll run created
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/procurement/rfqs:
 *   get:
 *     tags: [Procurement]
 *     summary: List procurement RFQs
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: RFQ list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [Procurement]
 *     summary: Create a procurement RFQ
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: RFQ created
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/field-partners:
 *   get:
 *     tags: [Field Partners]
 *     summary: List field partners
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Partner list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [Field Partners]
 *     summary: Register a new field partner
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Partner created
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/ops/chart-of-accounts:
 *   get:
 *     tags: [Ops / Admin]
 *     summary: Grouped chart of accounts with totals
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Chart
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/ops/tracing/{traceId}:
 *   get:
 *     tags: [Ops / Admin]
 *     summary: Trace tree for a request trace ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: traceId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Trace spans
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/ops/partitions:
 *   get:
 *     tags: [Ops / Admin]
 *     summary: Ledger and audit partition health
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Partition status
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/admin/aml/cases:
 *   get:
 *     tags: [Ops / Admin]
 *     summary: List AML cases
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: AML case list
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [Ops / Admin]
 *     summary: Open an AML case
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: AML case created
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/admin/aml/cases/{id}/file-sar:
 *   post:
 *     tags: [Ops / Admin]
 *     summary: Formal FIU SAR filing (immutable trail)
 *     description: |
 *       Writes the filing to `sar_filings`, mirrors onto `aml_cases`
 *       (reference, agency, filed_at, disposition → REFERRED_TO_LRA),
 *       appends an `SAR_FILED` audit entry. Multiple filings allowed.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reference]
 *             properties:
 *               reference:
 *                 type: string
 *                 description: "FIU filing reference (e.g. SAR-TZ-2026-001)"
 *               agency:
 *                 type: string
 *                 default: FIU
 *               summary:
 *                 type: string
 *     responses:
 *       200:
 *         description: SAR filed
 *       400:
 *         description: Missing reference
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/admin/aml/cases/{id}/filings:
 *   get:
 *     tags: [Ops / Admin]
 *     summary: List SAR filings for an AML case
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Filing trail
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/countries:
 *   get:
 *     tags: [Countries]
 *     summary: List supported countries (public)
 *     responses:
 *       200:
 *         description: Country list
 * /api/countries/me:
 *   get:
 *     tags: [Countries]
 *     summary: User's current country limits / WHT / KYC config
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Country config
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/devices:
 *   get:
 *     tags: [Devices]
 *     summary: List trusted devices
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Device list
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 * /api/ussd:
 *   post:
 *     tags: [USSD]
 *     summary: USSD session entry (HMAC-authenticated)
 *     description: |
 *       USSD sessions are authenticated via HMAC (WEBHOOK_SECRET) +
 *       IP allowlist. Body contains session state + user input.
 *     security:
 *       - hmacAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: string
 *               serviceCode:
 *                 type: string
 *               text:
 *                 type: string
 *               phoneNumber:
 *                 type: string
 *     responses:
 *       200:
 *         description: USSD menu / response text
 *       400:
 *         description: Invalid request / HMAC failure
 * /health:
 *   get:
 *     tags: [System]
 *     summary: Liveness probe (public)
 *     responses:
 *       200:
 *         description: UP
 * /health/db:
 *   get:
 *     tags: [System]
 *     summary: Readiness probe — database reachable (public)
 *     responses:
 *       200:
 *         description: Database OK
 *       503:
 *         description: Database unreachable
 * /api/v1:
 *   get:
 *     tags: [System]
 *     summary: API version info; non-production returns docs path
 *     responses:
 *       200:
 *         description: Version JSON
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 version:
 *                   type: string
 *                   example: 1.0.0
 *                 docs:
 *                   type: string
 *                   nullable: true
 *                   example: /api/v1/docs */
