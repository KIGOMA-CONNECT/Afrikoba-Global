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

## 3. Kuweka bila kusumbua domains nyingine (multi-domain / co-tenancy)

Ikiwa `afrikoba.com` inaishi kwenye server ambayo tayari ina domains nyingine
(e.g., WordPress, apps nyingine), fuata kanuni hizi ili **kila domain ifanye kazi
vyake bila kuguswa**:

**Kwa nini hatutagusa chochote:**
- Kila stack ya `docker compose` ina **network yake**, **volumes zake** na
  **container names** zenye prefix ya jina la project (`afrikoba_...`). Docker
  projects nyingine zinaendelea kwa kamili.
- API **inafunguka kwenye `127.0.0.1:${APP_PORT:-3000}` pekee** — haiwezi
  kuangukia kwenye ports zilizotumika na apps nyingine, wala kufunguliwa kwa nje
  moja kwa moja. Port inabadilishwa kwenye `.env` (`APP_PORT`) kama 3000 inatumiwa.
- Reverse proxy hupata **vhost mpya tu** (site block moja) kwa `app.afrikoba.com`.
  Vhosts za domains nyingine hazibadilishwi. Tumia faili zilizotengenezwa kwenye
  `deploy/` (see §4): `Caddyfile.afrikoba` (add `import Caddyfile.afrikoba` kwenye
  Caddyfile kuu) au `nginx-afrikoba.conf` (sites-available + symlink + reload).
- DNS: ONGEZA **A-record moja mpya pekee** kwa subdomain yako, e.g.
  `app  A  <IP ya server>`. Record zilizopo za domains nyingine haziguswi.
- `deploy/deploy-afrikoba.sh` inaendesha stack ya `afrikoba` pekee (idempotent)
  na kuthibitisha `/health/db`.

**Hatua (mfuatano uliopendekezwa):**
1. DNS (Bluehost Domain Center → domain ya `afrikoba.com` → Add A record):
   `app.afrikoba.com → <IP ya VPS>` (mara tu ukipata IP). Subdomain hizo za DNS
   hizi pekee ndizo zinazohusika na Afrikoba.
2. Kwenye server: `cd /opt/afrikoba && cp .env.example .env && bash deploy/deploy-afrikoba.sh`
3. Reverse proxy: `deploy/Caddyfile.afrikoba` au `deploy/nginx-afrikoba.conf`
   (ONGEZA tu — usibadilishe vhosts zilizopo).
4. Thibitisha:
   - `docker ps --filter name=afrikoba` → containers za afrikoba pekee zimeorodheshwa
   - `curl -I https://app.afrikoba.com/health` → `200`
   - `curl -I https://domain-nyingine-yako` → bado iko sawa (haijaguswa)

---

## 4. TLS & Reverse Proxy (inapendekezwa: Caddy/Nginx)

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

> Kwa server iliyo na **domains nyingine**: tumia faili zilizotengenezwa
> `deploy/Caddyfile.afrikoba` au `deploy/nginx-afrikoba.conf` (ONGEZA vhost peke
> yako, usibadilisha zilizopo) — angalia §3.

---

## 5. Monitoring & Maintenance

- Uptime: UptimeRobot / Better Stack kwenye `https://app.afrikoba.com/health`.
- Server logs: stdout (JSON) — connect kwenye Grafana/CloudWatch/Loki.
- DB backups: hakikisha `backups/` yanasynchronized (S3/R2) — **si kwenye server moja**.
- Cron jobs (split ya P2P, kukomaeza makusanyo): `node src/jobs/runAll.js`
  (imefanya hapa chini ya scheduling ya system).
- Update wa salama: `npm audit` mara moja kwa mwezi; upgrade image base.

---

## 6. Mobile App (Release)

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

## 7. Vigezo vya Kuenda LIVE (Go-Live Checklist)

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

## 8. CI/CD

`.github/workflows/ci.yml` hutoa:

- Backend: integration suite (78 checks) + regression scripts dhidi ya Postgres
  ya CI (rate limiting off kwa ajili ya tests).
- Dashboard: Vite build.
- Mobile: `flutter analyze` + `flutter test` + `flutter build web` +
  `flutter build apk --debug`.

Release APK signed: build manually (sehemu ya 5) au add job ya signing kwa
secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, ...).

---

## 9. Hatua za Kwanza (Sasa)

1. `git init` + commit (angalia `.gitignore` — `.env` haipaswi kucommit).
2. Push kwenye GitHub → CI inathibitisha tests.
3. Andaa VPS (2 vCPU/4GB) → install Docker → `docker compose up -d --build`.
4. Weka Caddy/Nginx + domain.
5. Anza checklist ya sehemu ya 6 (malipo + leseni = kazi kubwa zaidi).
