const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Afrikoba Global API',
      description: 'Pan-African digital banking platform — Wallet, VICOBA, ROSCA, P2P Crowdfunding, M-Koba, USSD.',
      version: '1.0.0',
      contact: { name: 'Afrikoba Team', email: 'api@afrikoba.com' },
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: 'https://api.afrikoba.com', description: 'Production' },
      { url: 'https://staging.afrikoba.com', description: 'Staging' },
      { url: 'http://localhost:3000', description: 'Local dev' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        hmacAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Signature',
          description: 'HMAC signature for USSD/webhook rails (WEBHOOK_SECRET)',
        },
      },
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            fullName: { type: 'string' },
            phone_number: { type: 'string', description: 'Canonical phone field (C4 contract: not `phone`)' },
            email: { type: 'string', nullable: true },
            role: { type: 'string' },
            kycLevel: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            code: { type: 'string', example: 'VALIDATION_ERROR' },
            message: { type: 'string' },
          },
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
            hasNext: { type: 'boolean' },
            hasPrev: { type: 'boolean' },
          },
        },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description: 'Idempotency key to prevent double-posting on financial mutations',
          schema: {
            type: 'string',
          },
        },
      },
      responses: {
        Unauthorized: {
          description: 'Missing or invalid JWT',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
        Forbidden: {
          description: 'Authenticated but insufficient privileges (RBAC / four-eyes)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/docs/openapi.js'],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerSpec };
