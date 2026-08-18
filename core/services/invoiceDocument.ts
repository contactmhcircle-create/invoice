import type { Db } from '../db/connection.js';
import { invoiceWithDetail } from './invoices.js';
import { formatMoney } from '../../shared/money.js';
import { formatDateUK, hoursDecimal } from '../../shared/dates.js';

/**
 * The invoice as the client sees it.
 *
 * The layout follows the reference the user supplied — company block top-left
 * with a logo space right, a bold INVOICE title, INVOICE TO beside the
 * number/date/due block, a FROM/TO period band, an accent-bar line table and a
 * bold BALANCE DUE — with the statutory content the reference was missing kept
 * in: registered office, company number, the VAT position and the late payment
 * line.
 *
 * Formats: HTML (screen and print-to-PDF), and .doc — Word opens an HTML
 * document served as application/msword, which gives an editable copy with no
 * dependency. CSV of the lines is `invoiceLinesCsv`.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);

export function renderInvoiceHtml(db: Db, invoiceId: string, forWord = false): string {
  const inv = invoiceWithDetail(db, invoiceId);
  if (!inv) throw new Error('Invoice not found');

  const c = (db.prepare('SELECT * FROM company WHERE id = 1').get() ?? {}) as any;
  const brand = c.brand_colour || '#c62828';
  const cur = inv.currency;

  const companyLines = [
    c.registered_address_1, c.registered_address_2,
    c.registered_city, 'United Kingdom', c.registered_postcode,
    c.website,
  ].filter(Boolean).map(esc);

  const clientLines = [
    inv.address_1, inv.address_2, inv.city, inv.postcode,
    (inv.country ?? 'United Kingdom') !== 'United Kingdom' ? inv.country : null,
  ].filter(Boolean).map(esc);

  const hasHours = inv.lines.some((l: any) => l.quantity_minutes !== null);

  const lineRows = inv.lines.map((l: any) => {
    const hours = l.quantity_minutes !== null ? (l.quantity_minutes / 60).toFixed(2) : '';
    const rate = l.quantity_minutes !== null ? formatMoney(l.unit_price_pence, cur) : '';
    return '<tr>'
      + `<td class="desc">${esc(l.description)}</td>`
      + (hasHours ? `<td class="num">${hours}</td><td class="num">${rate}</td>` : '')
      + `<td class="num">${formatMoney(l.net_pence, cur)}</td>`
      + '</tr>';
  }).join('');

  const periodBand = inv.period_from ? `
  <table class="period"><tr>
    <td><span class="label">FROM</span><br>${formatDateUK(inv.period_from)}</td>
    <td><span class="label">TO</span><br>${formatDateUK(inv.period_to)}</td>
  </tr></table>` : '';

  const vatRow = inv.vat_applied
    ? `<tr><td>VAT TOTAL (20%)</td><td class="num">${formatMoney(inv.vat_pence, cur)}</td></tr>`
    : `<tr><td>VAT TOTAL</td><td class="num">${formatMoney(0, cur)}</td></tr>`;

  const outstanding = inv.gross_pence - inv.paid_pence;
  const paidRows = inv.paid_pence > 0
    ? `<tr><td>PAID</td><td class="num">${formatMoney(inv.paid_pence, cur)}</td></tr>`
    : '';

  const backing = inv.backingTimesheets.length
    ? `<div class="backing"><strong>Supporting timesheets</strong><br>${
        inv.backingTimesheets.map((t: any) =>
          `${esc(t.reference)} — ${esc(`${t.first_name} ${t.last_name}`)}`
          + `, week ending ${formatDateUK(t.week_ending)}`
          + `, ${hoursDecimal(t.total_minutes)} hrs`
          + `, signed by ${esc(t.client_signatory ?? 'site')}`
          + ` on ${formatDateUK(t.client_signed_on)}`,
        ).join('<br>')}</div>`
    : '';

  const bank = [
    c.bank_account_name ? `Account name: ${esc(c.bank_account_name)}` : null,
    c.bank_name ? `Bank: ${esc(c.bank_name)}` : null,
    c.bank_sort_code ? `Sort code: ${esc(c.bank_sort_code)}` : null,
    c.bank_account_number ? `Account number: ${esc(c.bank_account_number)}` : null,
    c.bank_iban ? `IBAN: ${esc(c.bank_iban)}` : null,
  ].filter(Boolean);

  const regFooter = `${esc(c.legal_name ?? 'Cerviz Ltd')} is a company registered in England and Wales`
    + (c.company_number ? `, company number ${esc(c.company_number)}` : '') + '.'
    + (c.registered_address_1
        ? ` Registered office: ${esc([c.registered_address_1, c.registered_city, c.registered_postcode].filter(Boolean).join(', '))}.`
        : '')
    + (c.vat_registered && c.vat_number ? ` VAT registration number ${esc(c.vat_number)}.` : '');

  const voidStamp = inv.status === 'void' ? '<div class="void">VOID</div>' : '';
  const draftStamp = inv.status === 'draft' ? '<div class="draft-note">DRAFT — not yet issued</div>' : '';

  // Word needs absolute simplicity; print CSS is ignored there anyway.
  const pageCss = forWord ? '' : `@page { size: A4; margin: 14mm; }
  .void { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%) rotate(-24deg);
          font-size: 110px; font-weight: 800; color: rgba(198,40,40,0.14); letter-spacing: 6px; }`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(inv.number ?? 'Draft invoice')}</title>
<style>
  ${pageCss}
  * { box-sizing: border-box; }
  body { font: 12.5px/1.5 Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; padding: 8px; }
  .rule-top { border-top: 4px solid #1a1a1a; margin-bottom: 18px; }
  .head { width: 100%; border-collapse: collapse; }
  .head td { vertical-align: top; }
  .company-name { font-size: 15px; font-weight: bold; letter-spacing: 0.3px; }
  .company-block { line-height: 1.55; }
  .logo-cell { text-align: right; }
  .logo-mark { display: inline-block; padding: 14px 20px; border: 2px solid ${brand};
               color: ${brand}; font-weight: 800; font-size: 20px; letter-spacing: 3px; }
  .doc-title { font-size: 30px; font-weight: 800; color: ${brand}; letter-spacing: 1px; margin: 14px 0 18px; }
  .draft-note { display: inline-block; margin-left: 14px; font-size: 13px; color: #b26a00; font-weight: bold; }
  .parties { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  .parties td { vertical-align: top; width: 50%; padding-bottom: 8px; }
  .label { font-size: 11px; font-weight: bold; letter-spacing: 0.5px; color: #444; }
  .meta b { display: inline-block; min-width: 92px; }
  .period { width: 100%; border-collapse: collapse; margin: 10px 0 4px;
            border-top: 2px solid ${brand}; border-bottom: 1px solid #ddd; }
  .period td { padding: 8px 4px; width: 50%; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 14px; }
  table.lines th { background: ${brand}1a; color: ${brand}; text-align: left;
                   font-size: 11px; letter-spacing: 0.6px; padding: 7px 8px;
                   border-top: 2px solid ${brand}; border-bottom: 2px solid ${brand}; }
  table.lines th.num, td.num { text-align: right; }
  table.lines td { padding: 7px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .totals { margin-top: 10px; margin-left: auto; border-collapse: collapse; min-width: 300px; }
  .totals td { padding: 4px 8px; }
  .totals .num { text-align: right; min-width: 110px; }
  .totals tr.balance td { font-size: 17px; font-weight: 800; border-top: 2px solid #1a1a1a; padding-top: 8px; }
  .vat-note { margin-top: 12px; font-size: 11px; color: #555; font-style: italic; }
  .pay { margin-top: 22px; }
  .pay .heading { font-weight: bold; margin-bottom: 6px; }
  .late { font-size: 10.5px; color: #555; margin-top: 8px; }
  .backing { margin-top: 16px; padding-top: 8px; border-top: 1px solid #eee; font-size: 10px; color: #666; }
  .footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 9.5px; color: #777; }
</style></head><body>

${voidStamp}
<div class="rule-top"></div>

<table class="head"><tr>
  <td class="company-block">
    <div class="company-name">${esc(String(c.trading_name || c.legal_name || 'CERVIZ LTD').toUpperCase())}</div>
    ${companyLines.join('<br>')}
    ${c.company_number ? `<br>Company Registration No.: ${esc(c.company_number)}` : ''}
  </td>
  <td class="logo-cell"><span class="logo-mark">${esc(String(c.trading_name || c.legal_name || 'CERVIZ').toUpperCase())}</span></td>
</tr></table>

<div class="doc-title">INVOICE${draftStamp}</div>

<table class="parties"><tr>
  <td>
    <div class="label">INVOICE TO</div>
    <strong>${esc(inv.client_legal_name || inv.client_name)}</strong><br>
    ${clientLines.join('<br>')}
    ${inv.client_company_number ? `<br><span style="color:#777">Company no. ${esc(inv.client_company_number)}</span>` : ''}
  </td>
  <td class="meta">
    <div><b>INVOICE NO.</b> ${esc(inv.number ?? 'DRAFT')}</div>
    <div><b>DATE</b> ${formatDateUK(inv.issue_date)}</div>
    <div><b>DUE DATE</b> ${formatDateUK(inv.due_date)}</div>
    ${inv.po_reference ? `<div><b>YOUR PO</b> ${esc(inv.po_reference)}</div>` : ''}
    ${cur !== 'GBP' ? `<div><b>CURRENCY</b> ${esc(cur)}</div>` : ''}
  </td>
</tr></table>

${periodBand}

<table class="lines">
  <thead><tr>
    <th>DESCRIPTION</th>
    ${hasHours ? '<th class="num" style="width:70px">HOURS</th><th class="num" style="width:90px">RATE</th>' : ''}
    <th class="num" style="width:110px">AMOUNT</th>
  </tr></thead>
  <tbody>${lineRows}</tbody>
</table>

<table class="totals">
  <tr><td>SUBTOTAL</td><td class="num">${formatMoney(inv.net_pence, cur)}</td></tr>
  ${vatRow}
  <tr><td>TOTAL</td><td class="num">${formatMoney(inv.gross_pence, cur)}</td></tr>
  ${paidRows}
  <tr class="balance"><td>BALANCE DUE</td><td class="num">${formatMoney(outstanding, cur)}</td></tr>
</table>

${inv.vat_note ? `<div class="vat-note">${esc(inv.vat_note)}</div>` : ''}

<div class="pay">
  <div class="heading">Please pay the invoice into the following account:</div>
  ${bank.join('<br>')}
  ${inv.number ? `<br><strong>Please quote reference ${esc(inv.number)}</strong>` : ''}
  <div class="late">Late payment may incur statutory interest at the Bank of England base rate plus 8%
  together with fixed compensation under the Late Payment of Commercial Debts (Interest) Act 1998.</div>
</div>

${backing}

<div class="footer">${regFooter}${c.invoice_footer ? `<br>${esc(c.invoice_footer)}` : ''}</div>

</body></html>`;
}

export function invoiceLinesCsv(db: Db, invoiceId: string): string {
  const inv = invoiceWithDetail(db, invoiceId);
  if (!inv) throw new Error('Invoice not found');

  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const pounds = (pence: number) => (pence / 100).toFixed(2);

  const lines = ['Invoice,Line,Date,Description,Hours,Unit price,Net,VAT,Currency'];
  for (const l of inv.lines) {
    lines.push([
      inv.number ?? 'DRAFT', l.line_no, l.work_date ?? '', l.description,
      l.quantity_minutes !== null ? (l.quantity_minutes / 60).toFixed(2) : '',
      pounds(l.unit_price_pence), pounds(l.net_pence), pounds(l.vat_pence), inv.currency,
    ].map(cell).join(','));
  }
  lines.push([inv.number ?? 'DRAFT', '', '', 'TOTAL', '', '',
    pounds(inv.net_pence), pounds(inv.vat_pence), inv.currency].map(cell).join(','));
  return lines.join('\n');
}
