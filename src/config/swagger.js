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
      },
      schemas: {
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
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = { swaggerSpec };
