import type { Db } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { nowInstant } from '../../shared/dates.js';

/**
 * Deleting records in a system built to survive an HMRC enquiry.
 *
 * The rule: a record that never entered the paper trail — a duplicate client
 * added twice, a worker who never worked, a shift nobody was allocated to —
 * can be deleted outright, and the append-only audit log keeps a snapshot of
 * what was removed and by whom. A record with history behind it (invoiced
 * work, worked shifts, payments) is refused with a message saying exactly
 * what stands in the way, because deleting it would put a hole in the story
 * the books tell. Those records are closed or voided instead, never erased.
 */

/** Human-readable count of blocking references, or null when clear. */
function blockingReferences(db: Db, checks: Array<[string, string, string]>, id: string): string | null {
  const found: string[] = [];
  for (const [table, column, label] of checks) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id) as any).n;
    if (n > 0) found.push(`${n} ${label}${n === 1 ? '' : 's'}`);
  }
  return found.length ? found.join(', ') : null;
}

function purgeDocuments(db: Db, entityType: string, entityId: string): void {
  db.prepare('DELETE FROM documents WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
}

export function deleteOrganisation(db: Db, orgId: string, actor = 'system'): void {
  const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(orgId) as any;
  if (!org) throw new Error('Organisation not found');

  const blocking = blockingReferences(db, [
    ['sites', 'organisation_id', 'site'],
    ['workers', 'umbrella_org_id', 'worker paid via this umbrella'],
    ['assignments', 'client_org_id', 'assignment'],
    ['invoices', 'client_org_id', 'invoice'],
    ['credit_notes', 'client_org_id', 'credit note'],
    ['payments', 'organisation_id', 'payment'],
    ['purchase_invoices', 'organisation_id', 'purchase invoice'],
    ['self_bills', 'organisation_id', 'self-bill'],
    ['supply_chain_links', 'organisation_id', 'supply chain link'],
  ], orgId);
  if (blocking) {
    throw new Error(
      `${org.name} cannot be deleted — it has ${blocking} on record. ` +
      'Records with history are kept for the audit trail: set the organisation to closed instead.',
    );
  }

  db.prepare('DELETE FROM org_due_diligence WHERE organisation_id = ?').run(orgId);
  db.prepare(`DELETE FROM rates WHERE scope = 'client' AND scope_id = ?`).run(orgId);
  purgeDocuments(db, 'organisation', orgId);
  db.prepare('DELETE FROM organisations WHERE id = ?').run(orgId);

  recordAudit(db, {
    entityType: 'organisation', entityId: orgId, action: 'deleted',
    summary: `Organisation deleted: ${org.name} (no linked records)`, actor, before: org,
  });
}

export function deleteWorker(db: Db, workerId: string, actor = 'system'): void {
  const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId) as any;
  if (!w) throw new Error('Worker not found');

  const blocking = blockingReferences(db, [
    ['shifts', 'worker_id', 'shift'],
    ['timesheets', 'worker_id', 'timesheet'],
    ['invoice_lines', 'worker_id', 'invoice line'],
  ], workerId);
  if (blocking) {
    throw new Error(
      `${w.first_name} ${w.last_name} cannot be deleted — they have ${blocking} on record. ` +
      'Worked history is kept for the audit trail: mark the worker as left instead.',
    );
  }

  // Vetting records go with the worker (they cascade); evidence scans do not
  // cascade, so remove them explicitly.
  purgeDocuments(db, 'worker', workerId);
  db.prepare('DELETE FROM workers WHERE id = ?').run(workerId);

  recordAudit(db, {
    entityType: 'worker', entityId: workerId, action: 'deleted',
    summary: `Worker deleted: ${w.first_name} ${w.last_name} (${w.reference ?? 'no reference'}, never worked a shift)`,
    actor, before: w,
  });
}

export function deleteSite(db: Db, siteId: string, actor = 'system'): void {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId) as any;
  if (!site) throw new Error('Site not found');

  const blocking = blockingReferences(db, [
    ['assignments', 'site_id', 'assignment'],
    ['shifts', 'site_id', 'shift'],
  ], siteId);
  if (blocking) {
    throw new Error(`${site.name} cannot be deleted — it has ${blocking} linked. Set it to closed instead.`);
  }

  db.prepare(`DELETE FROM rates WHERE scope = 'site' AND scope_id = ?`).run(siteId);
  db.prepare('DELETE FROM sites WHERE id = ?').run(siteId);
  recordAudit(db, {
    entityType: 'site', entityId: siteId, action: 'deleted',
    summary: `Site deleted: ${site.name}`, actor, before: site,
  });
}

export function deleteAssignment(db: Db, assignmentId: string, actor = 'system'): void {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId) as any;
  if (!a) throw new Error('Assignment not found');

  // Shifts would cascade away silently — refuse instead, so rota history is
  // never lost as a side effect.
  const blocking = blockingReferences(db, [
    ['shifts', 'assignment_id', 'shift'],
    ['timesheets', 'assignment_id', 'timesheet'],
    ['invoices', 'assignment_id', 'invoice'],
  ], assignmentId);
  if (blocking) {
    throw new Error(
      `${a.title} cannot be deleted — it has ${blocking} on record. ` +
      'Delete its planned shifts from the rota first, or set the assignment to ended.',
    );
  }

  db.prepare(`DELETE FROM rates WHERE scope = 'assignment' AND scope_id = ?`).run(assignmentId);
  db.prepare('DELETE FROM supply_chain_links WHERE assignment_id = ?').run(assignmentId);
  db.prepare('DELETE FROM assignments WHERE id = ?').run(assignmentId);
  recordAudit(db, {
    entityType: 'assignment', entityId: assignmentId, action: 'deleted',
    summary: `Assignment deleted: ${a.title} (no shifts ever rostered)`, actor, before: a,
  });
}

export function deleteShift(db: Db, shiftId: string, actor = 'system'): void {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!s) throw new Error('Shift not found');

  if (!['planned', 'allocated', 'cancelled'].includes(s.status)) {
    throw new Error(
      `A ${s.status.replace(/_/g, ' ')} shift is part of the worked record and cannot be deleted.`,
    );
  }
  const onTimesheet = (db.prepare('SELECT COUNT(*) AS n FROM timesheet_lines WHERE shift_id = ?')
    .get(shiftId) as any).n;
  if (onTimesheet > 0) {
    throw new Error('This shift is on a timesheet. Remove the timesheet line first.');
  }

  purgeDocuments(db, 'shift', shiftId);
  db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);
  recordAudit(db, {
    entityType: 'shift', entityId: shiftId, action: 'deleted',
    summary: `Shift deleted: ${s.starts_at}–${s.ends_at} (${s.status}, never worked)`, actor, before: s,
  });
}

export function deleteTimesheet(db: Db, timesheetId: string, actor = 'system'): void {
  const t = db.prepare('SELECT * FROM timesheets WHERE id = ?').get(timesheetId) as any;
  if (!t) throw new Error('Timesheet not found');

  if (t.status !== 'draft') {
    throw new Error(
      `A ${t.status} timesheet cannot be deleted — it is part of the billing record. ` +
      (t.status === 'approved' ? 'Reopen it first if it was approved by mistake.' : ''),
    );
  }
  const billed = (db.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE timesheet_id = ?')
    .get(timesheetId) as any).n;
  if (billed > 0) throw new Error('This timesheet is on an invoice. Remove it from the draft invoice first.');

  db.prepare('DELETE FROM timesheet_lines WHERE timesheet_id = ?').run(timesheetId);
  purgeDocuments(db, 'timesheet', timesheetId);
  db.prepare('DELETE FROM timesheets WHERE id = ?').run(timesheetId);
  recordAudit(db, {
    entityType: 'timesheet', entityId: timesheetId, action: 'deleted',
    summary: `Draft timesheet ${t.reference} deleted (never approved)`, actor, before: t,
  });
}

export function deleteDraftInvoice(db: Db, invoiceId: string, actor = 'system'): void {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
  if (!inv) throw new Error('Invoice not found');

  if (inv.status !== 'draft' || inv.number) {
    throw new Error(
      'Only unissued drafts can be deleted. An issued invoice holds a number in the gapless ' +
      'series — void it instead, and it stays on record.',
    );
  }

  // Give the timesheets back to the unbilled list before the lines cascade away.
  db.prepare('UPDATE timesheets SET invoice_id = NULL, updated_at = ? WHERE invoice_id = ?')
    .run(nowInstant(), invoiceId);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(invoiceId);
  recordAudit(db, {
    entityType: 'invoice', entityId: invoiceId, action: 'deleted',
    summary: 'Draft invoice deleted before issue (no number was ever allocated)', actor, before: inv,
  });
}
