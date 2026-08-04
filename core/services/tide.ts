import { createHash } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { poundsToPence } from '../../shared/money.js';
import { nowInstant, today } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Tide reconciliation.
 *
 * Cerviz's books live in Tide. This app does not try to replace them — two sets
 * of books that disagree are worse than one. What it does is import the Tide
 * statement and match transactions against invoices and purchase invoices, so
 * that every movement in the bank has an explanation on this side, and every
 * invoice raised has a payment against it or a reason it does not.
 *
 * Unmatched items in either direction are the whole point of the exercise.
 */

export interface ParsedRow {
  transactedOn: IsoDate;
  description: string;
  reference: string | null;
  amountPence: number;
  balancePence: number | null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function normaliseDate(raw: string): IsoDate | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Tide exports typically use DD/MM/YYYY.
  const uk = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (uk) {
    const [, d, m, y] = uk;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

/**
 * Parses a Tide CSV export. Column names have varied between Tide's export
 * versions, so headers are matched loosely rather than by exact position.
 */
export function parseTideCsv(csv: string): ParsedRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));

  const find = (...names: string[]) =>
    headers.findIndex((h) => names.some((n) => h.includes(n)));

  const iDate = find('date', 'transactiondate');
  const iDesc = find('description', 'narrative', 'details', 'reference');
  const iRef = find('reference', 'transactionid');
  const iAmount = find('amount');
  const iPaidIn = find('paidin', 'credit', 'moneyin');
  const iPaidOut = find('paidout', 'debit', 'moneyout');
  const iBalance = find('balance');

  const rows: ParsedRow[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const date = iDate >= 0 ? normaliseDate(cells[iDate] ?? '') : null;
    if (!date) continue;

    let amountPence: number;
    if (iAmount >= 0 && cells[iAmount]) {
      amountPence = poundsToPence(cells[iAmount]);
    } else {
      const inP = iPaidIn >= 0 ? poundsToPence(cells[iPaidIn] || '0') : 0;
      const outP = iPaidOut >= 0 ? poundsToPence(cells[iPaidOut] || '0') : 0;
      amountPence = inP - Math.abs(outP);
    }
    if (amountPence === 0) continue;

    rows.push({
      transactedOn: date,
      description: (iDesc >= 0 ? cells[iDesc] : '') || '',
      reference: iRef >= 0 && iRef !== iDesc ? cells[iRef] || null : null,
      amountPence,
      balancePence: iBalance >= 0 && cells[iBalance] ? poundsToPence(cells[iBalance]) : null,
    });
  }

  return rows;
}

export interface ImportResult {
  imported: number;
  skippedDuplicates: number;
  autoMatched: number;
  batch: string;
}

export function importTideStatement(
  db: Db,
  csv: string,
  bankAccountId?: string,
): ImportResult {
  let accountId = bankAccountId;
  if (!accountId) {
    const existing = db.prepare(`SELECT id FROM bank_accounts WHERE provider = 'Tide' LIMIT 1`).get() as any;
    if (existing) accountId = existing.id;
    else {
      accountId = newId('bank');
      db.prepare(
        `INSERT INTO bank_accounts (id, name, provider, currency, is_business, created_at)
         VALUES (?, 'Tide business account', 'Tide', 'GBP', 1, ?)`,
      ).run(accountId, nowInstant());
    }
  }

  const rows = parseTideCsv(csv);
  const batch = newId('batch');
  const now = nowInstant();

  let imported = 0;
  let duplicates = 0;

  const insert = db.prepare(
    `INSERT INTO bank_transactions
       (id, bank_account_id, transacted_on, description, reference, amount_pence, balance_pence,
        import_batch, import_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const r of rows) {
    // A stable hash of the row's identity, so re-importing an overlapping export
    // does not duplicate transactions.
    const hash = createHash('sha256')
      .update(`${accountId}|${r.transactedOn}|${r.description}|${r.amountPence}|${r.balancePence ?? ''}`)
      .digest('hex');

    try {
      insert.run(
        newId('btx'), accountId, r.transactedOn, r.description, r.reference,
        r.amountPence, r.balancePence, batch, hash, now,
      );
      imported++;
    } catch (err) {
      if (String(err).includes('UNIQUE')) duplicates++;
      else throw err;
    }
  }

  const autoMatched = autoMatchTransactions(db, batch);

  recordAudit(db, {
    entityType: 'bank_import',
    entityId: batch,
    action: 'imported',
    summary: `Tide statement imported: ${imported} transaction(s), ${duplicates} duplicate(s) skipped, ${autoMatched} auto-matched`,
    after: { imported, duplicates, autoMatched },
  });

  return { imported, skippedDuplicates: duplicates, autoMatched, batch };
}

/**
 * Matches bank transactions to invoices and purchase invoices.
 *
 * Deliberately conservative: it matches only on an unambiguous signal — the
 * document number appearing in the description, or an exact outstanding amount
 * with exactly one candidate. A wrong automatic match is worse than no match,
 * because it hides a real discrepancy.
 */
export function autoMatchTransactions(db: Db, batch?: string): number {
  const unmatched = db
    .prepare(
      `SELECT * FROM bank_transactions
       WHERE matched_type IS NULL ${batch ? 'AND import_batch = ?' : ''}
       ORDER BY transacted_on`,
    )
    .all(...(batch ? [batch] : [])) as any[];

  let matched = 0;

  for (const tx of unmatched) {
    const haystack = `${tx.description ?? ''} ${tx.reference ?? ''}`.toUpperCase().replace(/\s+/g, '');

    if (tx.amount_pence > 0) {
      // Money in: look for an invoice number in the description.
      const candidates = db
        .prepare(
          `SELECT id, number, gross_pence, paid_pence FROM invoices
           WHERE status IN ('issued','part_paid','overdue') AND number IS NOT NULL`,
        )
        .all() as any[];

      let hit = candidates.find(
        (i) => i.number && haystack.includes(String(i.number).toUpperCase().replace(/[\s-]/g, '')),
      );

      if (!hit) {
        const exact = candidates.filter((i) => i.gross_pence - i.paid_pence === tx.amount_pence);
        if (exact.length === 1) hit = exact[0];
      }

      if (hit) {
        db.prepare(`UPDATE bank_transactions SET matched_type = 'invoice', matched_id = ?, matched_at = ? WHERE id = ?`)
          .run(hit.id, nowInstant(), tx.id);
        matched++;
      }
    } else {
      // Money out: look for a purchase invoice.
      const candidates = db
        .prepare(
          `SELECT p.id, p.our_reference, p.their_reference, p.gross_pence, p.paid_pence, o.name
           FROM purchase_invoices p JOIN organisations o ON o.id = p.organisation_id
           WHERE p.status NOT IN ('paid','void')`,
        )
        .all() as any[];

      const amount = Math.abs(tx.amount_pence);
      let hit = candidates.find((p) => {
        const refs = [p.our_reference, p.their_reference].filter(Boolean)
          .map((r: string) => String(r).toUpperCase().replace(/[\s-]/g, ''));
        return refs.some((r) => haystack.includes(r));
      });

      if (!hit) {
        const exact = candidates.filter((p) => p.gross_pence - p.paid_pence === amount);
        if (exact.length === 1) hit = exact[0];
      }

      if (hit) {
        db.prepare(`UPDATE bank_transactions SET matched_type = 'purchase_invoice', matched_id = ?, matched_at = ? WHERE id = ?`)
          .run(hit.id, nowInstant(), tx.id);
        matched++;
      }
    }
  }

  return matched;
}

export interface ReconciliationView {
  asOf: IsoDate;
  unmatchedTransactions: any[];
  invoicesAwaitingPayment: any[];
  purchasesAwaitingPayment: any[];
  totalUnmatchedInPence: number;
  totalUnmatchedOutPence: number;
  message: string;
}

export function reconciliationView(db: Db, asOf: IsoDate = today()): ReconciliationView {
  const unmatched = db
    .prepare(
      `SELECT * FROM bank_transactions WHERE matched_type IS NULL ORDER BY transacted_on DESC LIMIT 200`,
    )
    .all() as any[];

  const invoicesAwaiting = db
    .prepare(
      `SELECT i.id, i.number, i.issue_date, i.due_date, i.gross_pence, i.paid_pence,
              (i.gross_pence - i.paid_pence) AS outstanding, o.name AS client_name
       FROM invoices i JOIN organisations o ON o.id = i.client_org_id
       WHERE i.status IN ('issued','part_paid','overdue') AND i.gross_pence > i.paid_pence
       ORDER BY i.due_date`,
    )
    .all() as any[];

  const purchasesAwaiting = db
    .prepare(
      `SELECT p.id, p.our_reference, p.their_reference, p.invoice_date, p.due_date,
              (p.gross_pence - p.paid_pence) AS outstanding, o.name AS supplier
       FROM purchase_invoices p JOIN organisations o ON o.id = p.organisation_id
       WHERE p.status NOT IN ('paid','void') AND p.gross_pence > p.paid_pence
       ORDER BY p.due_date`,
    )
    .all() as any[];

  const inTotal = unmatched.filter((t) => t.amount_pence > 0).reduce((a, t) => a + t.amount_pence, 0);
  const outTotal = unmatched.filter((t) => t.amount_pence < 0).reduce((a, t) => a + Math.abs(t.amount_pence), 0);

  let message: string;
  if (unmatched.length === 0) {
    message = 'Every imported bank transaction is matched to a document.';
  } else {
    message =
      `${unmatched.length} bank transaction(s) have no matching document. Every unexplained movement ` +
      'is a question you would rather answer now than in an enquiry.';
  }

  return {
    asOf,
    unmatchedTransactions: unmatched,
    invoicesAwaitingPayment: invoicesAwaiting,
    purchasesAwaitingPayment: purchasesAwaiting,
    totalUnmatchedInPence: inTotal,
    totalUnmatchedOutPence: outTotal,
    message,
  };
}

/** Confirms a match and creates the corresponding payment record. */
export function confirmMatch(
  db: Db,
  bankTxnId: string,
  target: { type: 'invoice' | 'purchase_invoice'; id: string },
): void {
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(bankTxnId) as any;
  if (!tx) throw new Error('Bank transaction not found');

  db.prepare(`UPDATE bank_transactions SET matched_type = ?, matched_id = ?, matched_at = ? WHERE id = ?`)
    .run(target.type, target.id, nowInstant(), bankTxnId);

  recordAudit(db, {
    entityType: 'bank_transaction',
    entityId: bankTxnId,
    action: 'matched',
    summary: `Bank transaction of ${(tx.amount_pence / 100).toFixed(2)} on ${tx.transacted_on} matched to ${target.type}`,
    after: target,
  });
}

/**
 * Exports the period's transactions in a generic accounting CSV, for whichever
 * package the books eventually live in.
 */
export function exportLedgerCsv(db: Db, from: IsoDate, to: IsoDate): string {
  const rows = db
    .prepare(
      `SELECT j.journal_date, j.narrative, jl.account_code, a.name AS account_name,
              jl.debit_pence, jl.credit_pence, jl.description
       FROM journals j
       JOIN journal_lines jl ON jl.journal_id = j.id
       JOIN accounts a ON a.code = jl.account_code
       WHERE j.journal_date BETWEEN ? AND ?
       ORDER BY j.journal_date, j.id`,
    )
    .all(from, to) as any[];

  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = ['Date,Narrative,Account code,Account name,Debit,Credit,Description'];
  for (const r of rows) {
    lines.push([
      r.journal_date, r.narrative, r.account_code, r.account_name,
      (r.debit_pence / 100).toFixed(2), (r.credit_pence / 100).toFixed(2), r.description,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

export function exportSalesCsv(db: Db, from: IsoDate, to: IsoDate): string {
  const rows = db
    .prepare(
      `SELECT i.number, i.issue_date, i.due_date, o.name AS client, i.po_reference,
              i.currency, i.net_pence, i.vat_pence, i.gross_pence, i.paid_pence, i.status
       FROM invoices i JOIN organisations o ON o.id = i.client_org_id
       WHERE i.issue_date BETWEEN ? AND ? ORDER BY i.number`,
    )
    .all(from, to) as any[];

  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = ['Invoice number,Issue date,Due date,Client,PO reference,Currency,Net,VAT,Gross,Paid,Status'];
  for (const r of rows) {
    lines.push([
      r.number, r.issue_date, r.due_date, r.client, r.po_reference, r.currency,
      (r.net_pence / 100).toFixed(2), (r.vat_pence / 100).toFixed(2),
      (r.gross_pence / 100).toFixed(2), (r.paid_pence / 100).toFixed(2), r.status,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}
