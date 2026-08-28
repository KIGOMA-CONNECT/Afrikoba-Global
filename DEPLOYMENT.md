# AFRIKOBA GLOBAL — Deployment Guide

Mwongozo huu unaelezea jinsi ya kufunga na kuendesha mfumo wa Afrikoba Global
(API + Web Dashboard + Mobile App) katika mazingira ya production.

---

## 1. Mazingira (Environment)

| Variable | Maana | Thamani ya Production |
|---|---|---|
| `NODE_ENV` | Mode ya app | `production` |
| `PORT` | Port ya API | `3000` |
| `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` | PostgreSQL | managed DB (hapa chini) |
| `JWT_SECRET` | Siri ya token | random hex 48+ (`openssl rand -hex 48`) |
| `JWT_TTL` | Maisha ya token | `7d` |
| `CORS_ORIGINS` | Domains zinazoruhusiwa | `https://app.afrikoba.com,https://admin.afrikoba.com` (si `*`) |
| `WEBHOOK_SECRET` | Signature ya webhooks | random hex 48+ |
| `ALLOWED_WEBHOOK_IPS` | IP za AzamPay/Bank API | `41.79.128.0/17,...` |
| `BEEM_API_KEY / BEEM_SECRET_KEY / BEEM_SENDER_ID` | SMS (Beem) | maadili halisi kutoka Beem |
| `AZAMPAY_APP_NAME / CLIENT_ID / CLIENT_SECRET / AZAMPAY_ENV` | Malipo (AzamPay) | `AZAMPAY_ENV=production` |
| `CONTRACT_BASE_URL` | Viungo vya PDF za mikataba | `https://app.afrikoba.com/contracts` |
| `TRUST_PROXY` | Upstream reverse proxy | `true` |
| `TLS_CERT_PATH / TLS_KEY_PATH` | SSL (kama si reverse proxy) | path za cert/key |

**Fail-fast:** ikiwa `NODE_ENV=production` na thamani muhimu hazipo (JWT_SECRET ya
default, DB_PASSWORD, WEBHOOK_SECRET, Beem, AzamPay, CORS `*`, CONTRACT_BASE_URL
isiyo https), server **itakataa kuanza** (`src/config/index.js` → `validateConfig`).

Nakili `.env.example` → `.env` na ujaze. **Usiweke `.env` kwenye git.**

---

## 2. Chaguo la Deployment

### A. Docker Compose (imeandaliwa) — inapendekezwa kwa VPS

```bash
cp .env.example .env      # jaza maadili halisi
docker compose up -d --build
```

- `db`: PostgreSQL 16, schema + seed ndani ya initdb (fresh DB pekee), backup
  ya nightly kwenye `./backups`, volume `db_data`.
- `app`: image ya multi-stage (dashboard imejengwa ndani), non-root user,
  healthcheck, auto-restart. Kwenye startup, app **inatumia migrations**
  (`scripts/runMigrations.js`: `db/migrations/*.sql` — idempotent) kabla ya
  kuanza API. Hivyo fresh DB inapata schema nzima (001–NNN), sio `schema.sql`
  pekee. Sawa kutumia: `docker compose exec app node scripts/runMigrations.js`.
- Backup ya DB: `scripts/backup-db.sh` (pg_dump custom-format, retention 14d).
  Add kwenye cron: `0 2 * * * bash /opt/afrikoba/scripts/backup-db.sh`.

**Kumbuka:** katika compose, `CORS_ORIGINS` haipaswi kuwa `*` — weka domain halisi.
Vinginevyo `validateConfig()` italalamika kwenye `NODE_ENV=production`.

### B. Render / Railway / Fly.io (PaaS)

- Postgres: tumia managed Postgres ya platform (msingi wa backup/replication).
- Webservice: `npm ci --omit=dev && node src/server.js`.
- Weka env zote za jedwali la juu; `TRUST_PROXY=true` (PaaS ina TLS kwenye edge).

### C. Kubernetes

- Image sawa na Dockerfile; tumia Secret kwa env; service/ingress na TLS.
- `livenessProbe: /health`, `readinessProbe: /health/db`.

---

## 3. TLS & Reverse Proxy (inapendekezwa: Caddy/Nginx)

Caddy (SSL otomatiki):

```
app.afrikoba.com {
    reverse_proxy 127.0.0.1:3000
}
```

Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name app.afrikoba.com;
    ssl_certificate     /etc/letsencrypt/live/app.afrikoba.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.afrikoba.com/privkey.pem;
    client_max_body_size 10m;
    location / { proxy_pass http://127.0.0.1:3000; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
}
```

Server tayari iko na: helmet CSP, CORS allowlist, rate limiting,
`X-Request-Id`, `/health` + `/health/db`.

---

## 4. Monitoring & Maintenance

- Uptime: UptimeRobot / Better Stack kwenye `https://app.afrikoba.com/health`.
- Server logs: stdout (JSON) — connect kwenye Grafana/CloudWatch/Loki.
- DB backups: hakikisha `backups/` yanasynchronized (S3/R2) — **si kwenye server moja**.
- Cron jobs (split ya P2P, kukomaeza makusanyo): `node src/jobs/runAll.js`
  (imefanya hapa chini ya scheduling ya system).
- Update wa salama: `npm audit` mara moja kwa mwezi; upgrade image base.

---

## 5. Mobile App (Release)

- **Token sasa inahifadhiwa kwenye secure storage** (`flutter_secure_storage`:
  Android Keystore / iOS Keychain / Windows DPAPI).
- Base URL: `flutter build apk --release --dart-define=API_BASE=https://api.afrikoba.com/api`
  (default ni `http://localhost:3000/api` kwa maendeleo).
- **Android signing:** tengeneza keystore → weka `android/key.properties`
  (USIIWEKE kwenye git) → `flutter build appbundle --release` kwa Play Console.
- **iOS signing:** Xcode (macOS) → certificates/provisioning → TestFlight/App Store.
- Play/App Store zinahitaji: privacy policy, consent forms, data deletion,
  maelezo ya BOT/CMSA (hapa chini).

---

## 6. Vigezo vya Kuenda LIVE (Go-Live Checklist)

Hii ni **muhimu kabla ya kuingia production**:

1. [ ] **Malipo halisi (AzamPay)**: account ya production, API keys halisi,
      `AZAMPAY_ENV=production`. JARIBU flow kamili: Lipa → callback → wallet credit.
2. [ ] **SMS halisi (Beem)**: account halisi, sender ID imeidhinishwa, msapato uliohesabiwa.
3. [ ] **KYC/AML**: kitambulisho, verification, madokezo ya deal-amount kama inavyotakiwa.
4. [ ] **BOT (Benki Kuu / BoT)**: leseni/ushirikiano kwa shughuli za fedha —
      muundo wa P2P (michango na malipo ya mikopo) ni **money service**;
      wasiliana na BoT kupitia KAMINI au mshauri wa kisheria.
5. [ ] **CMSA (Capital Markets and Securities Authority)**: ikiwa P2P/VICOBA
      zinatoa *returns* kwa wawekezaji, hii inaweza kuwa *securities* —
      hitaji la usajili/leseni CMSA.
6. [ ] **PDPA (Data Protection Act 2022)**: usajili wa **Data Controller** kwa
      ODPC, privacy policy, consent, data subject rights, data retention.
7. [ ] **Contracts / E-signature**: PDF za mikataba — mawakili waweze kureview
      (VICOBA, P2P, ROSCA).
8. [ ] **Monitoring + Alerting** (sehemu ya 4).
9. [ ] **DR / Backup** uthibitisho: jaribu restore ya backup ndani ya kipindi cha muda.
10. [ ] **Elimu ya watumiaji**: mwongozo wa app kwa Kiswahili, help desk, malalamiko.

---

## 7. CI/CD

`.github/workflows/ci.yml` hutoa:

- Backend: integration suite (78 checks) + regression scripts dhidi ya Postgres
  ya CI (rate limiting off kwa ajili ya tests).
- Dashboard: Vite build.
- Mobile: `flutter analyze` + `flutter test` + `flutter build web` +
  `flutter build apk --debug`.

Release APK signed: build manually (sehemu ya 5) au add job ya signing kwa
secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, ...).

---

## 8. Hatua za Kwanza (Sasa)

1. `git init` + commit (angalia `.gitignore` — `.env` haipaswi kucommit).
2. Push kwenye GitHub → CI inathibitisha tests.
3. Andaa VPS (2 vCPU/4GB) → install Docker → `docker compose up -d --build`.
4. Weka Caddy/Nginx + domain.
5. Anza checklist ya sehemu ya 6 (malipo + leseni = kazi kubwa zaidi).
