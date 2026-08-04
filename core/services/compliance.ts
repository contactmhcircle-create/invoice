import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { recordAudit } from '../db/audit.js';
import { ageAt, addDays, daysBetween, nowInstant, today, weekEnding } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * The compliance engine.
 *
 * Everything here answers one of two questions:
 *   1. Is this worker legally placeable on this shift, right now?  (blockers)
 *   2. What is about to go wrong that I should deal with this week?  (warnings)
 *
 * Blockers stop allocation. Warnings never stop anything — they surface on the
 * dashboard. The distinction matters: an app that blocks on everything gets
 * worked around, and a worked-around compliance system is worse than none.
 */

export type Severity = 'blocker' | 'warning' | 'info';

export interface ComplianceFinding {
  code: string;
  severity: Severity;
  title: string;
  detail: string;
  /** What the operator should actually do about it. */
  action?: string;
  expiresOn?: IsoDate;
  daysRemaining?: number;
}

/** BS 7858 elements. All must be satisfied before a security worker is placed. */
export const BS7858_ELEMENTS = [
  'identity',
  'address_history',
  'employment_history',
  'character_references',
  'financial_probity',
  'criminal_record',
] as const;

export const BS7858_LABELS: Record<string, string> = {
  identity: 'Identity verification',
  address_history: 'Address history (5 years)',
  employment_history: 'Employment history (5 years, gaps accounted for)',
  character_references: 'Character references obtained and verified',
  financial_probity: 'Financial probity check',
  criminal_record: 'Criminal record declaration / basic disclosure',
  qualifications: 'Qualifications verified',
  health: 'Health declaration',
};

const LICENCE_WARNING_DAYS = 60;
const RTW_WARNING_DAYS = 30;
const AWR_QUALIFYING_WEEKS = 12;
const AWR_WARNING_AT_WEEK = 10;
/** A break of 6 or more calendar weeks between assignments resets the AWR clock. */
const AWR_RESET_WEEKS = 6;
const WTR_WEEKLY_LIMIT_MINUTES = 48 * 60;

// ---------------------------------------------------------------------------
// SIA licences
// ---------------------------------------------------------------------------

export function activeLicences(db: Db, workerId: string) {
  return db
    .prepare(
      `SELECT * FROM worker_licences
       WHERE worker_id = ? AND status IN ('valid','pending')
       ORDER BY expires_on DESC`,
    )
    .all(workerId) as any[];
}

/**
 * A licence must be valid on the date the shift is worked — not merely valid
 * today. Placing an officer on a rota that runs past their expiry date is the
 * single most expensive mistake available in this industry, so it is a hard
 * blocker rather than a warning.
 */
export function licenceValidOn(db: Db, workerId: string, date: IsoDate, sector?: string | null) {
  const licences = activeLicences(db, workerId).filter((l) => l.status === 'valid');
  const matching = sector ? licences.filter((l) => l.sector === sector) : licences;
  return matching.find((l) => l.expires_on >= date) ?? null;
}

// ---------------------------------------------------------------------------
// Right to work
// ---------------------------------------------------------------------------

export function latestRtw(db: Db, workerId: string) {
  return db
    .prepare('SELECT * FROM worker_rtw WHERE worker_id = ? ORDER BY checked_on DESC LIMIT 1')
    .get(workerId) as any | undefined;
}

// ---------------------------------------------------------------------------
// National Minimum Wage
// ---------------------------------------------------------------------------

export function nmwBandFor(dateOfBirth: IsoDate | null, at: IsoDate, isApprentice = false):
  | '21_and_over' | '18_to_20' | 'under_18' | 'apprentice' | null {
  if (isApprentice) return 'apprentice';
  if (!dateOfBirth) return null;
  const age = ageAt(dateOfBirth, at);
  if (age >= 21) return '21_and_over';
  if (age >= 18) return '18_to_20';
  return 'under_18';
}

export function nmwRatePence(db: Db, band: string, at: IsoDate): number | null {
  const row = db
    .prepare(
      `SELECT rate_pence FROM nmw_rates
       WHERE band = ? AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(band, at) as { rate_pence: number } | undefined;
  return row?.rate_pence ?? null;
}

export interface NmwCheck {
  ok: boolean;
  band: string | null;
  requiredPence: number | null;
  actualPence: number;
  shortfallPence: number;
}

export function checkNmw(db: Db, workerId: string, payRatePence: number, at: IsoDate): NmwCheck {
  const worker = db.prepare('SELECT date_of_birth FROM workers WHERE id = ?').get(workerId) as any;
  const band = nmwBandFor(worker?.date_of_birth ?? null, at);
  if (!band) {
    return { ok: true, band: null, requiredPence: null, actualPence: payRatePence, shortfallPence: 0 };
  }
  const required = nmwRatePence(db, band, at);
  if (required === null) {
    return { ok: true, band, requiredPence: null, actualPence: payRatePence, shortfallPence: 0 };
  }
  const shortfall = Math.max(0, required - payRatePence);
  return { ok: shortfall === 0, band, requiredPence: required, actualPence: payRatePence, shortfallPence: shortfall };
}

// ---------------------------------------------------------------------------
// Agency Workers Regulations — the 12-week qualifying clock
// ---------------------------------------------------------------------------

/**
 * Recomputes the AWR clock for a worker on an assignment from their worked
 * shifts. A calendar week in which any work was done is a qualifying week; a
 * gap of 6 or more weeks resets the count to zero.
 *
 * At 12 qualifying weeks the worker becomes entitled to the same basic pay and
 * conditions as a comparable direct employee of the hirer. Reaching that point
 * without noticing is a tribunal claim, so the dashboard warns from week 10.
 */
export function recalculateAwr(db: Db, workerId: string, assignmentId: string): number {
  const worked = db
    .prepare(
      `SELECT DISTINCT date(starts_at) AS d FROM shifts
       WHERE worker_id = ? AND assignment_id = ? AND status IN ('worked','allocated')
       ORDER BY d ASC`,
    )
    .all(workerId, assignmentId) as Array<{ d: string }>;

  const weeks = [...new Set(worked.map((r) => weekEnding(r.d)))].sort();

  db.prepare('DELETE FROM awr_weeks WHERE worker_id = ? AND assignment_id = ?')
    .run(workerId, assignmentId);

  const insert = db.prepare(
    `INSERT INTO awr_weeks (id, worker_id, assignment_id, week_ending, qualifies, cumulative, reset_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );

  let cumulative = 0;
  let previousWeek: string | null = null;
  const now = nowInstant();

  for (const week of weeks) {
    let resetReason: string | null = null;
    if (previousWeek) {
      const gapWeeks = Math.round(daysBetween(previousWeek, week) / 7);
      if (gapWeeks >= AWR_RESET_WEEKS) {
        cumulative = 0;
        resetReason = `Break of ${gapWeeks} weeks reset the qualifying clock`;
      }
    }
    cumulative++;
    insert.run(newId('awr'), workerId, assignmentId, week, 1, cumulative, resetReason, now);
    previousWeek = week;
  }

  return cumulative;
}

export function awrStatus(db: Db, workerId: string, assignmentId: string) {
  const row = db
    .prepare(
      `SELECT cumulative, week_ending FROM awr_weeks
       WHERE worker_id = ? AND assignment_id = ?
       ORDER BY week_ending DESC LIMIT 1`,
    )
    .get(workerId, assignmentId) as { cumulative: number; week_ending: string } | undefined;

  const weeks = row?.cumulative ?? 0;
  return {
    qualifyingWeeks: weeks,
    lastWeekEnding: row?.week_ending ?? null,
    hasQualified: weeks >= AWR_QUALIFYING_WEEKS,
    weeksRemaining: Math.max(0, AWR_QUALIFYING_WEEKS - weeks),
  };
}

// ---------------------------------------------------------------------------
// Working Time Regulations
// ---------------------------------------------------------------------------

/**
 * The 48-hour limit is an average over a 17-week reference period, not a hard
 * weekly cap — but a worker regularly exceeding 48 hours in a week without a
 * signed opt-out is heading for a breach, so that is what is surfaced.
 */
export function wtrWeeklyMinutes(db: Db, workerId: string, weekEndingDate: IsoDate): number {
  const from = addDays(weekEndingDate, -6);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(
          (julianday(ends_at) - julianday(starts_at)) * 24 * 60 - break_minutes
       ), 0) AS minutes
       FROM shifts
       WHERE worker_id = ? AND status IN ('worked','allocated')
         AND date(starts_at) BETWEEN ? AND ?`,
    )
    .get(workerId, from, weekEndingDate) as { minutes: number };
  return Math.round(row.minutes);
}

// ---------------------------------------------------------------------------
// Holiday pay accrual
// ---------------------------------------------------------------------------

/** 12.07% is the statutory accrual rate for irregular-hours workers. */
export const HOLIDAY_ACCRUAL_RATE = 0.1207;

export function holidayAccrualPence(payPence: number): number {
  return Math.round(payPence * HOLIDAY_ACCRUAL_RATE);
}

// ---------------------------------------------------------------------------
// The aggregate check
// ---------------------------------------------------------------------------

export interface ComplianceReport {
  workerId: string;
  workerName: string;
  atDate: IsoDate;
  findings: ComplianceFinding[];
  blockers: ComplianceFinding[];
  warnings: ComplianceFinding[];
  placeable: boolean;
}

/**
 * Full compliance picture for a worker on a given date. `requiredSector` is the
 * SIA sector the assignment demands, if any.
 */
export function checkWorker(
  db: Db,
  workerId: string,
  atDate: IsoDate = today(),
  requiredSector?: string | null,
): ComplianceReport {
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId) as any;
  if (!worker) throw new Error(`Worker ${workerId} not found`);

  const findings: ComplianceFinding[] = [];

  // --- Worker status -------------------------------------------------------
  if (worker.status === 'barred') {
    findings.push({
      code: 'WORKER_BARRED',
      severity: 'blocker',
      title: 'Worker is barred',
      detail: 'This worker has been barred and cannot be allocated to any shift.',
      action: 'Change the worker status if this is no longer correct.',
    });
  } else if (worker.status === 'left' || worker.status === 'inactive') {
    findings.push({
      code: 'WORKER_INACTIVE',
      severity: 'blocker',
      title: `Worker is marked ${worker.status}`,
      detail: 'Only active workers can be allocated to shifts.',
      action: 'Set the worker back to active to place them.',
    });
  }

  // --- SIA licence ---------------------------------------------------------
  const licences = activeLicences(db, workerId);
  const relevant = requiredSector ? licences.filter((l) => l.sector === requiredSector) : licences;

  if (relevant.length === 0) {
    findings.push({
      code: 'SIA_MISSING',
      severity: 'blocker',
      title: requiredSector ? `No ${requiredSector.replace(/_/g, ' ')} licence on file` : 'No SIA licence on file',
      detail: requiredSector
        ? `This assignment requires an SIA ${requiredSector.replace(/_/g, ' ')} licence and none is recorded for this worker.`
        : 'No SIA licence is recorded for this worker.',
      action: 'Add the licence and verify it against the SIA public register.',
    });
  } else {
    const valid = relevant.find((l) => l.status === 'valid' && l.expires_on >= atDate);
    if (!valid) {
      const mostRecent = relevant[0];
      findings.push({
        code: 'SIA_EXPIRED',
        severity: 'blocker',
        title: 'SIA licence not valid on this date',
        detail:
          mostRecent.status !== 'valid'
            ? `The licence on file is marked ${mostRecent.status}.`
            : `Licence ${mostRecent.licence_number} expired on ${mostRecent.expires_on}, before this shift date (${atDate}).`,
        action: 'Obtain and record the renewed licence before allocating this worker.',
        expiresOn: mostRecent.expires_on,
      });
    } else {
      const days = daysBetween(atDate, valid.expires_on);
      if (days <= LICENCE_WARNING_DAYS) {
        findings.push({
          code: 'SIA_EXPIRING',
          severity: 'warning',
          title: `SIA licence expires in ${days} day${days === 1 ? '' : 's'}`,
          detail: `Licence ${valid.licence_number} (${valid.sector.replace(/_/g, ' ')}) expires on ${valid.expires_on}.`,
          action: 'Start the renewal now — SIA renewals routinely take several weeks.',
          expiresOn: valid.expires_on,
          daysRemaining: days,
        });
      }
      if (!valid.verified_on) {
        findings.push({
          code: 'SIA_UNVERIFIED',
          severity: 'warning',
          title: 'Licence not verified against the SIA register',
          detail: `Licence ${valid.licence_number} has been recorded but never checked against the SIA public register.`,
          action: 'Check the number on the SIA register and record the verification date.',
        });
      }
    }
  }

  // --- Right to work -------------------------------------------------------
  const rtw = latestRtw(db, workerId);
  if (!rtw) {
    findings.push({
      code: 'RTW_MISSING',
      severity: 'blocker',
      title: 'No right to work check recorded',
      detail:
        'A right to work check must be completed before the worker starts their first shift. ' +
        'Without it there is no statutory excuse against an illegal working civil penalty.',
      action: 'Complete a share code or document check and record it before allocating.',
    });
  } else if (rtw.outcome === 'failed') {
    findings.push({
      code: 'RTW_FAILED',
      severity: 'blocker',
      title: 'Right to work check failed',
      detail: 'The recorded right to work check did not establish a right to work in the UK.',
      action: 'This worker must not be allocated to any shift.',
    });
  } else if (rtw.outcome === 'time_limited') {
    if (rtw.expires_on && rtw.expires_on < atDate) {
      findings.push({
        code: 'RTW_EXPIRED',
        severity: 'blocker',
        title: 'Right to work permission has expired',
        detail: `Time-limited permission expired on ${rtw.expires_on}, before this shift date (${atDate}).`,
        action: 'Carry out a follow-up check before this worker takes any further shift.',
        expiresOn: rtw.expires_on,
      });
    } else if (rtw.expires_on) {
      const days = daysBetween(atDate, rtw.expires_on);
      if (days <= RTW_WARNING_DAYS) {
        findings.push({
          code: 'RTW_EXPIRING',
          severity: 'warning',
          title: `Right to work expires in ${days} day${days === 1 ? '' : 's'}`,
          detail: `Time-limited permission expires on ${rtw.expires_on}.`,
          action: 'Schedule the follow-up check now.',
          expiresOn: rtw.expires_on,
          daysRemaining: days,
        });
      }
    }
    if (rtw.recheck_due_on && rtw.recheck_due_on <= atDate) {
      findings.push({
        code: 'RTW_RECHECK_DUE',
        severity: 'warning',
        title: 'Right to work re-check is due',
        detail: `A follow-up check was due on ${rtw.recheck_due_on}.`,
        action: 'Carry out the follow-up check to maintain the statutory excuse.',
      });
    }
  }

  // --- BS 7858 screening ---------------------------------------------------
  const screening = db
    .prepare('SELECT element, status, covers_from, covers_to FROM screening_checks WHERE worker_id = ?')
    .all(workerId) as any[];
  const byElement = new Map(screening.map((s) => [s.element, s]));

  const outstanding = BS7858_ELEMENTS.filter((el) => {
    const rec = byElement.get(el);
    return !rec || (rec.status !== 'satisfied' && rec.status !== 'waived');
  });

  if (outstanding.length > 0) {
    const failed = BS7858_ELEMENTS.filter((el) => byElement.get(el)?.status === 'failed');
    findings.push({
      code: failed.length > 0 ? 'BS7858_FAILED' : 'BS7858_INCOMPLETE',
      severity: 'blocker',
      title:
        failed.length > 0
          ? 'BS 7858 screening has a failed element'
          : `BS 7858 screening incomplete — ${outstanding.length} element${outstanding.length === 1 ? '' : 's'} outstanding`,
      detail: outstanding.map((el) => BS7858_LABELS[el]).join('; '),
      action:
        'Complete the outstanding screening elements. Security buyers audit this pack during procurement.',
    });
  } else {
    // Employment history must genuinely cover five years to satisfy BS 7858.
    const employment = byElement.get('employment_history');
    if (employment?.covers_from && employment?.covers_to) {
      const years = daysBetween(employment.covers_from, employment.covers_to) / 365.25;
      if (years < 4.95) {
        findings.push({
          code: 'BS7858_SHORT_HISTORY',
          severity: 'warning',
          title: 'Employment history covers less than 5 years',
          detail: `Recorded history covers ${years.toFixed(1)} years (${employment.covers_from} to ${employment.covers_to}). BS 7858 requires 5 years with all gaps accounted for.`,
          action: 'Extend the employment history record or document the gaps.',
        });
      }
    }
  }

  // --- Key Information Document -------------------------------------------
  const kid = db
    .prepare('SELECT id, issued_on FROM key_information_documents WHERE worker_id = ? ORDER BY version DESC LIMIT 1')
    .get(workerId) as any;
  if (!kid) {
    findings.push({
      code: 'KID_MISSING',
      severity: 'warning',
      title: 'No Key Information Document issued',
      detail:
        'A Key Information Document must be given to an agency worker before terms are agreed, ' +
        'under the Conduct of Employment Agencies and Employment Businesses Regulations.',
      action: 'Generate and issue the KID from the worker record.',
    });
  }

  // --- Engagement route ----------------------------------------------------
  if (worker.engagement_type === 'umbrella' && !worker.umbrella_org_id) {
    findings.push({
      code: 'UMBRELLA_MISSING',
      severity: 'blocker',
      title: 'Umbrella worker has no umbrella company recorded',
      detail:
        'This worker is set to be paid through an umbrella, but no umbrella company is linked. ' +
        'The pay chain cannot be evidenced and the invoice cannot be matched.',
      action: 'Link the umbrella company on the worker record.',
    });
  }

  if (worker.engagement_type === 'limited' || worker.engagement_type === 'self_employed') {
    if (!worker.ir35_status || worker.ir35_status === 'not_assessed') {
      findings.push({
        code: 'IR35_NOT_ASSESSED',
        severity: 'warning',
        title: 'No IR35 status determination on file',
        detail:
          'This worker is engaged off-payroll with no status determination recorded. ' +
          'Security officers working under a client’s supervision, direction and control are ' +
          'treated as employed for tax in almost all cases.',
        action: 'Complete a status determination, or move this worker onto PAYE or an umbrella.',
      });
    } else if (worker.ir35_status === 'inside') {
      findings.push({
        code: 'IR35_INSIDE',
        severity: 'warning',
        title: 'Worker assessed as inside IR35',
        detail: 'PAYE and NIC must be operated on payments to this worker.',
        action: 'Ensure deductions are being made through the correct pay route.',
      });
    }
  }

  // --- Working time --------------------------------------------------------
  const weekMinutes = wtrWeeklyMinutes(db, workerId, weekEnding(atDate));
  if (weekMinutes > WTR_WEEKLY_LIMIT_MINUTES && !worker.wtr_opt_out) {
    findings.push({
      code: 'WTR_OVER_48',
      severity: 'warning',
      title: `Scheduled ${Math.round(weekMinutes / 60)} hours this week with no 48-hour opt-out`,
      detail:
        'The Working Time Regulations limit average weekly working time to 48 hours unless the ' +
        'worker has signed an opt-out.',
      action: 'Obtain a signed opt-out, or reduce the hours allocated this week.',
    });
  }

  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return {
    workerId,
    workerName: `${worker.first_name} ${worker.last_name}`,
    atDate,
    findings,
    blockers,
    warnings,
    placeable: blockers.length === 0,
  };
}

/**
 * Ensures a worker's screening record has a row for every BS 7858 element, so
 * the UI can render the full checklist rather than only what has been started.
 */
export function ensureScreeningRows(db: Db, workerId: string): void {
  const now = nowInstant();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO screening_checks (id, worker_id, element, status, created_at, updated_at)
     VALUES (?,?,?,'not_started',?,?)`,
  );
  for (const element of BS7858_ELEMENTS) {
    stmt.run(newId('scr'), workerId, element, now, now);
  }
}

/**
 * Dashboard feed: everything expiring or overdue across the whole workforce.
 * This is the screen that stops problems rather than reporting them afterwards.
 */
export function expiringCompliance(db: Db, withinDays = 60) {
  const horizon = addDays(today(), withinDays);
  const now = today();

  const licences = db
    .prepare(
      `SELECT w.id AS worker_id, w.first_name, w.last_name, l.licence_number, l.sector, l.expires_on
       FROM worker_licences l
       JOIN workers w ON w.id = l.worker_id
       WHERE l.status = 'valid' AND l.expires_on <= ? AND w.status IN ('active','onboarding')
       ORDER BY l.expires_on ASC`,
    )
    .all(horizon) as any[];

  const rtw = db
    .prepare(
      `SELECT w.id AS worker_id, w.first_name, w.last_name, r.expires_on, r.recheck_due_on
       FROM worker_rtw r
       JOIN workers w ON w.id = r.worker_id
       WHERE r.outcome = 'time_limited'
         AND (r.expires_on <= ? OR r.recheck_due_on <= ?)
         AND w.status IN ('active','onboarding')
       ORDER BY r.expires_on ASC`,
    )
    .all(horizon, horizon) as any[];

  const awr = db
    .prepare(
      `SELECT a.worker_id, w.first_name, w.last_name, a.assignment_id, asg.title,
              MAX(a.cumulative) AS weeks
       FROM awr_weeks a
       JOIN workers w ON w.id = a.worker_id
       JOIN assignments asg ON asg.id = a.assignment_id
       GROUP BY a.worker_id, a.assignment_id
       HAVING weeks >= ?
       ORDER BY weeks DESC`,
    )
    .all(AWR_WARNING_AT_WEEK) as any[];

  const screening = db
    .prepare(
      `SELECT w.id AS worker_id, w.first_name, w.last_name,
              COUNT(*) AS outstanding
       FROM workers w
       LEFT JOIN screening_checks s
         ON s.worker_id = w.id AND s.status IN ('satisfied','waived')
       WHERE w.status IN ('active','onboarding')
       GROUP BY w.id
       HAVING COUNT(s.id) < ?`,
    )
    .all(BS7858_ELEMENTS.length) as any[];

  return {
    asOf: now,
    licencesExpiring: licences,
    rightToWorkExpiring: rtw,
    awrApproaching: awr.map((r) => ({
      ...r,
      qualified: r.weeks >= AWR_QUALIFYING_WEEKS,
      weeksRemaining: Math.max(0, AWR_QUALIFYING_WEEKS - r.weeks),
    })),
    screeningIncomplete: screening,
  };
}

/** Records a screening element result, with an audit entry. */
export function setScreeningElement(
  db: Db,
  workerId: string,
  element: string,
  status: 'not_started' | 'in_progress' | 'satisfied' | 'failed' | 'waived',
  opts: { coversFrom?: string; coversTo?: string; verifiedBy?: string; notes?: string } = {},
): void {
  const now = nowInstant();
  const before = db
    .prepare('SELECT * FROM screening_checks WHERE worker_id = ? AND element = ?')
    .get(workerId, element);

  db.prepare(
    `INSERT INTO screening_checks
       (id, worker_id, element, status, completed_on, covers_from, covers_to, verified_by, notes, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(worker_id, element) DO UPDATE SET
       status = excluded.status,
       completed_on = excluded.completed_on,
       covers_from = COALESCE(excluded.covers_from, screening_checks.covers_from),
       covers_to = COALESCE(excluded.covers_to, screening_checks.covers_to),
       verified_by = COALESCE(excluded.verified_by, screening_checks.verified_by),
       notes = COALESCE(excluded.notes, screening_checks.notes),
       updated_at = excluded.updated_at`,
  ).run(
    newId('scr'),
    workerId,
    element,
    status,
    status === 'satisfied' ? today() : null,
    opts.coversFrom ?? null,
    opts.coversTo ?? null,
    opts.verifiedBy ?? null,
    opts.notes ?? null,
    now,
    now,
  );

  recordAudit(db, {
    entityType: 'worker',
    entityId: workerId,
    action: 'screening_updated',
    summary: `BS 7858 — ${BS7858_LABELS[element] ?? element} set to ${status}`,
    before,
    after: { element, status, ...opts },
  });
}
