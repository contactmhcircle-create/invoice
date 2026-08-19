<?php
/**
 * The risk radar and dashboard analytics — port of core/services/insights.ts —
 * and the compliance registers — port of core/services/registers.ts.
 *
 * The radar is deliberately rule-based rather than a language model: every
 * finding is a query anyone can re-run, which is exactly the property a
 * compliance monitor needs when HMRC asks "how did you know". It runs on
 * every dashboard load, so nothing here may be slow.
 */

declare(strict_types=1);

const RISK_SEVERITY_RANK = ['critical' => 0, 'warning' => 1, 'watch' => 2];

function risk_radar(PDO $db): array {
    $findings = [];
    $t = today_iso();
    $gbp = fn(int $pence) => '£' . number_format($pence / 100, 2);

    // --- Duplicate counterparties -------------------------------------------
    $dupes = rows($db, "SELECT COALESCE(NULLIF(company_number, ''), 'name:' || lower(name)) AS k,
            COUNT(*) AS n, MIN(name) AS name
        FROM organisations GROUP BY k HAVING n > 1");
    foreach ($dupes as $d) {
        $findings[] = ['severity' => 'warning', 'area' => 'Records',
            'title' => "{$d['name']} appears {$d['n']} times",
            'detail' => 'Duplicate counterparty records split the history between entries and invite invoicing the wrong one.',
            'action' => 'Open Clients and delete the duplicate — the one with anything linked will refuse, keeping the right record.',
            'page' => 'clients'];
    }

    // --- Workforce compliance ------------------------------------------------
    $blocked = 0;
    $vettedOnboarding = 0;
    foreach (rows($db, "SELECT id, status FROM workers WHERE status IN ('active','onboarding')") as $w) {
        $report = check_worker($db, $w['id']);
        if ($report['blockers'] && $w['status'] === 'active') $blocked++;
        if (!$report['blockers'] && $w['status'] === 'onboarding') $vettedOnboarding++;
    }
    if ($blocked > 0) {
        $findings[] = ['severity' => 'critical', 'area' => 'Compliance',
            'title' => "$blocked active worker(s) have compliance blockers",
            'detail' => 'They cannot legally be placed on shift until the blockers clear — expired licences, missing right-to-work or incomplete screening.',
            'action' => 'Open Workers and resolve each red finding.', 'page' => 'workers'];
    }
    if ($vettedOnboarding > 0) {
        $findings[] = ['severity' => 'watch', 'area' => 'Compliance',
            'title' => "$vettedOnboarding fully-vetted worker(s) still marked onboarding",
            'detail' => 'Vetting is complete but they will not appear when allocating shifts until they are active.',
            'action' => 'Open each worker and click Mark active.', 'page' => 'workers'];
    }

    $expLicences = count(expiring_compliance($db, 30)['licences'] ?? []);
    if ($expLicences > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'SIA',
            'title' => "$expLicences SIA licence(s) expire within 30 days",
            'detail' => 'A shift on a date past expiry will be refused at allocation; renewals take weeks, not days.',
            'action' => 'Chase renewals now and record the new licence when it arrives.', 'page' => 'workers'];
    }

    // --- AWR 12-week clock ---------------------------------------------------
    $awrClose = (int) scalar($db, "SELECT COUNT(DISTINCT worker_id || assignment_id) FROM awr_weeks a
        WHERE cumulative BETWEEN 10 AND 11
          AND week_ending = (SELECT MAX(week_ending) FROM awr_weeks b
                             WHERE b.worker_id = a.worker_id AND b.assignment_id = a.assignment_id)");
    if ($awrClose > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'AWR',
            'title' => "$awrClose placement(s) reach the AWR 12-week mark within a fortnight",
            'detail' => 'From week 12 the worker is entitled to equal treatment on pay and conditions with a direct hire.',
            'action' => 'Confirm the comparator terms with the client before the clock completes.', 'page' => 'workers'];
    }

    // --- Money ---------------------------------------------------------------
    $overdue = row($db, "SELECT COUNT(*) AS n, COALESCE(SUM(gross_pence - paid_pence), 0) AS pence
        FROM invoices WHERE status = 'overdue'");
    if ((int) $overdue['n'] > 0) {
        $old = (int) scalar($db, "SELECT COUNT(*) FROM invoices WHERE status = 'overdue' AND due_date < ?",
            [add_days($t, -60)]);
        $findings[] = ['severity' => $old > 0 ? 'critical' : 'warning', 'area' => 'Debtors',
            'title' => $gbp((int) $overdue['pence']) . " overdue across {$overdue['n']} invoice(s)",
            'detail' => $old > 0
                ? "$old of them are more than 60 days past due — recovery odds fall sharply from here."
                : 'Statutory interest at Bank of England base + 8% is claimable on every one.',
            'action' => 'Send the reminders from the invoice screen; the interest calculation is ready on each invoice.',
            'page' => 'invoices'];
    }

    $stale = row($db, "SELECT COUNT(*) AS n, COALESCE(SUM(charge_total_pence), 0) AS pence
        FROM timesheets WHERE status = 'approved' AND invoice_id IS NULL AND week_ending < ?",
        [add_days($t, -14)]);
    if ((int) $stale['n'] > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'Billing',
            'title' => $gbp((int) $stale['pence']) . ' of approved work is over two weeks unbilled',
            'detail' => "{$stale['n']} timesheet(s) are approved but not yet on an invoice — every week unbilled is a week added to payment terms.",
            'action' => 'Open Sales invoices and bill the approved timesheets.', 'page' => 'invoices'];
    }

    $vat = vat_threshold_status($db);
    if (in_array($vat['severity'], ['urgent', 'watch'], true)) {
        $findings[] = ['severity' => $vat['severity'] === 'urgent' ? 'critical' : 'watch', 'area' => 'VAT',
            'title' => 'Rolling turnover is approaching the VAT registration threshold',
            'detail' => $vat['message'],
            'action' => 'Plan the registration date and price VAT into new quotes before it becomes mandatory.',
            'page' => 'statutory'];
    }

    // --- Evidence gaps -------------------------------------------------------
    $noScan = (int) scalar($db, "SELECT COUNT(*) FROM timesheets tsh
        WHERE tsh.status IN ('approved','invoiced')
          AND NOT EXISTS (SELECT 1 FROM documents d
                          WHERE d.entity_type = 'timesheet' AND d.entity_id = tsh.id
                            AND d.category = 'signed_timesheet')");
    if ($noScan > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'Evidence',
            'title' => "$noScan billed or approved timesheet(s) have no signed scan attached",
            'detail' => 'The enquiry pack will flag them, and a client dispute over those hours is hard to defend.',
            'action' => 'Photograph the paper sheets and attach them from the timesheet screen.', 'page' => 'timesheets'];
    }

    $noChain = (int) scalar($db, "SELECT COUNT(*) FROM assignments a
        WHERE a.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM supply_chain_links l WHERE l.assignment_id = a.id)");
    if ($noChain > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'Supply chain',
            'title' => "$noChain active assignment(s) have no supply chain mapped",
            'detail' => 'Without the chain, PAYE responsibility for umbrella workers cannot be shown — the first thing HMRC asks a labour supplier.',
            'action' => 'Open each assignment and map the chain; it takes a minute per assignment.', 'page' => 'clients'];
    }

    $missingDd = 0;
    foreach (rows($db, 'SELECT DISTINCT o.id FROM organisations o JOIN assignments a ON a.client_org_id = o.id') as $o) {
        if (!due_diligence_status($db, $o['id'])['complete']) $missingDd++;
    }
    if ($missingDd > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'Due diligence',
            'title' => "$missingDd counterpart" . ($missingDd === 1 ? 'y' : 'ies') . ' missing Kittel due diligence',
            'detail' => 'If a counterparty turns out to be connected to fraud, undocumented checks are what turns their problem into yours.',
            'action' => 'Record the four checks on each organisation: Companies House, VAT number, insurance, signed terms.',
            'page' => 'clients'];
    }

    // --- Rota ----------------------------------------------------------------
    $unfilled = (int) scalar($db, "SELECT COUNT(*) FROM shifts
        WHERE worker_id IS NULL AND status = 'planned' AND date(starts_at) BETWEEN ? AND ?",
        [$t, add_days($t, 7)]);
    if ($unfilled > 0) {
        $findings[] = ['severity' => 'warning', 'area' => 'Rota',
            'title' => "$unfilled shift(s) in the next 7 days are unfilled",
            'detail' => 'An unfilled security shift is a contract breach with the client, not just lost revenue.',
            'action' => 'Open the Rota and allocate officers.', 'page' => 'rota'];
    }

    // --- Filing deadlines ----------------------------------------------------
    foreach (upcoming_filings($db, $t, 30) as $f) {
        $findings[] = ['severity' => ($f['overdue'] || $f['daysUntilDue'] <= 7) ? 'critical' : 'watch',
            'area' => 'Filings',
            'title' => "{$f['label']} due {$f['dueOn']}" . ($f['overdue'] ? ' — LATE' : ''),
            'detail' => $f['overdue'] ? 'The deadline has passed; penalties accrue from the due date.'
                : "{$f['daysUntilDue']} day(s) remain.",
            'action' => 'Prepare it from the Statutory screen — the supporting figures are generated there.',
            'page' => 'statutory'];
    }

    usort($findings, fn($a, $b) => RISK_SEVERITY_RANK[$a['severity']] <=> RISK_SEVERITY_RANK[$b['severity']]);
    return $findings;
}

// ---------------------------------------------------------------------------
// Dashboard analytics
// ---------------------------------------------------------------------------

function dashboard_analytics(PDO $db): array {
    [$y, $m] = array_map('intval', explode('-', substr(today_iso(), 0, 7)));
    $months = [];
    for ($i = 11; $i >= 0; $i--) {
        $total = $y * 12 + ($m - 1) - $i;
        $months[] = sprintf('%d-%02d', intdiv($total, 12), ($total % 12) + 1);
    }
    $first = $months[0] . '-01';

    $invoiced = [];
    foreach (rows($db, "SELECT substr(issue_date, 1, 7) AS m, SUM(base_net_pence) AS pence
            FROM invoices WHERE number IS NOT NULL AND status <> 'void' AND issue_date >= ? GROUP BY m",
        [$first]) as $r) $invoiced[$r['m']] = (int) $r['pence'];

    $work = [];
    foreach (rows($db, "SELECT substr(week_ending, 1, 7) AS m,
              SUM(charge_total_pence) AS charge, SUM(pay_total_pence) AS pay
            FROM timesheets WHERE status IN ('approved','invoiced') AND week_ending >= ? GROUP BY m",
        [$first]) as $r) $work[$r['m']] = ['charge' => (int) $r['charge'], 'pay' => (int) $r['pay']];

    return ['months' => array_map(fn($mo) => [
        'month' => $mo,
        'invoicedPence' => $invoiced[$mo] ?? 0,
        'chargePence' => $work[$mo]['charge'] ?? 0,
        'payPence' => $work[$mo]['pay'] ?? 0,
        'marginPence' => ($work[$mo]['charge'] ?? 0) - ($work[$mo]['pay'] ?? 0),
    ], $months)];
}

// ---------------------------------------------------------------------------
// Compliance registers — the instant-documents hub
// ---------------------------------------------------------------------------

function build_register(PDO $db, string $type, ?string $from = null, ?string $to = null): array {
    return match ($type) {
        'sia_deployment' => register_sia_deployment($db, $from, $to),
        'rtw' => register_rtw($db),
        'screening' => register_screening($db),
        'kid' => register_kid($db),
        default => throw new DomainException(
            "Unknown register: $type. Available: sia_deployment, rtw, screening, kid."),
    };
}

function register_sia_deployment(PDO $db, ?string $from, ?string $to): array {
    $conds = ["s.worker_id IS NOT NULL", "s.status IN ('allocated','worked','invoiced')"];
    $params = [];
    if ($from) { $conds[] = 'date(s.starts_at) >= ?'; $params[] = $from; }
    if ($to) { $conds[] = 'date(s.starts_at) <= ?'; $params[] = $to; }

    $data = rows($db, 'SELECT date(s.starts_at) AS date, substr(s.starts_at, 12, 5) AS starts,
            substr(s.ends_at, 12, 5) AS ends,
            w.first_name || \' \' || w.last_name AS officer, w.reference,
            l.licence_number, l.sector, l.expires_on,
            o.name AS client, COALESCE(st.name, \'—\') AS site, s.status
        FROM shifts s
        JOIN workers w ON w.id = s.worker_id
        JOIN assignments a ON a.id = s.assignment_id
        JOIN organisations o ON o.id = a.client_org_id
        LEFT JOIN sites st ON st.id = s.site_id
        LEFT JOIN worker_licences l ON l.id =
          (SELECT id FROM worker_licences WHERE worker_id = w.id
             AND (a.required_licence_sector IS NULL OR sector = a.required_licence_sector)
           ORDER BY (status = \'valid\') DESC, expires_on DESC LIMIT 1)
        WHERE ' . implode(' AND ', $conds) . '
        ORDER BY s.starts_at', $params);

    return ['type' => 'sia_deployment',
        'title' => 'SIA officer deployment register',
        'subtitle' => ($from || $to)
            ? trim('Deployments ' . ($from ? 'from ' . format_date_uk($from) . ' ' : '') . ($to ? 'to ' . format_date_uk($to) : ''))
            : 'All recorded deployments',
        'columns' => [
            ['key' => 'date', 'label' => 'Date'], ['key' => 'times', 'label' => 'Times'],
            ['key' => 'officer', 'label' => 'Officer'], ['key' => 'reference', 'label' => 'Ref'],
            ['key' => 'licence_number', 'label' => 'SIA licence'], ['key' => 'sector', 'label' => 'Sector'],
            ['key' => 'expires_on', 'label' => 'Licence expiry'],
            ['key' => 'client', 'label' => 'Client'], ['key' => 'site', 'label' => 'Site'],
            ['key' => 'status', 'label' => 'Status'],
        ],
        'rows' => array_map(fn($r) => [
            'date' => format_date_uk($r['date']), 'times' => "{$r['starts']}–{$r['ends']}",
            'officer' => $r['officer'], 'reference' => $r['reference'] ?? '—',
            'licence_number' => $r['licence_number'] ?? 'NONE ON FILE',
            'sector' => $r['sector'] ? str_replace('_', ' ', $r['sector']) : '—',
            'expires_on' => $r['expires_on'] ? format_date_uk($r['expires_on']) : '—',
            'client' => $r['client'], 'site' => $r['site'], 'status' => $r['status'],
        ], $data),
        'footnote' => 'Licence shown is the relevant licence on file for the assignment’s required sector at generation time. '
            . 'Allocation is blocked at source when a licence would be expired on the shift date.'];
}

function register_rtw(PDO $db): array {
    $data = rows($db, 'SELECT w.first_name || \' \' || w.last_name AS worker, w.reference,
            r.method, r.share_code, r.document_type, r.document_ref,
            r.checked_on, r.checked_by, r.outcome, r.expires_on, r.recheck_due_on
        FROM worker_rtw r JOIN workers w ON w.id = r.worker_id
        ORDER BY w.last_name, r.checked_on');

    return ['type' => 'rtw',
        'title' => 'Right-to-work check register',
        'subtitle' => 'The statutory excuse log — every check, its method, who performed it and when it must be repeated',
        'columns' => [
            ['key' => 'worker', 'label' => 'Worker'], ['key' => 'reference', 'label' => 'Ref'],
            ['key' => 'method', 'label' => 'Method'], ['key' => 'evidence', 'label' => 'Share code / document'],
            ['key' => 'checked_on', 'label' => 'Checked'], ['key' => 'checked_by', 'label' => 'By'],
            ['key' => 'outcome', 'label' => 'Outcome'], ['key' => 'recheck', 'label' => 'Expiry / recheck'],
        ],
        'rows' => array_map(fn($r) => [
            'worker' => $r['worker'], 'reference' => $r['reference'] ?? '—',
            'method' => str_replace('_', ' ', $r['method']),
            'evidence' => $r['share_code'] ?? trim(($r['document_type'] ?? '') . ' ' . ($r['document_ref'] ?? '')) ?: '—',
            'checked_on' => format_date_uk($r['checked_on']), 'checked_by' => $r['checked_by'] ?? '—',
            'outcome' => str_replace('_', ' ', $r['outcome']),
            'recheck' => $r['expires_on'] ? format_date_uk($r['expires_on'])
                : ($r['recheck_due_on'] ? 'recheck ' . format_date_uk($r['recheck_due_on']) : 'not time-limited'),
        ], $data),
        'footnote' => 'A compliant check before the first day of work gives a statutory excuse against an illegal working '
            . 'penalty. Time-limited permissions are re-checked before expiry; allocation is blocked once expired.'];
}

function register_screening(PDO $db): array {
    $elements = ['identity', 'address_history', 'employment_history',
        'character_references', 'financial_probity', 'criminal_record'];

    $out = [];
    foreach (rows($db, "SELECT id, first_name || ' ' || last_name AS worker, reference, status
            FROM workers WHERE status <> 'left' ORDER BY last_name") as $w) {
        $checks = [];
        foreach (rows($db, 'SELECT element, status, completed_on FROM screening_checks WHERE worker_id = ?',
            [$w['id']]) as $c) $checks[$c['element']] = $c;

        $row = ['worker' => $w['worker'], 'reference' => $w['reference'] ?? '—', 'worker_status' => $w['status']];
        $complete = true;
        foreach ($elements as $el) {
            $c = $checks[$el] ?? null;
            $ok = $c && in_array($c['status'], ['satisfied', 'waived'], true);
            if (!$ok) $complete = false;
            $row[$el] = $c
                ? $c['status'] . ($c['completed_on'] ? ' ' . format_date_uk($c['completed_on']) : '')
                : 'not started';
        }
        $row['overall'] = $complete ? 'COMPLETE' : 'INCOMPLETE';
        $out[] = $row;
    }

    return ['type' => 'screening',
        'title' => 'BS 7858 screening register',
        'subtitle' => 'Every screening element per worker — identity, 5-year address and employment history, references, financial probity, criminal record',
        'columns' => array_merge(
            [['key' => 'worker', 'label' => 'Worker'], ['key' => 'reference', 'label' => 'Ref']],
            array_map(fn($el) => ['key' => $el, 'label' => str_replace('_', ' ', $el)], $elements),
            [['key' => 'overall', 'label' => 'Overall']]),
        'rows' => $out,
        'footnote' => 'BS 7858:2019 requires all elements before unsupervised deployment; limited screening applies only '
            . 'within the standard’s window. Allocation is blocked while screening is incomplete.'];
}

function register_kid(PDO $db): array {
    $data = rows($db, 'SELECT w.first_name || \' \' || w.last_name AS worker, w.reference,
            k.version, k.issued_on, k.issued_by, k.engagement_type, k.pay_rate_pence,
            o.name AS umbrella
        FROM key_information_documents k
        JOIN workers w ON w.id = k.worker_id
        LEFT JOIN organisations o ON o.id = k.umbrella_org_id
        ORDER BY w.last_name, k.version');

    return ['type' => 'kid',
        'title' => 'Key Information Document register',
        'subtitle' => 'Every KID issued under the Conduct of Employment Agencies and Employment Businesses Regulations 2003',
        'columns' => [
            ['key' => 'worker', 'label' => 'Worker'], ['key' => 'reference', 'label' => 'Ref'],
            ['key' => 'version', 'label' => 'Version'], ['key' => 'issued_on', 'label' => 'Issued'],
            ['key' => 'issued_by', 'label' => 'By'], ['key' => 'engagement_type', 'label' => 'Engagement'],
            ['key' => 'pay_rate', 'label' => 'Pay rate'], ['key' => 'umbrella', 'label' => 'Umbrella'],
        ],
        'rows' => array_map(fn($r) => [
            'worker' => $r['worker'], 'reference' => $r['reference'] ?? '—', 'version' => $r['version'],
            'issued_on' => format_date_uk($r['issued_on']), 'issued_by' => $r['issued_by'] ?? '—',
            'engagement_type' => str_replace('_', ' ', $r['engagement_type']),
            'pay_rate' => $r['pay_rate_pence'] !== null
                ? '£' . number_format($r['pay_rate_pence'] / 100, 2) . '/hr' : 'as agreed',
            'umbrella' => $r['umbrella'] ?? '—',
        ], $data),
        'footnote' => 'A KID must be given before terms are agreed with a work-seeker, and re-issued when the key facts change.'];
}

function render_register_html(PDO $db, array $reg): string {
    $c = row($db, 'SELECT * FROM company WHERE id = 1') ?? [];
    $generated = str_replace('T', ' ', substr(now_instant(), 0, 16)) . ' UTC';

    $head = implode('', array_map(fn($col) => '<th>' . esc($col['label']) . '</th>', $reg['columns']));
    $body = implode('', array_map(fn($row) => '<tr>' . implode('', array_map(
        fn($col) => '<td>' . esc((string) ($row[$col['key']] ?? '')) . '</td>', $reg['columns'])) . '</tr>',
        $reg['rows']));

    return '<!doctype html>
<html><head><meta charset="utf-8"><title>' . esc($reg['title']) . '</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px/1.5 Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; padding: 8px; }
  .rule-top { border-top: 4px solid #1a1a1a; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #555; margin-bottom: 4px; }
  .meta { color: #777; font-size: 10px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.5px; text-transform: uppercase;
       color: #444; border-top: 2px solid #1a1a1a; border-bottom: 2px solid #1a1a1a; padding: 6px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  .footnote { margin-top: 14px; font-size: 9.5px; color: #666; border-top: 1px solid #ddd; padding-top: 8px; }
</style></head><body>
<div class="rule-top"></div>
<h1>' . esc($reg['title']) . '</h1>
<div class="sub">' . esc($reg['subtitle']) . '</div>
<div class="meta">' . esc($c['legal_name'] ?? 'Cerviz Ltd')
    . (($c['company_number'] ?? null) ? ', company number ' . esc($c['company_number']) : '')
    . ' · generated ' . esc($generated) . ' · ' . count($reg['rows'])
    . ' row(s) · produced from live records by the Cerviz back office</div>
<table><thead><tr>' . $head . '</tr></thead><tbody>' . $body . '</tbody></table>
<div class="footnote">' . esc($reg['footnote']) . '</div>
</body></html>';
}

function register_csv(array $reg): string {
    $cell = fn($v) => preg_match('/[",\n]/', (string) $v)
        ? '"' . str_replace('"', '""', (string) $v) . '"' : (string) $v;
    $lines = [implode(',', array_map(fn($c) => $cell($c['label']), $reg['columns']))];
    foreach ($reg['rows'] as $row) {
        $lines[] = implode(',', array_map(fn($c) => $cell($row[$c['key']] ?? ''), $reg['columns']));
    }
    return implode("\n", $lines);
}

// ---------------------------------------------------------------------------
// Companies House lookup — auto-fill for counterparty records
// ---------------------------------------------------------------------------

function companies_house_lookup(PDO $db, string $number): array {
    $number = strtoupper(trim($number));
    if (!preg_match('/^[A-Z0-9]{2,10}$/', $number)) {
        fail('Enter a company number, e.g. 09985380.');
    }
    $key = scalar($db, "SELECT value FROM settings WHERE key = 'companies_house_api_key'");
    if (!$key) {
        fail('No Companies House API key is set. Get a free key at developer.company-information.service.gov.uk and save it under Settings.');
    }

    $ch = curl_init('https://api.company-information.service.gov.uk/company/'
        . str_pad($number, 8, '0', STR_PAD_LEFT));
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_HTTPHEADER => ['Authorization: Basic ' . base64_encode($key . ':')],
    ]);
    $bodyText = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);

    if ($bodyText === false) fail('Could not reach Companies House. Check the server\'s internet access.', 502);
    if ($status === 404) fail('No company found with that number.', 404);
    if ($status === 401) fail('Companies House rejected the API key. Check it under Settings.');
    if ($status < 200 || $status >= 300) fail("Companies House returned $status. Try again shortly.", 502);

    $d = json_decode($bodyText, true) ?? [];
    return [
        'companyNumber' => $d['company_number'] ?? $number,
        'name' => $d['company_name'] ?? null,
        'status' => $d['company_status'] ?? null,
        'type' => $d['type'] ?? null,
        'incorporatedOn' => $d['date_of_creation'] ?? null,
        'sicCodes' => $d['sic_codes'] ?? [],
        'address' => [
            'line1' => $d['registered_office_address']['address_line_1'] ?? null,
            'line2' => $d['registered_office_address']['address_line_2'] ?? null,
            'city' => $d['registered_office_address']['locality'] ?? null,
            'postcode' => $d['registered_office_address']['postal_code'] ?? null,
        ],
    ];
}
