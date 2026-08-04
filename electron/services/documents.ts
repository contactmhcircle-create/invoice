import { copyFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { nowInstant } from '../../shared/dates.js';

/**
 * Evidence files: signed timesheet scans, licence copies, right-to-work
 * evidence, contracts.
 *
 * Files are copied into the app's own store rather than referenced in place, so
 * a document cannot vanish because someone tidied their Downloads folder. Each
 * one is hashed on the way in, which is what allows a scan produced two years
 * later to be shown as the same file that was attached at the time.
 */

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export interface AttachInput {
  entityType: string;
  entityId: string;
  category?: string;
  sourcePath: string;
  notes?: string;
}

export function attachDocument(db: Db, storeRoot: string, input: AttachInput): string {
  if (!existsSync(input.sourcePath)) throw new Error(`File not found: ${input.sourcePath}`);

  const dir = join(storeRoot, input.entityType, input.entityId);
  mkdirSync(dir, { recursive: true });

  const id = newId('doc');
  const ext = extname(input.sourcePath).toLowerCase();
  const filename = basename(input.sourcePath);
  const storedPath = join(dir, `${id}${ext}`);

  copyFileSync(input.sourcePath, storedPath);

  const buffer = readFileSync(storedPath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const size = statSync(storedPath).size;

  db.prepare(
    `INSERT INTO documents (id, entity_type, entity_id, category, filename, stored_path,
       mime_type, size_bytes, sha256, uploaded_at, uploaded_by, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.entityType,
    input.entityId,
    input.category ?? null,
    filename,
    storedPath,
    MIME_BY_EXT[ext] ?? 'application/octet-stream',
    size,
    sha256,
    nowInstant(),
    process.env.USER ?? 'operator',
    input.notes ?? null,
  );

  recordAudit(db, {
    entityType: input.entityType,
    entityId: input.entityId,
    action: 'document_attached',
    summary: `${input.category ?? 'Document'} attached: ${filename} (sha256 ${sha256.slice(0, 12)}…)`,
    after: { documentId: id, filename, sha256, sizeBytes: size },
  });

  return id;
}

export function documentsFor(db: Db, entityType: string, entityId: string) {
  return db
    .prepare('SELECT * FROM documents WHERE entity_type = ? AND entity_id = ? ORDER BY uploaded_at DESC')
    .all(entityType, entityId);
}

export interface IntegrityCheck {
  documentId: string;
  filename: string;
  present: boolean;
  hashMatches: boolean;
  message: string;
}

/**
 * Verifies every stored file still exists and still hashes to what was recorded.
 * Run before producing an enquiry pack, so the pack does not cite evidence that
 * has gone missing.
 */
export function verifyDocuments(db: Db): IntegrityCheck[] {
  const docs = db.prepare('SELECT id, filename, stored_path, sha256 FROM documents').all() as any[];

  return docs.map((d) => {
    if (!existsSync(d.stored_path)) {
      return {
        documentId: d.id,
        filename: d.filename,
        present: false,
        hashMatches: false,
        message: 'File is missing from the document store.',
      };
    }
    const actual = createHash('sha256').update(readFileSync(d.stored_path)).digest('hex');
    const matches = actual === d.sha256;
    return {
      documentId: d.id,
      filename: d.filename,
      present: true,
      hashMatches: matches,
      message: matches ? 'Verified unchanged since upload.' : 'FILE HAS CHANGED since it was attached.',
    };
  });
}
