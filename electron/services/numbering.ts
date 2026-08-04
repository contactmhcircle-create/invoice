import type { Db } from '../db/connection.js';
import { nowInstant } from '../../shared/dates.js';

/**
 * Gapless sequential document numbering.
 *
 * HMRC expects invoice numbers to form a unique, sequential series. "Gapless"
 * does not mean numbers are never wasted — it means every number issued can be
 * accounted for. So a voided invoice keeps its number and stays visible as a
 * void; the number is never silently reused or skipped.
 *
 * Allocation happens inside the caller's transaction. If the surrounding work
 * rolls back, the number rolls back with it and is issued next time instead.
 */

export function allocateNumber(db: Db, docType: string, entityId?: string): string {
  const seq = db.prepare('SELECT * FROM numbering WHERE doc_type = ?').get(docType) as any;
  if (!seq) throw new Error(`No numbering sequence configured for '${docType}'`);

  const sequenceNo: number = seq.next_number;
  const year = new Date().getFullYear();
  const padded = String(sequenceNo).padStart(seq.pad_width, '0');
  const numberText = seq.include_year
    ? `${seq.prefix}-${year}-${padded}`
    : `${seq.prefix}-${padded}`;

  db.prepare('UPDATE numbering SET next_number = next_number + 1, updated_at = ? WHERE doc_type = ?')
    .run(nowInstant(), docType);

  db.prepare(
    `INSERT INTO number_allocations (doc_type, number_text, sequence_no, allocated_at, entity_id)
     VALUES (?,?,?,?,?)`,
  ).run(docType, numberText, sequenceNo, nowInstant(), entityId ?? null);

  return numberText;
}

export interface SequenceAudit {
  docType: string;
  allocated: number;
  lowest: number | null;
  highest: number | null;
  missing: number[];
  intact: boolean;
}

/**
 * Proves the series has no holes. This is what you show an inspector who asks
 * why invoice 0042 does not appear in the sales listing — either it is there as
 * a void, or this report names it as missing.
 */
export function auditSequence(db: Db, docType: string): SequenceAudit {
  const rows = db
    .prepare('SELECT sequence_no FROM number_allocations WHERE doc_type = ? ORDER BY sequence_no ASC')
    .all(docType) as Array<{ sequence_no: number }>;

  if (rows.length === 0) {
    return { docType, allocated: 0, lowest: null, highest: null, missing: [], intact: true };
  }

  const lowest = rows[0].sequence_no;
  const highest = rows[rows.length - 1].sequence_no;
  const present = new Set(rows.map((r) => r.sequence_no));
  const missing: number[] = [];
  for (let n = lowest; n <= highest; n++) if (!present.has(n)) missing.push(n);

  return { docType, allocated: rows.length, lowest, highest, missing, intact: missing.length === 0 };
}

export function setSequenceFormat(
  db: Db,
  docType: string,
  opts: { prefix?: string; padWidth?: number; includeYear?: boolean; nextNumber?: number },
): void {
  const current = db.prepare('SELECT * FROM numbering WHERE doc_type = ?').get(docType) as any;
  if (!current) throw new Error(`No numbering sequence configured for '${docType}'`);

  // The counter may be moved forward (e.g. continuing a series from a previous
  // system) but never backwards, which would risk duplicate numbers.
  if (opts.nextNumber != null && opts.nextNumber < current.next_number) {
    throw new Error(
      `The next number cannot be moved backwards from ${current.next_number} to ${opts.nextNumber} — ` +
        'that would risk issuing a duplicate invoice number.',
    );
  }

  db.prepare(
    `UPDATE numbering SET prefix = ?, pad_width = ?, include_year = ?, next_number = ?, updated_at = ?
     WHERE doc_type = ?`,
  ).run(
    opts.prefix ?? current.prefix,
    opts.padWidth ?? current.pad_width,
    opts.includeYear == null ? current.include_year : opts.includeYear ? 1 : 0,
    opts.nextNumber ?? current.next_number,
    nowInstant(),
    docType,
  );
}
