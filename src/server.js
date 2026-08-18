require('dotenv').config();

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

// Fail-fast: usiendelee na mazingira ya production yenye maadili hatari.
config.validateConfig();

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
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/vicoba', vicobaRoutes);
app.use('/api/rosca', roscaRoutes);
app.use('/api/p2p', p2pRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', callbackRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/ussd', ussdRoutes);

// SPA fallback: non-API routes -> index.html (React Router)
app.get(/^\/(?!api|contracts|health).*/, (req, res, next) => {
  if (fs.existsSync(webDist)) {
    return res.sendFile(path.join(webDist, 'index.html'));
  }
  next();
});

app.use(notFound);
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
