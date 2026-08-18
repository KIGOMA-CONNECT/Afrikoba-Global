#!/bin/sh
# ============================================================
# AFRIKOBA GLOBAL - DB Backup Script
# Hifadhi ya PostgreSQL kwa kutumia pg_dump (plain SQL, full).
#
# Matumizi:
#   DB_USER=afrikoba DB_PASSWORD=... DB_NAME=afrikoba_global \
#     bash scripts/backup-db.sh
#
# Schedule ya kila usiku (cron):
#   0 2 * * * cd /opt/afrikoba && bash scripts/backup-db.sh >> backups/backup.log 2>&1
# ============================================================

set -e

: "${DB_HOST:=db}"
: "${DB_PORT:=5432}"
: "${DB_USER:=afrikoba}"
: "${DB_PASSWORD:=}"
: "${DB_NAME:=afrikoba_global}"
: "${BACKUP_DIR:=backups}"
: "${RETENTION_DAYS:=14}"

export PGPASSWORD="$DB_PASSWORD"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/${DB_NAME}_${STAMP}.sql.gz"

echo "[$(date)] Backup inaanza: $FILE"

# Backup kamili (schema + data) ikiwa compressed
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-privileges --format=custom | gzip -9 > "$FILE"

# Futa backup zaidi ya siku za retention
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete

echo "[$(date)] Backup imekamilika: $(du -h "$FILE" | cut -f1)"
