import { describe, it, expect } from 'vitest';
import { freshDb, makeOrg, makeWorker, makeAssignment } from './helpers.js';
import { newId } from '../core/db/connection.js';
import { nowInstant, addDays, today } from '../shared/dates.js';
import { riskRadar, dashboardAnalytics } from '../core/services/insights.js';
import { buildRegister, registerCsv, renderRegisterHtml } from '../core/services/registers.js';
import { createShift, allocateWorker } from '../core/services/shifts.js';
import { createTimesheet, populateFromShifts, approveTimesheet } from '../core/services/timesheets.js';
import { createInvoiceFromTimesheets, issueInvoice } from '../core/services/invoices.js';

function approvedWeek(db: any) {
  const client = makeOrg(db, { name: 'Radar Client Ltd' });
  const assignment = makeAssignment(db, client);
  const worker = makeWorker(db);
  const date = addDays(today(), -21);
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
  return { client, assignment, worker, timesheet: ts };
}

describe('Risk radar', () => {
  it('flags duplicate organisations, stale unbilled work and unfilled shifts with actions', () => {
    const db = freshDb();
    makeOrg(db, { name: 'Hawk Security Group Ltd', companyNumber: '09985380' });
    makeOrg(db, { name: 'Hawk Security Group Ltd', companyNumber: '09985380' });
    const { assignment } = approvedWeek(db); // approved 3 weeks ago, never billed

    const soon = addDays(today(), 2);
    createShift(db, { assignmentId: assignment, startsAt: `${soon}T18:00:00`, endsAt: `${soon}T23:00:00` });

    const findings = riskRadar(db);
    const titles = findings.map((f) => f.title).join(' | ');
    expect(titles).toMatch(/Hawk Security Group Ltd appears 2 times/);
    expect(titles).toMatch(/unbilled/);
    expect(titles).toMatch(/unfilled/);
    // Ordered most-severe first, and every finding tells the user what to do.
    const ranks = findings.map((f) => ({ critical: 0, warning: 1, watch: 2 }[f.severity]));
    expect([...ranks].sort((a, b) => a! - b!)).toEqual(ranks);
    expect(findings.every((f) => f.action.length > 0)).toBe(true);
  });

  it('is quiet when there is nothing to report', () => {
    const db = freshDb();
    expect(riskRadar(db)).toHaveLength(0);
  });
});

describe('Dashboard analytics', () => {
  it('returns 12 months with invoiced and charge/pay series', () => {
    const db = freshDb();
    const { client, timesheet } = approvedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    const a = dashboardAnalytics(db);
    expect(a.months).toHaveLength(12);
    const totalInvoiced = a.months.reduce((x, m) => x + m.invoicedPence, 0);
    const totalCharge = a.months.reduce((x, m) => x + m.chargePence, 0);
    expect(totalInvoiced).toBe(8 * 1850); // one 8-hour shift at £18.50
    expect(totalCharge).toBe(8 * 1850);
    expect(a.months.reduce((x, m) => x + m.marginPence, 0)).toBe(8 * (1850 - 1400));
    expect(a.months.at(-1)!.month).toBe(today().slice(0, 7));
  });
});

describe('Compliance registers', () => {
  it('builds the deployment, RTW, screening and KID registers from live records', () => {
    const db = freshDb();
    approvedWeek(db);

    const dep = buildRegister(db, 'sia_deployment');
    expect(dep.rows).toHaveLength(1);
    expect(String(dep.rows[0].licence_number)).toMatch(/^1010/);

    const rtw = buildRegister(db, 'rtw');
    expect(rtw.rows).toHaveLength(1);
    expect(rtw.rows[0].outcome).toBe('continuous');

    const screening = buildRegister(db, 'screening');
    expect(screening.rows[0].overall).toBe('COMPLETE');

    const kid = buildRegister(db, 'kid');
    expect(kid.rows).toHaveLength(1);

    const csv = registerCsv(dep);
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv.split('\n')[0]).toContain('SIA licence');

    const html = renderRegisterHtml(db, dep);
    expect(html).toContain('SIA officer deployment register');
    expect(html).toContain('produced from live records');
  });

  it('refuses an unknown register type', () => {
    const db = freshDb();
    expect(() => buildRegister(db, 'nonsense')).toThrow(/Unknown register/);
  });
});
