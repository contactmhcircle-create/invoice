import type { Db } from '../db/connection.js';
import { addDays, today } from '../../shared/dates.js';
import { checkWorker, expiringCompliance } from './compliance.js';
import { thresholdStatus } from './vat.js';
import { upcomingFilings } from './statutory.js';
import { dueDiligenceStatus } from './supplyChain.js';

/**
 * The risk radar: one engine that re-reads the whole database and says what
 * could hurt the business right now, ordered by how much.
 *
 * Deliberately rule-based rather than a language model: every finding is a
 * query anyone can re-run, which is exactly the property a compliance monitor
 * needs when HMRC asks "how did you know". It runs on every dashboard load,
 * so nothing here may be slow.
 */

export type RiskSeverity = 'critical' | 'warning' | 'watch';

export interface RiskFinding {
  severity: RiskSeverity;
  area: string;        // short area tag shown as a chip: 'SIA', 'VAT', 'Debtors', …
  title: string;
  detail: string;
  action: string;
  page?: string;       // app page id the finding points at
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { critical: 0, warning: 1, watch: 2 };

export function riskRadar(db: Db): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const t = today();

  // --- Duplicate counterparties (double-billing / wrong-entity risk) -------
  const dupes = db.prepare(
    `SELECT COALESCE(NULLIF(company_number, ''), 'name:' || lower(name)) AS k,
            COUNT(*) AS n, MIN(name) AS name
     FROM organisations GROUP BY k HAVING n > 1`,
  ).all() as any[];
  for (const d of dupes) {
    findings.push({
      severity: 'warning', area: 'Records',
      title: `${d.name} appears ${d.n} times`,
      detail: 'Duplicate counterparty records split the history between entries and invite invoicing the wrong one.',
      action: 'Open Clients and delete the duplicate — the one with anything linked will refuse, keeping the right record.',
      page: 'clients',
    });
  }

  // --- Workforce compliance ------------------------------------------------
  const activeWorkers = db.prepare(
    `SELECT id, first_name, last_name, status FROM workers WHERE status IN ('active','onboarding')`,
  ).all() as any[];
  let blocked = 0;
  let vettedOnboarding = 0;
  for (const w of activeWorkers) {
    const report = checkWorker(db, w.id);
    if (report.blockers.length > 0 && w.status === 'active') blocked++;
    if (report.blockers.length === 0 && w.status === 'onboarding') vettedOnboarding++;
  }
  if (blocked > 0) {
    findings.push({
      severity: 'critical', area: 'Compliance',
      title: `${blocked} active worker(s) have compliance blockers`,
      detail: 'They cannot legally be placed on shift until the blockers clear — expired licences, missing right-to-work or incomplete screening.',
      action: 'Open Workers and resolve each red finding.',
      page: 'workers',
    });
  }
  if (vettedOnboarding > 0) {
    findings.push({
      severity: 'watch', area: 'Compliance',
      title: `${vettedOnboarding} fully-vetted worker(s) still marked onboarding`,
      detail: 'Vetting is complete but they will not appear when allocating shifts until they are active.',
      action: 'Open each worker and click Mark active.',
      page: 'workers',
    });
  }

  const expiring = expiringCompliance(db, 30) as any;
  const expLicences = expiring.licences?.length ?? 0;
  if (expLicences > 0) {
    findings.push({
      severity: 'warning', area: 'SIA',
      title: `${expLicences} SIA licence(s) expire within 30 days`,
      detail: 'A shift on a date past expiry will be refused at allocation; renewals take weeks, not days.',
      action: 'Chase renewals now and record the new licence when it arrives.',
      page: 'workers',
    });
  }

  // --- AWR 12-week clock ---------------------------------------------------
  const awrClose = db.prepare(
    `SELECT COUNT(DISTINCT worker_id || assignment_id) AS n FROM awr_weeks a
     WHERE cumulative BETWEEN 10 AND 11
       AND week_ending = (SELECT MAX(week_ending) FROM awr_weeks b
                          WHERE b.worker_id = a.worker_id AND b.assignment_id = a.assignment_id)`,
  ).get() as any;
  if (awrClose.n > 0) {
    findings.push({
      severity: 'warning', area: 'AWR',
      title: `${awrClose.n} placement(s) reach the AWR 12-week mark within a fortnight`,
      detail: 'From week 12 the worker is entitled to equal treatment on pay and conditions with a direct hire.',
      action: 'Confirm the comparator terms with the client before the clock completes.',
      page: 'workers',
    });
  }

  // --- Money ---------------------------------------------------------------
  const overdue = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(gross_pence - paid_pence), 0) AS pence
     FROM invoices WHERE status = 'overdue'`,
  ).get() as any;
  if (overdue.n > 0) {
    const old = db.prepare(
      `SELECT COUNT(*) AS n FROM invoices WHERE status = 'overdue' AND due_date < ?`,
    ).get(addDays(t, -60)) as any;
    findings.push({
      severity: old.n > 0 ? 'critical' : 'warning', area: 'Debtors',
      title: `£${(overdue.pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })} overdue across ${overdue.n} invoice(s)`,
      detail: old.n > 0
        ? `${old.n} of them are more than 60 days past due — recovery odds fall sharply from here.`
        : 'Statutory interest at Bank of England base + 8% is claimable on every one.',
      action: 'Send the reminders from the invoice screen; the interest calculation is ready on each invoice.',
      page: 'invoices',
    });
  }

  const staleUnbilled = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(charge_total_pence), 0) AS pence
     FROM timesheets WHERE status = 'approved' AND invoice_id IS NULL AND week_ending < ?`,
  ).get(addDays(t, -14)) as any;
  if (staleUnbilled.n > 0) {
    findings.push({
      severity: 'warning', area: 'Billing',
      title: `£${(staleUnbilled.pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })} of approved work is over two weeks unbilled`,
      detail: `${staleUnbilled.n} timesheet(s) are approved but not yet on an invoice — every week unbilled is a week added to payment terms.`,
      action: 'Open Sales invoices and bill the approved timesheets.',
      page: 'invoices',
    });
  }

  const vat = thresholdStatus(db);
  if (vat.severity === 'urgent' || vat.severity === 'watch') {
    findings.push({
      severity: vat.severity === 'urgent' ? 'critical' : 'watch', area: 'VAT',
      title: 'Rolling turnover is approaching the VAT registration threshold',
      detail: vat.message,
      action: 'Plan the registration date and price VAT into new quotes before it becomes mandatory.',
      page: 'statutory',
    });
  }

  // --- Evidence gaps (what an HMRC enquiry would flag) ---------------------
  const noScan = db.prepare(
    `SELECT COUNT(*) AS n FROM timesheets tsh
     WHERE tsh.status IN ('approved','invoiced')
       AND NOT EXISTS (SELECT 1 FROM documents d
                       WHERE d.entity_type = 'timesheet' AND d.entity_id = tsh.id
                         AND d.category = 'signed_timesheet')`,
  ).get() as any;
  if (noScan.n > 0) {
    findings.push({
      severity: 'warning', area: 'Evidence',
      title: `${noScan.n} billed or approved timesheet(s) have no signed scan attached`,
      detail: 'The enquiry pack will flag them, and a client dispute over those hours is hard to defend.',
      action: 'Photograph the paper sheets and attach them from the timesheet screen.',
      page: 'timesheets',
    });
  }

  const noChain = db.prepare(
    `SELECT COUNT(*) AS n FROM assignments a
     WHERE a.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM supply_chain_links l WHERE l.assignment_id = a.id)`,
  ).get() as any;
  if (noChain.n > 0) {
    findings.push({
      severity: 'warning', area: 'Supply chain',
      title: `${noChain.n} active assignment(s) have no supply chain mapped`,
      detail: 'Without the chain, PAYE responsibility for umbrella workers cannot be shown — the first thing HMRC asks a labour supplier.',
      action: 'Open each assignment and map the chain; it takes a minute per assignment.',
      page: 'clients',
    });
  }

  const clientOrgs = db.prepare(
    `SELECT DISTINCT o.id, o.name FROM organisations o
     JOIN assignments a ON a.client_org_id = o.id`,
  ).all() as any[];
  const missingDd = clientOrgs.filter((o) => !dueDiligenceStatus(db, o.id).complete);
  if (missingDd.length > 0) {
    findings.push({
      severity: 'warning', area: 'Due diligence',
      title: `${missingDd.length} counterpart${missingDd.length === 1 ? 'y' : 'ies'} missing Kittel due diligence`,
      detail: 'If a counterparty turns out to be connected to fraud, undocumented checks are what turns their problem into yours.',
      action: 'Record the four checks on each organisation: Companies House, VAT number, insurance, signed terms.',
      page: 'clients',
    });
  }

  // --- Rota ----------------------------------------------------------------
  const unfilled = db.prepare(
    `SELECT COUNT(*) AS n FROM shifts
     WHERE worker_id IS NULL AND status = 'planned' AND date(starts_at) BETWEEN ? AND ?`,
  ).get(t, addDays(t, 7)) as any;
  if (unfilled.n > 0) {
    findings.push({
      severity: 'warning', area: 'Rota',
      title: `${unfilled.n} shift(s) in the next 7 days are unfilled`,
      detail: 'An unfilled security shift is a contract breach with the client, not just lost revenue.',
      action: 'Open the Rota and allocate officers.',
      page: 'rota',
    });
  }

  // --- Filing deadlines ----------------------------------------------------
  for (const f of upcomingFilings(db, t, 30)) {
    findings.push({
      severity: f.overdue || f.daysUntilDue <= 7 ? 'critical' : 'watch', area: 'Filings',
      title: `${f.label} due ${f.dueOn}${f.overdue ? ' — LATE' : ''}`,
      detail: f.overdue
        ? 'The deadline has passed; penalties accrue from the due date.'
        : `${f.daysUntilDue} day(s) remain.`,
      action: 'Prepare it from the Statutory screen — the supporting figures are generated there.',
      page: 'statutory',
    });
  }

  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

// ---------------------------------------------------------------------------
// Dashboard analytics — the series behind the charts
// ---------------------------------------------------------------------------

function lastMonths(n: number): string[] {
  const [y, m] = today().split('-').map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export function dashboardAnalytics(db: Db) {
  const months = lastMonths(12);
  const first = `${months[0]}-01`;

  const invoiced = new Map<string, number>(
    (db.prepare(
      `SELECT substr(issue_date, 1, 7) AS m, SUM(base_net_pence) AS pence
       FROM invoices WHERE number IS NOT NULL AND status <> 'void' AND issue_date >= ?
       GROUP BY m`,
    ).all(first) as any[]).map((r) => [r.m, r.pence]),
  );

  const work = new Map<string, { charge: number; pay: number }>(
    (db.prepare(
      `SELECT substr(week_ending, 1, 7) AS m,
              SUM(charge_total_pence) AS charge, SUM(pay_total_pence) AS pay
       FROM timesheets WHERE status IN ('approved','invoiced') AND week_ending >= ?
       GROUP BY m`,
    ).all(first) as any[]).map((r) => [r.m, { charge: r.charge, pay: r.pay }]),
  );

  return {
    months: months.map((m) => ({
      month: m,
      invoicedPence: invoiced.get(m) ?? 0,
      chargePence: work.get(m)?.charge ?? 0,
      payPence: work.get(m)?.pay ?? 0,
      marginPence: (work.get(m)?.charge ?? 0) - (work.get(m)?.pay ?? 0),
    })),
  };
}
