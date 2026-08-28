#!/bin/bash
# ============================================================
# AFRIKOBA GLOBAL - Nightly DB backup (host cron)
# Hufanya pg_dump (custom format) ndani ya container ya db.
# Hakuna password kwenye cron: peer auth (docker exec kama postgres).
#
# Cron (root):
#   0 2 * * * bash /opt/afrikoba/scripts/backup-cron.sh >> /opt/afrikoba/backups/backup.log 2>&1
# ============================================================
set -eo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-afrikoba}"
CONTAINER="${PROJECT}-db-1"
DIR=/opt/afrikoba/backups
RETENTION_DAYS=14

mkdir -p "$DIR"
chmod 700 "$DIR"

STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$DIR/afrikoba_global_${STAMP}.sql.gz"

echo "[$(date)] Backup inaanza: $FILE"

docker exec -i "$CONTAINER" pg_dump -U postgres -d afrikoba_global \
  --no-owner --no-privileges --format=custom | gzip -9 > "$FILE"

find "$DIR" -name 'afrikoba_global_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "[$(date)] Backup imekamilika: $(du -h "$FILE" | cut -f1)"