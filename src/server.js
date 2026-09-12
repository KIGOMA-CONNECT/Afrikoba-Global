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
const { requestTelemetry } = require('./middleware/telemetry');
const { apiLimiter } = require('./middleware/rateLimiter');
const { securityHeaders, requestValidation, trackSuspiciousActivity, strictCors, secureErrorHandler } = require('./middleware/securityHardening');
const { validateSession } = require('./middleware/sessionManager');
const { initDbSecurity } = require('./middleware/dbSecurity');
const { authLimiter, otpLimiter, walletLimiter, financialLimiter, adminLimiter, webhookLimiter } = require('./middleware/granularRateLimit');
const { deviceRateLimit } = require('./middleware/deviceRateLimit');
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
const opsRoutes = require('./routes/opsRoutes');
const callbackRoutes = require('./routes/callbackRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const marketingRoutes = require('./routes/marketingRoutes');
const ussdRoutes = require('./routes/ussdRoutes');
const mkobaRoutes = require('./routes/mkobaRoutes');
const totpRoutes = require('./routes/totpRoutes');
const currencyRoutes = require('./routes/currencyRoutes');
const countryRoutes = require('./routes/countryRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
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
const vaultRoutes = require('./routes/vaultRoutes');
const cacheRoutes = require('./routes/cacheRoutes');
const merchantRoutes = require('./routes/merchantRoutes');
const budgetRoutes = require('./routes/budgetRoutes');
const creditRoutes = require('./routes/creditRoutes');
const cardRoutes = require('./routes/cardRoutes');
const saccosRoutes = require('./routes/saccosRoutes');
const secondaryRoutes = require('./routes/secondaryRoutes');
const bapRoutes = require('./routes/bapRoutes');
const publicStatsRoutes = require('./routes/publicStats');
const passportRoutes = require('./routes/passportRoutes');
const marketplaceRoutes = require('./routes/marketplaceRoutes');
const disputeRoutes = require('./routes/disputeRoutes');
const projectRoutes = require('./routes/projectRoutes');
const aiRoutes = require('./routes/aiRoutes');
const procurementRoutes = require('./routes/procurementRoutes');
const developerRoutes = require('./routes/developerRoutes');
const socialFundRoutes = require('./routes/socialFundRoutes');
const governanceRoutes = require('./routes/governanceRoutes');
const payrollRoutes = require('./routes/payrollRoutes');
const recurrenceRoutes = require('./routes/recurrenceRoutes');
const lendingCircleRoutes = require('./routes/lendingCircleRoutes');
const kilimoRoutes = require('./routes/kilimoRoutes');
const fieldPartnerRoutes = require('./routes/fieldPartnerRoutes');
const eventRoutes = require('./routes/eventRoutes');
const featureFlagRoutes = require('./routes/featureFlagRoutes');
const fraudOpsRoutes = require('./routes/fraudOpsRoutes');
const experimentRoutes = require('./routes/experimentRoutes');
const fourEyesRoutes = require('./routes/fourEyesRoutes');
const outboxRoutes = require('./routes/outboxRoutes');
const outbox = require('./services/outboxService');
const { createNotification } = require('./services/notificationService');
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

// Outbox / event-bus default handlers (transaction-aware fan-out).
let _outboxRetryCount = 0;
outbox.registerHandler('MERCHANT_PAYOUT_EXECUTED', async ({ payload }) => {
  const m = (await pool.query('SELECT user_id FROM merchants WHERE id = $1', [payload.merchantId])).rows[0];
  await createNotification(m ? m.user_id : payload.userId, {
    title: 'Malipo ya mfanyabiashara yametumwa',
    body: payload.reference ? `Rejea: ${payload.reference}` : 'Malipo yametumwa.',
    type: 'FRAUD_TRANSACTION',
  }).catch(() => {});
});
outbox.registerHandler('VICOBA_LOAN_APPROVED', async ({ payload }) => {
  await createNotification(payload.applicantUserId, {
    title: 'Mkopo wa VICOBA umetolewa',
    body: `Mkopo wa TZS ${payload.amount} umewekwa kwenye wallet yako.`,
    type: 'TRANSACTION',
  }).catch(() => {});
});
outbox.registerHandler('OUTBOX_TEST', async ({ payload }) => {
  await createNotification(payload.userId, { title: 'Outbox heartbeat', body: 'delivered' });
});
outbox.registerHandler('OUTBOX_RETRY', async () => {
  _outboxRetryCount += 1;
  if (_outboxRetryCount % 3 !== 0) throw new Error('sigui bado');
});

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

// Health check (liveness)
app.get('/health', (req, res) => {
  res.json({ success: true, service: 'Afrikoba Global', status: 'UP', time: new Date().toISOString() });
});

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


// Swagger UI - API documentation (production off - usitangaze API surface).
// MUST be registered before the blanket authRequired in projectRoutes
// (projectRoutes applies router.use(authRequired) to every /api/v1/* path).
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

// API version info (production: jibu sahili bila link za docs).
// Registered with the docs mount (before the blanket authRequired router)
// so /api/v1 stays publicly reachable.
app.get('/api/v1', (req, res) => {
  res.json({ success: true, version: '1.0.0', docs: config.nodeEnv === 'production' ? false : '/api/v1/docs' });
});

// API Routes - rate limited kwa jumla
app.use('/api', apiLimiter);
app.use('/api', requestTelemetry);
app.use('/api', sqlInjectionGuard);
app.use('/api', verifyCsrfToken);
app.use('/api', xssProtection);
app.use('/api', inputLengthGuard);
app.use('/api', validateApiKey);
app.use('/api', validateTokenPayload);

// v1 canonical prefix + backward-compatible /api prefix
const versionPrefixes = ['/api/v1', '/api'];
for (const prefix of versionPrefixes) {
  app.use(`${prefix}/auth`, authLimiter, authRoutes);
  app.use(`${prefix}/wallet`, deviceRateLimit, walletLimiter, walletRoutes);
  app.use(`${prefix}/vicoba`, walletLimiter, vicobaRoutes);
  app.use(`${prefix}/vicoba`, walletLimiter, mkobaRoutes);
  app.use(`${prefix}/rosca`, walletLimiter, roscaRoutes);
  app.use(`${prefix}/p2p`, financialLimiter, p2pRoutes);
  app.use(`${prefix}/admin`, adminLimiter, adminRoutes);
  app.use(`${prefix}/ops`, adminLimiter, opsRoutes);
  app.use(`${prefix}/payments`, webhookLimiter, webhookReplayProtection, verifyWebhookHmac, callbackRoutes);
  app.use(`${prefix}/services`, serviceRoutes);
  app.use(`${prefix}/marketing`, marketingRoutes);
  app.use(`${prefix}/ussd`, webhookLimiter, ussdRoutes);
  app.use(`${prefix}/totp`, authLimiter, totpRoutes);
  app.use(`${prefix}/currency`, currencyRoutes);
  app.use(`${prefix}/countries`, countryRoutes);
  app.use(`${prefix}/devices`, walletLimiter, deviceRoutes);
  app.use(`${prefix}/notifications`, notificationRoutes);
  app.use(`${prefix}/referrals`, referralRoutes);
  app.use(`${prefix}/analytics`, analyticsRoutes);
  app.use(`${prefix}/banking`, walletLimiter, bankingRoutes);
  app.use(`${prefix}/advanced`, walletLimiter, advancedRoutes);
  app.use(`${prefix}/smart`, walletLimiter, smartRoutes);
  app.use(`${prefix}/eco`, walletLimiter, ecosystemRoutes);
  app.use(`${prefix}/network`, walletLimiter, networkRoutes);
  app.use(`${prefix}/family`, walletLimiter, familyRoutes);
  app.use(`${prefix}/business`, walletLimiter, businessRoutes);
  app.use(`${prefix}/savings`, walletLimiter, savingsRoutes);
  app.use(`${prefix}/budget`, walletLimiter, budgetRoutes);
  app.use(`${prefix}/vaults`, walletLimiter, vaultRoutes);
  app.use(`${prefix}/cache`, adminLimiter, cacheRoutes);
  app.use(`${prefix}/merchant`, walletLimiter, merchantRoutes);
  app.use(`${prefix}/credit`, walletLimiter, creditRoutes);
  app.use(`${prefix}/cards`, walletLimiter, cardRoutes);
  if (process.env.SACCOS_ENABLED === 'true') {
    app.use(`${prefix}/saccos`, walletLimiter, saccosRoutes);
  }
  app.use(`${prefix}/bap`, walletLimiter, bapRoutes);
  app.use(`${prefix}/stats`, publicStatsRoutes);
  app.use(`${prefix}/passport`, walletLimiter, passportRoutes);
  app.use(`${prefix}/marketplace`, walletLimiter, marketplaceRoutes);
app.use(`${prefix}/disputes`, walletLimiter, disputeRoutes);
  app.use(`${prefix}/secondary`, walletLimiter, secondaryRoutes);
  // Events mounted BEFORE projectRoutes: projectRoutes applies router.use(authRequired)
  // blanket — public event share routes need to stay reachable unauthenticated.
  app.use(`${prefix}/events`, walletLimiter, eventRoutes);
  app.use(`${prefix}/outbox`, walletLimiter, outboxRoutes);
  app.use(prefix, projectRoutes);
  app.use(`${prefix}/ai`, aiRoutes);
  app.use(`${prefix}/procurement`, procurementRoutes);
  app.use(`${prefix}/developer`, developerRoutes);
  app.use(`${prefix}/social`, walletLimiter, socialFundRoutes);
  app.use(`${prefix}/governance`, governanceRoutes);
  app.use(`${prefix}/payroll`, payrollRoutes);
  app.use(`${prefix}/recurrence`, recurrenceRoutes);
  app.use(`${prefix}/circles`, walletLimiter, lendingCircleRoutes);
  app.use(`${prefix}/kilimo`, walletLimiter, kilimoRoutes);
  app.use(`${prefix}/field-partners`, walletLimiter, fieldPartnerRoutes);
  app.use(`${prefix}/features`, featureFlagRoutes);
  app.use(`${prefix}/experiments`, experimentRoutes);
  app.use(`${prefix}/admin/four-eyes`, adminLimiter, fourEyesRoutes);
  app.use(`${prefix}/fraud-ops`, adminLimiter, fraudOpsRoutes);
}

// Deprecation header for non-versioned /api routes
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/v1')) {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toUTCString());
    res.setHeader('Link', '</api/v1' + req.path + '>; rel="successor-version"');
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

// Partition future months for journal_entries + audit_logs (idempotent boot ensure;
// runs unconditionally so ledger/audit writes never hit a missing partition).
const { ensureAll: ensurePartitionsAtBoot } = require('./services/partitionService');
ensurePartitionsAtBoot().catch((e) => logger.error('PARTITION-BOOT', e.message));

// Start background jobs (reconciliation, ROSCA payout, split payment)
if (process.env.DISABLE_CRON !== 'true') {
  const { startAllJobs } = require('./jobs/runAll');
  startAllJobs();
  // H18: Start backup scheduler
  const { startBackupScheduler } = require('./services/backupService');
  startBackupScheduler();
  // Recurrence automation scheduler (auto-payroll, auto-savings, contribution cycles)
  const { startRecurrenceScheduler } = require('./services/recurrenceService');
  startRecurrenceScheduler(parseInt(process.env.RECURRENCE_INTERVAL_MS, 10) || 60000);
  // Event reminders (commitment due / upcoming event) — best-effort hourly sweep
  const { runEventReminders } = require('./services/eventService');
  const runReminders = () => runEventReminders().catch(() => {});
  runReminders();
  setInterval(runReminders, parseInt(process.env.EVENT_REMINDER_INTERVAL_MS, 10) || 3600000);
  // Recurring event series (templates + cadence) — generate due events, best-effort hourly
  const { runDueEventSeries } = require('./services/eventService');
  const runSeries = () => runDueEventSeries().catch(() => {});
  runSeries();
  setInterval(runSeries, parseInt(process.env.EVENT_SERIES_INTERVAL_MS, 10) || 3600000);
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
  const detail = (reason && (reason.stack || reason.message)) || String(reason);
  logger.error('SERVER', `Unhandled Rejection: ${detail}`);
});
process.on('uncaughtException', (err) => {
  const detail = (err && (err.stack || err.message)) || String(err);
  logger.error('SERVER', `Uncaught Exception: ${detail}`);
});
