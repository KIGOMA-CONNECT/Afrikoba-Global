#!/bin/bash
# ============================================================
# AFRIKOBA GLOBAL - Nightly DB backup (host cron)
# Hufanya pg_dump (custom format) ndani ya container ya db.
# Password inasomwa kutoka /opt/afrikoba/.env (hakuna kwenye cron).
#
# Cron (root):
#   0 2 * * * bash /opt/afrikoba/scripts/backup-cron.sh >> /opt/afrikoba/backups/backup.log 2>&1
# ============================================================
set -eo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-afrikoba}"
CONTAINER="${PROJECT}-db-1"
DIR=/opt/afrikoba/backups
RETENTION_DAYS=14

# Load DB credentials kutoka .env (si password inahifadhiwa kwenye crontab)
set -a
# shellcheck disable=SC1091
[ -f /opt/afrikoba/.env ] && . /opt/afrikoba/.env
set +a
: "${DB_USER:?DB_USER missing in /opt/afrikoba/.env}"
: "${DB_NAME:?DB_NAME missing in /opt/afrikoba/.env}"
: "${DB_PASSWORD:?DB_PASSWORD missing in /opt/afrikoba/.env}"

mkdir -p "$DIR"
chmod 700 "$DIR"

STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$DIR/afrikoba_global_${STAMP}.sql.gz"

echo "[$(date)] Backup inaanza: $FILE"

docker exec -e PGPASSWORD="$DB_PASSWORD" -i "$CONTAINER" \
  pg_dump -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-privileges --format=custom | gzip -9 > "$FILE"

find "$DIR" -name 'afrikoba_global_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "[$(date)] Backup imekamilika: $(du -h "$FILE" | cut -f1)"