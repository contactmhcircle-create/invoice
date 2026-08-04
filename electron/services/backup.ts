import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { recordAudit, verifyAuditChain } from '../db/audit.js';
import { nowInstant } from '../../shared/dates.js';

/**
 * Backups.
 *
 * The database is the business record. Losing it means losing the evidence for
 * every invoice raised, which is a far worse day than losing the software.
 * Backups are taken on every launch and on demand, kept for a rolling window,
 * and each one is hashed so a restored file can be proven to be the file that
 * was backed up.
 */

const KEEP_DAILY = 30;

export interface BackupResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  takenAt: string;
  auditChainOk: boolean;
}

export function backupDatabase(db: Db, dbPath: string, backupDir: string): BackupResult {
  mkdirSync(backupDir, { recursive: true });

  const stamp = nowInstant().replace(/[:.]/g, '-');
  const target = join(backupDir, `cerviz-${stamp}.sqlite`);

  // Checkpoint WAL first so the copied file is complete rather than a snapshot
  // missing the most recent writes.
  db.pragma('wal_checkpoint(TRUNCATE)');
  copyFileSync(dbPath, target);

  const stats = statSync(target);
  const sha256 = hashFile(target);
  const chain = verifyAuditChain(db);

  recordAudit(db, {
    entityType: 'backup',
    entityId: basename(target),
    action: 'created',
    summary: `Backup written (${(stats.size / 1024 / 1024).toFixed(1)} MB), audit chain ${chain.ok ? 'intact' : 'BROKEN'}`,
    after: { path: target, sha256, auditChainOk: chain.ok },
  });

  pruneOldBackups(backupDir);

  return {
    path: target,
    sizeBytes: stats.size,
    sha256,
    takenAt: nowInstant(),
    auditChainOk: chain.ok,
  };
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pruneOldBackups(backupDir: string): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith('cerviz-') && f.endsWith('.sqlite'))
    .map((f) => ({ name: f, path: join(backupDir, f), mtime: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of files.slice(KEEP_DAILY)) {
    try { unlinkSync(file.path); } catch { /* a backup that cannot be pruned is not an error worth failing on */ }
  }
}

export function listBackups(backupDir: string) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => f.startsWith('cerviz-') && f.endsWith('.sqlite'))
    .map((f) => {
      const path = join(backupDir, f);
      const s = statSync(path);
      return { name: f, path, sizeBytes: s.size, takenAt: new Date(s.mtime).toISOString() };
    })
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

/**
 * Restores a backup over the live database. The current file is copied aside
 * first, so a restore is itself reversible.
 */
export function restoreBackup(backupPath: string, dbPath: string): { previousCopiedTo: string } {
  if (!existsSync(backupPath)) throw new Error('Backup file not found');

  const aside = `${dbPath}.replaced-${nowInstant().replace(/[:.]/g, '-')}`;
  if (existsSync(dbPath)) copyFileSync(dbPath, aside);
  copyFileSync(backupPath, dbPath);

  return { previousCopiedTo: aside };
}
