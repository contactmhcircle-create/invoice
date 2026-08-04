import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { nowInstant, today, addMonths, addDays, intermediaryPeriodFor, daysBetween } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Statutory obligations: the things with deadlines attached.
 *
 * Cerviz has no accountant at present, so this module is deliberately loud. It
 * generates the employment intermediaries quarterly report, tracks Companies
 * House and HMRC deadlines, and says plainly what happens if one is missed.
 */

// ---------------------------------------------------------------------------
// Employment intermediaries quarterly report
// ---------------------------------------------------------------------------

/**
 * An employment intermediary that supplies more than one worker to a client
 * without operating PAYE on those workers must report to HMRC every quarter.
 * Periods end 5 Jul / 5 Oct / 5 Jan / 5 Apr, each due one month later.
 *
 * Umbrella workers fall in scope because Cerviz does not operate PAYE on them
 * itself — the umbrella does. Getting this wrong is common and penalties start
 * at £250, rising to £600 and £1,000 for repeated failures.
 */
export interface IntermediaryReportRow {
  workerFirstName: string;
  workerLastName: string;
  workerNiNumber: string | null;
  workerDateOfBirth: IsoDate | null;
  workerAddress: string;
  workerPostcode: string | null;
  engagementStartDate: IsoDate | null;
  engagementEndDate: IsoDate | null;
  paymentToIntermediary: number;
  currency: string;
  vatIncluded: 'Yes' | 'No';
  intermediaryName: string | null;
  intermediaryCompanyNumber: string | null;
  intermediaryAddress: string | null;
  reasonNoPaye: string;
}

const REASON_CODES: Record<string, string> = {
  umbrella: 'D — Another party operated PAYE on the worker’s payments',
  limited: 'A — Self-employed',
  self_employed: 'A — Self-employed',
  paye: '', // in-scope only where PAYE was NOT operated by us
};

export function generateIntermediaryReport(db: Db, periodFrom: IsoDate, periodTo: IsoDate) {
  // Workers we supplied in the period on whom we did not operate PAYE ourselves.
  const rows = db
    .prepare(
      `SELECT DISTINCT w.id, w.first_name, w.last_name, w.ni_number, w.date_of_birth,
              w.address_1, w.address_2, w.city, w.postcode, w.engagement_type,
              u.name AS umbrella_name, u.company_number AS umbrella_company_number,
              u.address_1 AS umbrella_address_1, u.city AS umbrella_city, u.postcode AS umbrella_postcode,
              MIN(date(s.starts_at)) AS first_shift,
              MAX(date(s.starts_at)) AS last_shift
       FROM workers w
       JOIN shifts s ON s.worker_id = w.id
       LEFT JOIN organisations u ON u.id = w.umbrella_org_id
       WHERE w.engagement_type IN ('umbrella','limited','self_employed')
         AND s.status IN ('worked','allocated')
         AND date(s.starts_at) BETWEEN ? AND ?
       GROUP BY w.id`,
    )
    .all(periodFrom, periodTo) as any[];

  const report: IntermediaryReportRow[] = rows.map((w) => {
    // Amount paid to the intermediary for this worker in the period.
    const paid = db
      .prepare(
        `SELECT COALESCE(SUM(pil.net_pence),0) AS total
         FROM purchase_invoice_lines pil
         JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
         WHERE pil.worker_id = ? AND pi.invoice_date BETWEEN ? AND ? AND pi.status <> 'void'`,
      )
      .get(w.id, periodFrom, periodTo) as any;

    // Fall back to the pay recorded on timesheets where no purchase invoice exists yet.
    const fallback = db
      .prepare(
        `SELECT COALESCE(SUM(pay_total_pence),0) AS total FROM timesheets
         WHERE worker_id = ? AND week_ending BETWEEN ? AND ? AND status IN ('approved','invoiced')`,
      )
      .get(w.id, periodFrom, periodTo) as any;

    return {
      workerFirstName: w.first_name,
      workerLastName: w.last_name,
      workerNiNumber: w.ni_number,
      workerDateOfBirth: w.date_of_birth,
      workerAddress: [w.address_1, w.address_2, w.city].filter(Boolean).join(', '),
      workerPostcode: w.postcode,
      engagementStartDate: w.first_shift,
      engagementEndDate: w.last_shift,
      paymentToIntermediary: (paid.total || fallback.total) / 100,
      currency: 'GBP',
      vatIncluded: 'No',
      intermediaryName: w.umbrella_name,
      intermediaryCompanyNumber: w.umbrella_company_number,
      intermediaryAddress: [w.umbrella_address_1, w.umbrella_city, w.umbrella_postcode]
        .filter(Boolean)
        .join(', ') || null,
      reasonNoPaye: REASON_CODES[w.engagement_type] ?? 'Other',
    };
  });

  return report;
}

export function intermediaryReportCsv(rows: IntermediaryReportRow[]): string {
  const headers = [
    'Worker forename', 'Worker surname', 'NI number', 'Date of birth',
    'Worker address', 'Postcode', 'Engagement start date', 'Engagement end date',
    'Amount paid to intermediary', 'Currency', 'VAT included',
    'Intermediary name', 'Intermediary company registration number', 'Intermediary address',
    'Reason PAYE not operated',
  ];

  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.workerFirstName, r.workerLastName, r.workerNiNumber, r.workerDateOfBirth,
      r.workerAddress, r.workerPostcode, r.engagementStartDate, r.engagementEndDate,
      r.paymentToIntermediary.toFixed(2), r.currency, r.vatIncluded,
      r.intermediaryName, r.intermediaryCompanyNumber, r.intermediaryAddress,
      r.reasonNoPaye,
    ].map(escape).join(','));
  }
  return lines.join('\n');
}

export function ensureIntermediaryPeriods(db: Db, asOf: IsoDate = today()): void {
  const now = nowInstant();
  // Track the current period and the three before it.
  for (let i = 0; i < 4; i++) {
    const p = intermediaryPeriodFor(addMonths(asOf, -3 * i));
    db.prepare(
      `INSERT OR IGNORE INTO intermediary_reports (id, period_from, period_to, due_on, status, created_at, updated_at)
       VALUES (?,?,?,?, 'due', ?,?)`,
    ).run(newId('imr'), p.from, p.to, p.due, now, now);
  }
}

export interface IntermediaryObligation {
  periodFrom: IsoDate;
  periodTo: IsoDate;
  dueOn: IsoDate;
  status: string;
  workerCount: number;
  daysUntilDue: number;
  overdue: boolean;
  message: string;
}

export function intermediaryObligations(db: Db, asOf: IsoDate = today()): IntermediaryObligation[] {
  ensureIntermediaryPeriods(db, asOf);

  const periods = db
    .prepare('SELECT * FROM intermediary_reports ORDER BY period_to DESC')
    .all() as any[];

  return periods.map((p) => {
    const rows = generateIntermediaryReport(db, p.period_from, p.period_to);
    const days = daysBetween(asOf, p.due_on);
    const submitted = p.status === 'submitted' || p.status === 'nil_return';
    const overdue = !submitted && days < 0;

    let message: string;
    if (submitted) {
      message = `Submitted${p.submitted_on ? ` on ${p.submitted_on}` : ''}.`;
    } else if (rows.length === 0) {
      message =
        'No reportable workers in this period. A nil return is still required once you have started ' +
        'reporting — HMRC treats silence as a missed return.';
    } else if (overdue) {
      message =
        `OVERDUE by ${Math.abs(days)} days with ${rows.length} reportable worker(s). ` +
        'Penalties start at £250 and rise to £600 then £1,000 for repeated failures. File this now.';
    } else if (days <= 14) {
      message = `Due in ${days} day(s) with ${rows.length} reportable worker(s). Generate and submit it.`;
    } else {
      message = `${rows.length} reportable worker(s) so far. Due ${p.due_on}.`;
    }

    return {
      periodFrom: p.period_from,
      periodTo: p.period_to,
      dueOn: p.due_on,
      status: p.status,
      workerCount: rows.length,
      daysUntilDue: days,
      overdue,
      message,
    };
  });
}

export function markIntermediaryReportSubmitted(
  db: Db,
  periodFrom: IsoDate,
  periodTo: IsoDate,
  opts: { submittedOn?: IsoDate; nilReturn?: boolean; csvPath?: string } = {},
): void {
  const rows = generateIntermediaryReport(db, periodFrom, periodTo);
  db.prepare(
    `UPDATE intermediary_reports SET status = ?, submitted_on = ?, worker_count = ?, csv_path = ?, updated_at = ?
     WHERE period_from = ? AND period_to = ?`,
  ).run(
    opts.nilReturn ? 'nil_return' : 'submitted',
    opts.submittedOn ?? today(),
    rows.length,
    opts.csvPath ?? null,
    nowInstant(),
    periodFrom,
    periodTo,
  );

  recordAudit(db, {
    entityType: 'intermediary_report',
    entityId: `${periodFrom}_${periodTo}`,
    action: 'submitted',
    summary: `Employment intermediaries report for ${periodFrom} to ${periodTo} marked submitted (${rows.length} workers)`,
    after: opts,
  });
}

// ---------------------------------------------------------------------------
// Companies House and HMRC filing calendar
// ---------------------------------------------------------------------------

/**
 * Generates the statutory deadlines that follow from the company's incorporation
 * date and accounting reference date. These are the deadlines that carry
 * automatic penalties regardless of whether anything was owed.
 */
export function refreshFilingCalendar(db: Db, asOf: IsoDate = today()): void {
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  if (!company?.incorporated_on) return;

  const now = nowInstant();
  const upsert = db.prepare(
    `INSERT INTO filings (id, filing_type, period_from, period_to, due_on, status, notes, created_at, updated_at)
     SELECT ?,?,?,?,?, 'due', ?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM filings WHERE filing_type = ? AND due_on = ?)`,
  );

  // Accounting reference date: end of the month of the first anniversary, then annually.
  const inc = company.incorporated_on as string;
  const ardMonth = inc.slice(5, 7);
  const thisYear = parseInt(asOf.slice(0, 4), 10);

  for (const year of [thisYear, thisYear + 1]) {
    const ardEnd = lastDayOfMonth(`${year}-${ardMonth}`);
    if (ardEnd < inc) continue;

    // Private company accounts: 9 months after the accounting reference date.
    const accountsDue = addMonths(ardEnd, 9);
    upsert.run(
      newId('fil'), 'annual_accounts', addMonths(ardEnd, -12), ardEnd, accountsDue,
      'Companies House annual accounts. Late filing penalties start at £150 and reach £1,500, and they double if you are late two years running.',
      now, now, 'annual_accounts', accountsDue,
    );

    // Corporation tax: payment 9 months and 1 day after period end; return 12 months.
    const ctDue = addMonths(ardEnd, 12);
    upsert.run(
      newId('fil'), 'corporation_tax', addMonths(ardEnd, -12), ardEnd, ctDue,
      `Company tax return (CT600). The tax itself is payable earlier — by ${addDays(addMonths(ardEnd, 9), 1)}.`,
      now, now, 'corporation_tax', ctDue,
    );

    // Confirmation statement: annually from incorporation, filed within 14 days.
    const csDue = addDays(`${year}-${inc.slice(5)}`, 14);
    upsert.run(
      newId('fil'), 'confirmation_statement', null, `${year}-${inc.slice(5)}`, csDue,
      'Companies House confirmation statement. Failing to file is a criminal offence and can lead to the company being struck off.',
      now, now, 'confirmation_statement', csDue,
    );
  }
}

export interface FilingObligation {
  id: string;
  filingType: string;
  label: string;
  dueOn: IsoDate;
  daysUntilDue: number;
  status: string;
  overdue: boolean;
  notes: string | null;
}

const FILING_LABELS: Record<string, string> = {
  annual_accounts: 'Annual accounts (Companies House)',
  confirmation_statement: 'Confirmation statement (Companies House)',
  corporation_tax: 'Company tax return (HMRC)',
  vat_return: 'VAT return (HMRC)',
  employment_intermediary_report: 'Employment intermediaries report (HMRC)',
  rti_fps: 'Payroll RTI submission (HMRC)',
};

export function upcomingFilings(db: Db, asOf: IsoDate = today(), withinDays = 180): FilingObligation[] {
  refreshFilingCalendar(db, asOf);

  const horizon = addDays(asOf, withinDays);
  const rows = db
    .prepare(
      `SELECT * FROM filings WHERE status = 'due' AND due_on <= ? ORDER BY due_on ASC`,
    )
    .all(horizon) as any[];

  return rows.map((f) => {
    const days = daysBetween(asOf, f.due_on);
    return {
      id: f.id,
      filingType: f.filing_type,
      label: FILING_LABELS[f.filing_type] ?? f.filing_type,
      dueOn: f.due_on,
      daysUntilDue: days,
      status: days < 0 ? 'late' : f.status,
      overdue: days < 0,
      notes: f.notes,
    };
  });
}

export function markFilingSubmitted(db: Db, filingId: string, submittedOn?: IsoDate, reference?: string): void {
  const f = db.prepare('SELECT * FROM filings WHERE id = ?').get(filingId) as any;
  if (!f) throw new Error('Filing not found');

  db.prepare(
    `UPDATE filings SET status = 'submitted', submitted_on = ?, reference = ?, updated_at = ? WHERE id = ?`,
  ).run(submittedOn ?? today(), reference ?? null, nowInstant(), filingId);

  recordAudit(db, {
    entityType: 'filing',
    entityId: filingId,
    action: 'submitted',
    summary: `${FILING_LABELS[f.filing_type] ?? f.filing_type} due ${f.due_on} marked submitted`,
    after: { submittedOn, reference },
  });
}

function lastDayOfMonth(ym: string): IsoDate {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
