# Afrikoba Global - Go-Live Production Checklist

## 1. Infrastructure
- [ ] Ubuntu 22.04+ server, 4+ CPU, 8GB+ RAM, 100GB+ SSD
- [ ] Docker + Docker Compose installed
- [ ] Domain: api.afrikoba.com, app.afrikoba.com
- [ ] DNS A records pointing to server IP
- [ ] SSL/TLS via Let's Encrypt or Cloudflare
- [ ] Nginx reverse proxy configured
- [ ] Firewall: only 80, 443, SSH open

## 2. Database
- [ ] PostgreSQL 16+ installed
- [ ] Run all 10 migrations in order (001-010)
- [ ] Create read replica for analytics queries
- [ ] Automated daily backups configured
- [ ] Connection pooling (PgBouncer) configured

## 3. Environment Variables (Critical)
- [ ] NODE_ENV=production
- [ ] AZAMPAY_ENV=production (CHANGE FROM sandbox!)
- [ ] JWT_SECRET (64+ char random hex)
- [ ] BEEM_API_KEY, BEEM_SECRET_KEY (production)
- [ ] AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET (production)
- [ ] WEBHOOK_SECRET, USSD_SECRET (random hex)
- [ ] CORS_ORIGINS=https://app.afrikoba.com
- [ ] SENTRY_DSN (production DSN)
- [ ] REDIS_URL=redis://localhost:6379
- [ ] TRUST_PROXY=1

## 4. Deploy
- [ ] git clone + cp .env.example .env + fill values
- [ ] docker compose up -d --build
- [ ] Verify: docker compose ps (all healthy)
- [ ] Verify: curl localhost:3000/health

## 5. Monitoring
- [ ] Sentry error tracking active
- [ ] UptimeRobot/Pingdom monitoring /health
- [ ] Alert on downtime > 2 minutes
- [ ] Log rotation configured

## 6. Security
- [ ] All secrets rotated from defaults
- [ ] Rate limiting enabled
- [ ] USSD HMAC + webhook guard active
- [ ] SSH key-only access
- [ ] Fail2ban configured
- [ ] Privacy policy + ToS published

## 7. Payment Providers
- [ ] Beem Africa: production keys, sender ID, webhook URL
- [ ] AzamPay: production merchant account, webhook URL
- [ ] USSD shortcode registered with TCRA
- [ ] Test end-to-end: deposit + withdrawal + transfer

## 8. Post-Launch
- [ ] Monitor error rates for 24h
- [ ] Test all payment flows with real (small) amounts
- [ ] Verify SMS delivery
- [ ] Verify USSD flow
- [ ] Check admin dashboard metrics
- [ ] Announce launch
