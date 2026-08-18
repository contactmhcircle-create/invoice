import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { allocateNumber } from './numbering.js';
import { vatPolicyFor } from './vat.js';
import { postInvoice, postCreditNote, postPaymentReceipt } from './ledger.js';
import { vatOn, toBase } from '../../shared/money.js';
import { nowInstant, today, addDays, daysBetween, formatDateUK, hoursDecimal } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Sales invoicing.
 *
 * Every invoice line traces back to a timesheet, and every timesheet to a signed
 * paper sheet. That chain — invoice line -> timesheet -> shift -> scan -> worker
 * compliance record — is the thing that turns an HMRC enquiry into an afternoon's
 * work instead of a crisis.
 *
 * An invoice is mutable only while it is a draft. Once issued it is frozen by
 * database trigger, not merely by convention. Corrections go out as credit notes.
 */

export interface CreateInvoiceInput {
  clientOrgId: string;
  timesheetIds: string[];
  issueDate?: IsoDate;
  taxPointDate?: IsoDate;
  poReference?: string;
  currency?: string;
  fxRate?: number;
  notes?: string;
  /** Group lines per worker per week rather than per shift. */
  summarise?: boolean;
}

export function createInvoiceFromTimesheets(db: Db, input: CreateInvoiceInput): string {
  if (input.timesheetIds.length === 0) throw new Error('Select at least one timesheet to invoice.');

  const client = db.prepare('SELECT * FROM organisations WHERE id = ?').get(input.clientOrgId) as any;
  if (!client) throw new Error('Client not found');

  const timesheets = db
    .prepare(
      `SELECT t.*, a.title AS assignment_title, a.client_org_id, a.id AS assignment_id,
              a.site_id, a.po_reference,
              w.first_name, w.last_name
       FROM timesheets t
       JOIN assignments a ON a.id = t.assignment_id
       JOIN workers w ON w.id = t.worker_id
       WHERE t.id IN (${input.timesheetIds.map(() => '?').join(',')})`,
    )
    .all(...input.timesheetIds) as any[];

  if (timesheets.length !== input.timesheetIds.length) {
    throw new Error('One or more timesheets could not be found.');
  }

  for (const ts of timesheets) {
    if (ts.status !== 'approved') {
      throw new Error(
        `Timesheet ${ts.reference} is ${ts.status}, not approved. Only approved timesheets can be invoiced.`,
      );
    }
    if (ts.client_org_id !== input.clientOrgId) {
      throw new Error(`Timesheet ${ts.reference} belongs to a different client.`);
    }
    if (ts.invoice_id) {
      throw new Error(
        `Timesheet ${ts.reference} is already on another invoice. Remove it from that draft first.`,
      );
    }
  }

  if (client.po_required && !input.poReference && !timesheets[0].po_reference) {
    throw new Error(
      `${client.name} requires a purchase order reference on every invoice. Add the PO number before raising this invoice.`,
    );
  }

  const issueDate = input.issueDate ?? today();
  const currency = input.currency ?? client.currency ?? 'GBP';
  const fxRate = input.fxRate ?? 1.0;
  const vat = vatPolicyFor(db, issueDate, client.country);

  const id = newId('inv');
  const now = nowInstant();
  const dueDate = addDays(issueDate, client.payment_terms_days ?? 30);

  const dates = timesheets.map((t) => t.week_ending).sort();

  db.prepare(
    `INSERT INTO invoices
       (id, client_org_id, assignment_id, site_id, issue_date, tax_point_date, due_date,
        period_from, period_to, po_reference, currency, fx_rate, vat_applied, vat_note,
        status, notes, terms, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`,
  ).run(
    id,
    input.clientOrgId,
    timesheets.length === 1 ? timesheets[0].assignment_id : null,
    timesheets.length === 1 ? timesheets[0].site_id : null,
    issueDate,
    input.taxPointDate ?? issueDate,
    dueDate,
    dates[0],
    dates[dates.length - 1],
    input.poReference ?? timesheets[0].po_reference ?? null,
    currency,
    fxRate,
    vat.applies ? 1 : 0,
    vat.note,
    input.notes ?? null,
    (db.prepare('SELECT invoice_terms FROM company WHERE id = 1').get() as any)?.invoice_terms ?? null,
    now,
    now,
  );

  let lineNo = 1;
  const insertLine = db.prepare(
    `INSERT INTO invoice_lines
       (id, invoice_id, line_no, description, timesheet_id, shift_id, worker_id, work_date,
        quantity_minutes, unit_price_pence, net_pence, vat_rate, vat_code, vat_pence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const ts of timesheets) {
    const lines = db
      .prepare('SELECT * FROM timesheet_lines WHERE timesheet_id = ? ORDER BY work_date, start_time')
      .all(ts.id) as any[];

    if (input.summarise) {
      // One line per worker per week, at a blended rate.
      const net = ts.charge_total_pence;
      const minutes = lines.reduce((a, l) => a + l.billed_minutes, 0);
      const rate = minutes > 0 ? Math.round((net * 60) / minutes) : 0;
      insertLine.run(
        newId('invl'),
        id,
        lineNo++,
        `${ts.first_name} ${ts.last_name} — ${ts.assignment_title}, week ending ${formatDateUK(ts.week_ending)} (${hoursDecimal(minutes)} hrs)`,
        ts.id,
        null,
        ts.worker_id,
        ts.week_ending,
        minutes,
        rate,
        net,
        vat.ratePercent,
        vat.code,
        vat.applies ? vatOn(net, vat.ratePercent) : 0,
        now,
      );
    } else {
      for (const l of lines) {
        const desc =
          `${ts.first_name} ${ts.last_name} — ${ts.assignment_title}, ${formatDateUK(l.work_date)}` +
          (l.start_time && l.end_time ? ` ${l.start_time}–${l.end_time}` : '') +
          ` (${hoursDecimal(l.billed_minutes)} hrs @ £${(l.charge_rate_pence / 100).toFixed(2)}/hr` +
          (l.band !== 'standard' ? `, ${l.band.replace(/_/g, ' ')}` : '') +
          ')';
        insertLine.run(
          newId('invl'),
          id,
          lineNo++,
          desc,
          ts.id,
          l.shift_id,
          ts.worker_id,
          l.work_date,
          l.billed_minutes,
          l.charge_rate_pence,
          l.charge_pence,
          vat.ratePercent,
          vat.code,
          vat.applies ? vatOn(l.charge_pence, vat.ratePercent) : 0,
          now,
        );
      }
    }

    db.prepare(`UPDATE timesheets SET invoice_id = ?, updated_at = ? WHERE id = ?`)
      .run(id, now, ts.id);
  }

  recalculateInvoice(db, id);

  recordAudit(db, {
    entityType: 'invoice',
    entityId: id,
    action: 'created',
    summary: `Draft invoice created for ${client.name} from ${timesheets.length} timesheet(s)`,
    after: { clientOrgId: input.clientOrgId, timesheetIds: input.timesheetIds, issueDate },
  });

  return id;
}

/**
 * A manual invoice: no timesheets behind it, for goods-and-services billing.
 * Lines are added and edited while the invoice is a draft; issue freezes it
 * exactly like a timesheet-backed one.
 */
export function createManualInvoice(db: Db, input: {
  clientOrgId: string; issueDate?: IsoDate; taxPointDate?: IsoDate;
  periodFrom?: IsoDate; periodTo?: IsoDate; poReference?: string;
  currency?: string; fxRate?: number; notes?: string;
}): string {
  const client = db.prepare('SELECT * FROM organisations WHERE id = ?').get(input.clientOrgId) as any;
  if (!client) throw new Error('Client not found');

  const issueDate = input.issueDate ?? today();
  const vat = vatPolicyFor(db, issueDate, client.country);
  const id = newId('inv');
  const now = nowInstant();

  db.prepare(
    `INSERT INTO invoices
       (id, client_org_id, issue_date, tax_point_date, due_date, period_from, period_to,
        po_reference, currency, fx_rate, vat_applied, vat_note, status, notes, terms,
        created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)`,
  ).run(
    id, input.clientOrgId, issueDate, input.taxPointDate ?? issueDate,
    addDays(issueDate, client.payment_terms_days ?? 30),
    input.periodFrom ?? null, input.periodTo ?? null, input.poReference ?? null,
    input.currency ?? client.currency ?? 'GBP', input.fxRate ?? 1.0,
    vat.applies ? 1 : 0, vat.note, input.notes ?? null,
    (db.prepare('SELECT invoice_terms FROM company WHERE id = 1').get() as any)?.invoice_terms ?? null,
    now, now,
  );

  recordAudit(db, {
    entityType: 'invoice', entityId: id, action: 'created',
    summary: `Draft manual invoice created for ${client.name}`, after: input,
  });
  return id;
}

function assertDraft(db: Db, invoiceId: string) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');
  if (inv.status !== 'draft') {
    throw new Error('This invoice has been issued and is frozen. Void it and reissue, or raise a credit note.');
  }
  return inv;
}

/** Add a free-form line to a draft. Quantity is plain units, not minutes. */
export function addManualLine(db: Db, invoiceId: string, l: {
  description: string; quantity?: number; unitPricePence?: number;
  netPence?: number; workDate?: IsoDate;
}): string {
  const inv = assertDraft(db, invoiceId);
  const clientCountry = (db.prepare('SELECT country FROM organisations WHERE id = ?')
    .get(inv.client_org_id) as any)?.country ?? 'United Kingdom';
  const vat = vatPolicyFor(db, inv.issue_date, clientCountry);

  const qty = Math.max(1, l.quantity ?? 1);
  const unit = l.unitPricePence ?? 0;
  const net = l.netPence ?? Math.round(qty * unit);
  if (net === 0 && unit === 0) throw new Error('Give the line an amount.');
  if (!l.description?.trim()) throw new Error('Give the line a description.');

  let description = l.description.trim();
  if (qty !== 1) description += ` (${qty} × £${(unit / 100).toFixed(2)})`;

  const lineNo = ((db.prepare('SELECT COALESCE(MAX(line_no),0) AS n FROM invoice_lines WHERE invoice_id = ?')
    .get(invoiceId) as any).n as number) + 1;

  const id = newId('invl');
  db.prepare(
    `INSERT INTO invoice_lines
       (id, invoice_id, line_no, description, work_date, quantity_minutes, unit_price_pence,
        net_pence, vat_rate, vat_code, vat_pence, created_at)
     VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?)`,
  ).run(id, invoiceId, lineNo, description, l.workDate ?? null, unit || net, net,
    vat.ratePercent, vat.code, vat.applies ? vatOn(net, vat.ratePercent) : 0, nowInstant());

  recalculateInvoice(db, invoiceId);
  return id;
}

export function updateInvoiceLine(db: Db, invoiceId: string, lineId: string, changes: {
  description?: string; netPence?: number; unitPricePence?: number;
}): void {
  const inv = assertDraft(db, invoiceId);
  const line = db.prepare('SELECT * FROM invoice_lines WHERE id = ? AND invoice_id = ?')
    .get(lineId, invoiceId) as any;
  if (!line) throw new Error('Line not found');

  const clientCountry = (db.prepare('SELECT country FROM organisations WHERE id = ?')
    .get(inv.client_org_id) as any)?.country ?? 'United Kingdom';
  const vat = vatPolicyFor(db, inv.issue_date, clientCountry);

  const description = changes.description !== undefined ? changes.description.trim() : line.description;
  if (!description) throw new Error('A line needs a description.');
  const net = changes.netPence !== undefined ? changes.netPence : line.net_pence;
  const unit = changes.unitPricePence !== undefined ? changes.unitPricePence : line.unit_price_pence;

  db.prepare('UPDATE invoice_lines SET description = ?, net_pence = ?, unit_price_pence = ?, vat_pence = ? WHERE id = ?')
    .run(description, net, unit, vat.applies ? vatOn(net, vat.ratePercent) : 0, lineId);
  recalculateInvoice(db, invoiceId);
}

export function removeInvoiceLine(db: Db, invoiceId: string, lineId: string): void {
  assertDraft(db, invoiceId);
  const line = db.prepare('SELECT * FROM invoice_lines WHERE id = ? AND invoice_id = ?')
    .get(lineId, invoiceId) as any;
  if (!line) throw new Error('Line not found');

  db.prepare('DELETE FROM invoice_lines WHERE id = ?').run(lineId);
  // Releasing the last line of a timesheet must release the timesheet, or the
  // work silently vanishes from the unbilled list.
  if (line.timesheet_id) {
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ? AND timesheet_id = ?')
      .get(invoiceId, line.timesheet_id) as any).n;
    if (remaining === 0) {
      db.prepare(`UPDATE timesheets SET invoice_id = NULL, updated_at = ? WHERE id = ? AND status <> 'invoiced'`)
        .run(nowInstant(), line.timesheet_id);
    }
  }
  recalculateInvoice(db, invoiceId);
}

/** Edit draft header fields. Moving the issue date recomputes the VAT position. */
export function updateDraftInvoice(db: Db, invoiceId: string, changes: Record<string, unknown>): void {
  const inv = assertDraft(db, invoiceId);
  const allowed = ['issue_date', 'tax_point_date', 'due_date', 'po_reference', 'notes',
    'period_from', 'period_to'];
  const fields = allowed.filter((f) => changes[f] !== undefined);
  if (fields.length === 0) return;

  db.prepare(`UPDATE invoices SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...fields.map((f) => changes[f]), nowInstant(), invoiceId);

  if (fields.includes('issue_date')) {
    const clientCountry = (db.prepare('SELECT country FROM organisations WHERE id = ?')
      .get(inv.client_org_id) as any)?.country ?? 'United Kingdom';
    const vat = vatPolicyFor(db, changes.issue_date as string, clientCountry);
    db.prepare('UPDATE invoices SET vat_applied = ?, vat_note = ? WHERE id = ?')
      .run(vat.applies ? 1 : 0, vat.note, invoiceId);
    for (const l of db.prepare('SELECT id, net_pence FROM invoice_lines WHERE invoice_id = ?')
      .all(invoiceId) as any[]) {
      db.prepare('UPDATE invoice_lines SET vat_rate = ?, vat_code = ?, vat_pence = ? WHERE id = ?')
        .run(vat.ratePercent, vat.code, vat.applies ? vatOn(l.net_pence, vat.ratePercent) : 0, l.id);
    }
  }
  recalculateInvoice(db, invoiceId);

  recordAudit(db, {
    entityType: 'invoice', entityId: invoiceId, action: 'draft_edited',
    summary: `Draft invoice edited: ${fields.join(', ')}`,
    before: Object.fromEntries(fields.map((f) => [f, inv[f]])),
    after: Object.fromEntries(fields.map((f) => [f, changes[f]])),
  });
}

export function recalculateInvoice(db: Db, invoiceId: string): void {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');
  if (inv.status !== 'draft') return; // issued invoices are frozen

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(net_pence),0) AS net, COALESCE(SUM(vat_pence),0) AS vat
       FROM invoice_lines WHERE invoice_id = ?`,
    )
    .get(invoiceId) as any;

  const gross = totals.net + totals.vat;

  db.prepare(
    `UPDATE invoices SET net_pence = ?, vat_pence = ?, gross_pence = ?,
       base_net_pence = ?, base_vat_pence = ?, base_gross_pence = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    totals.net,
    totals.vat,
    gross,
    toBase(totals.net, inv.fx_rate),
    toBase(totals.vat, inv.fx_rate),
    toBase(gross, inv.fx_rate),
    nowInstant(),
    invoiceId,
  );
}

/**
 * Issuing allocates the invoice number and freezes the document. After this the
 * database triggers refuse any change to the figures.
 */
export function issueInvoice(db: Db, invoiceId: string): string {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');
  if (inv.status !== 'draft') throw new Error('This invoice has already been issued.');

  const lineCount = db
    .prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?')
    .get(invoiceId) as any;
  if (lineCount.n === 0) throw new Error('Cannot issue an invoice with no lines.');

  recalculateInvoice(db, invoiceId);

  const number = allocateNumber(db, 'invoice', invoiceId);
  const now = nowInstant();

  db.prepare(`UPDATE invoices SET number = ?, status = 'issued', issued_at = ?, updated_at = ? WHERE id = ?`)
    .run(number, now, now, invoiceId);

  db.prepare(`UPDATE timesheets SET status = 'invoiced', updated_at = ? WHERE invoice_id = ?`)
    .run(now, invoiceId);

  scheduleReminders(db, invoiceId);
  postInvoice(db, invoiceId);

  const fresh = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  recordAudit(db, {
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'issued',
    summary: `Invoice ${number} issued — ${(fresh.gross_pence / 100).toFixed(2)} ${fresh.currency}`,
    after: { number, gross: fresh.gross_pence, issueDate: fresh.issue_date },
  });

  return number;
}

/**
 * Voiding keeps the number consumed and visible, which is what makes the series
 * provably gapless. It never deletes.
 */
export function voidInvoice(db: Db, invoiceId: string, reason: string): void {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');
  if (inv.paid_pence > 0) {
    throw new Error(
      'This invoice has payments recorded against it and cannot be voided. Raise a credit note instead.',
    );
  }
  if (!reason?.trim()) throw new Error('A reason is required to void an invoice.');

  const now = nowInstant();
  db.prepare(`UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?`)
    .run(now, reason, now, invoiceId);

  // Release the timesheets so the work can be re-invoiced correctly.
  db.prepare(`UPDATE timesheets SET status = 'approved', invoice_id = NULL, updated_at = ? WHERE invoice_id = ?`)
    .run(now, invoiceId);

  recordAudit(db, {
    entityType: 'invoice',
    entityId: invoiceId,
    action: 'voided',
    summary: `Invoice ${inv.number ?? '(draft)'} voided: ${reason}`,
    before: { status: inv.status },
    after: { status: 'void', reason },
  });
}

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------

export function createCreditNote(
  db: Db,
  input: { invoiceId: string; reason: string; lines?: Array<{ description: string; netPence: number }> },
): string {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(input.invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'draft') {
    throw new Error('This invoice has not been issued. Edit or delete the draft rather than crediting it.');
  }
  if (!input.reason?.trim()) throw new Error('A reason is required on a credit note.');

  const id = newId('cn');
  const now = nowInstant();
  const issueDate = today();
  const vat = vatPolicyFor(db, issueDate);

  db.prepare(
    `INSERT INTO credit_notes (id, invoice_id, client_org_id, issue_date, currency, fx_rate,
                               reason, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'draft', ?,?)`,
  ).run(id, input.invoiceId, inv.client_org_id, issueDate, inv.currency, inv.fx_rate, input.reason, now, now);

  // Default to a full credit of the invoice.
  const lines =
    input.lines ??
    (db.prepare('SELECT description, net_pence FROM invoice_lines WHERE invoice_id = ?').all(input.invoiceId) as any[])
      .map((l) => ({ description: l.description, netPence: l.net_pence }));

  let lineNo = 1;
  const insert = db.prepare(
    `INSERT INTO credit_note_lines (id, credit_note_id, line_no, description, net_pence, vat_rate, vat_code, vat_pence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const l of lines) {
    insert.run(
      newId('cnl'),
      id,
      lineNo++,
      l.description,
      l.netPence,
      vat.ratePercent,
      vat.code,
      vat.applies ? vatOn(l.netPence, vat.ratePercent) : 0,
      now,
    );
  }

  const totals = db
    .prepare('SELECT COALESCE(SUM(net_pence),0) AS net, COALESCE(SUM(vat_pence),0) AS vat FROM credit_note_lines WHERE credit_note_id = ?')
    .get(id) as any;

  db.prepare('UPDATE credit_notes SET net_pence = ?, vat_pence = ?, gross_pence = ?, updated_at = ? WHERE id = ?')
    .run(totals.net, totals.vat, totals.net + totals.vat, now, id);

  recordAudit(db, {
    entityType: 'credit_note',
    entityId: id,
    action: 'created',
    summary: `Credit note drafted against invoice ${inv.number}: ${input.reason}`,
    after: { invoiceId: input.invoiceId, reason: input.reason, net: totals.net },
  });

  return id;
}

export function issueCreditNote(db: Db, creditNoteId: string): string {
  const cn = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(creditNoteId) as any;
  if (!cn) throw new Error('Credit note not found');
  if (cn.status !== 'draft') throw new Error('This credit note has already been issued.');

  const number = allocateNumber(db, 'credit_note', creditNoteId);
  const now = nowInstant();

  db.prepare(`UPDATE credit_notes SET number = ?, status = 'issued', issued_at = ?, updated_at = ? WHERE id = ?`)
    .run(number, now, now, creditNoteId);

  postCreditNote(db, creditNoteId);

  recordAudit(db, {
    entityType: 'credit_note',
    entityId: creditNoteId,
    action: 'issued',
    summary: `Credit note ${number} issued — ${(cn.gross_pence / 100).toFixed(2)} ${cn.currency}`,
    after: { number },
  });

  return number;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  invoiceId: string;
  paidOn: IsoDate;
  amountPence: number;
  method?: string;
  reference?: string;
  bankTxnId?: string;
  /**
   * Set when company income was received into a director's personal account and
   * then passed to the business. It is not illegal, but it must be visible and
   * documented — an undocumented pattern of it is what HMRC treats as suspected
   * income diversion.
   */
  viaDirectorLoan?: boolean;
  notes?: string;
}

export function recordPayment(db: Db, input: RecordPaymentInput): string {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(input.invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'draft') throw new Error('Issue the invoice before recording a payment against it.');
  if (inv.status === 'void') throw new Error('This invoice has been voided.');
  if (input.amountPence <= 0) throw new Error('Payment amount must be greater than zero.');

  const id = newId('pay');
  const now = nowInstant();

  db.prepare(
    `INSERT INTO payments (id, direction, organisation_id, invoice_id, paid_on, amount_pence,
                           currency, fx_rate, method, reference, bank_txn_id, via_director_loan, notes, created_at)
     VALUES (?, 'in', ?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    inv.client_org_id,
    input.invoiceId,
    input.paidOn,
    input.amountPence,
    inv.currency,
    inv.fx_rate,
    input.method ?? 'bank_transfer',
    input.reference ?? null,
    input.bankTxnId ?? null,
    input.viaDirectorLoan ? 1 : 0,
    input.notes ?? null,
    now,
  );

  const paid = db
    .prepare(`SELECT COALESCE(SUM(amount_pence),0) AS total FROM payments WHERE invoice_id = ? AND direction = 'in'`)
    .get(input.invoiceId) as any;

  const status =
    paid.total >= inv.gross_pence ? 'paid' : paid.total > 0 ? 'part_paid' : inv.status;

  db.prepare('UPDATE invoices SET paid_pence = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(paid.total, status, now, input.invoiceId);

  postPaymentReceipt(db, id);

  recordAudit(db, {
    entityType: 'invoice',
    entityId: input.invoiceId,
    action: 'payment_recorded',
    summary:
      `Payment of ${(input.amountPence / 100).toFixed(2)} ${inv.currency} recorded against ${inv.number}` +
      (input.viaDirectorLoan ? ' (received via director\'s personal account)' : ''),
    after: { paymentId: id, ...input },
  });

  return id;
}

// ---------------------------------------------------------------------------
// Late payment — Late Payment of Commercial Debts (Interest) Act 1998
// ---------------------------------------------------------------------------

/**
 * Statutory interest runs at the Bank of England base rate plus 8%, plus fixed
 * compensation by debt size. The base rate is held in settings so it can be
 * updated when the MPC moves it.
 */
export function statutoryInterest(db: Db, invoiceId: string, asOf: IsoDate = today()) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');

  const outstanding = inv.gross_pence - inv.paid_pence;
  if (outstanding <= 0 || !inv.due_date || asOf <= inv.due_date) {
    return {
      applicable: false,
      daysLate: 0,
      outstandingPence: Math.max(0, outstanding),
      interestPence: 0,
      compensationPence: 0,
      totalClaimablePence: 0,
      ratePercent: 0,
    };
  }

  const baseRateSetting = db.prepare("SELECT value FROM settings WHERE key = 'boe_base_rate'").get() as any;
  const baseRate = baseRateSetting ? parseFloat(baseRateSetting.value) : 4.0;
  const ratePercent = baseRate + 8;

  const daysLate = daysBetween(inv.due_date, asOf);
  const interestPence = Math.round((outstanding * (ratePercent / 100) * daysLate) / 365);

  // Fixed compensation bands under section 5A.
  const debt = outstanding;
  const compensationPence = debt < 100_000 ? 4000 : debt < 1_000_000 ? 7000 : 10000;

  return {
    applicable: true,
    daysLate,
    outstandingPence: outstanding,
    interestPence,
    compensationPence,
    totalClaimablePence: interestPence + compensationPence,
    ratePercent,
    baseRate,
  };
}

function scheduleReminders(db: Db, invoiceId: string): void {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv?.due_date) return;

  const stages: Array<[string, number]> = [
    ['pre_due', -3],
    ['due', 0],
    ['overdue_7', 7],
    ['overdue_14', 14],
    ['overdue_30', 30],
  ];

  const insert = db.prepare(
    'INSERT INTO invoice_reminders (id, invoice_id, due_on, stage, created_at) VALUES (?,?,?,?,?)',
  );
  const now = nowInstant();
  for (const [stage, offset] of stages) {
    insert.run(newId('rem'), invoiceId, addDays(inv.due_date, offset), stage, now);
  }
}

export function dueReminders(db: Db, asOf: IsoDate = today()) {
  return db
    .prepare(
      `SELECT r.*, i.number, i.gross_pence, i.paid_pence, i.due_date, o.name AS client_name, o.contact_email
       FROM invoice_reminders r
       JOIN invoices i ON i.id = r.invoice_id
       JOIN organisations o ON o.id = i.client_org_id
       WHERE r.sent_at IS NULL AND r.due_on <= ?
         AND i.status IN ('issued','part_paid','overdue')
       ORDER BY r.due_on ASC`,
    )
    .all(asOf);
}

export function markReminderSent(db: Db, reminderId: string, channel = 'email'): void {
  db.prepare('UPDATE invoice_reminders SET sent_at = ?, channel = ? WHERE id = ?')
    .run(nowInstant(), channel, reminderId);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function refreshOverdueStatuses(db: Db, asOf: IsoDate = today()): number {
  const result = db
    .prepare(
      `UPDATE invoices SET status = 'overdue', updated_at = ?
       WHERE status IN ('issued','part_paid') AND due_date < ? AND gross_pence > paid_pence`,
    )
    .run(nowInstant(), asOf);
  return result.changes;
}

export function agedDebtors(db: Db, asOf: IsoDate = today()) {
  const rows = db
    .prepare(
      `SELECT i.id, i.number, i.issue_date, i.due_date, i.currency,
              i.gross_pence, i.paid_pence, (i.gross_pence - i.paid_pence) AS outstanding,
              o.id AS client_id, o.name AS client_name
       FROM invoices i
       JOIN organisations o ON o.id = i.client_org_id
       WHERE i.status IN ('issued','part_paid','overdue') AND i.gross_pence > i.paid_pence
       ORDER BY i.due_date ASC`,
    )
    .all() as any[];

  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
  const byClient = new Map<string, any>();

  for (const r of rows) {
    const daysOverdue = r.due_date ? daysBetween(r.due_date, asOf) : 0;
    const bucket =
      daysOverdue <= 0 ? 'current'
        : daysOverdue <= 30 ? 'days1to30'
        : daysOverdue <= 60 ? 'days31to60'
        : daysOverdue <= 90 ? 'days61to90'
        : 'over90';

    buckets[bucket as keyof typeof buckets] += r.outstanding;
    r.daysOverdue = Math.max(0, daysOverdue);
    r.bucket = bucket;

    if (!byClient.has(r.client_id)) {
      byClient.set(r.client_id, {
        clientId: r.client_id,
        clientName: r.client_name,
        total: 0,
        current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0,
        invoices: [],
      });
    }
    const c = byClient.get(r.client_id);
    c.total += r.outstanding;
    c[bucket] += r.outstanding;
    c.invoices.push(r);
  }

  return {
    asOf,
    totalOutstanding: rows.reduce((a, r) => a + r.outstanding, 0),
    buckets,
    byClient: [...byClient.values()].sort((a, b) => b.total - a.total),
    invoices: rows,
  };
}

export function invoiceWithDetail(db: Db, invoiceId: string) {
  const inv = db
    .prepare(
      `SELECT i.*, o.name AS client_name, o.legal_name AS client_legal_name, o.company_number AS client_company_number,
              o.vat_number AS client_vat_number, o.address_1, o.address_2, o.city, o.postcode, o.country
       FROM invoices i JOIN organisations o ON o.id = i.client_org_id WHERE i.id = ?`,
    )
    .get(invoiceId) as any;
  if (!inv) return null;

  const lines = db
    .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no')
    .all(invoiceId) as any[];

  const payments = db
    .prepare(`SELECT * FROM payments WHERE invoice_id = ? AND direction = 'in' ORDER BY paid_on`)
    .all(invoiceId) as any[];

  // The evidence chain behind this invoice, for the enquiry pack.
  const backing = db
    .prepare(
      `SELECT DISTINCT t.id, t.reference, t.week_ending, t.client_signatory, t.client_signed_on,
              t.total_minutes, w.first_name, w.last_name,
              (SELECT COUNT(*) FROM documents d WHERE d.entity_type='timesheet'
                 AND d.entity_id = t.id AND d.category='signed_timesheet') AS scan_count
       FROM invoice_lines il
       JOIN timesheets t ON t.id = il.timesheet_id
       JOIN workers w ON w.id = t.worker_id
       WHERE il.invoice_id = ?`,
    )
    .all(invoiceId) as any[];

  const creditNotes = db
    .prepare('SELECT * FROM credit_notes WHERE invoice_id = ?')
    .all(invoiceId) as any[];

  return {
    ...inv,
    lines,
    payments,
    backingTimesheets: backing,
    creditNotes,
    outstandingPence: inv.gross_pence - inv.paid_pence,
    lateInterest: statutoryInterest(db, invoiceId),
  };
}
