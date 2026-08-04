import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { allocateNumber } from './numbering.js';
import { postPurchaseInvoice } from './ledger.js';
import { nowInstant, today, addDays } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * The cost side: umbrella invoices, and self-bills received from agencies.
 *
 * Cerviz pays umbrellas rather than running its own payroll, so the cost of
 * every shift arrives as a purchase invoice. Matching those invoices back to the
 * shifts they relate to is what makes margin real rather than estimated — and it
 * catches the umbrella that quietly bills 41 hours for a 40-hour week.
 *
 * Self-bills are the mirror image: the agency above Cerviz raises the invoice
 * itself. Cerviz's job is then to check their figures against its own timesheets,
 * because an agency under-billing itself in its own favour is routine and
 * nobody else is going to notice.
 */

export interface CreatePurchaseInput {
  organisationId: string;
  theirReference?: string;
  invoiceDate: IsoDate;
  dueDate?: IsoDate;
  periodFrom?: IsoDate;
  periodTo?: IsoDate;
  currency?: string;
  fxRate?: number;
  netPence: number;
  vatPence?: number;
  category?: string;
  notes?: string;
}

export function createPurchaseInvoice(db: Db, input: CreatePurchaseInput): string {
  const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(input.organisationId) as any;
  if (!org) throw new Error('Supplier not found');

  const id = newId('pinv');
  const now = nowInstant();
  const reference = allocateNumber(db, 'purchase', id);
  const vat = input.vatPence ?? 0;

  db.prepare(
    `INSERT INTO purchase_invoices
       (id, our_reference, organisation_id, their_reference, invoice_date, due_date,
        period_from, period_to, currency, fx_rate, net_pence, vat_pence, gross_pence,
        category, status, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'received', ?,?,?)`,
  ).run(
    id,
    reference,
    input.organisationId,
    input.theirReference ?? null,
    input.invoiceDate,
    input.dueDate ?? addDays(input.invoiceDate, org.payment_terms_days ?? 14),
    input.periodFrom ?? null,
    input.periodTo ?? null,
    input.currency ?? 'GBP',
    input.fxRate ?? 1.0,
    input.netPence,
    vat,
    input.netPence + vat,
    input.category ?? 'umbrella_labour',
    input.notes ?? null,
    now,
    now,
  );

  recordAudit(db, {
    entityType: 'purchase_invoice',
    entityId: id,
    action: 'created',
    summary: `Purchase invoice ${reference} received from ${org.name} — £${(input.netPence / 100).toFixed(2)} net`,
    after: input,
  });

  return id;
}

export function addPurchaseLine(
  db: Db,
  purchaseInvoiceId: string,
  line: {
    description: string;
    workerId?: string;
    timesheetId?: string;
    shiftId?: string;
    quantityMinutes?: number;
    unitPricePence: number;
    netPence: number;
    vatPence?: number;
  },
): string {
  const pi = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(purchaseInvoiceId) as any;
  if (!pi) throw new Error('Purchase invoice not found');
  if (pi.status === 'paid' || pi.status === 'void') {
    throw new Error(`This purchase invoice is ${pi.status} and cannot be changed.`);
  }

  const nextLineNo = (db
    .prepare('SELECT COALESCE(MAX(line_no),0) AS n FROM purchase_invoice_lines WHERE purchase_invoice_id = ?')
    .get(purchaseInvoiceId) as any).n + 1;

  const id = newId('pinvl');
  db.prepare(
    `INSERT INTO purchase_invoice_lines
       (id, purchase_invoice_id, line_no, description, worker_id, timesheet_id, shift_id,
        quantity_minutes, unit_price_pence, net_pence, vat_pence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    purchaseInvoiceId,
    nextLineNo,
    line.description,
    line.workerId ?? null,
    line.timesheetId ?? null,
    line.shiftId ?? null,
    line.quantityMinutes ?? null,
    line.unitPricePence,
    line.netPence,
    line.vatPence ?? 0,
    nowInstant(),
  );

  return id;
}

export interface PurchaseMatch {
  purchaseInvoiceId: string;
  reference: string;
  supplier: string;
  theirNetPence: number;
  ourExpectedPence: number;
  variancePence: number;
  variancePercent: number;
  status: 'exact' | 'within_tolerance' | 'overbilled' | 'underbilled' | 'no_expectation';
  detail: Array<{
    workerName: string;
    weekEnding: string;
    ourMinutes: number;
    ourPayPence: number;
    theirMinutes: number | null;
    theirNetPence: number | null;
    variancePence: number;
  }>;
  message: string;
}

/**
 * Matches an umbrella's invoice against what Cerviz's own approved timesheets
 * say the labour should have cost. Tolerance is a few pence for rounding;
 * anything more is flagged for query rather than quietly paid.
 */
export function matchPurchaseToTimesheets(
  db: Db,
  purchaseInvoiceId: string,
  tolerancePence = 100,
): PurchaseMatch {
  const pi = db
    .prepare(
      `SELECT p.*, o.name AS supplier FROM purchase_invoices p
       JOIN organisations o ON o.id = p.organisation_id WHERE p.id = ?`,
    )
    .get(purchaseInvoiceId) as any;
  if (!pi) throw new Error('Purchase invoice not found');

  // What we believe this umbrella's workers cost over the invoice period.
  const expected = db
    .prepare(
      `SELECT t.id, t.week_ending, t.pay_total_pence, t.total_minutes,
              w.first_name, w.last_name, w.id AS worker_id
       FROM timesheets t
       JOIN workers w ON w.id = t.worker_id
       WHERE w.umbrella_org_id = ?
         AND t.status IN ('approved','invoiced')
         AND (? IS NULL OR t.week_ending >= ?)
         AND (? IS NULL OR t.week_ending <= ?)`,
    )
    .all(pi.organisation_id, pi.period_from, pi.period_from, pi.period_to, pi.period_to) as any[];

  // What they actually billed, where their lines identify a worker.
  const theirLines = db
    .prepare(
      `SELECT worker_id, timesheet_id, SUM(quantity_minutes) AS minutes, SUM(net_pence) AS net
       FROM purchase_invoice_lines WHERE purchase_invoice_id = ? GROUP BY worker_id, timesheet_id`,
    )
    .all(purchaseInvoiceId) as any[];

  const theirByWorker = new Map<string, { minutes: number; net: number }>();
  for (const l of theirLines) {
    if (!l.worker_id) continue;
    const cur = theirByWorker.get(l.worker_id) ?? { minutes: 0, net: 0 };
    cur.minutes += l.minutes ?? 0;
    cur.net += l.net ?? 0;
    theirByWorker.set(l.worker_id, cur);
  }

  const ourExpected = expected.reduce((a, t) => a + t.pay_total_pence, 0);
  const detail = expected.map((t) => {
    const theirs = theirByWorker.get(t.worker_id);
    return {
      workerName: `${t.first_name} ${t.last_name}`,
      weekEnding: t.week_ending,
      ourMinutes: t.total_minutes,
      ourPayPence: t.pay_total_pence,
      theirMinutes: theirs?.minutes ?? null,
      theirNetPence: theirs?.net ?? null,
      variancePence: (theirs?.net ?? 0) - t.pay_total_pence,
    };
  });

  const variance = pi.net_pence - ourExpected;
  const variancePercent = ourExpected > 0 ? Math.round((variance / ourExpected) * 1000) / 10 : 0;

  let status: PurchaseMatch['status'];
  let message: string;

  if (expected.length === 0) {
    status = 'no_expectation';
    message =
      'No approved timesheets found for this umbrella over the invoice period, so this invoice ' +
      'cannot be checked against our own records. Confirm the period and the workers before paying.';
  } else if (Math.abs(variance) <= tolerancePence) {
    status = variance === 0 ? 'exact' : 'within_tolerance';
    message = `Matches our timesheets${variance === 0 ? ' exactly' : ' within rounding tolerance'}.`;
  } else if (variance > 0) {
    status = 'overbilled';
    message =
      `This invoice is £${(variance / 100).toFixed(2)} (${variancePercent}%) HIGHER than our approved ` +
      'timesheets support. Query it before paying — you would be paying for hours no client will fund.';
  } else {
    status = 'underbilled';
    message =
      `This invoice is £${(Math.abs(variance) / 100).toFixed(2)} (${Math.abs(variancePercent)}%) lower than ` +
      'our timesheets suggest. Check for missing workers or weeks before treating it as settled.';
  }

  db.prepare(
    `UPDATE purchase_invoices SET expected_pence = ?, variance_pence = ?,
       status = CASE WHEN ? IN ('exact','within_tolerance') THEN 'matched' ELSE 'queried' END,
       updated_at = ? WHERE id = ?`,
  ).run(ourExpected, variance, status, nowInstant(), purchaseInvoiceId);

  return {
    purchaseInvoiceId,
    reference: pi.our_reference,
    supplier: pi.supplier,
    theirNetPence: pi.net_pence,
    ourExpectedPence: ourExpected,
    variancePence: variance,
    variancePercent,
    status,
    detail,
    message,
  };
}

export function approvePurchaseInvoice(db: Db, purchaseInvoiceId: string, approvedBy?: string): void {
  const pi = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(purchaseInvoiceId) as any;
  if (!pi) throw new Error('Purchase invoice not found');

  db.prepare(`UPDATE purchase_invoices SET status = 'approved', updated_at = ? WHERE id = ?`)
    .run(nowInstant(), purchaseInvoiceId);

  postPurchaseInvoice(db, purchaseInvoiceId);

  recordAudit(db, {
    entityType: 'purchase_invoice',
    entityId: purchaseInvoiceId,
    action: 'approved',
    summary: `Purchase invoice ${pi.our_reference} approved for payment by ${approvedBy ?? process.env.USER ?? 'operator'}`,
    before: { status: pi.status, variance: pi.variance_pence },
  });
}

// ---------------------------------------------------------------------------
// Self-bills received from agencies
// ---------------------------------------------------------------------------

export interface SelfBillInput {
  organisationId: string;
  theirReference: string;
  receivedOn: IsoDate;
  periodFrom?: IsoDate;
  periodTo?: IsoDate;
  currency?: string;
  theirNetPence: number;
  theirVatPence?: number;
  lines?: Array<{
    description?: string;
    workerId?: string;
    timesheetId?: string;
    workDate?: IsoDate;
    theirMinutes?: number;
    theirRatePence?: number;
    theirNetPence: number;
  }>;
}

export function recordSelfBill(db: Db, input: SelfBillInput): string {
  const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(input.organisationId) as any;
  if (!org) throw new Error('Agency not found');

  const id = newId('sb');
  const now = nowInstant();
  const vat = input.theirVatPence ?? 0;

  db.prepare(
    `INSERT INTO self_bills
       (id, organisation_id, their_reference, received_on, period_from, period_to, currency,
        their_net_pence, their_vat_pence, their_gross_pence, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'received', ?,?)`,
  ).run(
    id,
    input.organisationId,
    input.theirReference,
    input.receivedOn,
    input.periodFrom ?? null,
    input.periodTo ?? null,
    input.currency ?? 'GBP',
    input.theirNetPence,
    vat,
    input.theirNetPence + vat,
    now,
    now,
  );

  const insert = db.prepare(
    `INSERT INTO self_bill_lines
       (id, self_bill_id, description, worker_id, timesheet_id, work_date, their_minutes,
        their_rate_pence, their_net_pence, our_minutes, our_rate_pence, our_net_pence, variance_pence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const l of input.lines ?? []) {
    // Where their line names one of our timesheets, compare directly.
    let ourMinutes: number | null = null;
    let ourNet: number | null = null;
    if (l.timesheetId) {
      const ts = db
        .prepare('SELECT total_minutes, charge_total_pence FROM timesheets WHERE id = ?')
        .get(l.timesheetId) as any;
      ourMinutes = ts?.total_minutes ?? null;
      ourNet = ts?.charge_total_pence ?? null;
    }
    insert.run(
      newId('sbl'),
      id,
      l.description ?? null,
      l.workerId ?? null,
      l.timesheetId ?? null,
      l.workDate ?? null,
      l.theirMinutes ?? null,
      l.theirRatePence ?? null,
      l.theirNetPence,
      ourMinutes,
      ourNet != null && ourMinutes ? Math.round((ourNet * 60) / ourMinutes) : null,
      ourNet,
      ourNet != null ? l.theirNetPence - ourNet : null,
      now,
    );
  }

  recordAudit(db, {
    entityType: 'self_bill',
    entityId: id,
    action: 'received',
    summary: `Self-bill ${input.theirReference} received from ${org.name} — £${(input.theirNetPence / 100).toFixed(2)} net`,
    after: input,
  });

  reconcileSelfBill(db, id);
  return id;
}

export interface SelfBillReconciliation {
  selfBillId: string;
  agency: string;
  theirReference: string;
  theirNetPence: number;
  ourExpectedNetPence: number;
  variancePence: number;
  variancePercent: number;
  status: 'agreed' | 'underpaid' | 'overpaid' | 'unmatched';
  message: string;
  unmatchedTimesheets: Array<{ reference: string; weekEnding: string; worker: string; chargePence: number }>;
}

/**
 * Compares a received self-bill against Cerviz's own approved timesheets for
 * that agency and period. An agency that omits a week, or applies last year's
 * rate, produces a shortfall that nothing else in the business would surface.
 */
export function reconcileSelfBill(db: Db, selfBillId: string, tolerancePence = 100): SelfBillReconciliation {
  const sb = db
    .prepare(
      `SELECT s.*, o.name AS agency FROM self_bills s
       JOIN organisations o ON o.id = s.organisation_id WHERE s.id = ?`,
    )
    .get(selfBillId) as any;
  if (!sb) throw new Error('Self-bill not found');

  const ourTimesheets = db
    .prepare(
      `SELECT t.id, t.reference, t.week_ending, t.charge_total_pence,
              w.first_name, w.last_name
       FROM timesheets t
       JOIN assignments a ON a.id = t.assignment_id
       JOIN workers w ON w.id = t.worker_id
       WHERE a.client_org_id = ?
         AND t.status IN ('approved','invoiced')
         AND (? IS NULL OR t.week_ending >= ?)
         AND (? IS NULL OR t.week_ending <= ?)`,
    )
    .all(sb.organisation_id, sb.period_from, sb.period_from, sb.period_to, sb.period_to) as any[];

  const ourExpected = ourTimesheets.reduce((a, t) => a + t.charge_total_pence, 0);
  const variance = sb.their_net_pence - ourExpected;
  const variancePercent = ourExpected > 0 ? Math.round((variance / ourExpected) * 1000) / 10 : 0;

  const billedTimesheetIds = new Set(
    (db.prepare('SELECT timesheet_id FROM self_bill_lines WHERE self_bill_id = ?').all(selfBillId) as any[])
      .map((r) => r.timesheet_id)
      .filter(Boolean),
  );
  const unmatched = ourTimesheets
    .filter((t) => !billedTimesheetIds.has(t.id))
    .map((t) => ({
      reference: t.reference,
      weekEnding: t.week_ending,
      worker: `${t.first_name} ${t.last_name}`,
      chargePence: t.charge_total_pence,
    }));

  let status: SelfBillReconciliation['status'];
  let message: string;

  if (ourTimesheets.length === 0) {
    status = 'unmatched';
    message =
      'No approved timesheets found for this agency over the self-bill period. Either the period is ' +
      'wrong or the timesheets have not been entered yet — do not treat this self-bill as agreed.';
  } else if (Math.abs(variance) <= tolerancePence) {
    status = 'agreed';
    message = 'Self-bill agrees with our approved timesheets.';
  } else if (variance < 0) {
    status = 'underpaid';
    message =
      `This self-bill is £${(Math.abs(variance) / 100).toFixed(2)} (${Math.abs(variancePercent)}%) LESS than our ` +
      `approved timesheets support.` +
      (unmatched.length
        ? ` ${unmatched.length} timesheet(s) appear to have been left off entirely.`
        : ' Check the rates they have applied.') +
      ' Raise this with the agency in writing.';
  } else {
    status = 'overpaid';
    message =
      `This self-bill is £${(variance / 100).toFixed(2)} (${variancePercent}%) MORE than our timesheets support. ` +
      'Confirm before accepting — an overpayment you keep quietly becomes a dispute later.';
  }

  db.prepare(
    `UPDATE self_bills SET our_expected_net_pence = ?, variance_pence = ?,
       status = CASE WHEN ? = 'agreed' THEN 'agreed' ELSE 'disputed' END, updated_at = ?
     WHERE id = ?`,
  ).run(ourExpected, variance, status, nowInstant(), selfBillId);

  return {
    selfBillId,
    agency: sb.agency,
    theirReference: sb.their_reference,
    theirNetPence: sb.their_net_pence,
    ourExpectedNetPence: ourExpected,
    variancePence: variance,
    variancePercent,
    status,
    message,
    unmatchedTimesheets: unmatched,
  };
}

// ---------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------

export function marginReport(db: Db, from: IsoDate, to: IsoDate) {
  const byAssignment = db
    .prepare(
      `SELECT a.id, a.title, o.name AS client_name,
              COALESCE(SUM(t.charge_total_pence),0) AS charge,
              COALESCE(SUM(t.pay_total_pence),0) AS pay,
              COALESCE(SUM(t.total_minutes),0) AS minutes,
              COUNT(DISTINCT t.worker_id) AS workers
       FROM assignments a
       JOIN organisations o ON o.id = a.client_org_id
       LEFT JOIN timesheets t ON t.assignment_id = a.id
            AND t.week_ending BETWEEN ? AND ? AND t.status IN ('approved','invoiced')
       GROUP BY a.id
       HAVING charge > 0
       ORDER BY (charge - pay) DESC`,
    )
    .all(from, to) as any[];

  const byClient = db
    .prepare(
      `SELECT o.id, o.name,
              COALESCE(SUM(t.charge_total_pence),0) AS charge,
              COALESCE(SUM(t.pay_total_pence),0) AS pay,
              COALESCE(SUM(t.total_minutes),0) AS minutes
       FROM organisations o
       JOIN assignments a ON a.client_org_id = o.id
       JOIN timesheets t ON t.assignment_id = a.id
       WHERE t.week_ending BETWEEN ? AND ? AND t.status IN ('approved','invoiced')
       GROUP BY o.id
       ORDER BY (charge - pay) DESC`,
    )
    .all(from, to) as any[];

  const decorate = (r: any) => ({
    ...r,
    marginPence: r.charge - r.pay,
    marginPercent: r.charge > 0 ? Math.round(((r.charge - r.pay) / r.charge) * 1000) / 10 : 0,
    hours: Math.round((r.minutes / 60) * 10) / 10,
    marginPerHourPence: r.minutes > 0 ? Math.round(((r.charge - r.pay) * 60) / r.minutes) : 0,
  });

  const totalCharge = byClient.reduce((a, r) => a + r.charge, 0);
  const totalPay = byClient.reduce((a, r) => a + r.pay, 0);

  return {
    from,
    to,
    byAssignment: byAssignment.map(decorate),
    byClient: byClient.map(decorate),
    totalChargePence: totalCharge,
    totalPayPence: totalPay,
    totalMarginPence: totalCharge - totalPay,
    marginPercent: totalCharge > 0 ? Math.round(((totalCharge - totalPay) / totalCharge) * 1000) / 10 : 0,
  };
}

export function agedCreditors(db: Db, asOf: IsoDate = today()) {
  const rows = db
    .prepare(
      `SELECT p.id, p.our_reference, p.their_reference, p.invoice_date, p.due_date,
              p.gross_pence, p.paid_pence, (p.gross_pence - p.paid_pence) AS outstanding,
              p.variance_pence, p.status, o.name AS supplier
       FROM purchase_invoices p
       JOIN organisations o ON o.id = p.organisation_id
       WHERE p.status NOT IN ('paid','void') AND p.gross_pence > p.paid_pence
       ORDER BY p.due_date ASC`,
    )
    .all() as any[];

  return {
    asOf,
    totalOutstandingPence: rows.reduce((a, r) => a + r.outstanding, 0),
    queriedCount: rows.filter((r) => r.status === 'queried').length,
    invoices: rows,
  };
}
