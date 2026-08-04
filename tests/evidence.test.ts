import { describe, it, expect } from 'vitest';
import { freshDb, makeOrg, makeWorker, makeAssignment } from './helpers.js';
import { newId } from '../core/db/connection.js';
import { createShift, allocateWorker } from '../core/services/shifts.js';
import { createTimesheet, populateFromShifts, approveTimesheet } from '../core/services/timesheets.js';
import { createInvoiceFromTimesheets, issueInvoice, recordPayment } from '../core/services/invoices.js';
import { setSupplyChain, derivePayeResponsibility, recordDueDiligence, dueDiligenceStatus } from '../core/services/supplyChain.js';
import { generateIntermediaryReport, intermediaryReportCsv, intermediaryObligations, upcomingFilings } from '../core/services/statutory.js';
import { parseTideCsv, importTideStatement, reconciliationView } from '../core/services/tide.js';
import { buildEnquiryPack, renderEnquiryPackHtml } from '../core/services/enquiryPack.js';
import { renderInvoiceHtml } from '../core/services/invoiceDocument.js';
import { addDays, today, nowInstant } from '../shared/dates.js';

function billedWeek(db: any) {
  const client = makeOrg(db, { name: 'Upper Tier Agency Ltd', companyNumber: '11112222' });
  const assignment = makeAssignment(db, client);
  const worker = makeWorker(db, { firstName: 'Sam', lastName: 'Officer', licenceExpiry: addDays(today(), 400) });

  const base = addDays(today(), -7);
  for (let i = 0; i < 5; i++) {
    const date = addDays(base, i);
    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${date}T08:00:00`,
      endsAt: `${date}T16:00:00`,
    });
    allocateWorker(db, shift, worker);
  }

  const ts = createTimesheet(db, { assignmentId: assignment, workerId: worker, workDate: base });
  populateFromShifts(db, ts);
  db.prepare(
    `INSERT INTO documents (id, entity_type, entity_id, category, filename, stored_path, sha256, uploaded_at)
     VALUES (?, 'timesheet', ?, 'signed_timesheet', 'sheet.pdf', '/tmp/sheet.pdf', 'abc', ?)`,
  ).run(newId('doc'), ts, nowInstant());
  approveTimesheet(db, ts, { clientSignatory: 'Site Manager', clientSignedOn: today() });

  const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [ts] });
  const number = issueInvoice(db, invoice);
  return { client, assignment, worker, timesheet: ts, invoice, number };
}

describe('Supply chain and PAYE responsibility', () => {
  it('puts responsibility on Cerviz when Cerviz holds the end-client relationship', () => {
    const db = freshDb();
    const { assignment } = billedWeek(db);
    const endClient = makeOrg(db, { name: 'Riverside Logistics Ltd', isClient: false });

    setSupplyChain(db, assignment, [
      { role: 'end_client', organisationId: endClient, description: 'Riverside Logistics Ltd' },
      { role: 'cerviz', description: 'Cerviz Ltd' },
      { role: 'umbrella', description: 'Test Umbrella Ltd' },
    ]);

    const paye = derivePayeResponsibility(db, assignment);
    expect(paye.responsibility).toBe('cerviz');
    expect(paye.cervizContractsWithEndClient).toBe(true);
    expect(paye.detail).toMatch(/April 2026/);
    expect(paye.actions.length).toBeGreaterThan(0);
  });

  it('puts responsibility on the agency above when one sits between Cerviz and the end client', () => {
    const db = freshDb();
    const { assignment, client } = billedWeek(db);
    const endClient = makeOrg(db, { name: 'Riverside Logistics Ltd', isClient: false });

    setSupplyChain(db, assignment, [
      { role: 'end_client', organisationId: endClient, description: 'Riverside Logistics Ltd' },
      { role: 'upper_agency', organisationId: client, description: 'Upper Tier Agency Ltd' },
      { role: 'cerviz', description: 'Cerviz Ltd' },
      { role: 'umbrella', description: 'Test Umbrella Ltd' },
    ]);

    const paye = derivePayeResponsibility(db, assignment);
    expect(paye.responsibility).toBe('upper_agency');
    expect(paye.detail).toMatch(/look down the chain/);
  });

  it('refuses a chain that omits Cerviz or the end client', () => {
    const db = freshDb();
    const { assignment } = billedWeek(db);
    expect(() => setSupplyChain(db, assignment, [{ role: 'umbrella', description: 'Umbrella only' }]))
      .toThrow(/must include Cerviz/i);
  });

  it('reports missing counterparty due diligence', () => {
    const db = freshDb();
    const client = makeOrg(db, { name: 'Unchecked Agency Ltd' });

    let status = dueDiligenceStatus(db, client);
    expect(status.complete).toBe(false);
    expect(status.missing.length).toBe(4);
    expect(status.riskNote).toMatch(/undocumented checks/i);

    for (const check of ['companies_house', 'vat_number', 'insurance', 'contract']) {
      recordDueDiligence(db, { organisationId: client, checkType: check, outcome: 'pass' });
    }
    status = dueDiligenceStatus(db, client);
    expect(status.complete).toBe(true);
  });
});

describe('Employment intermediaries report', () => {
  it('lists umbrella workers supplied in the period with their intermediary', () => {
    const db = freshDb();
    billedWeek(db);

    const rows = generateIntermediaryReport(db, addDays(today(), -30), today());
    expect(rows).toHaveLength(1);
    expect(rows[0].workerLastName).toBe('Officer');
    expect(rows[0].intermediaryName).toBe('Test Umbrella Ltd');
    expect(rows[0].reasonNoPaye).toMatch(/Another party operated PAYE/);
    expect(rows[0].paymentToIntermediary).toBe(560); // 40h x £14.00

    const csv = intermediaryReportCsv(rows);
    expect(csv.split('\n')[0]).toMatch(/Worker forename/);
    expect(csv).toMatch(/Officer/);
  });

  it('tracks the quarterly deadlines and flags overdue periods', () => {
    const db = freshDb();
    billedWeek(db);

    const obligations = intermediaryObligations(db);
    expect(obligations.length).toBeGreaterThanOrEqual(4);
    // Deadlines are one month after each period end.
    for (const o of obligations) {
      expect(['-05', '-06']).toContain(o.dueOn.slice(-3));
    }
  });

  it('generates the Companies House filing calendar from the incorporation date', () => {
    const db = freshDb();
    db.prepare(`UPDATE company SET incorporated_on = ? WHERE id = 1`).run('2025-03-14');

    const filings = upcomingFilings(db, today(), 720);
    const types = filings.map((f) => f.filingType);
    expect(types).toContain('confirmation_statement');
    expect(types).toContain('annual_accounts');
    expect(filings.find((f) => f.filingType === 'annual_accounts')?.notes).toMatch(/£150/);
  });
});

describe('Tide statement import', () => {
  it('parses a Tide-style CSV with paid in / paid out columns', () => {
    const csv = [
      'Date,Transaction ID,Description,Paid In,Paid Out,Balance',
      '04/08/2026,TX1,"CRV-INV-2026-0001 UPPER TIER",740.00,,2740.00',
      '05/08/2026,TX2,"UMBRELLA PAYMENT",,560.00,2180.00',
    ].join('\n');

    const rows = parseTideCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].transactedOn).toBe('2026-08-04');
    expect(rows[0].amountPence).toBe(74000);
    expect(rows[1].amountPence).toBe(-56000);
  });

  it('matches an incoming payment to an invoice by its number, and skips re-imports', () => {
    const db = freshDb();
    const { number } = billedWeek(db);

    const csv = [
      'Date,Description,Paid In,Paid Out,Balance',
      `04/08/2026,"BACS ${number} AGENCY",740.00,,740.00`,
    ].join('\n');

    const first = importTideStatement(db, csv);
    expect(first.imported).toBe(1);
    expect(first.autoMatched).toBe(1);

    // Re-importing an overlapping export must not duplicate the transaction.
    const second = importTideStatement(db, csv);
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(1);

    const view = reconciliationView(db);
    expect(view.unmatchedTransactions).toHaveLength(0);
  });

  it('leaves an unexplained transaction unmatched rather than guessing', () => {
    const db = freshDb();
    billedWeek(db);

    const csv = [
      'Date,Description,Paid In,Paid Out,Balance',
      '04/08/2026,"UNKNOWN DEPOSIT",123.45,,123.45',
    ].join('\n');

    importTideStatement(db, csv);
    const view = reconciliationView(db);
    expect(view.unmatchedTransactions).toHaveLength(1);
    expect(view.message).toMatch(/no matching document/i);
  });
});

describe('HMRC enquiry pack', () => {
  it('assembles the full evidence chain and confirms integrity', () => {
    const db = freshDb();
    const { assignment } = billedWeek(db);
    const endClient = makeOrg(db, { name: 'Riverside Logistics Ltd', isClient: false });
    setSupplyChain(db, assignment, [
      { role: 'end_client', organisationId: endClient, description: 'Riverside Logistics Ltd' },
      { role: 'cerviz', description: 'Cerviz Ltd' },
    ]);

    const pack = buildEnquiryPack(db, addDays(today(), -30), today());

    expect(pack.integrity.auditChain.ok).toBe(true);
    expect(pack.integrity.invoiceSequence.intact).toBe(true);
    expect(pack.integrity.ledgerBalanced).toBe(true);
    expect(pack.summary.invoiceCount).toBe(1);
    expect(pack.summary.workerCount).toBe(1);
    expect(pack.summary.totalHours).toBe(40);

    // The chain from invoice to signed scan is present.
    expect(pack.invoices[0].timesheets[0].documents).toHaveLength(1);
    expect(pack.invoices[0].timesheets[0].client_signatory).toBe('Site Manager');
    expect(pack.assignments[0].supplyChain).toHaveLength(2);

    const html = renderEnquiryPackHtml(pack);
    expect(html).toMatch(/Audit trail verified intact/);
    expect(html).toMatch(/Sam.*Officer/s);
  });

  it('names the gaps an inspector would notice', () => {
    const db = freshDb();
    const client = makeOrg(db, { name: 'Unchecked Agency Ltd' });
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db, { licenceExpiry: addDays(today(), 400) });

    const date = addDays(today(), -3);
    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${date}T08:00:00`,
      endsAt: `${date}T16:00:00`,
    });
    allocateWorker(db, shift, worker);

    const ts = createTimesheet(db, { assignmentId: assignment, workerId: worker, workDate: date });
    populateFromShifts(db, ts);
    // Approved with no signed scan, and no supply chain or due diligence recorded.
    approveTimesheet(db, ts, { clientSignatory: 'Manager', clientSignedOn: today() },
      { allowMissingScan: true, missingScanReason: 'Scanner broken' });

    const pack = buildEnquiryPack(db, addDays(today(), -30), today());

    expect(pack.gaps.join(' ')).toMatch(/no signed scan attached/i);
    expect(pack.gaps.join(' ')).toMatch(/no supply chain map/i);
    expect(pack.gaps.join(' ')).toMatch(/No due diligence recorded/i);
  });

  it('flags income received through a director personal account', () => {
    const db = freshDb();
    const { invoice } = billedWeek(db);
    recordPayment(db, {
      invoiceId: invoice, paidOn: today(), amountPence: 74000, viaDirectorLoan: true,
    });

    const pack = buildEnquiryPack(db, addDays(today(), -30), today());
    expect(pack.gaps.join(' ')).toMatch(/director's personal account/i);
  });
});

describe('Invoice document', () => {
  it('renders the invoice with company details, backing schedule and no-VAT wording', () => {
    const db = freshDb();
    db.prepare(
      `UPDATE company SET company_number = '15551234', registered_address_1 = '1 Example Street',
        registered_city = 'Manchester', registered_postcode = 'M1 1AA',
        bank_account_name = 'Cerviz Ltd', bank_sort_code = '04-00-04', bank_account_number = '12345678'
       WHERE id = 1`,
    ).run();

    const { invoice, number } = billedWeek(db);
    const html = renderInvoiceHtml(db, invoice);

    expect(html).toMatch(new RegExp(number));
    expect(html).toMatch(/company number 15551234/);
    expect(html).toMatch(/not registered for VAT/i);
    expect(html).toMatch(/04-00-04/);
    expect(html).toMatch(/Sam Officer/);
    expect(html).toMatch(/Supporting timesheets/);
    expect(html).toMatch(/Late Payment of Commercial Debts/);
  });
});
