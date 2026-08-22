require('dotenv').config();

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

// Trust proxy (reverse proxy / load balancer) - lazima kwa rate limiting na req.ip
if (config.trustProxy) {
  app.set('trust proxy', 1);
}

// Security headers. CSP imesanifiwa kwa SPA (React dashboard) - inline styles,
// blob workers (Flutter web) na connect kwa same-origin/HTTPS.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
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
app.use(express.json({ limit: '1mb' }));

// Sentry request handler — must be before routes
if (config.sentry.dsn) app.use(Sentry.Handlers.requestHandler());

// Access logging + request-id
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

// API Routes - rate limited kwa jumla
app.use('/api', apiLimiter);

// v1 canonical prefix + backward-compatible /api prefix
const versionPrefixes = ['/api/v1', '/api'];
for (const prefix of versionPrefixes) {
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/wallet`, walletRoutes);
  app.use(`${prefix}/vicoba`, vicobaRoutes);
  app.use(`${prefix}/vicoba`, mkobaRoutes);
  app.use(`${prefix}/rosca`, roscaRoutes);
  app.use(`${prefix}/p2p`, p2pRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
  app.use(`${prefix}/payments`, callbackRoutes);
  app.use(`${prefix}/services`, serviceRoutes);
  app.use(`${prefix}/marketing`, marketingRoutes);
  app.use(`${prefix}/ussd`, ussdRoutes);
}

// API version info
app.get('/api/v1', (req, res) => {
  res.json({ success: true, version: '1.0.0', docs: '/api/v1/docs' });
});

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
app.use(errorHandler);

// Start background jobs (reconciliation, ROSCA payout, split payment)
if (process.env.DISABLE_CRON !== 'true') {
  const { startAllJobs } = require('./jobs/runAll');
  startAllJobs();
}

function startServer(server) {
  server.listen(config.port, () => {
    const proto = server instanceof https.Server ? 'https' : 'http';
    logger.info('SERVER', `Afrikoba Global inaendeshwa kwenye ${proto}://localhost:${config.port} (${config.nodeEnv})`);
  });
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
