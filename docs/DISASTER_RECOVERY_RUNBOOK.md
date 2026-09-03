# AFRIKOBA GLOBAL — DISASTER RECOVERY & BACKUP RUNBOOK

## 1. Objective
To guarantee business continuity, zero data loss for double-entry financial ledgers, and rapid recovery of the Afrikoba Global platform in the event of hardware failure, database corruption, or regional outage.

---

## 2. Backup Topology & Storage
- **Automated Frequency:** Daily at 02:00 EAT via `backupService.js`.
- **Storage Location:** Local `./backups/` directory (mounted on persistent Docker volumes in production).
- **Retention Policy:** 30 days (`BACKUP_RETENTION_DAYS=30`), maintaining a minimum of the last 7 daily backups regardless of age.
- **Verification:** Automated verification script runs immediately post-backup, checking SQL syntax, `CREATE TABLE`, `COPY`, and index presence.

---

## 3. Disaster Recovery (DR) Procedure

### Scenario A: Database Corruption / Point-in-Time Recovery
1. **Stop Application Container:**
   ```bash
   docker compose stop app
   ```
2. **Locate Latest Verified Backup:**
   ```bash
   ls -lt backups/ | head -n 5
   ```
3. **Restore Database:**
   ```bash
   docker exec -i afrikoba-db-1 psql -U afrikoba -d afrikoba_global < backups/afrikoba_backup_<TIMESTAMP>.sql
   ```
4. **Run Migrations & Verify Integrity:**
   ```bash
   docker compose restart app
   node scripts/runMigrations.js
   ```
5. **Verify System Health:**
   Check `/api/v1/health` or run `npm test`.

### Scenario B: Complete Server Rebuild (Infrastructure Failure)
1. Provision new server (Ubuntu 22.04 LTS / Docker / Docker Compose).
2. Clone repository from GitHub:
   ```bash
   git clone https://github.com/KIGOMA-CONNECT/Afrikoba-Global.git /var/www/afrikoba
   cd /var/www/afrikoba
   ```
3. Restore `.env` configuration file securely.
4. Restore DB backup into Docker volume.
5. Start containers:
   ```bash
   docker compose up -d --build
   ```

---

## 4. RTO & RPO Targets
- **Recovery Time Objective (RTO):** < 30 minutes.
- **Recovery Point Objective (RPO):** < 24 hours (up to 1 hour with incremental WAL archiving).
