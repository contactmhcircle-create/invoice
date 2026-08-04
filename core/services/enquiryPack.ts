import type { Db } from '../db/connection.js';
import { verifyAuditChain } from '../db/audit.js';
import { auditSequence } from './numbering.js';
import { trialBalance, profitAndLoss } from './ledger.js';
import { marginReport } from './purchases.js';
import { thresholdStatus } from './vat.js';
import { formatMoney } from '../../shared/money.js';
import { formatDateUK, hoursDecimal, today, nowInstant } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * The HMRC enquiry pack.
 *
 * Pick a date range, get everything: invoices, the timesheets behind them, the
 * signed scans, the workers who did the work, their compliance at the time, the
 * money in and out, the supply chain for each assignment, and a statement that
 * the audit trail is intact.
 *
 * The purpose is to turn a frightening letter into an afternoon's work. It is
 * also a useful self-check — running it and finding gaps is far better than
 * having someone else find them.
 */

export interface EnquiryPack {
  generatedAt: string;
  from: IsoDate;
  to: IsoDate;
  company: any;
  integrity: {
    auditChain: ReturnType<typeof verifyAuditChain>;
    invoiceSequence: ReturnType<typeof auditSequence>;
    creditNoteSequence: ReturnType<typeof auditSequence>;
    ledgerBalanced: boolean;
  };
  summary: {
    invoiceCount: number;
    totalNetPence: number;
    totalVatPence: number;
    totalGrossPence: number;
    totalReceivedPence: number;
    totalPurchasePence: number;
    totalPaidOutPence: number;
    workerCount: number;
    shiftCount: number;
    totalHours: number;
  };
  invoices: any[];
  purchases: any[];
  workers: any[];
  assignments: any[];
  payments: any[];
  gaps: string[];
  vat: ReturnType<typeof thresholdStatus>;
  margin: ReturnType<typeof marginReport>;
  profitAndLoss: ReturnType<typeof profitAndLoss>;
}

export function buildEnquiryPack(db: Db, from: IsoDate, to: IsoDate): EnquiryPack {
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;

  const invoices = db
    .prepare(
      `SELECT i.*, o.name AS client_name, o.company_number AS client_company_number
       FROM invoices i JOIN organisations o ON o.id = i.client_org_id
       WHERE i.issue_date BETWEEN ? AND ? ORDER BY i.number`,
    )
    .all(from, to) as any[];

  // Attach the evidence chain to every invoice.
  for (const inv of invoices) {
    inv.lines = db
      .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no')
      .all(inv.id);

    inv.timesheets = db
      .prepare(
        `SELECT DISTINCT t.id, t.reference, t.week_ending, t.total_minutes,
                t.client_signatory, t.client_signed_on, t.approved_by, t.approved_at,
                w.first_name, w.last_name, w.ni_number, w.engagement_type
         FROM invoice_lines il
         JOIN timesheets t ON t.id = il.timesheet_id
         JOIN workers w ON w.id = t.worker_id
         WHERE il.invoice_id = ?`,
      )
      .all(inv.id);

    for (const ts of inv.timesheets) {
      ts.documents = db
        .prepare(`SELECT filename, category, sha256, uploaded_at FROM documents
                  WHERE entity_type = 'timesheet' AND entity_id = ?`)
        .all(ts.id);
    }

    inv.payments = db
      .prepare(`SELECT * FROM payments WHERE invoice_id = ? AND direction = 'in'`)
      .all(inv.id);
  }

  const purchases = db
    .prepare(
      `SELECT p.*, o.name AS supplier, o.company_number AS supplier_company_number, o.vat_number AS supplier_vat
       FROM purchase_invoices p JOIN organisations o ON o.id = p.organisation_id
       WHERE p.invoice_date BETWEEN ? AND ? ORDER BY p.invoice_date`,
    )
    .all(from, to) as any[];

  const workers = db
    .prepare(
      `SELECT DISTINCT w.id, w.first_name, w.last_name, w.ni_number, w.date_of_birth,
              w.engagement_type, u.name AS umbrella_name, u.company_number AS umbrella_company_number
       FROM workers w
       LEFT JOIN organisations u ON u.id = w.umbrella_org_id
       JOIN shifts s ON s.worker_id = w.id
       WHERE date(s.starts_at) BETWEEN ? AND ?`,
    )
    .all(from, to) as any[];

  for (const w of workers) {
    w.licences = db
      .prepare('SELECT sector, licence_number, issued_on, expires_on, verified_on, status FROM worker_licences WHERE worker_id = ?')
      .all(w.id);
    w.rightToWork = db
      .prepare('SELECT method, checked_on, outcome, expires_on FROM worker_rtw WHERE worker_id = ? ORDER BY checked_on DESC')
      .all(w.id);
    w.screening = db
      .prepare('SELECT element, status, completed_on, covers_from, covers_to FROM screening_checks WHERE worker_id = ?')
      .all(w.id);
    w.shiftsInPeriod = (db
      .prepare(`SELECT COUNT(*) AS n FROM shifts WHERE worker_id = ? AND date(starts_at) BETWEEN ? AND ?`)
      .get(w.id, from, to) as any).n;
  }

  const assignments = db
    .prepare(
      `SELECT DISTINCT a.*, o.name AS client_name
       FROM assignments a
       JOIN organisations o ON o.id = a.client_org_id
       JOIN shifts s ON s.assignment_id = a.id
       WHERE date(s.starts_at) BETWEEN ? AND ?`,
    )
    .all(from, to) as any[];

  for (const a of assignments) {
    a.supplyChain = db
      .prepare(
        `SELECT l.position, l.role, l.description, l.contract_ref,
                o.name AS organisation_name, o.company_number, o.vat_number
         FROM supply_chain_links l
         LEFT JOIN organisations o ON o.id = l.organisation_id
         WHERE l.assignment_id = ? ORDER BY l.position`,
      )
      .all(a.id);
  }

  const payments = db
    .prepare(`SELECT * FROM payments WHERE paid_on BETWEEN ? AND ? ORDER BY paid_on`)
    .all(from, to) as any[];

  const shiftStats = db
    .prepare(
      `SELECT COUNT(*) AS shifts,
              COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 24 * 60 - break_minutes),0) AS minutes
       FROM shifts WHERE date(starts_at) BETWEEN ? AND ? AND status IN ('worked','allocated')`,
    )
    .get(from, to) as any;

  const tb = trialBalance(db, to);

  // --- Self-check: what would an inspector notice? -------------------------
  const gaps: string[] = [];

  const unsignedTimesheets = db
    .prepare(
      `SELECT COUNT(*) AS n FROM timesheets t
       WHERE t.week_ending BETWEEN ? AND ? AND t.status IN ('approved','invoiced')
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.entity_type = 'timesheet'
                          AND d.entity_id = t.id AND d.category = 'signed_timesheet')`,
    )
    .get(from, to) as any;
  if (unsignedTimesheets.n > 0) {
    gaps.push(
      `${unsignedTimesheets.n} approved timesheet(s) in this period have no signed scan attached. ` +
        'Revenue without the signed sheet behind it is the hardest kind to defend.',
    );
  }

  const noSupplyChain = assignments.filter((a) => a.supplyChain.length === 0);
  if (noSupplyChain.length > 0) {
    gaps.push(
      `${noSupplyChain.length} assignment(s) worked in this period have no supply chain map recorded: ` +
        noSupplyChain.map((a) => a.title).join(', ') + '.',
    );
  }

  const noDueDiligence = db
    .prepare(
      `SELECT o.name FROM organisations o
       WHERE o.is_client = 1
         AND EXISTS (SELECT 1 FROM assignments a JOIN shifts s ON s.assignment_id = a.id
                      WHERE a.client_org_id = o.id AND date(s.starts_at) BETWEEN ? AND ?)
         AND NOT EXISTS (SELECT 1 FROM org_due_diligence d WHERE d.organisation_id = o.id)`,
    )
    .all(from, to) as any[];
  if (noDueDiligence.length > 0) {
    gaps.push(
      `No due diligence recorded for ${noDueDiligence.length} counterparty/counterparties worked with in ` +
        `this period: ${noDueDiligence.map((o) => o.name).join(', ')}. In a labour supply chain, undocumented ` +
        'checks are what turn another party’s fraud into your liability.',
    );
  }

  const nonCompliantShifts = db
    .prepare(
      `SELECT COUNT(*) AS n FROM shifts s
       JOIN workers w ON w.id = s.worker_id
       WHERE date(s.starts_at) BETWEEN ? AND ?
         AND NOT EXISTS (SELECT 1 FROM worker_licences l WHERE l.worker_id = w.id
                          AND l.status = 'valid' AND l.expires_on >= date(s.starts_at))`,
    )
    .get(from, to) as any;
  if (nonCompliantShifts.n > 0) {
    gaps.push(
      `${nonCompliantShifts.n} shift(s) in this period were worked by someone with no valid SIA licence on ` +
        'that date. Investigate each one — this is the finding that ends contracts.',
    );
  }

  const directorReceipts = payments.filter((p) => p.via_director_loan);
  if (directorReceipts.length > 0) {
    gaps.push(
      `${directorReceipts.length} payment(s) were received into a director's personal account and passed to ` +
        'the company. This is documented here, which is what matters — but change the bank details held by ' +
        'those clients so it does not recur.',
    );
  }

  const chainCheck = verifyAuditChain(db);
  if (!chainCheck.ok) {
    gaps.push(`AUDIT TRAIL BROKEN: ${chainCheck.reason} The record cannot be relied on from that point.`);
  }

  return {
    generatedAt: nowInstant(),
    from,
    to,
    company,
    integrity: {
      auditChain: chainCheck,
      invoiceSequence: auditSequence(db, 'invoice'),
      creditNoteSequence: auditSequence(db, 'credit_note'),
      ledgerBalanced: tb.balanced,
    },
    summary: {
      invoiceCount: invoices.length,
      totalNetPence: invoices.reduce((a, i) => a + i.base_net_pence, 0),
      totalVatPence: invoices.reduce((a, i) => a + i.base_vat_pence, 0),
      totalGrossPence: invoices.reduce((a, i) => a + i.base_gross_pence, 0),
      totalReceivedPence: payments.filter((p) => p.direction === 'in').reduce((a, p) => a + p.amount_pence, 0),
      totalPurchasePence: purchases.reduce((a, p) => a + p.net_pence, 0),
      totalPaidOutPence: payments.filter((p) => p.direction === 'out').reduce((a, p) => a + p.amount_pence, 0),
      workerCount: workers.length,
      shiftCount: shiftStats.shifts,
      totalHours: hoursDecimal(shiftStats.minutes),
    },
    invoices,
    purchases,
    workers,
    assignments,
    payments,
    gaps,
    vat: thresholdStatus(db, to),
    margin: marginReport(db, from, to),
    profitAndLoss: profitAndLoss(db, from, to),
  };
}

/** Renders the pack as a self-contained HTML document for printing or PDF. */
export function renderEnquiryPackHtml(pack: EnquiryPack): string {
  const c = pack.company ?? {};
  const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"]/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);

  const integrityBanner = pack.integrity.auditChain.ok
    ? `<div class="ok"><strong>Audit trail verified intact.</strong> ${pack.integrity.auditChain.entriesChecked}
       entries checked; every entry cryptographically seals the one before it.</div>`
    : `<div class="bad"><strong>Audit trail broken.</strong> ${esc(pack.integrity.auditChain.reason)}</div>`;

  const gapsSection = pack.gaps.length
    ? `<h2>Points to address</h2><ul class="gaps">${pack.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>`
    : `<h2>Points to address</h2><p class="ok">No gaps detected in this period.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Enquiry pack ${pack.from} to ${pack.to}</title>
<style>
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin-top: 28px; border-bottom: 2px solid #1e3a5f; padding-bottom: 4px; }
  h3 { font-size: 14px; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12px; }
  th, td { border: 1px solid #d4d4d4; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f2f5f8; font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .ok { background: #e8f5e9; border-left: 4px solid #2e7d32; padding: 10px 12px; margin: 12px 0; }
  .bad { background: #ffebee; border-left: 4px solid #c62828; padding: 10px 12px; margin: 12px 0; }
  .gaps li { margin-bottom: 8px; }
  .meta { color: #555; font-size: 12px; }
  .chain { font-size: 11px; color: #444; margin-left: 14px; }
  @media print { body { margin: 12mm; } h2 { page-break-after: avoid; } table { page-break-inside: auto; } }
</style></head><body>

<h1>${esc(c.legal_name ?? 'Cerviz Ltd')} — records for enquiry</h1>
<p class="meta">
  Period ${formatDateUK(pack.from)} to ${formatDateUK(pack.to)} &middot;
  Generated ${new Date(pack.generatedAt).toLocaleString('en-GB')}<br>
  ${c.company_number ? `Company number ${esc(c.company_number)} &middot; ` : ''}
  ${c.vat_number ? `VAT number ${esc(c.vat_number)}` : 'Not registered for VAT'}
</p>

${integrityBanner}

<h2>Summary</h2>
<table>
  <tr><th>Invoices issued</th><td class="num">${pack.summary.invoiceCount}</td>
      <th>Total invoiced (net)</th><td class="num">${formatMoney(pack.summary.totalNetPence)}</td></tr>
  <tr><th>VAT charged</th><td class="num">${formatMoney(pack.summary.totalVatPence)}</td>
      <th>Total invoiced (gross)</th><td class="num">${formatMoney(pack.summary.totalGrossPence)}</td></tr>
  <tr><th>Received from clients</th><td class="num">${formatMoney(pack.summary.totalReceivedPence)}</td>
      <th>Purchase invoices</th><td class="num">${formatMoney(pack.summary.totalPurchasePence)}</td></tr>
  <tr><th>Workers supplied</th><td class="num">${pack.summary.workerCount}</td>
      <th>Shifts worked</th><td class="num">${pack.summary.shiftCount} (${pack.summary.totalHours} hrs)</td></tr>
  <tr><th>Gross margin</th><td class="num">${formatMoney(pack.margin.totalMarginPence)}</td>
      <th>Margin %</th><td class="num">${pack.margin.marginPercent}%</td></tr>
</table>

<h2>Document sequence integrity</h2>
<table>
  <tr><th>Series</th><th>Allocated</th><th>Range</th><th>Missing</th><th>Status</th></tr>
  <tr><td>Invoices</td><td class="num">${pack.integrity.invoiceSequence.allocated}</td>
      <td>${pack.integrity.invoiceSequence.lowest ?? '—'}–${pack.integrity.invoiceSequence.highest ?? '—'}</td>
      <td>${pack.integrity.invoiceSequence.missing.join(', ') || 'none'}</td>
      <td>${pack.integrity.invoiceSequence.intact ? 'Gapless' : 'GAPS FOUND'}</td></tr>
  <tr><td>Credit notes</td><td class="num">${pack.integrity.creditNoteSequence.allocated}</td>
      <td>${pack.integrity.creditNoteSequence.lowest ?? '—'}–${pack.integrity.creditNoteSequence.highest ?? '—'}</td>
      <td>${pack.integrity.creditNoteSequence.missing.join(', ') || 'none'}</td>
      <td>${pack.integrity.creditNoteSequence.intact ? 'Gapless' : 'GAPS FOUND'}</td></tr>
</table>
<p class="meta">Voided invoices retain their number and remain listed, which is what makes the series
provably gapless rather than merely tidy.</p>

${gapsSection}

<h2>Sales invoices and their evidence</h2>
${pack.invoices.map((i) => `
  <h3>${esc(i.number ?? '(draft)')} — ${esc(i.client_name)} — ${formatMoney(i.gross_pence, i.currency)}${i.status === 'void' ? ' <strong>[VOID]</strong>' : ''}</h3>
  <p class="meta">Issued ${formatDateUK(i.issue_date)} &middot; due ${formatDateUK(i.due_date)} &middot;
     status ${esc(i.status)} &middot; paid ${formatMoney(i.paid_pence, i.currency)}
     ${i.void_reason ? `<br>Void reason: ${esc(i.void_reason)}` : ''}</p>
  ${i.timesheets.map((t: any) => `
    <div class="chain">
      Backing: timesheet ${esc(t.reference)} — ${esc(t.first_name)} ${esc(t.last_name)},
      week ending ${formatDateUK(t.week_ending)}, ${hoursDecimal(t.total_minutes)} hrs,
      signed by ${esc(t.client_signatory ?? 'not recorded')} on ${formatDateUK(t.client_signed_on)}.
      Scans: ${t.documents.length ? t.documents.map((d: any) => `${esc(d.filename)} (sha256 ${esc(String(d.sha256).slice(0, 12))}…)`).join(', ') : '<strong>none attached</strong>'}
    </div>`).join('')}
`).join('')}

<h2>Workers supplied and their compliance</h2>
<table>
  <tr><th>Worker</th><th>NI number</th><th>Engagement</th><th>Umbrella</th>
      <th>SIA licence</th><th>Right to work</th><th>Screening</th><th>Shifts</th></tr>
  ${pack.workers.map((w) => {
    const lic = w.licences[0];
    const rtw = w.rightToWork[0];
    const satisfied = w.screening.filter((s: any) => s.status === 'satisfied' || s.status === 'waived').length;
    return `<tr>
      <td>${esc(w.first_name)} ${esc(w.last_name)}</td>
      <td>${esc(w.ni_number ?? '—')}</td>
      <td>${esc(w.engagement_type)}</td>
      <td>${esc(w.umbrella_name ?? '—')}${w.umbrella_company_number ? ` (${esc(w.umbrella_company_number)})` : ''}</td>
      <td>${lic ? `${esc(lic.licence_number)}<br>${esc(lic.sector)}<br>expires ${formatDateUK(lic.expires_on)}` : '<strong>none</strong>'}</td>
      <td>${rtw ? `${esc(rtw.outcome)}<br>checked ${formatDateUK(rtw.checked_on)}` : '<strong>none</strong>'}</td>
      <td>${satisfied}/${w.screening.length} BS 7858</td>
      <td class="num">${w.shiftsInPeriod}</td>
    </tr>`;
  }).join('')}
</table>

<h2>Labour supply chain by assignment</h2>
${pack.assignments.map((a) => `
  <h3>${esc(a.title)} — ${esc(a.client_name)}</h3>
  ${a.supplyChain.length
    ? `<table><tr><th>Position</th><th>Role</th><th>Party</th><th>Company number</th><th>VAT number</th><th>Contract ref</th></tr>
       ${a.supplyChain.map((l: any) => `<tr>
         <td class="num">${l.position}</td><td>${esc(l.role.replace(/_/g, ' '))}</td>
         <td>${esc(l.organisation_name ?? l.description ?? '—')}</td>
         <td>${esc(l.company_number ?? '—')}</td><td>${esc(l.vat_number ?? '—')}</td>
         <td>${esc(l.contract_ref ?? '—')}</td></tr>`).join('')}</table>`
    : '<p class="bad">No supply chain recorded for this assignment.</p>'}
`).join('')}

<h2>Purchase invoices</h2>
<table>
  <tr><th>Our ref</th><th>Supplier</th><th>Their ref</th><th>Date</th>
      <th class="num">Net</th><th class="num">Expected</th><th class="num">Variance</th><th>Status</th></tr>
  ${pack.purchases.map((p) => `<tr>
    <td>${esc(p.our_reference)}</td><td>${esc(p.supplier)}</td><td>${esc(p.their_reference ?? '—')}</td>
    <td>${formatDateUK(p.invoice_date)}</td>
    <td class="num">${formatMoney(p.net_pence)}</td>
    <td class="num">${p.expected_pence != null ? formatMoney(p.expected_pence) : '—'}</td>
    <td class="num">${p.variance_pence != null ? formatMoney(p.variance_pence) : '—'}</td>
    <td>${esc(p.status)}</td></tr>`).join('')}
</table>

<h2>Money movements</h2>
<table>
  <tr><th>Date</th><th>Direction</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Notes</th></tr>
  ${pack.payments.map((p) => `<tr>
    <td>${formatDateUK(p.paid_on)}</td><td>${p.direction === 'in' ? 'Received' : 'Paid'}</td>
    <td class="num">${formatMoney(p.amount_pence, p.currency)}</td>
    <td>${esc(p.method)}${p.via_director_loan ? ' <strong>(via director account)</strong>' : ''}</td>
    <td>${esc(p.reference ?? '—')}</td><td>${esc(p.notes ?? '')}</td></tr>`).join('')}
</table>

<h2>Profit and loss for the period</h2>
<table>
  <tr><th>Revenue</th><td class="num">${formatMoney(pack.profitAndLoss.totalIncomePence)}</td></tr>
  <tr><th>Cost of sales (labour)</th><td class="num">${formatMoney(pack.profitAndLoss.totalCostOfSalesPence)}</td></tr>
  <tr><th>Gross profit</th><td class="num">${formatMoney(pack.profitAndLoss.grossProfitPence)} (${pack.profitAndLoss.grossMarginPercent}%)</td></tr>
  <tr><th>Overheads</th><td class="num">${formatMoney(pack.profitAndLoss.totalOverheadsPence)}</td></tr>
  <tr><th>Net profit</th><td class="num">${formatMoney(pack.profitAndLoss.netProfitPence)}</td></tr>
</table>

<h2>VAT position</h2>
<p>${esc(pack.vat.message)}</p>
<p class="meta">Rolling 12-month turnover to ${formatDateUK(pack.to)}:
   ${formatMoney(pack.vat.rollingTwelveMonthPence)} against a £90,000 threshold
   (${pack.vat.percentOfThreshold}%).</p>

<p class="meta" style="margin-top:32px">
  Prepared by Cerviz Back Office. Every figure above is derived from source records held in the
  application: invoices from approved timesheets, timesheets from signed paper sheets, and shifts from
  the allocation record. The audit trail covering all of it is hash-chained and was verified at the
  time this pack was generated.
</p>
</body></html>`;
}
