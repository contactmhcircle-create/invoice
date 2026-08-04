import { createHash } from 'node:crypto';
import type { Db } from './connection.js';
import { nowInstant } from '../../shared/dates.js';

/**
 * Tamper-evident audit log.
 *
 * Every entry's hash is computed over its own content plus the hash of the
 * entry before it. That makes the log a chain: altering or removing any historic
 * row changes its hash, which invalidates every hash after it. The database
 * triggers already block UPDATE and DELETE on the table; the chain covers the
 * case where someone bypasses the application and edits the file directly.
 *
 * This is the difference between "we have a log" and "we can demonstrate the log
 * has not been rewritten", which is the question that actually gets asked.
 */

const GENESIS = '0'.repeat(64);

export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: string;
  summary?: string;
  before?: unknown;
  after?: unknown;
  actor?: string;
}

function computeHash(fields: {
  at: string;
  actor: string;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  beforeJson: string;
  afterJson: string;
  prevHash: string;
}): string {
  // Field separator is a unit separator character so that content containing
  // delimiters cannot be crafted to collide with a different field layout.
  const payload = [
    fields.at,
    fields.actor,
    fields.entityType,
    fields.entityId,
    fields.action,
    fields.summary,
    fields.beforeJson,
    fields.afterJson,
    fields.prevHash,
  ].join('');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function currentActor(): string {
  return process.env.CERVIZ_OPERATOR || process.env.USER || process.env.USERNAME || 'unknown';
}

/** Append an entry to the chain. Call inside the same transaction as the change. */
export function recordAudit(db: Db, entry: AuditEntry): void {
  const prev = db
    .prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')
    .get() as { hash: string } | undefined;

  const row = {
    at: nowInstant(),
    actor: entry.actor ?? currentActor(),
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    summary: entry.summary ?? '',
    beforeJson: entry.before === undefined ? '' : JSON.stringify(entry.before),
    afterJson: entry.after === undefined ? '' : JSON.stringify(entry.after),
    prevHash: prev?.hash ?? GENESIS,
  };

  db.prepare(
    `INSERT INTO audit_log
       (at, actor, entity_type, entity_id, action, summary, before_json, after_json, prev_hash, hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.at,
    row.actor,
    row.entityType,
    row.entityId,
    row.action,
    row.summary,
    row.beforeJson,
    row.afterJson,
    row.prevHash,
    computeHash(row),
  );
}

export interface ChainVerification {
  ok: boolean;
  entriesChecked: number;
  brokenAtId?: number;
  reason?: string;
}

/**
 * Walks the whole chain and reports the first break. Run this before generating
 * an HMRC enquiry pack, so the pack can state that the record is intact.
 */
export function verifyAuditChain(db: Db): ChainVerification {
  const rows = db
    .prepare(
      `SELECT id, at, actor, entity_type, entity_id, action, summary,
              before_json, after_json, prev_hash, hash
       FROM audit_log ORDER BY id ASC`,
    )
    .all() as any[];

  let expectedPrev = GENESIS;
  let checked = 0;

  for (const r of rows) {
    if (r.prev_hash !== expectedPrev) {
      return {
        ok: false,
        entriesChecked: checked,
        brokenAtId: r.id,
        reason: `Entry ${r.id} does not follow the previous entry — a record may have been removed.`,
      };
    }

    const recomputed = computeHash({
      at: r.at,
      actor: r.actor,
      entityType: r.entity_type,
      entityId: r.entity_id,
      action: r.action,
      summary: r.summary ?? '',
      beforeJson: r.before_json ?? '',
      afterJson: r.after_json ?? '',
      prevHash: r.prev_hash,
    });

    if (recomputed !== r.hash) {
      return {
        ok: false,
        entriesChecked: checked,
        brokenAtId: r.id,
        reason: `Entry ${r.id} has been altered since it was written.`,
      };
    }

    expectedPrev = r.hash;
    checked++;
  }

  return { ok: true, entriesChecked: checked };
}

export function auditTrailFor(db: Db, entityType: string, entityId: string) {
  return db
    .prepare(
      `SELECT id, at, actor, action, summary, before_json, after_json
       FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id ASC`,
    )
    .all(entityType, entityId);
}
