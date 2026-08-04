import type { Db } from '../db/connection.js';
import { addMonths, addDays, today } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * VAT.
 *
 * Cerviz is not VAT registered yet, so the engine is built and dormant: invoices
 * carry no VAT and show the correct "not VAT registered" wording. When the
 * company registers, Settings gets a VAT number and an effective date, and every
 * invoice dated on or after that date carries VAT automatically. Historic
 * invoices are untouched.
 *
 * The threshold matters more here than in most businesses. An employment
 * business supplying temporary workers accounts for VAT on the FULL charge to
 * the client, including the wages element — the staff hire concession that once
 * allowed margin-only VAT was withdrawn in 2009. So Cerviz's VAT turnover is
 * effectively its whole invoiced revenue, and the threshold arrives fast.
 */

export const VAT_REGISTRATION_THRESHOLD_PENCE = 9_000_000; // £90,000
export const STANDARD_RATE = 20;

export type VatCode =
  | 'none'
  | 'standard'
  | 'reduced'
  | 'zero'
  | 'exempt'
  | 'outside_scope'
  | 'reverse_charge';

export interface VatPolicy {
  applies: boolean;
  code: VatCode;
  ratePercent: number;
  /** Wording that must appear on the invoice. */
  note: string | null;
}

export function vatPolicyFor(db: Db, issueDate: IsoDate, clientCountry = 'United Kingdom'): VatPolicy {
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;

  const registered =
    !!company?.vat_registered &&
    (!company.vat_registered_from || issueDate >= company.vat_registered_from);

  if (!registered) {
    return {
      applies: false,
      code: 'none',
      ratePercent: 0,
      note: 'Cerviz Ltd is not registered for VAT. No VAT has been charged on this invoice.',
    };
  }

  if (clientCountry && clientCountry !== 'United Kingdom') {
    return {
      applies: false,
      code: 'outside_scope',
      ratePercent: 0,
      note:
        'Supply of staff to a business customer outside the UK — outside the scope of UK VAT. ' +
        'The customer accounts for VAT under the reverse charge in their own country.',
    };
  }

  return { applies: true, code: 'standard', ratePercent: STANDARD_RATE, note: null };
}

export interface ThresholdStatus {
  asOf: IsoDate;
  rollingTwelveMonthPence: number;
  thresholdPence: number;
  percentOfThreshold: number;
  registered: boolean;
  /** Set when the rolling total has already crossed the threshold. */
  breachedOn: IsoDate | null;
  registerBy: IsoDate | null;
  effectiveFrom: IsoDate | null;
  message: string;
  severity: 'ok' | 'watch' | 'urgent' | 'breached';
}

/**
 * Rolling 12-month taxable turnover test.
 *
 * If turnover in any rolling 12 months exceeds the threshold, registration must
 * happen within 30 days of the end of that month, and VAT is charged from the
 * first day of the month after that. Missing it means owing VAT you never
 * collected from the client — which comes straight out of margin.
 */
export function thresholdStatus(db: Db, asOf: IsoDate = today()): ThresholdStatus {
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  const registered = !!company?.vat_registered;

  const from = addMonths(asOf, -12);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(base_net_pence), 0) AS total
       FROM invoices
       WHERE status IN ('issued','part_paid','paid','overdue')
         AND issue_date > ? AND issue_date <= ?`,
    )
    .get(from, asOf) as { total: number };

  const total = row.total;
  const percent = Math.round((total / VAT_REGISTRATION_THRESHOLD_PENCE) * 1000) / 10;

  // Find the first month-end at which the rolling total crossed the threshold.
  let breachedOn: IsoDate | null = null;
  if (total >= VAT_REGISTRATION_THRESHOLD_PENCE) {
    const months = db
      .prepare(
        `SELECT DISTINCT substr(issue_date, 1, 7) AS ym FROM invoices
         WHERE status IN ('issued','part_paid','paid','overdue') ORDER BY ym ASC`,
      )
      .all() as Array<{ ym: string }>;
    for (const { ym } of months) {
      const monthEnd = lastDayOfMonth(ym);
      const windowFrom = addMonths(monthEnd, -12);
      const r = db
        .prepare(
          `SELECT COALESCE(SUM(base_net_pence),0) AS total FROM invoices
           WHERE status IN ('issued','part_paid','paid','overdue')
             AND issue_date > ? AND issue_date <= ?`,
        )
        .get(windowFrom, monthEnd) as { total: number };
      if (r.total >= VAT_REGISTRATION_THRESHOLD_PENCE) {
        breachedOn = monthEnd;
        break;
      }
    }
  }

  const registerBy = breachedOn ? addDays(breachedOn, 30) : null;
  const effectiveFrom = breachedOn ? firstDayOfMonthAfter(addDays(breachedOn, 30)) : null;

  let severity: ThresholdStatus['severity'] = 'ok';
  let message: string;

  if (registered) {
    severity = 'ok';
    message = 'Registered for VAT. Threshold monitoring is not applicable.';
  } else if (breachedOn) {
    severity = 'breached';
    message =
      `Rolling 12-month turnover passed £90,000 at ${breachedOn}. Registration was required by ` +
      `${registerBy}, with VAT chargeable from ${effectiveFrom}. Act on this immediately — VAT is ` +
      'owed on supplies from the effective date whether or not it was charged to clients.';
  } else if (percent >= 90) {
    severity = 'urgent';
    message =
      `Rolling 12-month turnover is ${percent}% of the £90,000 threshold. Registration is imminent — ` +
      'start the process now so VAT can be added to client rates before it becomes a cost to you.';
  } else if (percent >= 75) {
    severity = 'watch';
    message =
      `Rolling 12-month turnover is ${percent}% of the £90,000 threshold. Remember that as an employment ` +
      'business you account for VAT on the full charge including the wages element, so this rises quickly.';
  } else {
    message = `Rolling 12-month turnover is ${percent}% of the £90,000 threshold.`;
  }

  return {
    asOf,
    rollingTwelveMonthPence: total,
    thresholdPence: VAT_REGISTRATION_THRESHOLD_PENCE,
    percentOfThreshold: percent,
    registered,
    breachedOn,
    registerBy,
    effectiveFrom,
    message,
    severity,
  };
}

function lastDayOfMonth(ym: string): IsoDate {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function firstDayOfMonthAfter(date: IsoDate): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** VAT return worksheet, boxes 1–9. Dormant until registration, but ready. */
export function vatReturnWorksheet(db: Db, periodFrom: IsoDate, periodTo: IsoDate) {
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  const cashBasis = company?.vat_basis === 'cash';

  const sales = db
    .prepare(
      cashBasis
        ? `SELECT COALESCE(SUM(i.base_vat_pence),0) AS vat, COALESCE(SUM(i.base_net_pence),0) AS net
           FROM invoices i
           WHERE i.status IN ('paid','part_paid')
             AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id
                          AND p.paid_on BETWEEN ? AND ?)`
        : `SELECT COALESCE(SUM(base_vat_pence),0) AS vat, COALESCE(SUM(base_net_pence),0) AS net
           FROM invoices
           WHERE status IN ('issued','part_paid','paid','overdue')
             AND tax_point_date BETWEEN ? AND ?`,
    )
    .get(periodFrom, periodTo) as any;

  const purchases = db
    .prepare(
      `SELECT COALESCE(SUM(vat_pence),0) AS vat, COALESCE(SUM(net_pence),0) AS net
       FROM purchase_invoices
       WHERE status <> 'void' AND invoice_date BETWEEN ? AND ?`,
    )
    .get(periodFrom, periodTo) as any;

  const box1 = sales.vat;
  const box3 = box1;
  const box4 = purchases.vat;

  return {
    periodFrom,
    periodTo,
    basis: cashBasis ? 'cash' : 'accrual',
    box1_vatDueOnSales: box1,
    box2_vatDueOnAcquisitions: 0,
    box3_totalVatDue: box3,
    box4_vatReclaimed: box4,
    box5_netVatDue: box3 - box4,
    box6_totalSalesExVat: sales.net,
    box7_totalPurchasesExVat: purchases.net,
    box8_totalSupplies: 0,
    box9_totalAcquisitions: 0,
  };
}
