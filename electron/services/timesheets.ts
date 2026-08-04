import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { allocateNumber } from './numbering.js';
import { shiftValue } from './shifts.js';
import { recalculateAwr, holidayAccrualPence, checkNmw } from './compliance.js';
import { nowInstant, weekEnding, workedMinutes, today } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Timesheets.
 *
 * Cerviz works from paper timesheets signed on site by the client, keyed into
 * the app with the scan attached. That scan is the evidential anchor for every
 * pound of revenue: invoice line -> timesheet line -> shift -> signed paper.
 *
 * A timesheet is editable while draft. Approval locks the hours. Once billed it
 * cannot be changed at all — a correction goes out as a credit note.
 */

export interface TimesheetLineInput {
  shiftId?: string | null;
  workDate: IsoDate;
  startTime?: string;
  endTime?: string;
  breakMinutes?: number;
  workedMinutes?: number;
  billedMinutes?: number;
  band?: string;
  chargeRatePence?: number;
  payRatePence?: number;
  notes?: string;
}

export function createTimesheet(
  db: Db,
  input: { assignmentId: string; workerId: string; weekEnding?: IsoDate; workDate?: IsoDate; notes?: string },
): string {
  const week = input.weekEnding ?? weekEnding(input.workDate ?? today());

  const existing = db
    .prepare('SELECT id FROM timesheets WHERE assignment_id = ? AND worker_id = ? AND week_ending = ?')
    .get(input.assignmentId, input.workerId, week) as any;
  if (existing) return existing.id;

  const id = newId('ts');
  const now = nowInstant();
  const reference = allocateNumber(db, 'timesheet', id);

  db.prepare(
    `INSERT INTO timesheets (id, reference, assignment_id, worker_id, week_ending, status,
                             entered_by, entered_at, notes, created_at, updated_at)
     VALUES (?,?,?,?,?, 'draft', ?,?,?,?,?)`,
  ).run(
    id,
    reference,
    input.assignmentId,
    input.workerId,
    week,
    process.env.USER ?? 'operator',
    now,
    input.notes ?? null,
    now,
    now,
  );

  recordAudit(db, {
    entityType: 'timesheet',
    entityId: id,
    action: 'created',
    summary: `Timesheet ${reference} opened for week ending ${week}`,
    after: input,
  });

  return id;
}

function assertEditable(db: Db, timesheetId: string) {
  const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(timesheetId) as any;
  if (!ts) throw new Error('Timesheet not found');
  if (ts.status === 'invoiced') {
    throw new Error(
      'This timesheet has been invoiced and cannot be changed. Raise a credit note against the invoice instead.',
    );
  }
  if (ts.status === 'approved') {
    throw new Error('This timesheet has been approved and is locked. Reopen it to make changes.');
  }
  if (ts.status === 'void') throw new Error('This timesheet has been voided.');
  return ts;
}

export function addLine(db: Db, timesheetId: string, line: TimesheetLineInput): string {
  const ts = assertEditable(db, timesheetId);

  let minutes = line.workedMinutes;
  let chargeRate = line.chargeRatePence;
  let payRate = line.payRatePence;
  let band = line.band ?? 'standard';
  let billed = line.billedMinutes;

  // Where the line comes from an allocated shift, the shift is the source of
  // truth for rates — they were snapshotted when it was allocated.
  if (line.shiftId) {
    const value = shiftValue(db, line.shiftId);
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(line.shiftId) as any;
    minutes = minutes ?? value.workedMinutes;
    billed = billed ?? value.billedMinutes;
    chargeRate = chargeRate ?? value.chargeRatePence;
    payRate = payRate ?? value.payRatePence;
    band = line.band ?? shift.band;
  }

  if (minutes == null && line.startTime && line.endTime) {
    minutes = workedMinutes(
      `${line.workDate}T${line.startTime}`,
      `${line.workDate}T${line.endTime}`,
      line.breakMinutes ?? 0,
    );
  }

  if (minutes == null) throw new Error('Cannot determine hours worked for this line');
  billed = billed ?? minutes;
  chargeRate = chargeRate ?? 0;
  payRate = payRate ?? 0;

  // NMW is checked at the point hours are recorded, not only at allocation —
  // a rate can be edited on the line.
  const nmw = checkNmw(db, ts.worker_id, payRate, line.workDate);
  if (!nmw.ok) {
    throw new Error(
      `Pay rate £${(payRate / 100).toFixed(2)}/hour is below the ${nmw.band?.replace(/_/g, ' ')} ` +
        `National Minimum Wage of £${((nmw.requiredPence ?? 0) / 100).toFixed(2)}/hour on ${line.workDate}.`,
    );
  }

  const chargePence = Math.round((billed * chargeRate) / 60);
  const payPence = Math.round((minutes * payRate) / 60);

  const id = newId('tsl');
  db.prepare(
    `INSERT INTO timesheet_lines
       (id, timesheet_id, shift_id, work_date, start_time, end_time, break_minutes,
        worked_minutes, billed_minutes, band, charge_rate_pence, pay_rate_pence,
        charge_pence, pay_pence, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    timesheetId,
    line.shiftId ?? null,
    line.workDate,
    line.startTime ?? null,
    line.endTime ?? null,
    line.breakMinutes ?? 0,
    minutes,
    billed,
    band,
    chargeRate,
    payRate,
    chargePence,
    payPence,
    line.notes ?? null,
    nowInstant(),
  );

  recalculateTotals(db, timesheetId);
  return id;
}

export function removeLine(db: Db, timesheetId: string, lineId: string): void {
  assertEditable(db, timesheetId);
  db.prepare('DELETE FROM timesheet_lines WHERE id = ? AND timesheet_id = ?').run(lineId, timesheetId);
  recalculateTotals(db, timesheetId);
}

export function recalculateTotals(db: Db, timesheetId: string): void {
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(worked_minutes),0) AS minutes,
              COALESCE(SUM(charge_pence),0) AS charge,
              COALESCE(SUM(pay_pence),0) AS pay
       FROM timesheet_lines WHERE timesheet_id = ?`,
    )
    .get(timesheetId) as any;

  db.prepare(
    `UPDATE timesheets SET total_minutes = ?, charge_total_pence = ?, pay_total_pence = ?, updated_at = ?
     WHERE id = ?`,
  ).run(totals.minutes, totals.charge, totals.pay, nowInstant(), timesheetId);
}

/**
 * Populates a timesheet from the shifts already allocated for that week. This is
 * the normal path: the rota is built first, the paper comes back, and the
 * operator adjusts only the hours that differed from plan.
 */
export function populateFromShifts(db: Db, timesheetId: string): number {
  const ts = assertEditable(db, timesheetId);
  const weekStart = new Date(`${ts.week_ending}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const from = weekStart.toISOString().slice(0, 10);

  const shifts = db
    .prepare(
      `SELECT * FROM shifts
       WHERE assignment_id = ? AND worker_id = ?
         AND date(starts_at) BETWEEN ? AND ?
         AND status IN ('allocated','worked')
         AND id NOT IN (SELECT COALESCE(shift_id,'') FROM timesheet_lines WHERE timesheet_id = ?)
       ORDER BY starts_at ASC`,
    )
    .all(ts.assignment_id, ts.worker_id, from, ts.week_ending, timesheetId) as any[];

  for (const s of shifts) {
    addLine(db, timesheetId, {
      shiftId: s.id,
      workDate: s.starts_at.slice(0, 10),
      startTime: s.starts_at.slice(11, 16),
      endTime: s.ends_at.slice(11, 16),
      breakMinutes: s.break_minutes,
    });
  }

  return shifts.length;
}

export interface ApprovalInput {
  clientSignatory: string;
  clientSignedOn: IsoDate;
  approvedBy?: string;
  /** Document id of the scanned signed sheet. Required — see below. */
  signedScanDocumentId?: string;
}

/**
 * Approving a timesheet locks its hours and makes it billable.
 *
 * The signed scan is required by default. Billing from an unsigned timesheet is
 * how agencies end up unable to defend a disputed invoice, so the app makes the
 * scan the norm and the exception explicit and audited.
 */
export function approveTimesheet(
  db: Db,
  timesheetId: string,
  input: ApprovalInput,
  opts: { allowMissingScan?: boolean; missingScanReason?: string } = {},
): void {
  const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(timesheetId) as any;
  if (!ts) throw new Error('Timesheet not found');
  if (ts.status === 'invoiced') throw new Error('This timesheet has already been invoiced.');
  if (ts.status === 'approved') throw new Error('This timesheet is already approved.');

  const lineCount = db
    .prepare('SELECT COUNT(*) AS n FROM timesheet_lines WHERE timesheet_id = ?')
    .get(timesheetId) as any;
  if (lineCount.n === 0) throw new Error('Cannot approve a timesheet with no hours on it.');

  const scan =
    input.signedScanDocumentId ??
    (db
      .prepare(
        `SELECT id FROM documents WHERE entity_type = 'timesheet' AND entity_id = ?
           AND category = 'signed_timesheet' LIMIT 1`,
      )
      .get(timesheetId) as any)?.id;

  if (!scan && !opts.allowMissingScan) {
    throw new Error(
      'No signed timesheet scan is attached. Attach the signed paper sheet, or approve with an ' +
        'explicit reason recorded for the missing scan.',
    );
  }

  db.prepare(
    `UPDATE timesheets SET status = 'approved', client_signatory = ?, client_signed_on = ?,
       approved_by = ?, approved_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.clientSignatory,
    input.clientSignedOn,
    input.approvedBy ?? process.env.USER ?? 'operator',
    nowInstant(),
    nowInstant(),
    timesheetId,
  );

  recordAudit(db, {
    entityType: 'timesheet',
    entityId: timesheetId,
    action: 'approved',
    summary:
      `Timesheet ${ts.reference} approved — signed by ${input.clientSignatory} on ${input.clientSignedOn}` +
      (scan ? '' : ` (NO SIGNED SCAN: ${opts.missingScanReason ?? 'no reason given'})`),
    after: { ...input, scanDocumentId: scan ?? null, missingScanReason: opts.missingScanReason },
  });

  // Mark the underlying shifts as worked so the AWR clock and reports are right.
  const shiftIds = db
    .prepare('SELECT shift_id FROM timesheet_lines WHERE timesheet_id = ? AND shift_id IS NOT NULL')
    .all(timesheetId) as Array<{ shift_id: string }>;
  const markWorked = db.prepare(
    `UPDATE shifts SET status = 'worked', updated_at = ? WHERE id = ? AND status = 'allocated'`,
  );
  for (const { shift_id } of shiftIds) markWorked.run(nowInstant(), shift_id);

  recalculateAwr(db, ts.worker_id, ts.assignment_id);
}

export function reopenTimesheet(db: Db, timesheetId: string, reason: string): void {
  const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(timesheetId) as any;
  if (!ts) throw new Error('Timesheet not found');
  if (ts.status === 'invoiced') {
    throw new Error(
      'This timesheet has been invoiced. Credit the invoice first, then the timesheet can be reopened.',
    );
  }

  db.prepare(`UPDATE timesheets SET status = 'draft', approved_at = NULL, updated_at = ? WHERE id = ?`)
    .run(nowInstant(), timesheetId);

  recordAudit(db, {
    entityType: 'timesheet',
    entityId: timesheetId,
    action: 'reopened',
    summary: `Timesheet ${ts.reference} reopened: ${reason}`,
    before: { status: ts.status },
  });
}

export function disputeTimesheet(db: Db, timesheetId: string, reason: string): void {
  const ts = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(timesheetId) as any;
  if (!ts) throw new Error('Timesheet not found');

  db.prepare(`UPDATE timesheets SET status = 'disputed', dispute_reason = ?, updated_at = ? WHERE id = ?`)
    .run(reason, nowInstant(), timesheetId);

  recordAudit(db, {
    entityType: 'timesheet',
    entityId: timesheetId,
    action: 'disputed',
    summary: `Timesheet ${ts.reference} marked disputed: ${reason}`,
  });
}

/** Approved but not yet invoiced — the money you have earned and not asked for. */
export function unbilledTimesheets(db: Db, clientOrgId?: string) {
  const sql = `
    SELECT t.*, a.title AS assignment_title, a.client_org_id,
           o.name AS client_name, w.first_name, w.last_name,
           (SELECT COUNT(*) FROM documents d
             WHERE d.entity_type = 'timesheet' AND d.entity_id = t.id
               AND d.category = 'signed_timesheet') AS scan_count
    FROM timesheets t
    JOIN assignments a ON a.id = t.assignment_id
    JOIN organisations o ON o.id = a.client_org_id
    JOIN workers w ON w.id = t.worker_id
    WHERE t.status = 'approved'
      ${clientOrgId ? 'AND a.client_org_id = ?' : ''}
    ORDER BY t.week_ending ASC, o.name ASC`;

  const rows = clientOrgId
    ? (db.prepare(sql).all(clientOrgId) as any[])
    : (db.prepare(sql).all() as any[]);

  return rows.map((r) => ({
    ...r,
    marginPence: r.charge_total_pence - r.pay_total_pence,
    holidayAccrualPence: holidayAccrualPence(r.pay_total_pence),
  }));
}

export function timesheetWithLines(db: Db, timesheetId: string) {
  const ts = db
    .prepare(
      `SELECT t.*, a.title AS assignment_title, o.name AS client_name,
              w.first_name, w.last_name, w.engagement_type
       FROM timesheets t
       JOIN assignments a ON a.id = t.assignment_id
       JOIN organisations o ON o.id = a.client_org_id
       JOIN workers w ON w.id = t.worker_id
       WHERE t.id = ?`,
    )
    .get(timesheetId) as any;
  if (!ts) return null;

  const lines = db
    .prepare('SELECT * FROM timesheet_lines WHERE timesheet_id = ? ORDER BY work_date, start_time')
    .all(timesheetId) as any[];

  const documents = db
    .prepare(`SELECT * FROM documents WHERE entity_type = 'timesheet' AND entity_id = ?`)
    .all(timesheetId) as any[];

  return {
    ...ts,
    lines,
    documents,
    marginPence: ts.charge_total_pence - ts.pay_total_pence,
    holidayAccrualPence: holidayAccrualPence(ts.pay_total_pence),
  };
}
