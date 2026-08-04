import { describe, it, expect } from 'vitest';
import { freshDb, makeOrg, makeWorker, makeAssignment } from './helpers.js';
import { isNightShift, determineBand, setRate, resolveRate } from '../core/services/rates.js';
import { createShift, allocateWorker, shiftValue } from '../core/services/shifts.js';
import { workedMinutes } from '../shared/dates.js';
import { addDays, today } from '../shared/dates.js';

/**
 * Overnight shifts are the default pattern in security, so they get their own
 * coverage: a 19:00–07:00 rota crosses midnight, is entirely a night shift, and
 * must bill 11.5 hours rather than a negative duration clamped to zero.
 */

describe('Shifts crossing midnight', () => {
  it('measures duration across midnight rather than clamping to zero', () => {
    expect(workedMinutes('2026-07-28T19:00:00', '2026-07-28T07:00:00', 30)).toBe(11 * 60 + 30);
    expect(workedMinutes('2026-07-28T22:00:00', '2026-07-28T02:00:00', 0)).toBe(4 * 60);
    // A same-day shift is unaffected.
    expect(workedMinutes('2026-07-28T08:00:00', '2026-07-28T18:00:00', 30)).toBe(9 * 60 + 30);
  });

  it('values an overnight shift at the full hours worked', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client, { chargeRatePence: 1850, payRatePence: 1400 });
    const worker = makeWorker(db, { licenceExpiry: addDays(today(), 400) });

    const date = addDays(today(), 2);
    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${date}T19:00:00`,
      endsAt: `${date}T07:00:00`,
      breakMinutes: 30,
    });
    allocateWorker(db, shift, worker);

    const value = shiftValue(db, shift);
    expect(value.workedMinutes).toBe(690);              // 11.5 hours
    expect(value.chargePence).toBe(Math.round((690 * 1850) / 60));
    expect(value.payPence).toBe(Math.round((690 * 1400) / 60));
    expect(value.chargePence).toBeGreaterThan(0);
  });
});

describe('Night shift classification', () => {
  it('treats the standard 19:00–07:00 security rota as a night shift', () => {
    expect(isNightShift('2026-07-28T19:00:00', '2026-07-28T07:00:00')).toBe(true);
  });

  it('recognises other patterns that sit inside the night period', () => {
    expect(isNightShift('2026-07-28T22:00:00', '2026-07-28T06:00:00')).toBe(true);
    expect(isNightShift('2026-07-28T00:00:00', '2026-07-28T08:00:00')).toBe(true);
    expect(isNightShift('2026-07-28T23:00:00', '2026-07-28T02:00:00')).toBe(true);
  });

  it('does not classify day shifts, or shifts barely touching the night window', () => {
    expect(isNightShift('2026-07-28T08:00:00', '2026-07-28T18:00:00')).toBe(false);
    expect(isNightShift('2026-07-28T14:00:00', '2026-07-28T22:00:00')).toBe(false);
    // Only one hour inside the night period — below the three-hour threshold.
    expect(isNightShift('2026-07-28T05:00:00', '2026-07-28T13:00:00')).toBe(false);
  });

  it('bands an overnight weekday shift as night when the assignment uses bands', () => {
    // 28 July 2026 is a Tuesday.
    expect(determineBand('2026-07-28T19:00:00', '2026-07-28T07:00:00', false, true)).toBe('night');
    expect(determineBand('2026-07-28T08:00:00', '2026-07-28T18:00:00', false, true)).toBe('standard');
    // Banding stays off unless the assignment opts in.
    expect(determineBand('2026-07-28T19:00:00', '2026-07-28T07:00:00', false, false)).toBe('standard');
  });
});

describe('Rate resolution for banded assignments', () => {
  it('applies the night rate to an overnight shift and the standard rate by day', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client, {
      chargeRatePence: 1850, payRatePence: 1400, useRateBands: true,
    });
    setRate(db, {
      scope: 'assignment', scopeId: assignment, band: 'night',
      chargeRatePence: 1975, payRatePence: 1500,
      effectiveFrom: addDays(today(), -365),
    });

    // Wednesday, so the weekend band does not take precedence.
    const wednesday = '2026-07-29';
    const night = createShift(db, {
      assignmentId: assignment,
      startsAt: `${wednesday}T19:00:00`,
      endsAt: `${wednesday}T07:00:00`,
      breakMinutes: 30,
    });
    const day = createShift(db, {
      assignmentId: assignment,
      startsAt: `${wednesday}T08:00:00`,
      endsAt: `${wednesday}T18:00:00`,
      breakMinutes: 30,
    });

    const nightRow = db.prepare('SELECT * FROM shifts WHERE id = ?').get(night) as any;
    const dayRow = db.prepare('SELECT * FROM shifts WHERE id = ?').get(day) as any;

    expect(nightRow.band).toBe('night');
    expect(nightRow.charge_rate_pence).toBe(1975);
    expect(nightRow.pay_rate_pence).toBe(1500);

    expect(dayRow.band).toBe('standard');
    expect(dayRow.charge_rate_pence).toBe(1850);
  });

  it('falls back to the standard rate and says so when no band rate exists', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client, {
      chargeRatePence: 1850, payRatePence: 1400, useRateBands: true,
    });

    const resolved = resolveRate(db, {
      assignmentId: assignment,
      clientOrgId: client,
      band: 'night',
      on: '2026-07-29',
    });

    expect(resolved?.chargeRatePence).toBe(1850);
    expect(resolved?.source).toMatch(/no night rate set/i);
  });
});
