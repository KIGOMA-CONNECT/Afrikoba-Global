# Staging Environment — Afrikoba Global

Staging ni mazingira tofauti kabisa ya majaribio (test/review) inayoendesha
code ya `main` bila kugusa production.

## Access

| Kitu | Thamani |
|---|---|
| URL | `https://staging.afrikoba.com` |
| Basic Auth (dashboard tu) | `admin-staging` / `AfriKoba#Stagin9!2026` |
| Namba ya test | `+255719000002` |
| OTP | Inatolewa na response ya send-otp as `devOtp` (hakuna SMS halisi) |

> `/api/*` haiko nyuma ya Basic Auth - imelindwa na mfumo wa app yenyewe
> (JWT/OTP, rate limits, lockout). `auth_basic` inatumika kwenye `/` pekee
> (SPA + assets) ili browser ishinde mgongano wa header ya `Authorization`.

## Uhusiano na Production

Staging inaendesha kwenye **server hiyohiyo** (`129.121.86.66`) lakini ni
**pekee kabisa**:

- Compose project: `afrikoba-staging` (network na volumes zake)
- Bandari: `127.0.0.1:3001` (sio 3000 ya production)
- DB: `afrikoba_global_staging` (sio `afrikoba_global`)
- Redis yake mwenyewe
- Credentials za SMS/Wallet zote ni `placeholder` au sandbox
  (`AZAMPAY_ENV=sandbox`) - **hakuna transaction halisi**

Production huendeshwa kutoka `/var/www/afrikoba`; staging kutoka
`/var/www/afrikoba-staging`. Paths mbili tofauti: staging haiwezi kuathiri
production.

## Deploy Mipya

1. Nenda: GitHub → Actions → **Afrikoba Staging Deployment**
2. Bonyeza **Run workflow** (manual pekee; hutumia `origin/main` sasa)
3. Subiri hadi "Staging API healthy" (kawaida < 1 min after rebuild)

Workflow inafanya: `git fetch/reset` kwenye `/var/www/afrikoba-staging`
→ `docker compose -p afrikoba-staging --env-file .env.staging up -d --build`
→ inangojea `/health/db` kuonyesha `db:UP`.

> `.env.staging` inahifadhiwa: workflow haitaifuta. Secrets zake ziko kwenye
> GitHub (STAGING_DB_PASSWORD, STAGING_JWT_SECRET, STAGING_WEBHOOK_SECRET).

## Backup

Cron kila siku saa 2:00 asubuhi inaendesha pg_dump (gzip) kwenye
`/var/www/afrikoba-staging/backups-staging/` na huhifadhi backup **7 za
mwisho**. Inaweza kuendeshwa kwa mkono:

```bash
bash /var/www/afrikoba-staging/backups-staging/staging-backup.sh
```

## Rollback

```bash
cd /var/www/afrikoba-staging
git checkout <commit_ya_nyuma>
docker compose --env-file .env.staging -p afrikoba-staging up -d --build
```

Kurejesha DB kutoka backup:

```bash
zcat backups-staging/afrikoba_global_staging_*.sql.gz | \
  docker exec -i afrikoba-staging-db-1 psql -U afrikoba -d afrikoba_global_staging
```

## TLS

**Let's Encrypt** (halisi) imeshawekwa - browser haitaonya.
Cert itarenew kiotomatiki na certbot. Unaweza kuangalia:

```bash
echo | openssl s_client -connect staging.afrikoba.com:443 -servername staging.afrikoba.com 2>/dev/null | openssl x509 -noout -issuer -dates
```

## Vhost (aaPanel nginx)

Faili: `/www/server/panel/vhost/nginx/staging.afrikoba.com.conf`

- HTTP → HTTPS redirect
- `/` : Basic Auth + proxy → `127.0.0.1:3001`
- `/api/` : proxy → `127.0.0.1:3001` (no Basic Auth; app JWT inalinda)

---

# Testing Guide (Maabara ya Frontend)

## 1) Credentials za kuingia

**Door ya nje (Basic Auth — dashboard tu):**
- User: `admin-staging` — Password: `AfriKoba#Stagin9!2026`

**Test user wa app:**
- Namba: `0719000002` ≡ `+255719000002` ≡ `255719000002` (zote tatu zinakubalika)
- PASSWORD/OTP: hakuna password ya kudumu — login ni **OTP inayobadilika**.
  Kwenye staging (`NODE_ENV=development`), OTP inaonekana moja kwa moja kwenye
  skrini (sanduku la kijani `devOtp`). Kila OTP inatumika mara moja tu.

**Njia mbadala (API):**
```bash
# 1. Tuma OTP (inarejesha devOtp moja kwa moja)
curl -s -X POST https://staging.afrikoba.com/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+255719000002"}'
#   → {"success":true,"devOtp":"XXXXXX",...}

# 2. Ingia kwa kutumia devOtp
curl -s -X POST https://staging.afrikoba.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber":"+255719000002","otp":"XXXXXX"}'
#   → {"token":"...","user":{...}}
```

## 2) Test entities na roles

| User | Namba | Roli | KYC | Wallet | Status |
|---|---|---|---|---|---|
| Staging Test User (id=1) | `255719000002` | `MJUMBE` | 1 | 0.00 TZS | active |

Roli zilizopo katika mfumo (kwenye code): `MJUMBE` (chaguo-msingi),
`ADMIN`, `OPERATOR`, `OPS`, `COMPLIANCE`, `SUPPORT`, `FIELD_PARTNER`,
`AGRONOMIST`, na SACCOS office: `CHAIR`, `TREASURER`, `SECRETARY`.
(Nyongeza ya roli kwa watumiaji wa staging inawezekana — omba tu.)

## 3) Staging checklist (hali ya sasa)

| Kipengele | Hali |
|---|---|
| SSL Let's Encrypt (halisi) | ✅ |
| Basic Auth + JWT (`Bearer` kutoka merged header) | ✅ imerekebishwa |
| DB tofauti `afrikoba_global_staging` + sandbox pekee | ✅ |
| Backup daily 2:00 + monitor kila 15 min | ✅ |
| Rollback script | ✅ |
| Deploy workflow (manual pekee) | ✅ |
| Production `afrikoba.com` | ✅ haigusiwi |

**Tahadhari ya browser:** ukiingia Basic Auth kwanza, browser inaweka header
moja `Authorization: Basic …, Bearer …` kwa `/api`. Fix ya `092eb1b`
(auth.js) inashughulikia hili — iko kwenye staging sasa.

## 4) AzamPay sandbox — credentials au flow

- `AZAMPAY_ENV=sandbox` kwenye staging → API inaelekeza kwenye
  `https://sandbox.azampay.co.tz` + `https://authenticator-sandbox.azampay.co.tz`.
- Credentials za sasa ni **placeholder** → deposit flow inarudi na hitilafu
  laini ("Imeshindwa kupata Access Token kutoka AzamPay") — salama, hakuna
  USSD push wala hela inayosogea.
- **Kwa jaribio la green-path (USSD halisi ya sandbox):**
  1. Jitokeze kwenye https://portal.azampay.co.tz (sandbox developer)
  2. Unda app ya sandbox → pata `AZAMPAY_APP_NAME`, `AZAMPAY_CLIENT_ID`,
     `AZAMPAY_CLIENT_SECRET`
  3. Nitaingiza vigezo hivyo kwenye server `.env.staging` na kurestart app
  4. Jaribu kupitia UI: **Wallet → Amana (Deposit)** — provider `Mpesa/Tigo/…`
     (`POST /api/v1/wallet/deposit/initiate {amount≥1000, provider}`)
  5. Namba yako ya simu itapokea USSD ombi la kuthibitisha (sandbox).
- Callback ya sandbox: `POST /api/v1/payments/azampay-callback` (ina HMAC).
- Internal transfer (bila sandbox): `POST /api/v1/wallet/transfer`
  `{toPhoneNumber, amount, note}`.

## 5) Maelekezo ya kuingia kwenye mfumo (UI)

1. Fungua `https://staging.afrikoba.com`
2. Basic Auth → `admin-staging` / `AfriKoba#Stagin9!2026`
3. Tab **Ingia** → namba `0719000002` → **Tuma OTP**
4. Chukua OTP kwenye sanduku la kijani (`devOtp`) → ingiza → **Ingia**
5. Utajikuta kwenye dashboard (nilipo unaweza kubadili SW/EN juu kulia,
   kagua SACCOS, Wallet, malipo, n.k.)