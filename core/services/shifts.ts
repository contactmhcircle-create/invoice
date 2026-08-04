import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { checkWorker, recalculateAwr, checkNmw } from './compliance.js';
import type { ComplianceFinding } from './compliance.js';
import { resolveRate, determineBand, marginOf } from './rates.js';
import { chargeFor } from '../../shared/money.js';
import { nowInstant, workedMinutes, today } from '../../shared/dates.js';

/**
 * Shifts and allocation.
 *
 * The rule that matters: a worker cannot be allocated to a shift they are not
 * compliant to work on the date that shift runs. Compliance is evaluated against
 * the shift date, not today, so a rota extending past a licence expiry is caught
 * when it is built rather than when the licence lapses.
 */

export interface CreateShiftInput {
  assignmentId: string;
  siteId?: string | null;
  startsAt: string;
  endsAt: string;
  breakMinutes?: number;
  isBankHoliday?: boolean;
  workerId?: string | null;
  chargeRateOverridePence?: number | null;
  payRateOverridePence?: number | null;
  notes?: string;
}

export function createShift(db: Db, input: CreateShiftInput): string {
  const assignment = db
    .prepare('SELECT * FROM assignments WHERE id = ?')
    .get(input.assignmentId) as any;
  if (!assignment) throw new Error('Assignment not found');

  const id = newId('shift');
  const now = nowInstant();
  const band = determineBand(
    input.startsAt,
    input.endsAt,
    input.isBankHoliday ?? false,
    !!assignment.use_rate_bands,
  );

  const rate = resolveRate(db, {
    assignmentId: input.assignmentId,
    siteId: input.siteId ?? assignment.site_id,
    clientOrgId: assignment.client_org_id,
    band,
    on: input.startsAt.slice(0, 10),
    chargeOverridePence: input.chargeRateOverridePence,
    payOverridePence: input.payRateOverridePence,
  });

  db.prepare(
    `INSERT INTO shifts
       (id, assignment_id, site_id, worker_id, starts_at, ends_at, break_minutes, band,
        is_bank_holiday, charge_rate_pence, pay_rate_pence, rate_source,
        charge_rate_override_pence, pay_rate_override_pence, status, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.assignmentId,
    input.siteId ?? assignment.site_id,
    null, // allocation happens separately, so it always runs the compliance gate
    input.startsAt,
    input.endsAt,
    input.breakMinutes ?? 0,
    band,
    input.isBankHoliday ? 1 : 0,
    rate?.chargeRatePence ?? null,
    rate?.payRatePence ?? null,
    rate?.source ?? 'No rate found',
    input.chargeRateOverridePence ?? null,
    input.payRateOverridePence ?? null,
    'planned',
    input.notes ?? null,
    now,
    now,
  );

  recordAudit(db, {
    entityType: 'shift',
    entityId: id,
    action: 'created',
    summary: `Shift created ${input.startsAt} – ${input.endsAt} on ${assignment.title}`,
    after: { ...input, band, rate },
  });

  if (input.workerId) allocateWorker(db, id, input.workerId);
  return id;
}

export interface AllocationCheck {
  allowed: boolean;
  blockers: ComplianceFinding[];
  warnings: ComplianceFinding[];
  clashes: Array<{ shiftId: string; startsAt: string; endsAt: string; assignment: string }>;
  nmw?: ReturnType<typeof checkNmw>;
}

/**
 * Evaluates whether a worker may be placed on a shift, without changing anything.
 * The UI calls this as the operator picks a worker, so the reason a name is
 * greyed out is visible before they click.
 */
export function checkAllocation(db: Db, shiftId: string, workerId: string): AllocationCheck {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!shift) throw new Error('Shift not found');

  const assignment = db
    .prepare('SELECT * FROM assignments WHERE id = ?')
    .get(shift.assignment_id) as any;

  const shiftDate = shift.starts_at.slice(0, 10);
  const report = checkWorker(db, workerId, shiftDate, assignment?.required_licence_sector);

  // Overlapping shifts for the same worker. A worker cannot be in two places at
  // once, and double-booking is the most common rota error.
  const clashes = db
    .prepare(
      `SELECT s.id AS shiftId, s.starts_at AS startsAt, s.ends_at AS endsAt, a.title AS assignment
       FROM shifts s
       JOIN assignments a ON a.id = s.assignment_id
       WHERE s.worker_id = ?
         AND s.id <> ?
         AND s.status IN ('planned','allocated','worked')
         AND s.starts_at < ?
         AND s.ends_at > ?`,
    )
    .all(workerId, shiftId, shift.ends_at, shift.starts_at) as any[];

  const blockers = [...report.blockers];
  if (clashes.length > 0) {
    blockers.push({
      code: 'SHIFT_CLASH',
      severity: 'blocker',
      title: `Worker is already booked on ${clashes.length} overlapping shift${clashes.length === 1 ? '' : 's'}`,
      detail: clashes
        .map((c) => `${c.assignment}: ${c.startsAt.slice(11, 16)}–${c.endsAt.slice(11, 16)} on ${c.startsAt.slice(0, 10)}`)
        .join('; '),
      action: 'Release the clashing shift, or allocate a different worker.',
    });
  }

  // National Minimum Wage on the resolved pay rate.
  let nmw;
  if (shift.pay_rate_pence != null) {
    nmw = checkNmw(db, workerId, shift.pay_rate_pence, shiftDate);
    if (!nmw.ok) {
      blockers.push({
        code: 'NMW_BREACH',
        severity: 'blocker',
        title: 'Pay rate is below the National Minimum Wage',
        detail:
          `The resolved pay rate is £${(nmw.actualPence / 100).toFixed(2)}/hour but the ` +
          `${nmw.band?.replace(/_/g, ' ')} minimum on ${shiftDate} is £${((nmw.requiredPence ?? 0) / 100).toFixed(2)}/hour ` +
          `— a shortfall of £${(nmw.shortfallPence / 100).toFixed(2)}/hour.`,
        action:
          'Raise the pay rate. NMW penalties reach 200% of the underpayment and HMRC publishes the names of employers who breach it.',
      });
    }
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    warnings: report.warnings,
    clashes,
    nmw,
  };
}

export interface AllocateOptions {
  /**
   * Records a deliberate override of a warning. Blockers can never be overridden
   * — that is what makes them blockers.
   */
  acknowledgeWarnings?: boolean;
  reason?: string;
}

export function allocateWorker(
  db: Db,
  shiftId: string,
  workerId: string,
  opts: AllocateOptions = {},
): AllocationCheck {
  const check = checkAllocation(db, shiftId, workerId);

  if (!check.allowed) {
    const reasons = check.blockers.map((b) => `• ${b.title}: ${b.detail}`).join('\n');
    throw new Error(`This worker cannot be allocated to this shift.\n\n${reasons}`);
  }

  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  const assignment = db
    .prepare('SELECT * FROM assignments WHERE id = ?')
    .get(shift.assignment_id) as any;

  // Re-resolve in case the worker carries a different pay rate to the default.
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId) as any;
  const payOverride =
    shift.pay_rate_override_pence ?? (shift.pay_rate_pence == null ? worker?.default_pay_rate_pence : null);

  const rate = resolveRate(db, {
    assignmentId: shift.assignment_id,
    siteId: shift.site_id,
    clientOrgId: assignment.client_org_id,
    band: shift.band,
    on: shift.starts_at.slice(0, 10),
    chargeOverridePence: shift.charge_rate_override_pence,
    payOverridePence: payOverride,
  });

  db.prepare(
    `UPDATE shifts SET worker_id = ?, status = 'allocated',
       charge_rate_pence = COALESCE(?, charge_rate_pence),
       pay_rate_pence = COALESCE(?, pay_rate_pence),
       rate_source = COALESCE(?, rate_source),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    workerId,
    rate?.chargeRatePence ?? null,
    rate?.payRatePence ?? null,
    rate?.source ?? null,
    nowInstant(),
    shiftId,
  );

  recordAudit(db, {
    entityType: 'shift',
    entityId: shiftId,
    action: 'allocated',
    summary:
      `${worker.first_name} ${worker.last_name} allocated to ${assignment.title} on ${shift.starts_at.slice(0, 10)}` +
      (check.warnings.length ? ` (${check.warnings.length} warning(s) acknowledged)` : ''),
    after: {
      workerId,
      warnings: check.warnings.map((w) => w.code),
      acknowledged: !!opts.acknowledgeWarnings,
      reason: opts.reason,
      rate,
    },
  });

  recalculateAwr(db, workerId, shift.assignment_id);
  return check;
}

export function releaseWorker(db: Db, shiftId: string, reason: string): void {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!shift) throw new Error('Shift not found');
  if (shift.status === 'worked') {
    throw new Error('This shift has already been worked and cannot be unallocated. Mark it as an adjustment instead.');
  }

  db.prepare(`UPDATE shifts SET worker_id = NULL, status = 'planned', updated_at = ? WHERE id = ?`)
    .run(nowInstant(), shiftId);

  recordAudit(db, {
    entityType: 'shift',
    entityId: shiftId,
    action: 'released',
    summary: `Worker released from shift: ${reason}`,
    before: { workerId: shift.worker_id },
  });

  if (shift.worker_id) recalculateAwr(db, shift.worker_id, shift.assignment_id);
}

export function markShiftStatus(
  db: Db,
  shiftId: string,
  status: 'worked' | 'no_show' | 'cancelled',
  opts: { reason?: string; actualStartAt?: string; actualEndAt?: string; actualBreakMinutes?: number } = {},
): void {
  const before = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!before) throw new Error('Shift not found');

  db.prepare(
    `UPDATE shifts SET status = ?, cancellation_reason = ?,
       actual_start_at = COALESCE(?, actual_start_at),
       actual_end_at = COALESCE(?, actual_end_at),
       actual_break_minutes = COALESCE(?, actual_break_minutes),
       updated_at = ?
     WHERE id = ?`,
  ).run(
    status,
    opts.reason ?? null,
    opts.actualStartAt ?? null,
    opts.actualEndAt ?? null,
    opts.actualBreakMinutes ?? null,
    nowInstant(),
    shiftId,
  );

  recordAudit(db, {
    entityType: 'shift',
    entityId: shiftId,
    action: `marked_${status}`,
    summary: `Shift marked ${status}${opts.reason ? `: ${opts.reason}` : ''}`,
    before: { status: before.status },
    after: { status, ...opts },
  });

  if (before.worker_id) recalculateAwr(db, before.worker_id, before.assignment_id);
}

/** Records a replacement worker on a no-show, keeping both shifts in the record. */
export function replaceShift(db: Db, shiftId: string, replacementWorkerId: string, reason: string): string {
  const original = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!original) throw new Error('Shift not found');

  const replacementId = createShift(db, {
    assignmentId: original.assignment_id,
    siteId: original.site_id,
    startsAt: original.starts_at,
    endsAt: original.ends_at,
    breakMinutes: original.break_minutes,
    isBankHoliday: !!original.is_bank_holiday,
    notes: `Replacement for shift ${shiftId}: ${reason}`,
  });

  allocateWorker(db, replacementId, replacementWorkerId, { reason });

  db.prepare(`UPDATE shifts SET status = 'replaced', replaced_by_shift_id = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?`)
    .run(replacementId, reason, nowInstant(), shiftId);

  recordAudit(db, {
    entityType: 'shift',
    entityId: shiftId,
    action: 'replaced',
    summary: `Shift replaced by ${replacementId}: ${reason}`,
    after: { replacementId, replacementWorkerId },
  });

  return replacementId;
}

/** Value of a shift: what it bills, what it costs, and the margin between. */
export function shiftValue(db: Db, shiftId: string) {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
  if (!s) throw new Error('Shift not found');

  const assignment = db.prepare('SELECT * FROM assignments WHERE id = ?').get(s.assignment_id) as any;
  const minutes = workedMinutes(
    s.actual_start_at ?? s.starts_at,
    s.actual_end_at ?? s.ends_at,
    s.actual_break_minutes ?? s.break_minutes,
  );

  // A minimum shift charge bills a floor number of hours regardless of the hours
  // actually worked — common on callouts.
  const billedMinutes = assignment?.min_shift_minutes
    ? Math.max(minutes, assignment.min_shift_minutes)
    : minutes;

  const chargePence = chargeFor(billedMinutes, s.charge_rate_pence ?? 0);
  const payPence = chargeFor(minutes, s.pay_rate_pence ?? 0);

  return {
    shiftId,
    workedMinutes: minutes,
    billedMinutes,
    chargeRatePence: s.charge_rate_pence ?? 0,
    payRatePence: s.pay_rate_pence ?? 0,
    chargePence,
    payPence,
    ...marginOf(chargePence, payPence),
    rateSource: s.rate_source,
  };
}

export function fillRate(db: Db, assignmentId: string, from: string, to: string) {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN worker_id IS NOT NULL AND status IN ('allocated','worked') THEN 1 ELSE 0 END) AS filled,
         SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS noShows
       FROM shifts
       WHERE assignment_id = ? AND date(starts_at) BETWEEN ? AND ?
         AND status <> 'replaced'`,
    )
    .get(assignmentId, from, to) as any;

  const total = row.total ?? 0;
  return {
    total,
    filled: row.filled ?? 0,
    unfilled: total - (row.filled ?? 0),
    noShows: row.noShows ?? 0,
    fillRatePercent: total > 0 ? Math.round(((row.filled ?? 0) / total) * 1000) / 10 : 0,
  };
}

/** Workers who could legally cover a given shift, with their warnings attached. */
export function eligibleWorkers(db: Db, shiftId: string) {
  const candidates = db
    .prepare(`SELECT id, first_name, last_name FROM workers WHERE status = 'active' ORDER BY last_name`)
    .all() as any[];

  return candidates.map((w) => {
    let check: AllocationCheck;
    try {
      check = checkAllocation(db, shiftId, w.id);
    } catch {
      check = { allowed: false, blockers: [], warnings: [], clashes: [] };
    }
    return {
      workerId: w.id,
      name: `${w.first_name} ${w.last_name}`,
      eligible: check.allowed,
      blockers: check.blockers,
      warnings: check.warnings,
    };
  });
}
