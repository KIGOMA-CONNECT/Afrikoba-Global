/**
 * Database Backup Automation
 * Automated backups with verification and retention.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BACKUP_DIR = path.resolve(process.cwd(), 'backups');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
const PGDUMP_PATH = process.env.PGDUMP_PATH || 'pg_dump';

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
  let backupAttempted = false;

  try {
    logger.info('BACKUP', 'Starting database backup...');

    const dbConfig = {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || '5432',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    };

    const missingConfig = Object.entries(dbConfig)
      .filter(([key, value]) => key !== 'port' && !value)
      .map(([key]) => key);

    if (missingConfig.length) {
      throw new Error(`Backup configuration missing: ${missingConfig.join(', ')}`);
    }

    if (fs.existsSync(backupFile)) {
      throw new Error('Backup file already exists; refusing to overwrite it.');
    }

    backupAttempted = true;
    execFileSync(PGDUMP_PATH, [
      '-h', dbConfig.host,
      '-p', dbConfig.port,
      '-U', dbConfig.user,
      '-d', dbConfig.database,
      '--no-owner',
      '--no-privileges',
      '--format=plain',
      '-f', backupFile,
    ], {
      timeout: 300000,
      env: { ...process.env, PGPASSWORD: dbConfig.password },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const stats = fs.statSync(backupFile);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    if (stats.size < 1000) {
      throw new Error('Backup file too small - likely empty');
    }

    logger.info('BACKUP', `Backup created: ${backupFile} (${sizeMB} MB)`);
    return { success: true, file: backupFile, size: stats.size };
  } catch (err) {
    if (backupAttempted) {
      try {
        if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
      } catch (cleanupErr) {
        logger.error('BACKUP', 'Failed to remove incomplete backup file.');
      }
    }

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
    const size = fs.statSync(backupFile).size;
    const hasHeader = /^-- PostgreSQL database dump/m.test(content);
    const hasDumpVersion = /^-- Dumped by pg_dump version /m.test(content);
    const hasFooter = /-- PostgreSQL database dump complete\s*$/.test(content.trimEnd());
    const hasTables = /\bCREATE TABLE\b/i.test(content);
    const hasData = /^\s*COPY\b/m.test(content);
    const hasIndexes = /\bCREATE INDEX\b/i.test(content);
    const valid = size > 0 && hasHeader && hasDumpVersion && hasFooter;

    return {
      valid,
      hasHeader,
      hasDumpVersion,
      hasFooter,
      hasTables,
      hasData,
      hasIndexes,
      lines: content.split('\n').length,
      size,
      ...(!valid ? { error: 'Missing PostgreSQL plain-dump markers or empty file' } : {}),
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
