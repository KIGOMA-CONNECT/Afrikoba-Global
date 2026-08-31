require('dotenv').config();
const { startTracing } = require('./tracing');
startTracing();

const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const config = require('./config');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { requestLog } = require('./middleware/requestLog');
const { apiLimiter } = require('./middleware/rateLimiter');
const { securityHeaders, requestValidation, trackSuspiciousActivity, strictCors, secureErrorHandler } = require('./middleware/securityHardening');
const { validateSession } = require('./middleware/sessionManager');
const { initDbSecurity } = require('./middleware/dbSecurity');
const { authLimiter, otpLimiter, walletLimiter, financialLimiter, adminLimiter, webhookLimiter } = require('./middleware/granularRateLimit');
const { requestId, responseTiming, requestTimeout, sanitizeHeaders } = require('./middleware/requestHardening');
const { validateTokenPayload } = require('./middleware/jwtHardening');
const { validateApiKey } = require('./middleware/apiKeyAuth');
const { sqlInjectionGuard } = require('./middleware/sqlInjectionGuard');
const { webhookReplayProtection, verifyWebhookHmac } = require('./middleware/webhookSecurity');
const { xssProtection } = require('./middleware/xssProtection');
const { verifyCsrfToken } = require('./middleware/csrf');
const { inputLengthGuard } = require('./middleware/inputLengthGuard');
const { ipBlockGuard, recordViolation } = require('./middleware/ipBlock');
const { getMetrics, httpLatencyHistogram } = require('./services/metricsService');
const logger = require('./utils/logger');

const authRoutes = require('./routes/authRoutes');
const walletRoutes = require('./routes/walletRoutes');
const vicobaRoutes = require('./routes/vicobaRoutes');
const roscaRoutes = require('./routes/roscaRoutes');
const p2pRoutes = require('./routes/p2pRoutes');
const adminRoutes = require('./routes/adminRoutes');
const callbackRoutes = require('./routes/callbackRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const marketingRoutes = require('./routes/marketingRoutes');
const ussdRoutes = require('./routes/ussdRoutes');
const mkobaRoutes = require('./routes/mkobaRoutes');
const totpRoutes = require('./routes/totpRoutes');
const currencyRoutes = require('./routes/currencyRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const referralRoutes = require('./routes/referralRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const bankingRoutes = require('./routes/bankingRoutes');
const advancedRoutes = require('./routes/advancedRoutes');
const smartRoutes = require('./routes/smartRoutes');
const ecosystemRoutes = require('./routes/ecosystemRoutes');
const networkRoutes = require('./routes/networkRoutes');
const familyRoutes = require('./routes/familyRoutes');
const businessRoutes = require('./routes/businessRoutes');
const savingsRoutes = require('./routes/savingsRoutes');
const creditRoutes = require('./routes/creditRoutes');
const cardRoutes = require('./routes/cardRoutes');
const bapRoutes = require('./routes/bapRoutes');
const publicStatsRoutes = require('./routes/publicStats');
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec } = require('./config/swagger');

// Fail-fast: usiendelee na mazingira ya production yenye maadili hatari.
config.validateConfig();

// Sentry error monitoring — only in production when DSN is set
if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.sentry.environment,
    tracesSampleRate: config.sentry.tracesSampleRate,
  });
}

const app = express();

// H5: Initialize database security settings
initDbSecurity().catch(() => {});

// Trust proxy (reverse proxy / load balancer) - lazima kwa rate limiting na req.ip
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// i18n: req.locale (Accept-Language) + res.t() — lazima kabla ya handlers zinazotumia messages
const { i18n } = require('./i18n/middleware');
app.use(i18n);

// H1: Enhanced security headers
app.use(securityHeaders);

// H4: Request validation (content-type, suspicious user agents)
app.use(requestValidation);

// H6: Suspicious activity detection
app.use(trackSuspiciousActivity);

// IP block guard — blocks IPs after repeated violations
app.use(ipBlockGuard);

// H3: Session validation (check token blacklist)
app.use(validateSession);

// Security headers. CSP imesanifiwa kwa SPA (React dashboard) - inline styles,
// blob workers (Flutter web) na connect kwa same-origin/HTTPS.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https:', 'ws:', 'wss:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// CORS: katika development '*' (zote). Katika production inahitaji list halisi.
const corsOptions =
  config.security.corsOrigins.includes('*')
    ? { origin: true }
    : { origin: config.security.corsOrigins, credentials: false };

app.use(cors(corsOptions));
app.use(express.json({
  limit: '512kb',
  // Capture raw body kwa webhook HMAC verification (exact bytes).
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

// Sentry request handler — must be before routes
if (config.sentry.dsn) app.use(Sentry.Handlers.requestHandler());

// Access logging + request-id
app.use(requestId);
app.use(responseTiming);

// Prometheus latency metric
app.use((req, res, next) => {
  const end = httpLatencyHistogram.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route?.path || req.path, status: res.statusCode });
  });
  next();
});

app.use(requestTimeout(30000));
app.use(requestLog);

// Serve contracts (PDF)
const contractDir = path.resolve(process.cwd(), config.contract.dir);
if (!fs.existsSync(contractDir)) fs.mkdirSync(contractDir, { recursive: true });
app.use('/contracts', express.static(contractDir));

// Serve built web dashboard (single-origin, production standard)
const webDist = path.resolve(process.cwd(), 'web-dashboard', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  logger.info('SERVER', 'Web dashboard (dist) inatumiwa kwenye origin hii.');
} else {
  logger.warn('SERVER', 'web-dashboard/dist haipatikani - endesha npm run build kwenye web-dashboard.');
}

// H12: Metrics endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', require('./services/metricsService').client.register.contentType);
  res.send(await getMetrics());
});

// Readiness check (DB connectivity - kwa orchestrators kama Docker/K8s)
app.get('/health/db', async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.query('SELECT 1');
    res.json({ success: true, db: 'UP', time: new Date().toISOString() });
  } catch (error) {
    logger.error('HEALTH', `DB readiness imeshindikana: ${error.message}`);
    res.status(503).json({ success: false, db: 'DOWN', time: new Date().toISOString() });
  }
});

// Alias for orchestrators using the newer path
app.get('/health/ready', async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.query('SELECT 1');
    res.json({ success: true, status: 'READY', time: new Date().toISOString() });
  } catch (error) {
    logger.error('HEALTH', `Readiness check failed: ${error.message}`);
    res.status(503).json({ success: false, status: 'NOT_READY', time: new Date().toISOString() });
  }
});


// API Routes - rate limited kwa jumla
app.use('/api', apiLimiter);
app.use('/api', sqlInjectionGuard);
app.use('/api', verifyCsrfToken);
app.use('/api', xssProtection);
app.use('/api', inputLengthGuard);
app.use('/api', validateApiKey);
app.use('/api', validateTokenPayload);

// v1 canonical prefix
const versionPrefix = '/api/v1';
  app.use(`${versionPrefix}/auth`, authLimiter, authRoutes);
  app.use(`${versionPrefix}/wallet`, walletLimiter, walletRoutes);
  app.use(`${versionPrefix}/vicoba`, walletLimiter, vicobaRoutes);
  app.use(`${versionPrefix}/vicoba`, walletLimiter, mkobaRoutes);
  app.use(`${versionPrefix}/rosca`, walletLimiter, roscaRoutes);
  app.use(`${versionPrefix}/p2p`, financialLimiter, p2pRoutes);
  app.use(`${versionPrefix}/admin`, adminLimiter, adminRoutes);
  app.use(`${versionPrefix}/payments`, webhookLimiter, webhookReplayProtection, verifyWebhookHmac, callbackRoutes);
  app.use(`${versionPrefix}/services`, serviceRoutes);
  app.use(`${versionPrefix}/marketing`, marketingRoutes);
  app.use(`${versionPrefix}/ussd`, webhookLimiter, ussdRoutes);
  app.use(`${versionPrefix}/totp`, authLimiter, totpRoutes);
  app.use(`${versionPrefix}/currency`, currencyRoutes);
  app.use(`${versionPrefix}/notifications`, notificationRoutes);
  app.use(`${versionPrefix}/referrals`, referralRoutes);
  app.use(`${versionPrefix}/analytics`, analyticsRoutes);
  app.use(`${versionPrefix}/banking`, walletLimiter, bankingRoutes);
  app.use(`${versionPrefix}/advanced`, walletLimiter, advancedRoutes);
  app.use(`${versionPrefix}/smart`, walletLimiter, smartRoutes);
  app.use(`${versionPrefix}/eco`, walletLimiter, ecosystemRoutes);
  app.use(`${versionPrefix}/network`, walletLimiter, networkRoutes);
  app.use(`${versionPrefix}/family`, walletLimiter, familyRoutes);
  app.use(`${versionPrefix}/business`, walletLimiter, businessRoutes);
  app.use(`${versionPrefix}/savings`, walletLimiter, savingsRoutes);
  app.use(`${versionPrefix}/credit`, walletLimiter, creditRoutes);
  app.use(`${versionPrefix}/cards`, walletLimiter, cardRoutes);
  app.use(`${versionPrefix}/bap`, walletLimiter, bapRoutes);
  app.use(`${versionPrefix}/stats`, publicStatsRoutes);


// Swagger UI - API documentation (production off - usitangaze API surface)
if (config.nodeEnv !== 'production') {
  app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Afrikoba Global API',
    customCss: '.swagger-ui .topbar { display: none }',
  }));
  app.get('/api/v1/docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

// API version info (production: jibu sahili bila link za docs)
app.get('/api/v1', (req, res) => {
  res.json({ success: true, version: '1.0.0', docs: config.nodeEnv === 'production' ? false : '/api/v1/docs' });
});

// Deprecation header for legacy /api routes (forward to /api/v1)
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/v1')) {
    const newUrl = `/api/v1${req.path}`;
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toUTCString());
    res.setHeader('Link', `<${newUrl}>; rel="successor-version"`);
    // Redirect to the new path
    return res.redirect(301, newUrl);
  }
  next();
});


// SPA fallback: non-API routes -> index.html (React Router)
app.get(/^\/(?!api|contracts|health).*/, (req, res, next) => {
  if (fs.existsSync(webDist)) {
    return res.sendFile(path.join(webDist, 'index.html'));
  }
  next();
});

app.use(notFound);
if (config.sentry.dsn) app.use(Sentry.Handlers.errorHandler());
app.use(sanitizeHeaders);
app.use(secureErrorHandler);

// Start background jobs (reconciliation, ROSCA payout, split payment)
if (process.env.DISABLE_CRON !== 'true') {
  const { startAllJobs } = require('./jobs/runAll');
  startAllJobs();
  // H18: Start backup scheduler
  const { startBackupScheduler } = require('./services/backupService');
  startBackupScheduler();
}

function startServer(server) {
  server.listen(config.port, () => {
    const proto = server instanceof https.Server ? 'https' : 'http';
    logger.info('SERVER', `Afrikoba Global inaendeshwa kwenye ${proto}://localhost:${config.port} (${config.nodeEnv})`);
  });

  // Graceful shutdown — essential for zero-downtime deploys & load balancers
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('SERVER', `Received ${signal}. Shutting down gracefully...`);
    server.close(() => {
      logger.info('SERVER', 'HTTP server closed.');
      const pool = require('./config/db');
      pool.end().then(() => {
        logger.info('SERVER', 'Database pool closed. Exiting.');
        process.exit(0);
      }).catch(() => process.exit(1));
    });
    // Force exit after 30s
    setTimeout(() => {
      logger.error('SERVER', 'Forced shutdown after timeout.');
      process.exit(1);
    }, 30000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Optional TLS: kama TLS_CERT_PATH na TLS_KEY_PATH zimewekwa, tumia HTTPS.
// (Inapendekezwa reverse proxy kama Nginx/Caddy/Cloudflare inayosimamia TLS.)
const hasTls = config.security.tlsCert && config.security.tlsKey;
if (hasTls) {
  const tlsOptions = {
    cert: fs.readFileSync(config.security.tlsCert),
    key: fs.readFileSync(config.security.tlsKey),
  };
  const server = https.createServer(tlsOptions, app);
  startServer(server);
} else {
  const server = http.createServer(app);
  startServer(server);
}

module.exports = app;

// H14: Graceful handling of unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('SERVER', 'Unhandled Rejection at: Promise', { promise, reason });
});
process.on('uncaughtException', (err) => {
  logger.error('SERVER', 'Uncaught Exception', { err });
});
