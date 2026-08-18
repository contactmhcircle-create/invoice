<?php
/**
 * Printable documents: the customer-facing invoice and the HMRC enquiry pack.
 *
 * The invoice layout follows the reference the user supplied — company block
 * top-left with a logo space right, a bold INVOICE title, INVOICE TO beside the
 * number/date/due block, a FROM/TO period band, an accent-bar line table and a
 * bold BALANCE DUE — with the statutory content the reference was missing kept
 * in: registered office, company number, the VAT position and the late payment
 * line.
 *
 * Formats: HTML (screen and print-to-PDF), and .doc — Word opens an HTML
 * document served as application/msword, which gives an editable copy with no
 * dependency. CSV of the lines is separate and handled in the router.
 */

declare(strict_types=1);

function esc(?string $s): string {
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}

function render_invoice_html(PDO $db, string $invoiceId, bool $forWord = false): string {
    $inv = invoice_with_detail($db, $invoiceId);
    if (!$inv) throw new DomainException('Invoice not found');

    $c = row($db, 'SELECT * FROM company WHERE id = 1') ?? [];
    $brand = $c['brand_colour'] ?: '#c62828';
    $cur = $inv['currency'];

    $companyLines = array_filter([
        $c['registered_address_1'] ?? null, $c['registered_address_2'] ?? null,
        $c['registered_city'] ?? null, 'United Kingdom', $c['registered_postcode'] ?? null,
        $c['website'] ?? null,
    ]);

    $clientLines = array_filter([
        $inv['address_1'], $inv['address_2'], $inv['city'], $inv['postcode'],
        ($inv['country'] ?? 'United Kingdom') !== 'United Kingdom' ? $inv['country'] : null,
    ]);

    $hasHours = array_reduce($inv['lines'], fn($carry, $l) => $carry || $l['quantity_minutes'] !== null, false);

    $lineRows = '';
    foreach ($inv['lines'] as $l) {
        $hours = $l['quantity_minutes'] !== null ? number_format($l['quantity_minutes'] / 60, 2) : '';
        $rate = $l['quantity_minutes'] !== null ? format_money((int) $l['unit_price_pence'], $cur) : '';
        $lineRows .= '<tr>'
            . '<td class="desc">' . esc($l['description']) . '</td>'
            . ($hasHours ? '<td class="num">' . $hours . '</td><td class="num">' . $rate . '</td>' : '')
            . '<td class="num">' . format_money((int) $l['net_pence'], $cur) . '</td>'
            . '</tr>';
    }

    $periodBand = $inv['period_from'] ? '
  <table class="period"><tr>
    <td><span class="label">FROM</span><br>' . format_date_uk($inv['period_from']) . '</td>
    <td><span class="label">TO</span><br>' . format_date_uk($inv['period_to']) . '</td>
  </tr></table>' : '';

    $vatRow = (int) $inv['vat_applied'] === 1
        ? '<tr><td>VAT TOTAL (20%)</td><td class="num">' . format_money((int) $inv['vat_pence'], $cur) . '</td></tr>'
        : '<tr><td>VAT TOTAL</td><td class="num">' . format_money(0, $cur) . '</td></tr>';

    $outstanding = (int) $inv['gross_pence'] - (int) $inv['paid_pence'];
    $paidRows = (int) $inv['paid_pence'] > 0
        ? '<tr><td>PAID</td><td class="num">' . format_money((int) $inv['paid_pence'], $cur) . '</td></tr>'
        : '';

    $backing = '';
    if ($inv['backingTimesheets']) {
        $items = array_map(fn($t) =>
            esc($t['reference']) . ' — ' . esc("{$t['first_name']} {$t['last_name']}")
            . ', week ending ' . format_date_uk($t['week_ending'])
            . ', ' . hours_decimal((int) $t['total_minutes']) . ' hrs'
            . ', signed by ' . esc($t['client_signatory'] ?? 'site')
            . ' on ' . format_date_uk($t['client_signed_on']),
            $inv['backingTimesheets']);
        $backing = '<div class="backing"><strong>Supporting timesheets</strong><br>'
            . implode('<br>', $items) . '</div>';
    }

    $bank = array_filter([
        ($c['bank_account_name'] ?? null) ? 'Account name: ' . esc($c['bank_account_name']) : null,
        ($c['bank_name'] ?? null) ? 'Bank: ' . esc($c['bank_name']) : null,
        ($c['bank_sort_code'] ?? null) ? 'Sort code: ' . esc($c['bank_sort_code']) : null,
        ($c['bank_account_number'] ?? null) ? 'Account number: ' . esc($c['bank_account_number']) : null,
        ($c['bank_iban'] ?? null) ? 'IBAN: ' . esc($c['bank_iban']) : null,
    ]);

    $regFooter = esc($c['legal_name'] ?? 'Cerviz Ltd') . ' is a company registered in England and Wales'
        . (($c['company_number'] ?? null) ? ', company number ' . esc($c['company_number']) : '') . '.'
        . (($c['registered_address_1'] ?? null)
            ? ' Registered office: ' . esc(implode(', ', array_filter([
                $c['registered_address_1'], $c['registered_city'], $c['registered_postcode']]))) . '.'
            : '')
        . (((int) ($c['vat_registered'] ?? 0) === 1 && ($c['vat_number'] ?? null))
            ? ' VAT registration number ' . esc($c['vat_number']) . '.' : '');

    $voidStamp = $inv['status'] === 'void' ? '<div class="void">VOID</div>' : '';
    $draftStamp = $inv['status'] === 'draft' ? '<div class="draft-note">DRAFT — not yet issued</div>' : '';

    // Word needs absolute simplicity; print CSS is ignored there anyway.
    $pageCss = $forWord ? '' : '@page { size: A4; margin: 14mm; }
  .void { position: fixed; top: 40%; left: 50%; transform: translate(-50%,-50%) rotate(-24deg);
          font-size: 110px; font-weight: 800; color: rgba(198,40,40,0.14); letter-spacing: 6px; }';

    return '<!doctype html>
<html><head><meta charset="utf-8"><title>' . esc($inv['number'] ?? 'Draft invoice') . '</title>
<style>
  ' . $pageCss . '
  * { box-sizing: border-box; }
  body { font: 12.5px/1.5 Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; padding: 8px; }
  .rule-top { border-top: 4px solid #1a1a1a; margin-bottom: 18px; }
  .head { width: 100%; border-collapse: collapse; }
  .head td { vertical-align: top; }
  .company-name { font-size: 15px; font-weight: bold; letter-spacing: 0.3px; }
  .company-block { line-height: 1.55; }
  .logo-cell { text-align: right; }
  .logo-mark { display: inline-block; padding: 14px 20px; border: 2px solid ' . $brand . ';
               color: ' . $brand . '; font-weight: 800; font-size: 20px; letter-spacing: 3px; }
  .doc-title { font-size: 30px; font-weight: 800; color: ' . $brand . '; letter-spacing: 1px; margin: 14px 0 18px; }
  .draft-note { display: inline-block; margin-left: 14px; font-size: 13px; color: #b26a00; font-weight: bold; }
  .parties { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  .parties td { vertical-align: top; width: 50%; padding-bottom: 8px; }
  .label { font-size: 11px; font-weight: bold; letter-spacing: 0.5px; color: #444; }
  .meta b { display: inline-block; min-width: 92px; }
  .period { width: 100%; border-collapse: collapse; margin: 10px 0 4px;
            border-top: 2px solid ' . $brand . '; border-bottom: 1px solid #ddd; }
  .period td { padding: 8px 4px; width: 50%; }
  table.lines { width: 100%; border-collapse: collapse; margin-top: 14px; }
  table.lines th { background: ' . $brand . '1a; color: ' . $brand . '; text-align: left;
                   font-size: 11px; letter-spacing: 0.6px; padding: 7px 8px;
                   border-top: 2px solid ' . $brand . '; border-bottom: 2px solid ' . $brand . '; }
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

' . $voidStamp . '
<div class="rule-top"></div>

<table class="head"><tr>
  <td class="company-block">
    <div class="company-name">' . esc(strtoupper($c['trading_name'] ?: ($c['legal_name'] ?? 'CERVIZ LTD'))) . '</div>
    ' . implode('<br>', array_map('esc', $companyLines)) . '
    ' . (($c['company_number'] ?? null) ? '<br>Company Registration No.: ' . esc($c['company_number']) : '') . '
  </td>
  <td class="logo-cell"><span class="logo-mark">' . esc(strtoupper($c['trading_name'] ?: ($c['legal_name'] ?? 'CERVIZ'))) . '</span></td>
</tr></table>

<div class="doc-title">INVOICE' . $draftStamp . '</div>

<table class="parties"><tr>
  <td>
    <div class="label">INVOICE TO</div>
    <strong>' . esc($inv['client_legal_name'] ?: $inv['client_name']) . '</strong><br>
    ' . implode('<br>', array_map('esc', $clientLines)) . '
    ' . ($inv['client_company_number'] ? '<br><span style="color:#777">Company no. ' . esc($inv['client_company_number']) . '</span>' : '') . '
  </td>
  <td class="meta">
    <div><b>INVOICE NO.</b> ' . esc($inv['number'] ?? 'DRAFT') . '</div>
    <div><b>DATE</b> ' . format_date_uk($inv['issue_date']) . '</div>
    <div><b>DUE DATE</b> ' . format_date_uk($inv['due_date']) . '</div>
    ' . ($inv['po_reference'] ? '<div><b>YOUR PO</b> ' . esc($inv['po_reference']) . '</div>' : '') . '
    ' . ($cur !== 'GBP' ? '<div><b>CURRENCY</b> ' . esc($cur) . '</div>' : '') . '
  </td>
</tr></table>

' . $periodBand . '

<table class="lines">
  <thead><tr>
    <th>DESCRIPTION</th>
    ' . ($hasHours ? '<th class="num" style="width:70px">HOURS</th><th class="num" style="width:90px">RATE</th>' : '') . '
    <th class="num" style="width:110px">AMOUNT</th>
  </tr></thead>
  <tbody>' . $lineRows . '</tbody>
</table>

<table class="totals">
  <tr><td>SUBTOTAL</td><td class="num">' . format_money((int) $inv['net_pence'], $cur) . '</td></tr>
  ' . $vatRow . '
  <tr><td>TOTAL</td><td class="num">' . format_money((int) $inv['gross_pence'], $cur) . '</td></tr>
  ' . $paidRows . '
  <tr class="balance"><td>BALANCE DUE</td><td class="num">' . format_money($outstanding, $cur) . '</td></tr>
</table>

' . ($inv['vat_note'] ? '<div class="vat-note">' . esc($inv['vat_note']) . '</div>' : '') . '

<div class="pay">
  <div class="heading">Please pay the invoice into the following account:</div>
  ' . implode('<br>', $bank) . '
  ' . ($inv['number'] ? '<br><strong>Please quote reference ' . esc($inv['number']) . '</strong>' : '') . '
  <div class="late">Late payment may incur statutory interest at the Bank of England base rate plus 8%
  together with fixed compensation under the Late Payment of Commercial Debts (Interest) Act 1998.</div>
</div>

' . $backing . '

<div class="footer">' . $regFooter . ($c['invoice_footer'] ?? null ? '<br>' . esc($c['invoice_footer']) : '') . '</div>

</body></html>';
}

function invoice_lines_csv(PDO $db, string $invoiceId): string {
    $inv = invoice_with_detail($db, $invoiceId);
    if (!$inv) throw new DomainException('Invoice not found');

    $esc = fn($v) => preg_match('/[",\n]/', (string) $v)
        ? '"' . str_replace('"', '""', (string) $v) . '"' : (string) $v;

    $lines = ['Invoice,Line,Date,Description,Hours,Unit price,Net,VAT,Currency'];
    foreach ($inv['lines'] as $l) {
        $lines[] = implode(',', array_map($esc, [
            $inv['number'] ?? 'DRAFT', $l['line_no'], $l['work_date'] ?? '', $l['description'],
            $l['quantity_minutes'] !== null ? number_format($l['quantity_minutes'] / 60, 2, '.', '') : '',
            number_format($l['unit_price_pence'] / 100, 2, '.', ''),
            number_format($l['net_pence'] / 100, 2, '.', ''),
            number_format($l['vat_pence'] / 100, 2, '.', ''),
            $inv['currency']]));
    }
    $lines[] = implode(',', array_map($esc, [$inv['number'] ?? 'DRAFT', '', '', 'TOTAL', '', '',
        number_format($inv['net_pence'] / 100, 2, '.', ''),
        number_format($inv['vat_pence'] / 100, 2, '.', ''), $inv['currency']]));
    return implode("\n", $lines);
}

// ---------------------------------------------------------------------------
// Enquiry pack
// ---------------------------------------------------------------------------

function build_enquiry_pack(PDO $db, string $from, string $to): array {
    $company = row($db, 'SELECT * FROM company WHERE id = 1');

    $invoices = rows($db, 'SELECT i.*, o.name AS client_name, o.company_number AS client_company_number
        FROM invoices i JOIN organisations o ON o.id = i.client_org_id
        WHERE i.issue_date BETWEEN ? AND ? ORDER BY i.number', [$from, $to]);

    foreach ($invoices as &$inv) {
        $inv['lines'] = rows($db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [$inv['id']]);
        $inv['timesheets'] = rows($db, 'SELECT DISTINCT t.id, t.reference, t.week_ending, t.total_minutes,
                  t.client_signatory, t.client_signed_on, t.approved_by, t.approved_at,
                  w.first_name, w.last_name, w.ni_number, w.engagement_type
            FROM invoice_lines il
            JOIN timesheets t ON t.id = il.timesheet_id
            JOIN workers w ON w.id = t.worker_id
            WHERE il.invoice_id = ?', [$inv['id']]);
        foreach ($inv['timesheets'] as &$ts) {
            $ts['documents'] = rows($db, "SELECT filename, category, sha256, uploaded_at FROM documents
                WHERE entity_type = 'timesheet' AND entity_id = ?", [$ts['id']]);
        }
        unset($ts);
        $inv['payments'] = rows($db, "SELECT * FROM payments WHERE invoice_id = ? AND direction = 'in'", [$inv['id']]);
    }
    unset($inv);

    $purchases = rows($db, 'SELECT p.*, o.name AS supplier, o.company_number AS supplier_company_number,
              o.vat_number AS supplier_vat
        FROM purchase_invoices p JOIN organisations o ON o.id = p.organisation_id
        WHERE p.invoice_date BETWEEN ? AND ? ORDER BY p.invoice_date', [$from, $to]);

    $workers = rows($db, 'SELECT DISTINCT w.id, w.first_name, w.last_name, w.ni_number, w.date_of_birth,
              w.engagement_type, u.name AS umbrella_name, u.company_number AS umbrella_company_number
        FROM workers w
        LEFT JOIN organisations u ON u.id = w.umbrella_org_id
        JOIN shifts s ON s.worker_id = w.id
        WHERE date(s.starts_at) BETWEEN ? AND ?', [$from, $to]);

    foreach ($workers as &$w) {
        $w['licences'] = rows($db, 'SELECT sector, licence_number, issued_on, expires_on, verified_on, status
            FROM worker_licences WHERE worker_id = ?', [$w['id']]);
        $w['rightToWork'] = rows($db, 'SELECT method, checked_on, outcome, expires_on FROM worker_rtw
            WHERE worker_id = ? ORDER BY checked_on DESC', [$w['id']]);
        $w['screening'] = rows($db, 'SELECT element, status, completed_on, covers_from, covers_to
            FROM screening_checks WHERE worker_id = ?', [$w['id']]);
        $w['shiftsInPeriod'] = (int) scalar($db,
            'SELECT COUNT(*) FROM shifts WHERE worker_id = ? AND date(starts_at) BETWEEN ? AND ?',
            [$w['id'], $from, $to]);
    }
    unset($w);

    $assignments = rows($db, 'SELECT DISTINCT a.*, o.name AS client_name
        FROM assignments a
        JOIN organisations o ON o.id = a.client_org_id
        JOIN shifts s ON s.assignment_id = a.id
        WHERE date(s.starts_at) BETWEEN ? AND ?', [$from, $to]);
    foreach ($assignments as &$a) {
        $a['supplyChain'] = rows($db, 'SELECT l.position, l.role, l.description, l.contract_ref,
                  o.name AS organisation_name, o.company_number, o.vat_number
            FROM supply_chain_links l
            LEFT JOIN organisations o ON o.id = l.organisation_id
            WHERE l.assignment_id = ? ORDER BY l.position', [$a['id']]);
    }
    unset($a);

    $payments = rows($db, 'SELECT * FROM payments WHERE paid_on BETWEEN ? AND ? ORDER BY paid_on', [$from, $to]);

    $shiftStats = row($db, "SELECT COUNT(*) AS shifts,
              COALESCE(SUM((julianday(ends_at) - julianday(starts_at)) * 24 * 60 - break_minutes),0) AS minutes
        FROM shifts WHERE date(starts_at) BETWEEN ? AND ? AND status IN ('worked','allocated')", [$from, $to]);

    $tb = trial_balance($db, $to);

    // Self-check — the gaps an inspector would notice first.
    $gaps = [];

    $unsigned = (int) scalar($db, "SELECT COUNT(*) FROM timesheets t
        WHERE t.week_ending BETWEEN ? AND ? AND t.status IN ('approved','invoiced')
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.entity_type = 'timesheet'
                           AND d.entity_id = t.id AND d.category = 'signed_timesheet')", [$from, $to]);
    if ($unsigned > 0) {
        $gaps[] = "$unsigned approved timesheet(s) in this period have no signed scan attached. "
            . 'Revenue without the signed sheet behind it is the hardest kind to defend.';
    }

    $noChain = array_values(array_filter($assignments, fn($a) => !$a['supplyChain']));
    if ($noChain) {
        $gaps[] = count($noChain) . ' assignment(s) worked in this period have no supply chain map recorded: '
            . implode(', ', array_column($noChain, 'title')) . '.';
    }

    $noDd = rows($db, 'SELECT o.name FROM organisations o
        WHERE o.is_client = 1
          AND EXISTS (SELECT 1 FROM assignments a JOIN shifts s ON s.assignment_id = a.id
                       WHERE a.client_org_id = o.id AND date(s.starts_at) BETWEEN ? AND ?)
          AND NOT EXISTS (SELECT 1 FROM org_due_diligence d WHERE d.organisation_id = o.id)', [$from, $to]);
    if ($noDd) {
        $gaps[] = 'No due diligence recorded for ' . count($noDd) . ' counterparty/counterparties worked with in '
            . 'this period: ' . implode(', ', array_column($noDd, 'name')) . '. In a labour supply chain, undocumented '
            . 'checks are what turn another party’s fraud into your liability.';
    }

    $badShifts = (int) scalar($db, "SELECT COUNT(*) FROM shifts s
        JOIN workers w ON w.id = s.worker_id
        WHERE date(s.starts_at) BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM worker_licences l WHERE l.worker_id = w.id
                           AND l.status = 'valid' AND l.expires_on >= date(s.starts_at))", [$from, $to]);
    if ($badShifts > 0) {
        $gaps[] = "$badShifts shift(s) in this period were worked by someone with no valid SIA licence on "
            . 'that date. Investigate each one — this is the finding that ends contracts.';
    }

    $directorReceipts = array_filter($payments, fn($p) => (int) $p['via_director_loan'] === 1);
    if ($directorReceipts) {
        $gaps[] = count($directorReceipts) . " payment(s) were received into a director's personal account and passed to "
            . 'the company. This is documented here, which is what matters — but change the bank details held by '
            . 'those clients so it does not recur.';
    }

    $chainCheck = verify_audit_chain($db);
    if (!$chainCheck['ok']) {
        $gaps[] = 'AUDIT TRAIL BROKEN: ' . $chainCheck['reason'] . ' The record cannot be relied on from that point.';
    }

    $inTotal = array_sum(array_map(fn($p) => $p['direction'] === 'in' ? (int) $p['amount_pence'] : 0, $payments));
    $outTotal = array_sum(array_map(fn($p) => $p['direction'] === 'out' ? (int) $p['amount_pence'] : 0, $payments));

    return [
        'generatedAt' => now_instant(), 'from' => $from, 'to' => $to, 'company' => $company,
        'integrity' => [
            'auditChain' => $chainCheck,
            'invoiceSequence' => audit_sequence($db, 'invoice'),
            'creditNoteSequence' => audit_sequence($db, 'credit_note'),
            'ledgerBalanced' => $tb['balanced'],
        ],
        'summary' => [
            'invoiceCount' => count($invoices),
            'totalNetPence' => array_sum(array_map(fn($i) => (int) $i['base_net_pence'], $invoices)),
            'totalVatPence' => array_sum(array_map(fn($i) => (int) $i['base_vat_pence'], $invoices)),
            'totalGrossPence' => array_sum(array_map(fn($i) => (int) $i['base_gross_pence'], $invoices)),
            'totalReceivedPence' => $inTotal,
            'totalPurchasePence' => array_sum(array_map(fn($p) => (int) $p['net_pence'], $purchases)),
            'totalPaidOutPence' => $outTotal,
            'workerCount' => count($workers),
            'shiftCount' => (int) $shiftStats['shifts'],
            'totalHours' => hours_decimal((int) round((float) $shiftStats['minutes'])),
        ],
        'invoices' => $invoices, 'purchases' => $purchases, 'workers' => $workers,
        'assignments' => $assignments, 'payments' => $payments, 'gaps' => $gaps,
        'vat' => vat_threshold_status($db, $to),
        'margin' => margin_report($db, $from, $to),
        'profitAndLoss' => profit_and_loss($db, $from, $to),
    ];
}

function render_enquiry_pack_html(array $pack): string {
    $c = $pack['company'] ?? [];

    $integrityBanner = $pack['integrity']['auditChain']['ok']
        ? '<div class="ok"><strong>Audit trail verified intact.</strong> ' . $pack['integrity']['auditChain']['entriesChecked']
          . ' entries checked; every entry cryptographically seals the one before it.</div>'
        : '<div class="bad"><strong>Audit trail broken.</strong> ' . esc($pack['integrity']['auditChain']['reason'] ?? '') . '</div>';

    $gapsSection = $pack['gaps']
        ? '<h2>Points to address</h2><ul class="gaps">'
          . implode('', array_map(fn($g) => '<li>' . esc($g) . '</li>', $pack['gaps'])) . '</ul>'
        : '<h2>Points to address</h2><p class="ok">No gaps detected in this period.</p>';

    $seq = function (array $s): string {
        return '<td class="num">' . $s['allocated'] . '</td>'
            . '<td>' . ($s['lowest'] ?? '—') . '–' . ($s['highest'] ?? '—') . '</td>'
            . '<td>' . ($s['missing'] ? implode(', ', $s['missing']) : 'none') . '</td>'
            . '<td>' . ($s['intact'] ? 'Gapless' : 'GAPS FOUND') . '</td>';
    };

    $invoiceBlocks = '';
    foreach ($pack['invoices'] as $i) {
        $chains = '';
        foreach ($i['timesheets'] as $t) {
            $scans = $t['documents']
                ? implode(', ', array_map(fn($d) => esc($d['filename']) . ' (sha256 '
                    . esc(substr((string) $d['sha256'], 0, 12)) . '…)', $t['documents']))
                : '<strong>none attached</strong>';
            $chains .= '<div class="chain">Backing: timesheet ' . esc($t['reference']) . ' — '
                . esc("{$t['first_name']} {$t['last_name']}") . ', week ending ' . format_date_uk($t['week_ending'])
                . ', ' . hours_decimal((int) $t['total_minutes']) . ' hrs, signed by '
                . esc($t['client_signatory'] ?? 'not recorded') . ' on ' . format_date_uk($t['client_signed_on'])
                . '. Scans: ' . $scans . '</div>';
        }
        $invoiceBlocks .= '<h3>' . esc($i['number'] ?? '(draft)') . ' — ' . esc($i['client_name']) . ' — '
            . format_money((int) $i['gross_pence'], $i['currency'])
            . ($i['status'] === 'void' ? ' <strong>[VOID]</strong>' : '') . '</h3>'
            . '<p class="meta">Issued ' . format_date_uk($i['issue_date']) . ' · due ' . format_date_uk($i['due_date'])
            . ' · status ' . esc($i['status']) . ' · paid ' . format_money((int) $i['paid_pence'], $i['currency'])
            . ($i['void_reason'] ? '<br>Void reason: ' . esc($i['void_reason']) : '') . '</p>' . $chains;
    }

    $workerRows = '';
    foreach ($pack['workers'] as $w) {
        $lic = $w['licences'][0] ?? null;
        $rtw = $w['rightToWork'][0] ?? null;
        $satisfied = count(array_filter($w['screening'],
            fn($s) => in_array($s['status'], ['satisfied', 'waived'], true)));
        $workerRows .= '<tr>'
            . '<td>' . esc("{$w['first_name']} {$w['last_name']}") . '</td>'
            . '<td>' . esc($w['ni_number'] ?? '—') . '</td>'
            . '<td>' . esc($w['engagement_type']) . '</td>'
            . '<td>' . esc($w['umbrella_name'] ?? '—')
            . ($w['umbrella_company_number'] ? ' (' . esc($w['umbrella_company_number']) . ')' : '') . '</td>'
            . '<td>' . ($lic ? esc($lic['licence_number']) . '<br>' . esc($lic['sector'])
                . '<br>expires ' . format_date_uk($lic['expires_on']) : '<strong>none</strong>') . '</td>'
            . '<td>' . ($rtw ? esc($rtw['outcome']) . '<br>checked ' . format_date_uk($rtw['checked_on'])
                : '<strong>none</strong>') . '</td>'
            . '<td>' . $satisfied . '/' . count($w['screening']) . ' BS 7858</td>'
            . '<td class="num">' . $w['shiftsInPeriod'] . '</td></tr>';
    }

    $chainBlocks = '';
    foreach ($pack['assignments'] as $a) {
        $chainRows = '';
        foreach ($a['supplyChain'] as $l) {
            $chainRows .= '<tr><td class="num">' . $l['position'] . '</td>'
                . '<td>' . esc(str_replace('_', ' ', $l['role'])) . '</td>'
                . '<td>' . esc($l['organisation_name'] ?? $l['description'] ?? '—') . '</td>'
                . '<td>' . esc($l['company_number'] ?? '—') . '</td>'
                . '<td>' . esc($l['vat_number'] ?? '—') . '</td>'
                . '<td>' . esc($l['contract_ref'] ?? '—') . '</td></tr>';
        }
        $chainBlocks .= '<h3>' . esc($a['title']) . ' — ' . esc($a['client_name']) . '</h3>'
            . ($a['supplyChain']
                ? '<table><tr><th>Position</th><th>Role</th><th>Party</th><th>Company number</th><th>VAT number</th><th>Contract ref</th></tr>'
                  . $chainRows . '</table>'
                : '<p class="bad">No supply chain recorded for this assignment.</p>');
    }

    $purchaseRows = '';
    foreach ($pack['purchases'] as $p) {
        $purchaseRows .= '<tr><td>' . esc($p['our_reference']) . '</td><td>' . esc($p['supplier']) . '</td>'
            . '<td>' . esc($p['their_reference'] ?? '—') . '</td><td>' . format_date_uk($p['invoice_date']) . '</td>'
            . '<td class="num">' . format_money((int) $p['net_pence']) . '</td>'
            . '<td class="num">' . ($p['expected_pence'] !== null ? format_money((int) $p['expected_pence']) : '—') . '</td>'
            . '<td class="num">' . ($p['variance_pence'] !== null ? format_money((int) $p['variance_pence']) : '—') . '</td>'
            . '<td>' . esc($p['status']) . '</td></tr>';
    }

    $paymentRows = '';
    foreach ($pack['payments'] as $p) {
        $paymentRows .= '<tr><td>' . format_date_uk($p['paid_on']) . '</td>'
            . '<td>' . ($p['direction'] === 'in' ? 'Received' : 'Paid') . '</td>'
            . '<td class="num">' . format_money((int) $p['amount_pence'], $p['currency']) . '</td>'
            . '<td>' . esc($p['method'])
            . ((int) $p['via_director_loan'] === 1 ? ' <strong>(via director account)</strong>' : '') . '</td>'
            . '<td>' . esc($p['reference'] ?? '—') . '</td><td>' . esc($p['notes'] ?? '') . '</td></tr>';
    }

    $s = $pack['summary']; $pl = $pack['profitAndLoss']; $vat = $pack['vat'];

    return '<!doctype html>
<html><head><meta charset="utf-8"><title>Enquiry pack ' . esc($pack['from']) . ' to ' . esc($pack['to']) . '</title>
<style>
  body { font: 13px/1.5 Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin-top: 28px; border-bottom: 2px solid #1e3a5f; padding-bottom: 4px; }
  h3 { font-size: 14px; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12px; }
  th, td { border: 1px solid #d4d4d4; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #f2f5f8; font-weight: 600; }
  .num { text-align: right; }
  .ok { background: #e8f5e9; border-left: 4px solid #2e7d32; padding: 10px 12px; margin: 12px 0; }
  .bad { background: #ffebee; border-left: 4px solid #c62828; padding: 10px 12px; margin: 12px 0; }
  .gaps li { margin-bottom: 8px; }
  .meta { color: #555; font-size: 12px; }
  .chain { font-size: 11px; color: #444; margin-left: 14px; }
  @media print { body { margin: 12mm; } h2 { page-break-after: avoid; } }
</style></head><body>

<h1>' . esc($c['legal_name'] ?? 'Cerviz Ltd') . ' — records for enquiry</h1>
<p class="meta">Period ' . format_date_uk($pack['from']) . ' to ' . format_date_uk($pack['to']) . ' · Generated '
    . esc($pack['generatedAt']) . '<br>'
    . (($c['company_number'] ?? null) ? 'Company number ' . esc($c['company_number']) . ' · ' : '')
    . (($c['vat_number'] ?? null) ? 'VAT number ' . esc($c['vat_number']) : 'Not registered for VAT') . '</p>

' . $integrityBanner . '

<h2>Summary</h2>
<table>
  <tr><th>Invoices issued</th><td class="num">' . $s['invoiceCount'] . '</td>
      <th>Total invoiced (net)</th><td class="num">' . format_money($s['totalNetPence']) . '</td></tr>
  <tr><th>VAT charged</th><td class="num">' . format_money($s['totalVatPence']) . '</td>
      <th>Total invoiced (gross)</th><td class="num">' . format_money($s['totalGrossPence']) . '</td></tr>
  <tr><th>Received from clients</th><td class="num">' . format_money($s['totalReceivedPence']) . '</td>
      <th>Purchase invoices</th><td class="num">' . format_money($s['totalPurchasePence']) . '</td></tr>
  <tr><th>Workers supplied</th><td class="num">' . $s['workerCount'] . '</td>
      <th>Shifts worked</th><td class="num">' . $s['shiftCount'] . ' (' . $s['totalHours'] . ' hrs)</td></tr>
  <tr><th>Gross margin</th><td class="num">' . format_money($pack['margin']['totalMarginPence']) . '</td>
      <th>Margin %</th><td class="num">' . $pack['margin']['marginPercent'] . '%</td></tr>
</table>

<h2>Document sequence integrity</h2>
<table>
  <tr><th>Series</th><th>Allocated</th><th>Range</th><th>Missing</th><th>Status</th></tr>
  <tr><td>Invoices</td>' . $seq($pack['integrity']['invoiceSequence']) . '</tr>
  <tr><td>Credit notes</td>' . $seq($pack['integrity']['creditNoteSequence']) . '</tr>
</table>
<p class="meta">Voided invoices retain their number and remain listed, which is what makes the series
provably gapless rather than merely tidy.</p>

' . $gapsSection . '

<h2>Sales invoices and their evidence</h2>
' . $invoiceBlocks . '

<h2>Workers supplied and their compliance</h2>
<table>
  <tr><th>Worker</th><th>NI number</th><th>Engagement</th><th>Umbrella</th>
      <th>SIA licence</th><th>Right to work</th><th>Screening</th><th>Shifts</th></tr>
  ' . $workerRows . '
</table>

<h2>Labour supply chain by assignment</h2>
' . $chainBlocks . '

<h2>Purchase invoices</h2>
<table>
  <tr><th>Our ref</th><th>Supplier</th><th>Their ref</th><th>Date</th>
      <th class="num">Net</th><th class="num">Expected</th><th class="num">Variance</th><th>Status</th></tr>
  ' . $purchaseRows . '
</table>

<h2>Money movements</h2>
<table>
  <tr><th>Date</th><th>Direction</th><th class="num">Amount</th><th>Method</th><th>Reference</th><th>Notes</th></tr>
  ' . $paymentRows . '
</table>

<h2>Profit and loss for the period</h2>
<table>
  <tr><th>Revenue</th><td class="num">' . format_money($pl['totalIncomePence']) . '</td></tr>
  <tr><th>Cost of sales (labour)</th><td class="num">' . format_money($pl['totalCostOfSalesPence']) . '</td></tr>
  <tr><th>Gross profit</th><td class="num">' . format_money($pl['grossProfitPence']) . ' (' . $pl['grossMarginPercent'] . '%)</td></tr>
  <tr><th>Overheads</th><td class="num">' . format_money($pl['totalOverheadsPence']) . '</td></tr>
  <tr><th>Net profit</th><td class="num">' . format_money($pl['netProfitPence']) . '</td></tr>
</table>

<h2>VAT position</h2>
<p>' . esc($vat['message']) . '</p>
<p class="meta">Rolling 12-month turnover to ' . format_date_uk($pack['to']) . ': '
    . format_money($vat['rollingTwelveMonthPence']) . ' against a £90,000 threshold ('
    . $vat['percentOfThreshold'] . '%).</p>

<p class="meta" style="margin-top:32px">
  Prepared by Cerviz Back Office. Every figure above is derived from source records held in the
  application: invoices from approved timesheets, timesheets from signed paper sheets, and shifts from
  the allocation record. The audit trail covering all of it is hash-chained and was verified at the
  time this pack was generated.
</p>
</body></html>';
}
