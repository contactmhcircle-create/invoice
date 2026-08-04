import type { Db } from '../db/connection.js';
import { invoiceWithDetail } from './invoices.js';
import { formatMoney } from '../../shared/money.js';
import { formatDateUK, hoursDecimal } from '../../shared/dates.js';

/**
 * The invoice as the client sees it.
 *
 * A UK invoice from a limited company must show the company name, registered
 * office, registered number and — once registered — the VAT number and a VAT
 * breakdown. Cerviz is not VAT registered yet, so the document says so plainly
 * rather than leaving the client to wonder.
 *
 * The shift-level backing schedule is what makes this an agency invoice rather
 * than a generic one: the client can see exactly who worked, when, for how long
 * and at what rate, which is what stops queries before they start.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);

export function renderInvoiceHtml(db: Db, invoiceId: string): string {
  const inv = invoiceWithDetail(db, invoiceId);
  if (!inv) throw new Error('Invoice not found');

  const c = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  const brand = c?.brand_colour || '#1e3a5f';

  const companyAddress = [c?.registered_address_1, c?.registered_address_2, c?.registered_city, c?.registered_postcode]
    .filter(Boolean).map(esc).join('<br>');

  const clientAddress = [inv.address_1, inv.address_2, inv.city, inv.postcode, inv.country !== 'United Kingdom' ? inv.country : null]
    .filter(Boolean).map(esc).join('<br>');

  // Group lines by worker so a rota of eight officers reads as eight blocks
  // rather than forty undifferentiated rows.
  const byWorker = new Map<string, any[]>();
  for (const l of inv.lines) {
    const key = l.worker_id ?? 'other';
    if (!byWorker.has(key)) byWorker.set(key, []);
    byWorker.get(key)!.push(l);
  }

  const workerNames = new Map<string, string>();
  for (const key of byWorker.keys()) {
    if (key === 'other') continue;
    const w = db.prepare('SELECT first_name, last_name FROM workers WHERE id = ?').get(key) as any;
    if (w) workerNames.set(key, `${w.first_name} ${w.last_name}`);
  }

  const scheduleRows = [...byWorker.entries()].map(([workerId, lines]) => {
    const name = workerNames.get(workerId) ?? 'Services';
    const subtotal = lines.reduce((a: number, l: any) => a + l.net_pence, 0);
    const minutes = lines.reduce((a: number, l: any) => a + (l.quantity_minutes ?? 0), 0);

    return `
      <tr class="worker-row">
        <td colspan="5"><strong>${esc(name)}</strong> — ${hoursDecimal(minutes)} hrs</td>
        <td class="num"><strong>${formatMoney(subtotal, inv.currency)}</strong></td>
      </tr>
      ${lines.map((l: any) => `
        <tr class="detail">
          <td>${formatDateUK(l.work_date)}</td>
          <td colspan="2">${esc(stripName(l.description, name))}</td>
          <td class="num">${hoursDecimal(l.quantity_minutes ?? 0)}</td>
          <td class="num">${formatMoney(l.unit_price_pence, inv.currency)}</td>
          <td class="num">${formatMoney(l.net_pence, inv.currency)}</td>
        </tr>`).join('')}`;
  }).join('');

  const vatSection = inv.vat_applied
    ? `<tr><td>VAT at 20%</td><td class="num">${formatMoney(inv.vat_pence, inv.currency)}</td></tr>`
    : '';

  const backingNote = inv.backingTimesheets.length
    ? `<div class="backing">
         <strong>Supporting timesheets</strong><br>
         ${inv.backingTimesheets.map((t: any) =>
           `${esc(t.reference)} — ${esc(t.first_name)} ${esc(t.last_name)}, week ending ${formatDateUK(t.week_ending)}, ` +
           `${hoursDecimal(t.total_minutes)} hrs, signed by ${esc(t.client_signatory ?? 'site')} on ${formatDateUK(t.client_signed_on)}`
         ).join('<br>')}
       </div>`
    : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(inv.number ?? 'Draft invoice')}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, sans-serif; color: #1a1a1a; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid ${brand}; padding-bottom: 14px; }
  .company-name { font-size: 24px; font-weight: 700; color: ${brand}; letter-spacing: -0.3px; }
  .doc-title { font-size: 26px; font-weight: 700; color: ${brand}; text-align: right; }
  .doc-number { font-size: 14px; color: #444; text-align: right; margin-top: 2px; }
  .parties { display: flex; gap: 32px; margin-top: 22px; }
  .party { flex: 1; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.7px; color: #6b7280; margin-bottom: 4px; }
  .facts { margin-top: 18px; width: 100%; border-collapse: collapse; }
  .facts td { padding: 3px 0; }
  .facts .k { color: #6b7280; width: 120px; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 22px; }
  table.lines th { background: ${brand}; color: #fff; padding: 7px 8px; font-size: 10px;
                   text-transform: uppercase; letter-spacing: 0.5px; text-align: left; }
  table.lines td { padding: 5px 8px; border-bottom: 1px solid #e8e8e8; }
  tr.worker-row td { background: #f4f6f9; border-top: 1px solid #d8dee6; }
  tr.detail td { font-size: 11px; color: #444; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-top: 16px; margin-left: auto; width: 300px; border-collapse: collapse; }
  .totals td { padding: 5px 8px; }
  .totals tr.grand td { border-top: 2px solid ${brand}; font-size: 15px; font-weight: 700; color: ${brand}; }
  .pay { margin-top: 26px; background: #f4f6f9; border-left: 4px solid ${brand}; padding: 12px 14px; }
  .vat-note { margin-top: 14px; font-size: 11px; color: #555; font-style: italic; }
  .backing { margin-top: 18px; font-size: 10px; color: #666; border-top: 1px solid #e8e8e8; padding-top: 10px; }
  .footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #e0e0e0; font-size: 9.5px; color: #777; }
  .void { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%) rotate(-24deg);
          font-size: 110px; font-weight: 800; color: rgba(198,40,40,0.14); letter-spacing: 6px; }
</style></head><body>

${inv.status === 'void' ? '<div class="void">VOID</div>' : ''}

<div class="head">
  <div>
    <div class="company-name">${esc(c?.trading_name || c?.legal_name || 'Cerviz Ltd')}</div>
    <div style="margin-top:6px;color:#555">${companyAddress}</div>
    ${c?.phone ? `<div style="color:#555">${esc(c.phone)}</div>` : ''}
    ${c?.email ? `<div style="color:#555">${esc(c.email)}</div>` : ''}
  </div>
  <div>
    <div class="doc-title">INVOICE</div>
    <div class="doc-number">${esc(inv.number ?? 'DRAFT — not yet issued')}</div>
  </div>
</div>

<div class="parties">
  <div class="party">
    <div class="label">Invoice to</div>
    <strong>${esc(inv.client_legal_name || inv.client_name)}</strong><br>
    ${clientAddress}
    ${inv.client_company_number ? `<br><span style="color:#6b7280">Company no. ${esc(inv.client_company_number)}</span>` : ''}
    ${inv.client_vat_number ? `<br><span style="color:#6b7280">VAT no. ${esc(inv.client_vat_number)}</span>` : ''}
  </div>
  <div class="party">
    <table class="facts">
      <tr><td class="k">Invoice date</td><td>${formatDateUK(inv.issue_date)}</td></tr>
      <tr><td class="k">Tax point</td><td>${formatDateUK(inv.tax_point_date)}</td></tr>
      <tr><td class="k">Payment due</td><td><strong>${formatDateUK(inv.due_date)}</strong></td></tr>
      ${inv.po_reference ? `<tr><td class="k">Your PO</td><td>${esc(inv.po_reference)}</td></tr>` : ''}
      ${inv.period_from ? `<tr><td class="k">Period</td><td>${formatDateUK(inv.period_from)} – ${formatDateUK(inv.period_to)}</td></tr>` : ''}
      ${inv.currency !== 'GBP' ? `<tr><td class="k">Currency</td><td>${esc(inv.currency)} (rate ${inv.fx_rate})</td></tr>` : ''}
    </table>
  </div>
</div>

<table class="lines">
  <thead><tr>
    <th style="width:80px">Date</th><th colspan="2">Description</th>
    <th class="num" style="width:60px">Hours</th>
    <th class="num" style="width:80px">Rate</th>
    <th class="num" style="width:90px">Amount</th>
  </tr></thead>
  <tbody>${scheduleRows}</tbody>
</table>

<table class="totals">
  <tr><td>Subtotal</td><td class="num">${formatMoney(inv.net_pence, inv.currency)}</td></tr>
  ${vatSection}
  <tr class="grand"><td>Total due</td><td class="num">${formatMoney(inv.gross_pence, inv.currency)}</td></tr>
  ${inv.paid_pence > 0 ? `
    <tr><td>Paid</td><td class="num">${formatMoney(inv.paid_pence, inv.currency)}</td></tr>
    <tr class="grand"><td>Outstanding</td><td class="num">${formatMoney(inv.outstandingPence, inv.currency)}</td></tr>` : ''}
</table>

${inv.vat_note ? `<div class="vat-note">${esc(inv.vat_note)}</div>` : ''}

<div class="pay">
  <strong>Payment details</strong><br>
  ${c?.bank_account_name ? `Account name: ${esc(c.bank_account_name)}<br>` : ''}
  ${c?.bank_sort_code ? `Sort code: ${esc(c.bank_sort_code)}<br>` : ''}
  ${c?.bank_account_number ? `Account number: ${esc(c.bank_account_number)}<br>` : ''}
  ${c?.bank_iban ? `IBAN: ${esc(c.bank_iban)}<br>` : ''}
  <strong>Please quote reference ${esc(inv.number ?? '')}</strong><br>
  <span style="color:#555">Payment terms: ${formatDateUK(inv.due_date)}. Late payment may incur statutory
  interest at the Bank of England base rate plus 8% together with fixed compensation under the
  Late Payment of Commercial Debts (Interest) Act 1998.</span>
</div>

${backingNote}

<div class="footer">
  ${esc(c?.legal_name ?? 'Cerviz Ltd')} is a company registered in England and Wales${c?.company_number ? `, company number ${esc(c.company_number)}` : ''}.
  ${c?.registered_address_1 ? `Registered office: ${[c.registered_address_1, c.registered_city, c.registered_postcode].filter(Boolean).map(esc).join(', ')}.` : ''}
  ${c?.vat_registered && c?.vat_number ? `VAT registration number ${esc(c.vat_number)}.` : ''}
  ${c?.invoice_footer ? `<br>${esc(c.invoice_footer)}` : ''}
</div>

</body></html>`;
}

/** Removes a leading "Name — " prefix so it is not repeated under the worker heading. */
function stripName(description: string, name: string): string {
  return description.startsWith(`${name} — `) ? description.slice(name.length + 3) : description;
}
