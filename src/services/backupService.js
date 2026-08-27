/**
 * Database Backup Automation
 * Automated backups with verification and retention.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BACKUP_DIR = path.resolve(process.cwd(), 'backups');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
const PSQL_PATH = process.env.PSQL_PATH || '"C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe"';
const PGDUMP_PATH = process.env.PGDUMP_PATH || '"C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe"';

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * H18: Create database backup.
 */
function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(BACKUP_DIR, `afrikoba_backup_${timestamp}.sql`);

  try {
    logger.info('BACKUP', 'Starting database backup...');

    const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:Mwambola%404307@localhost:5432/afrikoba_global';

    execSync(`${PGDUMP_PATH} "${dbUrl}" > "${backupFile}"`, {
      timeout: 300000, // 5 minutes
      stdio: 'pipe',
    });

    const stats = fs.statSync(backupFile);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    logger.info('BACKUP', `Backup created: ${backupFile} (${sizeMB} MB)`);

    // Verify backup has content
    if (stats.size < 1000) {
      throw new Error('Backup file too small - likely empty');
    }

    return { success: true, file: backupFile, size: stats.size };
  } catch (err) {
    logger.error('BACKUP', `Backup failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * H18: Verify backup integrity.
 */
function verifyBackup(backupFile) {
  try {
    if (!fs.existsSync(backupFile)) {
      return { valid: false, error: 'File not found' };
    }

    const content = fs.readFileSync(backupFile, 'utf8');

    // Check for essential SQL statements
    const hasTables = content.includes('CREATE TABLE');
    const hasData = content.includes('COPY');
    const hasIndexes = content.includes('CREATE INDEX');

    return {
      valid: hasTables && (hasData || hasIndexes),
      hasTables,
      hasData,
      hasIndexes,
      lines: content.split('\n').length,
      size: fs.statSync(backupFile).size,
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * H18: Clean old backups.
 */
function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('afrikoba_backup_') && f.endsWith('.sql'))
      .map((f) => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime,
      }))
      .sort((a, b) => b.time - a.time);

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const file of files) {
      if (file.time.getTime() < cutoff && files.length > 7) {
        fs.unlinkSync(file.path);
        deleted++;
        logger.info('BACKUP', `Deleted old backup: ${file.name}`);
      }
    }

    return { deleted, remaining: files.length - deleted };
  } catch (err) {
    logger.error('BACKUP', `Cleanup failed: ${err.message}`);
    return { deleted: 0, error: err.message };
  }
}

/**
 * H18: Get backup status.
 */
function getBackupStatus() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('afrikoba_backup_') && f.endsWith('.sql'))
      .map((f) => ({
        name: f,
        size: fs.statSync(path.join(BACKUP_DIR, f)).size,
        created: fs.statSync(path.join(BACKUP_DIR, f)).mtime,
      }))
      .sort((a, b) => b.created - a.created);

    const lastBackup = files[0] || null;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    return {
      totalBackups: files.length,
      lastBackup: lastBackup ? lastBackup.name : null,
      lastBackupTime: lastBackup ? lastBackup.created : null,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      retentionDays: RETENTION_DAYS,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * H18: Backup scheduler (runs daily at 2 AM).
 */
function startBackupScheduler() {
  const now = new Date();
  const next2AM = new Date(now);
  next2AM.setHours(2, 0, 0, 0);
  if (next2AM <= now) next2AM.setDate(next2AM.getDate() + 1);

  const msUntil2AM = next2AM - now;

  setTimeout(() => {
    logger.info('BACKUP', 'Running scheduled backup...');
    const result = createBackup();
    if (result.success) {
      const verification = verifyBackup(result.file);
      logger.info('BACKUP', `Verification: ${verification.valid ? 'PASS' : 'FAIL'}`);
    }
    cleanupOldBackups();

    // Schedule next backup in 24 hours
    setInterval(() => {
      logger.info('BACKUP', 'Running scheduled backup...');
      const res = createBackup();
      if (res.success) {
        const v = verifyBackup(res.file);
        logger.info('BACKUP', `Verification: ${v.valid ? 'PASS' : 'FAIL'}`);
      }
      cleanupOldBackups();
    }, 24 * 60 * 60 * 1000);
  }, msUntil2AM);
}

module.exports = {
  createBackup,
  verifyBackup,
  cleanupOldBackups,
  getBackupStatus,
  startBackupScheduler,
};
