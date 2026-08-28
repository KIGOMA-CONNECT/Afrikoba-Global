#!/usr/bin/env bash
# =========================================================
# AFRIKOBA GLOBAL - Deploy script (additive & idempotent)
# ---------------------------------------------------------
# HUGAANISHA/HAKUSUMBUI domains nyingine wala Docker projects
# nyingine kwenye server hii. Kila inachofanya ni kuendesha
# stack ya "afrikoba" pekee (network, volumes, containers zake).
#
# Inafanya:
#   1. Build + up ya stack (migrations zinaenda kwenye startup)
#   2. Kusubiri health kupitia 127.0.0.1 (up to 90s)
#   3. Kumsaidia kutaja hatua za reverse proxy katika faili ya deploy/
#
# Matumizi:
#   cd /opt/afrikoba
#   cp .env.example .env   # jaza maadili halisi
#   bash deploy/deploy-afrikoba.sh
#
# COMPOSE_PROJECT_NAME inaweza kubadilishwa kwenye .env ikiwa unataka
# stack nyingine (staging) pamoja na prod - haiathiriani.
# =========================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker haipo kwenye server. Sakinisha Docker kwanza." >&2
  exit 1
fi

PROJECT="${COMPOSE_PROJECT_NAME:-afrikoba}"
APP_PORT="${APP_PORT:-3000}"

echo "==> [Afrikoba] Deploying Docker project '$PROJECT' (port 127.0.0.1:${APP_PORT}) ..."

# Hakuna --env-file flag za project nyingine; tu project pekee inaendeshwa.
docker compose --project-name "$PROJECT" up -d --build

echo "==> [Afrikoba] Kuthibitisha health ..."
ok=0
for i in $(seq 1 45); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/health/db" || true)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done

if [ "$ok" != "1" ]; then
  echo "ERROR: Afrikoba healthcheck imeshindwa (127.0.0.1:${APP_PORT}/health/db). Angalia:"
  echo "       docker compose --project-name $PROJECT logs --tail=100 app" >&2
  exit 1
fi

echo "==> [Afrikoba] OK - API ipo salama kwenye http://127.0.0.1:${APP_PORT}"

echo ""
echo "==> [Afrikoba] HATUA ZINAZOFUATA (usibadilishe vhosts za domains nyingine):"
echo "    1) Reverse proxy - ONGEZA vhost mpya tu:"
echo "       - Caddy : kuweka deploy/Caddyfile.afrikoba na 'import' kwenye Caddyfile kuu"
echo "       - Nginx : deploy/nginx-afrikoba.conf -> sites-available + reload"
echo "    2) DNS: ONGEZA A-record mpya pekee (Bluehost Domain Center):"
echo "       app.afrikoba.com  A  <IP ya server>   (record zilizopo usiziguse)"
echo "    3) Thibitisha domains nyingine bado zinafanya kazi:"
echo "       curl -I https://domain-nyingine-yako"
echo ""
echo "==> [Afrikoba] Tazama logi:"
echo "    docker compose --project-name $PROJECT logs -f app"