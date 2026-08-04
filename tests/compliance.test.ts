import { describe, it, expect } from 'vitest';
import { freshDb, makeOrg, makeWorker, makeAssignment } from './helpers.js';
import { newId } from '../electron/db/connection.js';
import {
  checkWorker,
  setScreeningElement,
  recalculateAwr,
  awrStatus,
  checkNmw,
  nmwBandFor,
  holidayAccrualPence,
} from '../electron/services/compliance.js';
import { createShift, allocateWorker, checkAllocation, eligibleWorkers } from '../electron/services/shifts.js';
import { addDays, today, nowInstant } from '../shared/dates.js';

describe('SIA licence expiry blocking', () => {
  it('blocks allocation when the licence expires before the shift date', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    // Licence valid for 10 more days only.
    const worker = makeWorker(db, { licenceExpiry: addDays(today(), 10) });

    const shiftDate = addDays(today(), 30); // beyond expiry
    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${shiftDate}T18:00:00`,
      endsAt: `${shiftDate}T06:00:00`,
    });

    const check = checkAllocation(db, shift, worker);
    expect(check.allowed).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain('SIA_EXPIRED');

    expect(() => allocateWorker(db, shift, worker)).toThrow(/cannot be allocated/i);
  });

  it('allows allocation while the licence is still valid, and warns near expiry', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db, { licenceExpiry: addDays(today(), 20) });

    const shiftDate = addDays(today(), 5);
    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${shiftDate}T18:00:00`,
      endsAt: `${shiftDate}T22:00:00`,
    });

    const check = checkAllocation(db, shift, worker);
    expect(check.allowed).toBe(true);
    expect(check.warnings.map((w) => w.code)).toContain('SIA_EXPIRING');
  });

  it('requires the licence sector the assignment demands', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client, { requiredLicenceSector: 'door_supervisor' });
    const worker = makeWorker(db, { licenceSector: 'cctv' });

    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${addDays(today(), 3)}T20:00:00`,
      endsAt: `${addDays(today(), 3)}T23:00:00`,
    });

    const check = checkAllocation(db, shift, worker);
    expect(check.allowed).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain('SIA_MISSING');
  });
});

describe('BS 7858 screening', () => {
  it('blocks placement while any element is outstanding', () => {
    const db = freshDb();
    const worker = makeWorker(db, { fullyCompliant: false });

    const report = checkWorker(db, worker);
    expect(report.placeable).toBe(false);
    expect(report.blockers.map((b) => b.code)).toContain('BS7858_INCOMPLETE');
  });

  it('warns when employment history covers less than five years', () => {
    const db = freshDb();
    const worker = makeWorker(db);
    setScreeningElement(db, worker, 'employment_history', 'satisfied', {
      coversFrom: addDays(today(), -365 * 2),
      coversTo: today(),
    });

    const report = checkWorker(db, worker);
    expect(report.warnings.map((w) => w.code)).toContain('BS7858_SHORT_HISTORY');
  });

  it('clears once every element is satisfied', () => {
    const db = freshDb();
    const worker = makeWorker(db);
    const report = checkWorker(db, worker);
    expect(report.blockers).toHaveLength(0);
    expect(report.placeable).toBe(true);
  });
});

describe('Right to work', () => {
  it('blocks a worker with no check on file', () => {
    const db = freshDb();
    const worker = makeWorker(db, { fullyCompliant: false });
    const report = checkWorker(db, worker);
    expect(report.blockers.map((b) => b.code)).toContain('RTW_MISSING');
  });

  it('blocks when time-limited permission has expired before the shift date', () => {
    const db = freshDb();
    const worker = makeWorker(db);
    db.prepare('DELETE FROM worker_rtw WHERE worker_id = ?').run(worker);
    db.prepare(
      `INSERT INTO worker_rtw (id, worker_id, method, checked_on, outcome, expires_on, created_at)
       VALUES (?,?, 'share_code', ?, 'time_limited', ?, ?)`,
    ).run(newId('rtw'), worker, addDays(today(), -100), addDays(today(), -1), nowInstant());

    const report = checkWorker(db, worker, today());
    expect(report.blockers.map((b) => b.code)).toContain('RTW_EXPIRED');
  });
});

describe('National Minimum Wage', () => {
  it('picks the age band from date of birth', () => {
    expect(nmwBandFor('2000-01-01', '2026-06-01')).toBe('21_and_over');
    expect(nmwBandFor('2007-01-01', '2026-06-01')).toBe('18_to_20');
    expect(nmwBandFor('2010-01-01', '2026-06-01')).toBe('under_18');
  });

  it('flags a pay rate below the minimum', () => {
    const db = freshDb();
    const worker = makeWorker(db, { dateOfBirth: '1990-01-01' });
    const check = checkNmw(db, worker, 1100, '2026-06-01');
    expect(check.ok).toBe(false);
    expect(check.requiredPence).toBe(1271);
    expect(check.shortfallPence).toBe(171);
  });

  it('blocks allocation when the resolved pay rate breaches NMW', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client, { payRatePence: 1000, chargeRatePence: 1800 });
    const worker = makeWorker(db, { dateOfBirth: '1990-01-01' });

    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${addDays(today(), 2)}T09:00:00`,
      endsAt: `${addDays(today(), 2)}T17:00:00`,
    });

    const check = checkAllocation(db, shift, worker);
    expect(check.allowed).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain('NMW_BREACH');
  });
});

describe('AWR 12-week qualifying clock', () => {
  it('counts qualifying weeks and flags reaching 12', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db, { licenceExpiry: addDays(today(), 500) });

    // 12 consecutive weekly shifts.
    for (let week = 0; week < 12; week++) {
      const date = addDays(today(), -7 * (12 - week));
      const shift = createShift(db, {
        assignmentId: assignment,
        startsAt: `${date}T09:00:00`,
        endsAt: `${date}T17:00:00`,
      });
      allocateWorker(db, shift, worker);
    }

    recalculateAwr(db, worker, assignment);
    const status = awrStatus(db, worker, assignment);
    expect(status.qualifyingWeeks).toBe(12);
    expect(status.hasQualified).toBe(true);
    expect(status.weeksRemaining).toBe(0);
  });

  it('resets the clock after a break of six weeks or more', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db, { licenceExpiry: addDays(today(), 500) });

    // 4 weeks, then a 7-week gap, then 2 weeks.
    const weeks = [20, 19, 18, 17, 9, 8];
    for (const w of weeks) {
      const date = addDays(today(), -7 * w);
      const shift = createShift(db, {
        assignmentId: assignment,
        startsAt: `${date}T09:00:00`,
        endsAt: `${date}T17:00:00`,
      });
      allocateWorker(db, shift, worker);
    }

    recalculateAwr(db, worker, assignment);
    const status = awrStatus(db, worker, assignment);
    // The gap resets, so only the last two weeks count.
    expect(status.qualifyingWeeks).toBe(2);
  });
});

describe('Shift clash detection', () => {
  it('refuses to double-book a worker across overlapping shifts', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db);
    const date = addDays(today(), 4);

    const first = createShift(db, {
      assignmentId: assignment,
      startsAt: `${date}T08:00:00`,
      endsAt: `${date}T16:00:00`,
    });
    allocateWorker(db, first, worker);

    const overlapping = createShift(db, {
      assignmentId: assignment,
      startsAt: `${date}T14:00:00`,
      endsAt: `${date}T22:00:00`,
    });

    const check = checkAllocation(db, overlapping, worker);
    expect(check.allowed).toBe(false);
    expect(check.blockers.map((b) => b.code)).toContain('SHIFT_CLASH');
    expect(check.clashes).toHaveLength(1);
  });
});

describe('Eligible worker listing', () => {
  it('separates placeable workers from blocked ones with reasons', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const good = makeWorker(db, { firstName: 'Ada', lastName: 'Compliant' });
    const bad = makeWorker(db, { firstName: 'Bob', lastName: 'Unscreened', fullyCompliant: false });

    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${addDays(today(), 3)}T18:00:00`,
      endsAt: `${addDays(today(), 3)}T23:00:00`,
    });

    const list = eligibleWorkers(db, shift);
    const ada = list.find((w) => w.workerId === good)!;
    const bob = list.find((w) => w.workerId === bad)!;

    expect(ada.eligible).toBe(true);
    expect(bob.eligible).toBe(false);
    expect(bob.blockers.length).toBeGreaterThan(0);
  });
});

describe('Holiday pay accrual', () => {
  it('accrues at 12.07% of pay', () => {
    expect(holidayAccrualPence(100000)).toBe(12070);
  });
});
