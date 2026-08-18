import { describe, it, expect } from 'vitest';
import { freshDb, makeOrg, makeWorker, makeAssignment } from './helpers.js';
import { newId } from '../core/db/connection.js';
import { nowInstant, addDays, today } from '../shared/dates.js';
import {
  deleteOrganisation,
  deleteWorker,
  deleteAssignment,
  deleteShift,
  deleteTimesheet,
  deleteDraftInvoice,
} from '../core/services/deletion.js';
import { createShift, allocateWorker } from '../core/services/shifts.js';
import {
  createTimesheet, populateFromShifts, approveTimesheet, unbilledTimesheets,
} from '../core/services/timesheets.js';
import { createInvoiceFromTimesheets, createManualInvoice, addManualLine, issueInvoice } from '../core/services/invoices.js';

/** An approved, scan-backed timesheet ready to invoice. */
function workedWeek(db: any) {
  const client = makeOrg(db, { name: 'History Ltd' });
  const assignment = makeAssignment(db, client);
  const worker = makeWorker(db);
  const date = addDays(today(), -7);
  const shift = createShift(db, {
    assignmentId: assignment, startsAt: `${date}T08:00:00`, endsAt: `${date}T16:00:00`,
  });
  allocateWorker(db, shift, worker);
  const ts = createTimesheet(db, { assignmentId: assignment, workerId: worker, workDate: date });
  populateFromShifts(db, ts);
  db.prepare(
    `INSERT INTO documents (id, entity_type, entity_id, category, filename, stored_path, sha256, uploaded_at)
     VALUES (?, 'timesheet', ?, 'signed_timesheet', 's.pdf', '/tmp/s.pdf', 'x', ?)`,
  ).run(newId('doc'), ts, nowInstant());
  approveTimesheet(db, ts, { clientSignatory: 'Mgr', clientSignedOn: today() });
  return { client, assignment, worker, timesheet: ts, shift };
}

describe('Deleting records without history', () => {
  it('deletes a duplicate organisation and keeps a snapshot in the audit trail', () => {
    const db = freshDb();
    const dupe = makeOrg(db, { name: 'Hawk Security Group Ltd' });

    deleteOrganisation(db, dupe, 'usr_test');
    expect(db.prepare('SELECT COUNT(*) AS n FROM organisations WHERE id = ?').get(dupe)).toMatchObject({ n: 0 });

    const audit = db.prepare(
      `SELECT summary, before_json FROM audit_log WHERE entity_id = ? AND action = 'deleted'`,
    ).get(dupe) as any;
    expect(audit.summary).toContain('Hawk Security Group Ltd');
    expect(JSON.parse(audit.before_json).name).toBe('Hawk Security Group Ltd');
  });

  it('deletes a never-worked worker together with their vetting records', () => {
    const db = freshDb();
    const worker = makeWorker(db, { firstName: 'Never', lastName: 'Worked' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM screening_checks WHERE worker_id = ?').get(worker) as any).n).toBe(6);

    deleteWorker(db, worker);
    expect((db.prepare('SELECT COUNT(*) AS n FROM workers WHERE id = ?').get(worker) as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM screening_checks WHERE worker_id = ?').get(worker) as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM worker_licences WHERE worker_id = ?').get(worker) as any).n).toBe(0);
  });

  it('deletes an unworked planned shift and an empty assignment', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const date = addDays(today(), 5);
    const shift = createShift(db, {
      assignmentId: assignment, startsAt: `${date}T08:00:00`, endsAt: `${date}T16:00:00`,
    });

    // Assignment first refuses while the shift exists…
    expect(() => deleteAssignment(db, assignment)).toThrow(/1 shift/);
    // …then both go, shift first.
    deleteShift(db, shift);
    deleteAssignment(db, assignment);
    expect((db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE id = ?').get(assignment) as any).n).toBe(0);
  });

  it('deletes a draft invoice and returns its timesheets to the unbilled list', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    expect(unbilledTimesheets(db)).toHaveLength(0);

    deleteDraftInvoice(db, invoice);
    expect((db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE id = ?').get(invoice) as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ?').get(invoice) as any).n).toBe(0);
    expect(unbilledTimesheets(db)).toHaveLength(1);
  });
});

describe('Refusing deletions that would break the paper trail', () => {
  it('refuses an organisation with invoices, naming what stands in the way', () => {
    const db = freshDb();
    const { client } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, {
      clientOrgId: client,
      timesheetIds: [(db.prepare('SELECT id FROM timesheets').get() as any).id],
    });
    issueInvoice(db, invoice);

    expect(() => deleteOrganisation(db, client)).toThrow(/1 assignment.*1 invoice|1 invoice/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM organisations WHERE id = ?').get(client) as any).n).toBe(1);
  });

  it('refuses a worker with shifts on record', () => {
    const db = freshDb();
    const { worker } = workedWeek(db);
    expect(() => deleteWorker(db, worker)).toThrow(/shift.*mark the worker as left/is);
  });

  it('refuses a worked shift and a shift already on a timesheet', () => {
    const db = freshDb();
    const { shift } = workedWeek(db);
    // Worked and on a timesheet — refused for the status alone.
    expect(() => deleteShift(db, shift)).toThrow(/worked.*cannot be deleted/i);
  });

  it('refuses an approved timesheet and an issued invoice', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    expect(() => deleteTimesheet(db, timesheet)).toThrow(/approved timesheet cannot be deleted/i);

    const manual = createManualInvoice(db, { clientOrgId: client });
    addManualLine(db, manual, { description: 'Cover', netPence: 10_000 });
    issueInvoice(db, manual);
    expect(() => deleteDraftInvoice(db, manual)).toThrow(/void it instead/i);
  });

  it('refuses a draft timesheet that sits on a draft invoice', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    // Reopening drops it back to draft but the invoice lines still reference it.
    db.prepare(`UPDATE timesheets SET status = 'draft' WHERE id = ?`).run(timesheet);
    expect(() => deleteTimesheet(db, timesheet)).toThrow(/on an invoice/i);
  });
});
