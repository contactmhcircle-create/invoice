import { describe, it, expect } from 'vitest';
import { freshDb, makeOrg, makeWorker, makeAssignment } from './helpers.js';
import { newId } from '../core/db/connection.js';
import { createShift, allocateWorker, shiftValue } from '../core/services/shifts.js';
import {
  createTimesheet,
  populateFromShifts,
  approveTimesheet,
  unbilledTimesheets,
} from '../core/services/timesheets.js';
import {
  createInvoiceFromTimesheets,
  issueInvoice,
  voidInvoice,
  recordPayment,
  createCreditNote,
  issueCreditNote,
  statutoryInterest,
  agedDebtors,
  invoiceWithDetail,
} from '../core/services/invoices.js';
import { auditSequence } from '../core/services/numbering.js';
import { verifyAuditChain } from '../core/db/audit.js';
import { trialBalance, profitAndLoss } from '../core/services/ledger.js';
import { recordSelfBill, reconcileSelfBill, createPurchaseInvoice, addPurchaseLine, matchPurchaseToTimesheets, marginReport } from '../core/services/purchases.js';
import { thresholdStatus } from '../core/services/vat.js';
import { addDays, today, weekEnding, nowInstant } from '../shared/dates.js';

/** Builds a worked, approved timesheet ready to invoice. */
function workedWeek(db: any, opts: { chargeRatePence?: number; payRatePence?: number } = {}) {
  const client = makeOrg(db, { name: 'Upper Tier Agency Ltd', paymentTermsDays: 30 });
  const assignment = makeAssignment(db, client, {
    chargeRatePence: opts.chargeRatePence ?? 1850,
    payRatePence: opts.payRatePence ?? 1400,
  });
  const worker = makeWorker(db, { firstName: 'Sam', lastName: 'Officer', licenceExpiry: addDays(today(), 400) });

  // Five 8-hour shifts last week.
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

  // Attach the signed paper scan.
  db.prepare(
    `INSERT INTO documents (id, entity_type, entity_id, category, filename, stored_path, sha256, uploaded_at)
     VALUES (?, 'timesheet', ?, 'signed_timesheet', 'sheet.pdf', '/tmp/sheet.pdf', 'abc123', ?)`,
  ).run(newId('doc'), ts, nowInstant());

  approveTimesheet(db, ts, { clientSignatory: 'Site Manager', clientSignedOn: today() });

  return { client, assignment, worker, timesheet: ts };
}

describe('Timesheet to invoice chain', () => {
  it('bills 40 hours at the assignment rate with the timesheet as backing', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);

    const unbilled = unbilledTimesheets(db);
    expect(unbilled).toHaveLength(1);
    expect(unbilled[0].total_minutes).toBe(40 * 60);
    expect(unbilled[0].charge_total_pence).toBe(40 * 1850);
    expect(unbilled[0].pay_total_pence).toBe(40 * 1400);
    expect(unbilled[0].marginPence).toBe(40 * 450);

    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    const number = issueInvoice(db, invoice);

    expect(number).toMatch(/^CRV-INV-\d{4}-0001$/);

    const detail = invoiceWithDetail(db, invoice)!;
    expect(detail.net_pence).toBe(40 * 1850);
    expect(detail.lines).toHaveLength(5);
    // Every line traces back to the timesheet, which has a signed scan.
    expect(detail.lines.every((l: any) => l.timesheet_id === timesheet)).toBe(true);
    expect(detail.backingTimesheets[0].scan_count).toBe(1);
    expect(detail.backingTimesheets[0].client_signatory).toBe('Site Manager');
  });

  it('refuses to approve a timesheet with no signed scan unless a reason is recorded', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db);
    const date = addDays(today(), -3);
    const shift = createShift(db, {
      assignmentId: assignment,
      startsAt: `${date}T08:00:00`,
      endsAt: `${date}T16:00:00`,
    });
    allocateWorker(db, shift, worker);

    const ts = createTimesheet(db, { assignmentId: assignment, workerId: worker, workDate: date });
    populateFromShifts(db, ts);

    expect(() =>
      approveTimesheet(db, ts, { clientSignatory: 'Manager', clientSignedOn: today() }),
    ).toThrow(/signed timesheet scan/i);

    // Allowed with an explicit, audited reason.
    approveTimesheet(db, ts, { clientSignatory: 'Manager', clientSignedOn: today() }, {
      allowMissingScan: true,
      missingScanReason: 'Scanner broken; original held in the office file',
    });

    const audit = db
      .prepare(`SELECT summary FROM audit_log WHERE entity_id = ? AND action = 'approved'`)
      .get(ts) as any;
    expect(audit.summary).toContain('NO SIGNED SCAN');
  });

  it('refuses to invoice a timesheet that has not been approved', () => {
    const db = freshDb();
    const client = makeOrg(db);
    const assignment = makeAssignment(db, client);
    const worker = makeWorker(db);
    const ts = createTimesheet(db, { assignmentId: assignment, workerId: worker, workDate: today() });

    expect(() =>
      createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [ts] }),
    ).toThrow(/not approved/i);
  });
});

describe('Invoice immutability', () => {
  it('freezes an issued invoice at the database level', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    // Directly attempting to alter the figures must fail, not merely be discouraged.
    expect(() =>
      db.prepare('UPDATE invoices SET net_pence = 1 WHERE id = ?').run(invoice),
    ).toThrow(/issued and cannot be altered/i);

    expect(() => db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice)).toThrow(/cannot be deleted/i);
  });

  it('allows a void with a reason, and keeps the number consumed', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    const number = issueInvoice(db, invoice);

    voidInvoice(db, invoice, 'Raised against the wrong agency');

    const after = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice) as any;
    expect(after.status).toBe('void');
    expect(after.number).toBe(number); // number retained, not recycled

    // The timesheet is released so the work can be billed correctly.
    const ts = db.prepare('SELECT status FROM timesheets WHERE id = ?').get(timesheet) as any;
    expect(ts.status).toBe('approved');
  });

  it('refuses to void an invoice that has been paid', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);
    recordPayment(db, { invoiceId: invoice, paidOn: today(), amountPence: 10000 });

    expect(() => voidInvoice(db, invoice, 'changed my mind')).toThrow(/credit note/i);
  });
});

describe('Gapless numbering', () => {
  it('produces an unbroken sequence including voided documents', () => {
    const db = freshDb();

    for (let i = 0; i < 3; i++) {
      const { client, timesheet } = workedWeek(db);
      const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
      issueInvoice(db, invoice);
      if (i === 1) voidInvoice(db, invoice, 'Duplicate raised in error');
    }

    const audit = auditSequence(db, 'invoice');
    expect(audit.allocated).toBe(3);
    expect(audit.lowest).toBe(1);
    expect(audit.highest).toBe(3);
    expect(audit.missing).toEqual([]);
    expect(audit.intact).toBe(true);
  });
});

describe('Credit notes', () => {
  it('credits an issued invoice in full and posts the reversal', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    const cn = createCreditNote(db, { invoiceId: invoice, reason: 'Hours disputed by client' });
    const cnNumber = issueCreditNote(db, cn);
    expect(cnNumber).toMatch(/^CRV-CN-\d{4}-0001$/);

    const note = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(cn) as any;
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice) as any;
    expect(note.net_pence).toBe(inv.net_pence);

    // Revenue nets to zero once the credit note is posted.
    const pl = profitAndLoss(db, addDays(today(), -30), today());
    expect(pl.totalIncomePence).toBe(0);
  });
});

describe('Payments and late payment interest', () => {
  it('tracks partial payment then settlement', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    const total = (db.prepare('SELECT gross_pence FROM invoices WHERE id = ?').get(invoice) as any).gross_pence;

    recordPayment(db, { invoiceId: invoice, paidOn: today(), amountPence: Math.floor(total / 2) });
    expect((db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice) as any).status).toBe('part_paid');

    recordPayment(db, { invoiceId: invoice, paidOn: today(), amountPence: Math.ceil(total / 2) });
    expect((db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoice) as any).status).toBe('paid');
  });

  it('records income received via a director personal account through the loan account', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    recordPayment(db, {
      invoiceId: invoice,
      paidOn: today(),
      amountPence: 260000,
      viaDirectorLoan: true,
      notes: 'Paid into personal account, transferred to business account same week',
    });

    const tb = trialBalance(db);
    const dla = tb.accounts.find((a) => a.code === '1210');
    expect(dla).toBeDefined();
    expect(dla!.debitsPence).toBe(260000);

    const audit = db
      .prepare(`SELECT summary FROM audit_log WHERE action = 'payment_recorded'`)
      .get() as any;
    expect(audit.summary).toContain('director');
  });

  it('calculates statutory interest at base rate plus 8% with fixed compensation', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, {
      clientOrgId: client,
      timesheetIds: [timesheet],
      issueDate: addDays(today(), -90),
    });
    issueInvoice(db, invoice);

    const interest = statutoryInterest(db, invoice, today());
    expect(interest.applicable).toBe(true);
    expect(interest.daysLate).toBe(60);
    expect(interest.ratePercent).toBe(12); // 4% base + 8%
    // 40h x £18.50 = £740 outstanding, 60 days at 12%
    expect(interest.outstandingPence).toBe(74000);
    expect(interest.interestPence).toBe(Math.round((74000 * 0.12 * 60) / 365));
    expect(interest.compensationPence).toBe(4000); // debt under £1,000
  });

  it('buckets aged debt by how overdue it is', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, {
      clientOrgId: client,
      timesheetIds: [timesheet],
      issueDate: addDays(today(), -75),
    });
    issueInvoice(db, invoice);

    const aged = agedDebtors(db);
    expect(aged.totalOutstanding).toBe(74000);
    expect(aged.buckets.days31to60).toBe(74000);
  });
});

describe('Audit chain', () => {
  it('verifies intact after normal operations', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBeGreaterThan(5);
  });

  it('refuses updates and deletes on the log itself', () => {
    const db = freshDb();
    workedWeek(db);
    expect(() => db.prepare('UPDATE audit_log SET summary = ? WHERE id = 1').run('tampered'))
      .toThrow(/append-only/i);
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run()).toThrow(/append-only/i);
  });
});

describe('Self-bill reconciliation', () => {
  it('detects an agency self-billing less than our timesheets support', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);

    // We expect 40h x £18.50 = £740. They self-bill £600.
    const sb = recordSelfBill(db, {
      organisationId: client,
      theirReference: 'SB-9001',
      receivedOn: today(),
      periodFrom: addDays(today(), -14),
      periodTo: today(),
      theirNetPence: 60000,
    });

    const result = reconcileSelfBill(db, sb);
    expect(result.status).toBe('underpaid');
    expect(result.ourExpectedNetPence).toBe(74000);
    expect(result.variancePence).toBe(-14000);
    expect(result.unmatchedTimesheets).toHaveLength(1);
    expect(result.message).toMatch(/£140\.00/);
  });

  it('agrees when the figures match', () => {
    const db = freshDb();
    const { client } = workedWeek(db);

    const sb = recordSelfBill(db, {
      organisationId: client,
      theirReference: 'SB-9002',
      receivedOn: today(),
      periodFrom: addDays(today(), -14),
      periodTo: today(),
      theirNetPence: 74000,
    });

    expect(reconcileSelfBill(db, sb).status).toBe('agreed');
  });
});

describe('Umbrella invoice matching and margin', () => {
  it('flags an umbrella billing more than the approved timesheets support', () => {
    const db = freshDb();
    const { worker } = workedWeek(db);

    const umbrellaId = (db.prepare('SELECT umbrella_org_id FROM workers WHERE id = ?').get(worker) as any)
      .umbrella_org_id;

    // We expect 40h x £14.00 = £560. They bill £600.
    const pi = createPurchaseInvoice(db, {
      organisationId: umbrellaId,
      theirReference: 'UMB-123',
      invoiceDate: today(),
      periodFrom: addDays(today(), -14),
      periodTo: today(),
      netPence: 60000,
    });
    addPurchaseLine(db, pi, {
      description: 'Sam Officer — week',
      workerId: worker,
      quantityMinutes: 40 * 60,
      unitPricePence: 1500,
      netPence: 60000,
    });

    const match = matchPurchaseToTimesheets(db, pi);
    expect(match.status).toBe('overbilled');
    expect(match.ourExpectedPence).toBe(56000);
    expect(match.variancePence).toBe(4000);
    expect(match.message).toMatch(/HIGHER/);
  });

  it('reports margin by client and assignment', () => {
    const db = freshDb();
    workedWeek(db);

    const report = marginReport(db, addDays(today(), -30), today());
    expect(report.totalChargePence).toBe(74000);
    expect(report.totalPayPence).toBe(56000);
    expect(report.totalMarginPence).toBe(18000);
    expect(report.marginPercent).toBe(24.3);
    expect(report.byClient[0].marginPerHourPence).toBe(450);
  });
});

describe('VAT', () => {
  it('issues invoices with no VAT and the correct wording while unregistered', () => {
    const db = freshDb();
    const { client, timesheet } = workedWeek(db);
    const invoice = createInvoiceFromTimesheets(db, { clientOrgId: client, timesheetIds: [timesheet] });
    issueInvoice(db, invoice);

    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoice) as any;
    expect(inv.vat_applied).toBe(0);
    expect(inv.vat_pence).toBe(0);
    expect(inv.vat_note).toMatch(/not registered for VAT/i);
    expect(inv.gross_pence).toBe(inv.net_pence);
  });

  it('applies 20% once registration takes effect, leaving earlier invoices untouched', () => {
    const db = freshDb();
    const before = workedWeek(db);
    const earlyInvoice = createInvoiceFromTimesheets(db, {
      clientOrgId: before.client,
      timesheetIds: [before.timesheet],
      issueDate: addDays(today(), -10),
    });
    issueInvoice(db, earlyInvoice);

    db.prepare(
      `UPDATE company SET vat_registered = 1, vat_number = 'GB123456789', vat_registered_from = ? WHERE id = 1`,
    ).run(addDays(today(), -5));

    const after = workedWeek(db);
    const lateInvoice = createInvoiceFromTimesheets(db, {
      clientOrgId: after.client,
      timesheetIds: [after.timesheet],
      issueDate: today(),
    });
    issueInvoice(db, lateInvoice);

    const early = db.prepare('SELECT * FROM invoices WHERE id = ?').get(earlyInvoice) as any;
    const late = db.prepare('SELECT * FROM invoices WHERE id = ?').get(lateInvoice) as any;

    expect(early.vat_pence).toBe(0);
    expect(late.vat_applied).toBe(1);
    expect(late.vat_pence).toBe(Math.round(late.net_pence * 0.2));
  });

  it('warns as rolling turnover approaches the registration threshold', () => {
    const db = freshDb();
    const client = makeOrg(db);

    // Twelve months of invoices totalling £85,000 net.
    for (let i = 0; i < 12; i++) {
      const w = workedWeek(db);
      const inv = createInvoiceFromTimesheets(db, {
        clientOrgId: w.client,
        timesheetIds: [w.timesheet],
        issueDate: addDays(today(), -i * 20),
      });
      issueInvoice(db, inv);
      db.prepare('UPDATE invoices SET base_net_pence = ? WHERE id = ?').run(708_333, inv);
    }

    const status = thresholdStatus(db);
    expect(status.rollingTwelveMonthPence).toBeGreaterThan(8_000_000);
    expect(['watch', 'urgent']).toContain(status.severity);
    expect(status.message).toMatch(/threshold/i);
  });
});
