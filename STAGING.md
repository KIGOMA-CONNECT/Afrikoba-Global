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

Sasa: self-signed cert (`/etc/nginx/ssl-staging/`) - browser itaonya.

Baada ya DNS A record (`staging` → `129.121.86.66`) kuanza kusolve,
Let's Encrypt inaweza kuwekwa:

```bash
/usr/bin/certbot --nginx -d staging.afrikoba.com \
  --register-unsafely-without-email --agree-tos
```

## Vhost (aaPanel nginx)

Faili: `/www/server/panel/vhost/nginx/staging.afrikoba.com.conf`

- HTTP → HTTPS redirect
- `/` : Basic Auth + proxy → `127.0.0.1:3001`
- `/api/` : proxy → `127.0.0.1:3001` (no Basic Auth; app JWT inalinda)