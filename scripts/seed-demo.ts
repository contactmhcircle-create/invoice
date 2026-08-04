/**
 * Builds a realistic demo dataset so the app can be exercised before real data
 * goes in. Run with: npx tsx scripts/seed-demo.ts [dbPath]
 *
 * This is a development tool. It is never run by the packaged application.
 */
import { openDatabase, newId } from '../electron/db/connection.js';
import { nowInstant, today, addDays, weekEnding } from '../shared/dates.js';
import { ensureScreeningRows, setScreeningElement, BS7858_ELEMENTS } from '../electron/services/compliance.js';
import { setRate } from '../electron/services/rates.js';
import { createShift, allocateWorker, markShiftStatus } from '../electron/services/shifts.js';
import { createTimesheet, populateFromShifts, approveTimesheet } from '../electron/services/timesheets.js';
import { createInvoiceFromTimesheets, issueInvoice, recordPayment } from '../electron/services/invoices.js';
import { setSupplyChain, recordDueDiligence } from '../electron/services/supplyChain.js';
import { createPurchaseInvoice, addPurchaseLine, matchPurchaseToTimesheets, recordSelfBill } from '../electron/services/purchases.js';

const dbPath = process.argv[2] ?? './data/cerviz.sqlite';
const db = openDatabase(dbPath);
const now = nowInstant();

console.log(`Seeding demo data into ${dbPath}`);

db.prepare(
  `UPDATE company SET
     legal_name = 'Cerviz Ltd', trading_name = 'Cerviz Recruitment',
     company_number = '15234567', incorporated_on = '2025-03-14',
     registered_address_1 = 'Unit 4, Enterprise House', registered_address_2 = '12 Commercial Road',
     registered_city = 'Manchester', registered_postcode = 'M1 2AB',
     phone = '0161 000 0000', email = 'accounts@cerviz.co.uk',
     bank_name = 'Tide', bank_account_name = 'Cerviz Ltd',
     bank_sort_code = '04-06-05', bank_account_number = '12345678',
     invoice_terms = 'Payment due within 30 days of invoice date. Timesheets signed on site are attached as the supporting schedule.',
     updated_at = ?
   WHERE id = 1`,
).run(now);

db.prepare(
  `INSERT OR IGNORE INTO directors (id, name, role, appointed_on, created_at, updated_at)
   VALUES (?, 'Director', 'director', '2025-03-14', ?, ?)`,
).run(newId('dir'), now, now);

function org(name: string, opts: any = {}) {
  const id = newId('org');
  db.prepare(
    `INSERT INTO organisations (id, name, legal_name, company_number, vat_number, is_client, is_umbrella,
       is_end_client, address_1, city, postcode, payment_terms_days, self_bills_us, po_required,
       contact_name, contact_email, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, name, opts.legalName ?? name, opts.companyNumber ?? null, opts.vatNumber ?? null,
    opts.isClient ? 1 : 0, opts.isUmbrella ? 1 : 0, opts.isEndClient ? 1 : 0,
    opts.address ?? null, opts.city ?? 'Manchester', opts.postcode ?? null,
    opts.terms ?? 30, opts.selfBills ? 1 : 0, opts.poRequired ? 1 : 0,
    opts.contact ?? null, opts.email ?? null, now, now,
  );
  return id;
}

// --- Counterparties --------------------------------------------------------
const northgate = org('Northgate Staffing Solutions Ltd', {
  isClient: true, companyNumber: '09887766', vatNumber: 'GB223344556',
  address: 'Northgate House, 40 King Street', postcode: 'M2 6BA', terms: 30,
  contact: 'Rachel Mbeki', email: 'payables@northgatestaffing.co.uk', selfBills: true,
});
const halcyon = org('Halcyon Facilities Group Ltd', {
  isClient: true, companyNumber: '07665544', vatNumber: 'GB998877665',
  address: '2 Bridgewater Place', postcode: 'M15 4PZ', terms: 45, poRequired: true,
  contact: 'Dev Patel', email: 'ap@halcyonfm.co.uk',
});
const riverside = org('Riverside Logistics Ltd', {
  isEndClient: true, companyNumber: '06554433',
  address: 'Riverside Distribution Park', postcode: 'M17 1TH',
});
const meridianUmbrella = org('Meridian Umbrella Services Ltd', {
  isUmbrella: true, companyNumber: '11223344', vatNumber: 'GB445566778',
  address: '18 Peter Street', postcode: 'M2 5QR', terms: 14,
});

for (const [o, checks] of [
  [northgate, ['companies_house', 'vat_number', 'insurance', 'contract']],
  [meridianUmbrella, ['companies_house', 'vat_number', 'insurance', 'contract']],
  [halcyon, ['companies_house', 'contract']], // deliberately incomplete
] as const) {
  for (const check of checks) {
    recordDueDiligence(db, {
      organisationId: o, checkType: check, outcome: 'pass',
      performedOn: addDays(today(), -60), reference: 'Verified on the public register',
    });
  }
}

function site(orgId: string, name: string, postcode: string) {
  const id = newId('site');
  db.prepare(
    `INSERT INTO sites (id, organisation_id, name, address_1, city, postcode, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, orgId, name, name, 'Manchester', postcode, now, now);
  return id;
}

const depot = site(northgate, 'Riverside Distribution Depot', 'M17 1TH');
const retail = site(halcyon, 'Trafford Retail Park', 'M41 7BB');

// --- Workers ---------------------------------------------------------------
interface WorkerSpec {
  first: string; last: string; dob: string; ni: string;
  sector: string; licenceDays: number; payPence: number;
  compliant?: boolean; rtwTimeLimited?: boolean;
}

const workerSpecs: WorkerSpec[] = [
  { first: 'Samuel', last: 'Adeyemi', dob: '1988-06-12', ni: 'JK123456C', sector: 'security_guard', licenceDays: 420, payPence: 1400 },
  { first: 'Priya', last: 'Raman', dob: '1994-02-03', ni: 'JL234567D', sector: 'security_guard', licenceDays: 310, payPence: 1400 },
  { first: 'Tomas', last: 'Nowak', dob: '1991-11-21', ni: 'JM345678A', sector: 'door_supervisor', licenceDays: 45, payPence: 1450 },
  { first: 'Grace', last: 'Okonkwo', dob: '1986-04-30', ni: 'JN456789B', sector: 'security_guard', licenceDays: 190, payPence: 1400 },
  { first: 'Daniel', last: 'Whitfield', dob: '1999-09-08', ni: 'JP567890C', sector: 'security_guard', licenceDays: 28, payPence: 1400 },
  { first: 'Aisha', last: 'Karim', dob: '1996-01-17', ni: 'JR678901D', sector: 'cctv', licenceDays: 500, payPence: 1500, rtwTimeLimited: true },
  { first: 'Marcus', last: 'Bell', dob: '1990-07-25', ni: 'JS789012A', sector: 'security_guard', licenceDays: 365, payPence: 1400, compliant: false },
];

const workers: string[] = [];
for (const spec of workerSpecs) {
  const id = newId('wkr');
  db.prepare(
    `INSERT INTO workers (id, reference, first_name, last_name, date_of_birth, ni_number,
       engagement_type, umbrella_org_id, default_pay_rate_pence, status, address_1, city, postcode,
       phone, wtr_opt_out, wtr_opt_out_signed_on, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'umbrella', ?,?, ?,?,?,?,?,1,?,?,?)`,
  ).run(
    id, `CRV-W-${String(workers.length + 1).padStart(4, '0')}`,
    spec.first, spec.last, spec.dob, spec.ni, meridianUmbrella, spec.payPence,
    spec.compliant === false ? 'onboarding' : 'active',
    '1 Worker Street', 'Manchester', 'M1 3AA', '07700 900000',
    addDays(today(), -120), now, now,
  );

  ensureScreeningRows(db, id);

  db.prepare(
    `INSERT INTO worker_licences (id, worker_id, sector, licence_number, issued_on, expires_on,
       verified_on, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'valid', ?,?)`,
  ).run(
    newId('lic'), id, spec.sector,
    `1010${Math.floor(100000000 + Math.random() * 800000000)}`,
    addDays(today(), -700), addDays(today(), spec.licenceDays),
    addDays(today(), -30), now, now,
  );

  db.prepare(
    `INSERT INTO worker_rtw (id, worker_id, method, share_code, checked_on, outcome, expires_on, recheck_due_on, created_at)
     VALUES (?,?, 'share_code', ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('rtw'), id, `W${Math.floor(100000 + Math.random() * 899999)} XYZ`,
    addDays(today(), -90),
    spec.rtwTimeLimited ? 'time_limited' : 'continuous',
    spec.rtwTimeLimited ? addDays(today(), 25) : null,
    spec.rtwTimeLimited ? addDays(today(), 18) : null,
    now,
  );

  // Marcus is mid-onboarding: screening deliberately incomplete.
  const elements = spec.compliant === false ? BS7858_ELEMENTS.slice(0, 3) : BS7858_ELEMENTS;
  for (const el of elements) {
    setScreeningElement(db, id, el, 'satisfied', {
      coversFrom: addDays(today(), -365 * 5 - 5),
      coversTo: today(),
      verifiedBy: 'Compliance',
    });
  }

  if (spec.compliant !== false) {
    db.prepare(
      `INSERT INTO key_information_documents (id, worker_id, version, issued_on, engagement_type,
         pay_rate_pence, umbrella_org_id, content_html, created_at)
       VALUES (?,?,1,?, 'umbrella', ?,?, '<p>Key Information Document</p>', ?)`,
    ).run(newId('kid'), id, addDays(today(), -120), spec.payPence, meridianUmbrella, now);
  }

  workers.push(id);
}

// --- Assignments -----------------------------------------------------------
function assignment(clientId: string, siteId: string, title: string, opts: any) {
  const id = newId('asg');
  db.prepare(
    `INSERT INTO assignments (id, reference, client_org_id, site_id, title, sector, role,
       required_licence_sector, starts_on, po_reference, use_rate_bands, min_shift_minutes,
       status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'security', ?,?,?,?,?,?, 'active', ?,?)`,
  ).run(
    id, opts.reference, clientId, siteId, title, opts.role ?? 'Security officer',
    opts.licence ?? 'security_guard', addDays(today(), -120), opts.po ?? null,
    opts.bands ? 1 : 0, opts.minShift ?? null, now, now,
  );
  setRate(db, {
    scope: 'assignment', scopeId: id,
    chargeRatePence: opts.charge, payRatePence: opts.pay,
    effectiveFrom: addDays(today(), -120),
  });
  if (opts.bands) {
    setRate(db, {
      scope: 'assignment', scopeId: id, band: 'night',
      chargeRatePence: opts.nightCharge, payRatePence: opts.nightPay,
      effectiveFrom: addDays(today(), -120),
    });
  }
  return id;
}

const depotNights = assignment(northgate, depot, 'Riverside Depot — night cover', {
  reference: 'CRV-ASG-001', charge: 1850, pay: 1400, bands: true, nightCharge: 1975, nightPay: 1500,
});
const retailDays = assignment(halcyon, retail, 'Trafford Retail Park — day guarding', {
  reference: 'CRV-ASG-002', charge: 1795, pay: 1400, po: 'PO-88213', licence: 'security_guard',
});

// Cerviz sits below Northgate on the depot contract; on Halcyon it holds the
// end-client relationship directly, so PAYE responsibility differs between them.
setSupplyChain(db, depotNights, [
  { role: 'end_client', organisationId: riverside, description: 'Riverside Logistics Ltd', contractRef: 'RL-2026-14' },
  { role: 'upper_agency', organisationId: northgate, description: 'Northgate Staffing Solutions Ltd', contractRef: 'NG-SUB-0042' },
  { role: 'cerviz', description: 'Cerviz Ltd (sub-contractor)' },
  { role: 'umbrella', organisationId: meridianUmbrella, description: 'Meridian Umbrella Services Ltd' },
]);

setSupplyChain(db, retailDays, [
  { role: 'end_client', organisationId: halcyon, description: 'Halcyon Facilities Group Ltd' },
  { role: 'cerviz', description: 'Cerviz Ltd (direct supply)' },
  { role: 'umbrella', organisationId: meridianUmbrella, description: 'Meridian Umbrella Services Ltd' },
]);

// --- Shifts, timesheets, invoices over the last eight weeks ----------------
const activeWorkers = workers.slice(0, 6);
let invoiceCount = 0;

for (let week = 8; week >= 1; week--) {
  const weekStart = addDays(today(), -7 * week);
  const wkEnd = weekEnding(weekStart);
  const timesheetsThisWeek: Record<string, string[]> = { [northgate]: [], [halcyon]: [] };

  for (const [asgId, clientId, startTime, endTime, count] of [
    [depotNights, northgate, '19:00', '07:00', 3],
    [retailDays, halcyon, '08:00', '18:00', 2],
  ] as const) {
    for (let w = 0; w < count; w++) {
      const workerId = activeWorkers[(week + w) % activeWorkers.length];
      const created: string[] = [];

      for (let d = 0; d < 5; d++) {
        const date = addDays(weekStart, d);
        const shiftId = createShift(db, {
          assignmentId: asgId,
          startsAt: `${date}T${startTime}:00`,
          endsAt: `${date}T${endTime}:00`,
          breakMinutes: 30,
        });
        try {
          allocateWorker(db, shiftId, workerId);
          markShiftStatus(db, shiftId, 'worked');
          created.push(shiftId);
        } catch {
          // A compliance blocker leaves the shift unfilled, which is the point.
        }
      }

      if (created.length === 0) continue;

      const tsId = createTimesheet(db, { assignmentId: asgId, workerId, workDate: weekStart });
      populateFromShifts(db, tsId);

      db.prepare(
        `INSERT INTO documents (id, entity_type, entity_id, category, filename, stored_path,
           mime_type, size_bytes, sha256, uploaded_at, uploaded_by)
         VALUES (?, 'timesheet', ?, 'signed_timesheet', ?, ?, 'application/pdf', 148000, ?, ?, 'operator')`,
      ).run(
        newId('doc'), tsId, `signed-timesheet-${wkEnd}.pdf`, `/demo/signed-${tsId}.pdf`,
        newId('sha').replace(/[^a-f0-9]/g, '0').padEnd(64, 'a').slice(0, 64), now,
      );

      approveTimesheet(db, tsId, {
        clientSignatory: clientId === northgate ? 'J. Harper (Site Supervisor)' : 'L. Ahmed (Duty Manager)',
        clientSignedOn: wkEnd,
      });
      timesheetsThisWeek[clientId].push(tsId);
    }
  }

  // Bill the two most recent weeks separately; leave week 1 unbilled so the
  // dashboard has something to chase.
  if (week > 1) {
    for (const [clientId, tsIds] of Object.entries(timesheetsThisWeek)) {
      if (tsIds.length === 0) continue;
      const invId = createInvoiceFromTimesheets(db, {
        clientOrgId: clientId,
        timesheetIds: tsIds,
        issueDate: addDays(wkEnd, 1),
        poReference: clientId === halcyon ? 'PO-88213' : undefined,
      });
      const number = issueInvoice(db, invId);
      invoiceCount++;

      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId) as any;
      // Older invoices are paid; the most recent two are left outstanding.
      if (week > 3) {
        recordPayment(db, {
          invoiceId: invId,
          paidOn: addDays(inv.due_date, clientId === halcyon ? 4 : -2),
          amountPence: inv.gross_pence,
          reference: number,
        });
      }
    }
  }
}

// --- Umbrella invoice, deliberately over-billed ---------------------------
const expected = (db
  .prepare(
    `SELECT COALESCE(SUM(t.pay_total_pence),0) AS total FROM timesheets t
     JOIN workers w ON w.id = t.worker_id
     WHERE w.umbrella_org_id = ? AND t.week_ending >= ?`,
  )
  .get(meridianUmbrella, addDays(today(), -21)) as any).total;

const pinv = createPurchaseInvoice(db, {
  organisationId: meridianUmbrella,
  theirReference: 'MER-2026-0881',
  invoiceDate: addDays(today(), -5),
  periodFrom: addDays(today(), -21),
  periodTo: today(),
  netPence: expected + 18_650, // £186.50 more than our timesheets support
  category: 'umbrella_labour',
});
addPurchaseLine(db, pinv, {
  description: 'Assignment labour, weeks 30–32',
  quantityMinutes: 0,
  unitPricePence: 0,
  netPence: expected + 18_650,
});
matchPurchaseToTimesheets(db, pinv);

// --- Self-bill from Northgate, deliberately a week short ------------------
const expectedCharge = (db
  .prepare(
    `SELECT COALESCE(SUM(t.charge_total_pence),0) AS total FROM timesheets t
     JOIN assignments a ON a.id = t.assignment_id
     WHERE a.client_org_id = ? AND t.week_ending >= ?`,
  )
  .get(northgate, addDays(today(), -21)) as any).total;

recordSelfBill(db, {
  organisationId: northgate,
  theirReference: 'NG-SB-4471',
  receivedOn: addDays(today(), -3),
  periodFrom: addDays(today(), -21),
  periodTo: today(),
  theirNetPence: Math.round(expectedCharge * 0.86),
});

const counts = {
  organisations: (db.prepare('SELECT COUNT(*) AS n FROM organisations').get() as any).n,
  workers: (db.prepare('SELECT COUNT(*) AS n FROM workers').get() as any).n,
  shifts: (db.prepare('SELECT COUNT(*) AS n FROM shifts').get() as any).n,
  timesheets: (db.prepare('SELECT COUNT(*) AS n FROM timesheets').get() as any).n,
  invoices: (db.prepare('SELECT COUNT(*) AS n FROM invoices').get() as any).n,
  auditEntries: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as any).n,
};

console.log('Seeded:', counts);
db.close();
