<?php
/**
 * Supply chain, statutory obligations, bank reconciliation, evidence files and
 * backups — ports of supplyChain.ts, statutory.ts, tide.ts, documents.ts and
 * backup.ts.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Supply chain and due diligence
// ---------------------------------------------------------------------------

const REQUIRED_DD_CHECKS = ['companies_house', 'vat_number', 'insurance', 'contract'];

const DD_CHECK_LABELS = [
    'companies_house' => 'Companies House registration verified',
    'vat_number' => 'VAT number verified',
    'insurance' => 'Employer’s and public liability insurance seen',
    'contract' => 'Signed contract or terms of business on file',
    'credit' => 'Credit check',
    'licence' => 'Licence or accreditation verified',
    'site_visit' => 'Site visit carried out',
    'other' => 'Other check',
];

function set_supply_chain(PDO $db, string $assignmentId, array $links, string $actor = 'system'): void {
    if (!row($db, 'SELECT id FROM assignments WHERE id = ?', [$assignmentId])) {
        throw new DomainException('Assignment not found');
    }
    $roles = array_column($links, 'role');
    if (!in_array('cerviz', $roles, true)) {
        throw new DomainException('The supply chain must include Cerviz — the map is incomplete without our own position.');
    }
    if (!in_array('end_client', $roles, true)) {
        throw new DomainException('The supply chain must identify the end client — the party whose site the officers actually work on. Without it, PAYE responsibility cannot be determined.');
    }

    $before = rows($db, 'SELECT * FROM supply_chain_links WHERE assignment_id = ? ORDER BY position', [$assignmentId]);
    q($db, 'DELETE FROM supply_chain_links WHERE assignment_id = ?', [$assignmentId]);

    $now = now_instant();
    foreach (array_values($links) as $i => $link) {
        q($db, 'INSERT INTO supply_chain_links
                  (id, assignment_id, position, role, organisation_id, description, contract_ref, notes, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)',
            [new_id('scl'), $assignmentId, $i, $link['role'], $link['organisationId'] ?? null,
             $link['description'] ?? null, $link['contractRef'] ?? null, $link['notes'] ?? null, $now]);
    }

    record_audit($db, [
        'entityType' => 'assignment', 'entityId' => $assignmentId, 'action' => 'supply_chain_updated',
        'summary' => 'Supply chain map set: ' . implode(' → ', $roles),
        'actor' => $actor, 'before' => $before, 'after' => $links,
    ]);
}

function derive_paye_responsibility(PDO $db, string $assignmentId): array {
    $links = rows($db, 'SELECT * FROM supply_chain_links WHERE assignment_id = ? ORDER BY position', [$assignmentId]);

    $cerviz = null; $endClient = null; $upperAgencies = [];
    foreach ($links as $l) {
        if ($l['role'] === 'cerviz') $cerviz = $l;
        elseif ($l['role'] === 'end_client') $endClient = $l;
        elseif ($l['role'] === 'upper_agency') $upperAgencies[] = $l;
    }

    $umbrellaCount = (int) scalar($db, "SELECT COUNT(DISTINCT s.worker_id)
        FROM shifts s JOIN workers w ON w.id = s.worker_id
        WHERE s.assignment_id = ? AND w.engagement_type = 'umbrella'", [$assignmentId]);
    $hasUmbrella = $umbrellaCount > 0;

    if (!$cerviz || !$endClient) {
        return ['assignmentId' => $assignmentId, 'cervizPosition' => $cerviz['position'] ?? -1,
            'cervizContractsWithEndClient' => false, 'hasUmbrellaWorkers' => $hasUmbrella,
            'responsibility' => 'unclear', 'confidence' => 'check_contract',
            'summary' => 'Supply chain incomplete',
            'detail' => 'The chain does not identify both Cerviz and the end client, so responsibility cannot be derived.',
            'actions' => ['Complete the supply chain map for this assignment.']];
    }

    $contractsDirectly = true;
    foreach ($upperAgencies as $a) {
        if ((int) $a['position'] > (int) $endClient['position'] && (int) $a['position'] < (int) $cerviz['position']) {
            $contractsDirectly = false;
            break;
        }
    }

    if (!$hasUmbrella) {
        return ['assignmentId' => $assignmentId, 'cervizPosition' => (int) $cerviz['position'],
            'cervizContractsWithEndClient' => $contractsDirectly, 'hasUmbrellaWorkers' => false,
            'responsibility' => 'not_applicable', 'confidence' => 'clear',
            'summary' => 'No umbrella workers on this assignment',
            'detail' => 'The umbrella PAYE rules do not bite here because no worker on this assignment is paid through '
                . 'an umbrella company. Normal PAYE or off-payroll rules still apply to however the workers are engaged.',
            'actions' => []];
    }

    if ($contractsDirectly) {
        return ['assignmentId' => $assignmentId, 'cervizPosition' => (int) $cerviz['position'],
            'cervizContractsWithEndClient' => true, 'hasUmbrellaWorkers' => true,
            'responsibility' => 'cerviz', 'confidence' => 'check_contract',
            'summary' => 'PAYE responsibility likely sits with Cerviz',
            'detail' => 'Cerviz contracts directly with the end client (' . ($endClient['description'] ?? 'end client') . ') and '
                . "$umbrellaCount worker(s) on this assignment are paid through an umbrella. Since April 2026, "
                . 'responsibility for accounting for PAYE on umbrella workers sits with the agency that contracts '
                . 'with the end client — which on this assignment appears to be Cerviz.',
            'actions' => [
                'Confirm this reading against the actual contract with your accountant.',
                'Keep the umbrella’s pay-chain evidence for every worker on this assignment.',
                'Satisfy yourself that the umbrella is operating PAYE correctly — the liability may land on you.',
            ]];
    }

    $upper = $upperAgencies[0] ?? null;
    return ['assignmentId' => $assignmentId, 'cervizPosition' => (int) $cerviz['position'],
        'cervizContractsWithEndClient' => false, 'hasUmbrellaWorkers' => true,
        'responsibility' => 'upper_agency', 'confidence' => 'check_contract',
        'summary' => 'PAYE responsibility likely sits with the agency above Cerviz',
        'detail' => ($upper['description'] ?? 'An agency above Cerviz') . ' holds the end-client relationship on this assignment, '
            . 'so responsibility for umbrella PAYE most likely sits with them rather than Cerviz. This does not '
            . 'remove Cerviz from the chain: HMRC can still look down the chain where the responsible party fails, '
            . 'and supply chain due diligence remains Cerviz’s own obligation.',
        'actions' => [
            'Confirm in writing with the agency above that they are accounting for umbrella PAYE.',
            'Keep due diligence records for that agency current.',
            'Retain the umbrella’s details and pay-chain evidence regardless.',
        ]];
}

function record_due_diligence(PDO $db, array $input, string $actor = 'system'): string {
    $id = new_id('dd');
    $performedOn = $input['performedOn'] ?? today_iso();
    q($db, 'INSERT INTO org_due_diligence
              (id, organisation_id, check_type, performed_on, performed_by, outcome, reference, notes, next_review_on, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)',
        [$id, $input['organisationId'], $input['checkType'], $performedOn,
         $input['performedBy'] ?? $actor, $input['outcome'], $input['reference'] ?? null,
         $input['notes'] ?? null, add_months($performedOn, (int) ($input['reviewMonths'] ?? 12)), now_instant()]);

    record_audit($db, [
        'entityType' => 'organisation', 'entityId' => $input['organisationId'], 'action' => 'due_diligence_recorded',
        'summary' => (DD_CHECK_LABELS[$input['checkType']] ?? $input['checkType']) . ": {$input['outcome']}",
        'actor' => $actor, 'after' => $input,
    ]);
    return $id;
}

function due_diligence_status(PDO $db, string $organisationId): array {
    $org = row($db, 'SELECT * FROM organisations WHERE id = ?', [$organisationId]);
    if (!$org) throw new DomainException('Organisation not found');

    $checks = rows($db, 'SELECT * FROM org_due_diligence WHERE organisation_id = ? ORDER BY performed_on DESC',
        [$organisationId]);

    $latestByType = [];
    foreach ($checks as $c) {
        if (!isset($latestByType[$c['check_type']])) $latestByType[$c['check_type']] = $c;
    }

    $missing = array_values(array_map(fn($t) => DD_CHECK_LABELS[$t],
        array_filter(REQUIRED_DD_CHECKS, fn($t) => !isset($latestByType[$t]))));
    $failed = array_values(array_map(fn($c) => DD_CHECK_LABELS[$c['check_type']] ?? $c['check_type'],
        array_filter($latestByType, fn($c) => $c['outcome'] === 'fail')));
    $now = today_iso();
    $overdue = array_values(array_map(
        fn($c) => (DD_CHECK_LABELS[$c['check_type']] ?? $c['check_type']) . " (due {$c['next_review_on']})",
        array_filter($latestByType, fn($c) => $c['next_review_on'] && $c['next_review_on'] < $now)));

    $complete = !$missing && !$failed;

    if ($failed) {
        $riskNote = 'A due diligence check has FAILED for this counterparty. Do not place workers or accept work '
            . 'until it is resolved and the resolution is documented.';
    } elseif ($missing) {
        $riskNote = count($missing) . ' required check(s) have never been carried out. If this counterparty turns out to '
            . 'be connected to fraud, undocumented checks are what turns someone else’s problem into yours.';
    } elseif ($overdue) {
        $riskNote = count($overdue) . ' check(s) are past their review date. Refresh them.';
    } else {
        $riskNote = 'Due diligence is complete and current for this counterparty.';
    }

    return ['organisationId' => $organisationId, 'name' => $org['name'], 'complete' => $complete,
        'missing' => $missing, 'failed' => $failed, 'overdue' => $overdue, 'checks' => $checks,
        'riskNote' => $riskNote];
}

function supply_chain_for(PDO $db, string $assignmentId): array {
    $links = rows($db, 'SELECT l.*, o.name AS organisation_name, o.company_number, o.vat_number
        FROM supply_chain_links l
        LEFT JOIN organisations o ON o.id = l.organisation_id
        WHERE l.assignment_id = ? ORDER BY l.position', [$assignmentId]);

    return [
        'links' => array_map(fn($l) => $l + [
            'dueDiligence' => $l['organisation_id'] ? due_diligence_status($db, $l['organisation_id']) : null,
        ], $links),
        'payeResponsibility' => derive_paye_responsibility($db, $assignmentId),
    ];
}

// ---------------------------------------------------------------------------
// Employment intermediaries report and the filing calendar
// ---------------------------------------------------------------------------

const INTERMEDIARY_REASON_CODES = [
    'umbrella' => 'D — Another party operated PAYE on the worker’s payments',
    'limited' => 'A — Self-employed',
    'self_employed' => 'A — Self-employed',
];

function generate_intermediary_report(PDO $db, string $from, string $to): array {
    $workers = rows($db, "SELECT DISTINCT w.id, w.first_name, w.last_name, w.ni_number, w.date_of_birth,
              w.address_1, w.address_2, w.city, w.postcode, w.engagement_type,
              u.name AS umbrella_name, u.company_number AS umbrella_company_number,
              u.address_1 AS umbrella_address_1, u.city AS umbrella_city, u.postcode AS umbrella_postcode,
              MIN(date(s.starts_at)) AS first_shift,
              MAX(date(s.starts_at)) AS last_shift
        FROM workers w
        JOIN shifts s ON s.worker_id = w.id
        LEFT JOIN organisations u ON u.id = w.umbrella_org_id
        WHERE w.engagement_type IN ('umbrella','limited','self_employed')
          AND s.status IN ('worked','allocated')
          AND date(s.starts_at) BETWEEN ? AND ?
        GROUP BY w.id", [$from, $to]);

    return array_map(function ($w) use ($db, $from, $to) {
        $paid = (int) scalar($db, "SELECT COALESCE(SUM(pil.net_pence),0)
            FROM purchase_invoice_lines pil
            JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id
            WHERE pil.worker_id = ? AND pi.invoice_date BETWEEN ? AND ? AND pi.status <> 'void'",
            [$w['id'], $from, $to]);
        $fallback = (int) scalar($db, "SELECT COALESCE(SUM(pay_total_pence),0) FROM timesheets
            WHERE worker_id = ? AND week_ending BETWEEN ? AND ? AND status IN ('approved','invoiced')",
            [$w['id'], $from, $to]);

        return [
            'workerFirstName' => $w['first_name'], 'workerLastName' => $w['last_name'],
            'workerNiNumber' => $w['ni_number'], 'workerDateOfBirth' => $w['date_of_birth'],
            'workerAddress' => implode(', ', array_filter([$w['address_1'], $w['address_2'], $w['city']])),
            'workerPostcode' => $w['postcode'],
            'engagementStartDate' => $w['first_shift'], 'engagementEndDate' => $w['last_shift'],
            'paymentToIntermediary' => ($paid ?: $fallback) / 100,
            'currency' => 'GBP', 'vatIncluded' => 'No',
            'intermediaryName' => $w['umbrella_name'],
            'intermediaryCompanyNumber' => $w['umbrella_company_number'],
            'intermediaryAddress' => implode(', ', array_filter([
                $w['umbrella_address_1'], $w['umbrella_city'], $w['umbrella_postcode']])) ?: null,
            'reasonNoPaye' => INTERMEDIARY_REASON_CODES[$w['engagement_type']] ?? 'Other',
        ];
    }, $workers);
}

function intermediary_report_csv(array $reportRows): string {
    $headers = ['Worker forename', 'Worker surname', 'NI number', 'Date of birth',
        'Worker address', 'Postcode', 'Engagement start date', 'Engagement end date',
        'Amount paid to intermediary', 'Currency', 'VAT included',
        'Intermediary name', 'Intermediary company registration number', 'Intermediary address',
        'Reason PAYE not operated'];

    $esc = fn($v) => preg_match('/[",\n]/', (string) $v)
        ? '"' . str_replace('"', '""', (string) $v) . '"' : (string) $v;

    $lines = [implode(',', $headers)];
    foreach ($reportRows as $r) {
        $lines[] = implode(',', array_map($esc, [
            $r['workerFirstName'], $r['workerLastName'], $r['workerNiNumber'], $r['workerDateOfBirth'],
            $r['workerAddress'], $r['workerPostcode'], $r['engagementStartDate'], $r['engagementEndDate'],
            number_format($r['paymentToIntermediary'], 2, '.', ''), $r['currency'], $r['vatIncluded'],
            $r['intermediaryName'], $r['intermediaryCompanyNumber'], $r['intermediaryAddress'],
            $r['reasonNoPaye']]));
    }
    return implode("\n", $lines);
}

function ensure_intermediary_periods(PDO $db, ?string $asOf = null): void {
    $asOf = $asOf ?? today_iso();
    $now = now_instant();
    for ($i = 0; $i < 4; $i++) {
        $p = intermediary_period_for(add_months($asOf, -3 * $i));
        q($db, "INSERT OR IGNORE INTO intermediary_reports (id, period_from, period_to, due_on, status, created_at, updated_at)
                VALUES (?,?,?,?, 'due', ?,?)",
            [new_id('imr'), $p['from'], $p['to'], $p['due'], $now, $now]);
    }
}

function intermediary_obligations(PDO $db, ?string $asOf = null): array {
    $asOf = $asOf ?? today_iso();
    ensure_intermediary_periods($db, $asOf);

    return array_map(function ($p) use ($db, $asOf) {
        $reportRows = generate_intermediary_report($db, $p['period_from'], $p['period_to']);
        $days = days_between($asOf, $p['due_on']);
        $submitted = in_array($p['status'], ['submitted', 'nil_return'], true);
        $overdue = !$submitted && $days < 0;
        $n = count($reportRows);

        if ($submitted) {
            $message = 'Submitted' . ($p['submitted_on'] ? " on {$p['submitted_on']}" : '') . '.';
        } elseif ($n === 0) {
            $message = 'No reportable workers in this period. A nil return is still required once you have started '
                . 'reporting — HMRC treats silence as a missed return.';
        } elseif ($overdue) {
            $message = 'OVERDUE by ' . abs($days) . " days with $n reportable worker(s). "
                . 'Penalties start at £250 and rise to £600 then £1,000 for repeated failures. File this now.';
        } elseif ($days <= 14) {
            $message = "Due in $days day(s) with $n reportable worker(s). Generate and submit it.";
        } else {
            $message = "$n reportable worker(s) so far. Due {$p['due_on']}.";
        }

        return ['periodFrom' => $p['period_from'], 'periodTo' => $p['period_to'], 'dueOn' => $p['due_on'],
            'status' => $p['status'], 'workerCount' => $n, 'daysUntilDue' => $days,
            'overdue' => $overdue, 'message' => $message];
    }, rows($db, 'SELECT * FROM intermediary_reports ORDER BY period_to DESC'));
}

function mark_intermediary_submitted(PDO $db, string $from, string $to, array $opts = [], string $actor = 'system'): void {
    $n = count(generate_intermediary_report($db, $from, $to));
    q($db, 'UPDATE intermediary_reports SET status = ?, submitted_on = ?, worker_count = ?, updated_at = ?
            WHERE period_from = ? AND period_to = ?',
        [!empty($opts['nilReturn']) ? 'nil_return' : 'submitted',
         $opts['submittedOn'] ?? today_iso(), $n, now_instant(), $from, $to]);
    record_audit($db, [
        'entityType' => 'intermediary_report', 'entityId' => "{$from}_{$to}", 'action' => 'submitted',
        'summary' => "Employment intermediaries report for $from to $to marked submitted ($n workers)",
        'actor' => $actor, 'after' => $opts,
    ]);
}

const FILING_LABELS = [
    'annual_accounts' => 'Annual accounts (Companies House)',
    'confirmation_statement' => 'Confirmation statement (Companies House)',
    'corporation_tax' => 'Company tax return (HMRC)',
    'vat_return' => 'VAT return (HMRC)',
    'employment_intermediary_report' => 'Employment intermediaries report (HMRC)',
    'rti_fps' => 'Payroll RTI submission (HMRC)',
];

function refresh_filing_calendar(PDO $db, ?string $asOf = null): void {
    $asOf = $asOf ?? today_iso();
    $company = row($db, 'SELECT * FROM company WHERE id = 1');
    if (!$company || !$company['incorporated_on']) return;

    $now = now_instant();
    $inc = $company['incorporated_on'];
    $ardMonth = substr($inc, 5, 2);
    $thisYear = (int) substr($asOf, 0, 4);

    $upsert = function (string $type, ?string $from, ?string $to, string $due, string $notes) use ($db, $now): void {
        if (row($db, 'SELECT 1 FROM filings WHERE filing_type = ? AND due_on = ?', [$type, $due])) return;
        q($db, "INSERT INTO filings (id, filing_type, period_from, period_to, due_on, status, notes, created_at, updated_at)
                VALUES (?,?,?,?,?, 'due', ?,?,?)",
            [new_id('fil'), $type, $from, $to, $due, $notes, $now, $now]);
    };

    foreach ([$thisYear, $thisYear + 1] as $year) {
        $ardEnd = last_day_of_month("$year-$ardMonth");
        if ($ardEnd < $inc) continue;

        $upsert('annual_accounts', add_months($ardEnd, -12), $ardEnd, add_months($ardEnd, 9),
            'Companies House annual accounts. Late filing penalties start at £150 and reach £1,500, and they double if you are late two years running.');
        $upsert('corporation_tax', add_months($ardEnd, -12), $ardEnd, add_months($ardEnd, 12),
            'Company tax return (CT600). The tax itself is payable earlier — by ' . add_days(add_months($ardEnd, 9), 1) . '.');
        $upsert('confirmation_statement', null, "$year-" . substr($inc, 5),
            add_days("$year-" . substr($inc, 5), 14),
            'Companies House confirmation statement. Failing to file is a criminal offence and can lead to the company being struck off.');
    }
}

function upcoming_filings(PDO $db, ?string $asOf = null, int $withinDays = 180): array {
    $asOf = $asOf ?? today_iso();
    refresh_filing_calendar($db, $asOf);

    $horizon = add_days($asOf, $withinDays);
    return array_map(function ($f) use ($asOf) {
        $days = days_between($asOf, $f['due_on']);
        return ['id' => $f['id'], 'filingType' => $f['filing_type'],
            'label' => FILING_LABELS[$f['filing_type']] ?? $f['filing_type'],
            'dueOn' => $f['due_on'], 'daysUntilDue' => $days,
            'status' => $days < 0 ? 'late' : $f['status'], 'overdue' => $days < 0,
            'notes' => $f['notes']];
    }, rows($db, "SELECT * FROM filings WHERE status = 'due' AND due_on <= ? ORDER BY due_on ASC", [$horizon]));
}

function mark_filing_submitted(PDO $db, string $filingId, ?string $submittedOn, ?string $reference, string $actor = 'system'): void {
    $f = row($db, 'SELECT * FROM filings WHERE id = ?', [$filingId]);
    if (!$f) throw new DomainException('Filing not found');
    q($db, "UPDATE filings SET status = 'submitted', submitted_on = ?, reference = ?, updated_at = ? WHERE id = ?",
        [$submittedOn ?? today_iso(), $reference, now_instant(), $filingId]);
    record_audit($db, [
        'entityType' => 'filing', 'entityId' => $filingId, 'action' => 'submitted',
        'summary' => (FILING_LABELS[$f['filing_type']] ?? $f['filing_type']) . " due {$f['due_on']} marked submitted",
        'actor' => $actor, 'after' => ['submittedOn' => $submittedOn, 'reference' => $reference],
    ]);
}

// ---------------------------------------------------------------------------
// Tide statement import and reconciliation
// ---------------------------------------------------------------------------

function split_csv_line(string $line): array {
    $out = []; $cur = ''; $inQuotes = false;
    $len = strlen($line);
    for ($i = 0; $i < $len; $i++) {
        $ch = $line[$i];
        if ($ch === '"') {
            if ($inQuotes && ($line[$i + 1] ?? '') === '"') { $cur .= '"'; $i++; }
            else $inQuotes = !$inQuotes;
        } elseif ($ch === ',' && !$inQuotes) {
            $out[] = trim($cur); $cur = '';
        } else $cur .= $ch;
    }
    $out[] = trim($cur);
    return $out;
}

function pounds_to_pence(string $raw): int {
    $n = (float) preg_replace('/[£,\s]/u', '', $raw);
    return (int) round($n * 100);
}

function normalise_csv_date(string $raw): ?string {
    $s = trim($raw);
    if (preg_match('/^\d{4}-\d{2}-\d{2}/', $s)) return substr($s, 0, 10);
    if (preg_match('#^(\d{1,2})[/-](\d{1,2})[/-](\d{4})#', $s, $m)) {
        return sprintf('%s-%02d-%02d', $m[3], (int) $m[2], (int) $m[1]);
    }
    return null;
}

function parse_tide_csv(string $csv): array {
    $lines = array_values(array_filter(preg_split('/\r?\n/', $csv), fn($l) => trim($l) !== ''));
    if (count($lines) < 2) return [];

    $headers = array_map(fn($h) => preg_replace('/[^a-z]/', '', strtolower($h)), split_csv_line($lines[0]));
    $find = function (array $names) use ($headers): int {
        foreach ($headers as $i => $h) {
            foreach ($names as $n) if (str_contains($h, $n)) return $i;
        }
        return -1;
    };

    $iDate = $find(['date', 'transactiondate']);
    $iDesc = $find(['description', 'narrative', 'details', 'reference']);
    $iRef = $find(['reference', 'transactionid']);
    $iAmount = $find(['amount']);
    $iPaidIn = $find(['paidin', 'credit', 'moneyin']);
    $iPaidOut = $find(['paidout', 'debit', 'moneyout']);
    $iBalance = $find(['balance']);

    $out = [];
    foreach (array_slice($lines, 1) as $line) {
        $cells = split_csv_line($line);
        $date = $iDate >= 0 ? normalise_csv_date($cells[$iDate] ?? '') : null;
        if (!$date) continue;

        if ($iAmount >= 0 && ($cells[$iAmount] ?? '') !== '') {
            $amountPence = pounds_to_pence($cells[$iAmount]);
        } else {
            $inP = $iPaidIn >= 0 ? pounds_to_pence($cells[$iPaidIn] ?? '0') : 0;
            $outP = $iPaidOut >= 0 ? pounds_to_pence($cells[$iPaidOut] ?? '0') : 0;
            $amountPence = $inP - abs($outP);
        }
        if ($amountPence === 0) continue;

        $out[] = ['transactedOn' => $date, 'description' => $cells[$iDesc] ?? '',
            'reference' => ($iRef >= 0 && $iRef !== $iDesc) ? ($cells[$iRef] ?: null) : null,
            'amountPence' => $amountPence,
            'balancePence' => ($iBalance >= 0 && ($cells[$iBalance] ?? '') !== '')
                ? pounds_to_pence($cells[$iBalance]) : null];
    }
    return $out;
}

function import_tide_statement(PDO $db, string $csv): array {
    $account = row($db, "SELECT id FROM bank_accounts WHERE provider = 'Tide' LIMIT 1");
    if ($account) {
        $accountId = $account['id'];
    } else {
        $accountId = new_id('bank');
        q($db, "INSERT INTO bank_accounts (id, name, provider, currency, is_business, created_at)
                VALUES (?, 'Tide business account', 'Tide', 'GBP', 1, ?)", [$accountId, now_instant()]);
    }

    $parsed = parse_tide_csv($csv);
    $batch = new_id('batch');
    $now = now_instant();
    $imported = 0; $duplicates = 0;

    foreach ($parsed as $r) {
        $hashInput = "$accountId|{$r['transactedOn']}|{$r['description']}|{$r['amountPence']}|"
            . ($r['balancePence'] ?? '');
        try {
            q($db, 'INSERT INTO bank_transactions
                      (id, bank_account_id, transacted_on, description, reference, amount_pence, balance_pence,
                       import_batch, import_hash, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?)',
                [new_id('btx'), $accountId, $r['transactedOn'], $r['description'], $r['reference'],
                 $r['amountPence'], $r['balancePence'], $batch, hash('sha256', $hashInput), $now]);
            $imported++;
        } catch (PDOException $e) {
            if (str_contains($e->getMessage(), 'UNIQUE')) $duplicates++;
            else throw $e;
        }
    }

    $autoMatched = auto_match_transactions($db, $batch);
    record_audit($db, [
        'entityType' => 'bank_import', 'entityId' => $batch, 'action' => 'imported',
        'summary' => "Tide statement imported: $imported transaction(s), $duplicates duplicate(s) skipped, $autoMatched auto-matched",
        'after' => ['imported' => $imported, 'duplicates' => $duplicates, 'autoMatched' => $autoMatched],
    ]);

    return ['imported' => $imported, 'skippedDuplicates' => $duplicates,
        'autoMatched' => $autoMatched, 'batch' => $batch];
}

/** Conservative matching: an unambiguous signal or nothing. */
function auto_match_transactions(PDO $db, ?string $batch = null): int {
    $unmatched = rows($db, 'SELECT * FROM bank_transactions WHERE matched_type IS NULL'
        . ($batch ? ' AND import_batch = ?' : '') . ' ORDER BY transacted_on',
        $batch ? [$batch] : []);

    $matched = 0;
    foreach ($unmatched as $tx) {
        $haystack = strtoupper(preg_replace('/\s+/', '', ($tx['description'] ?? '') . ' ' . ($tx['reference'] ?? '')));

        if ((int) $tx['amount_pence'] > 0) {
            $candidates = rows($db, "SELECT id, number, gross_pence, paid_pence FROM invoices
                WHERE status IN ('issued','part_paid','overdue') AND number IS NOT NULL");
            $hit = null;
            foreach ($candidates as $i) {
                if ($i['number'] && str_contains($haystack, strtoupper(str_replace([' ', '-'], '', $i['number'])))) {
                    $hit = $i; break;
                }
            }
            if (!$hit) {
                $exact = array_values(array_filter($candidates,
                    fn($i) => (int) $i['gross_pence'] - (int) $i['paid_pence'] === (int) $tx['amount_pence']));
                if (count($exact) === 1) $hit = $exact[0];
            }
            if ($hit) {
                q($db, "UPDATE bank_transactions SET matched_type = 'invoice', matched_id = ?, matched_at = ? WHERE id = ?",
                    [$hit['id'], now_instant(), $tx['id']]);
                $matched++;
            }
        } else {
            $candidates = rows($db, "SELECT p.id, p.our_reference, p.their_reference, p.gross_pence, p.paid_pence
                FROM purchase_invoices p WHERE p.status NOT IN ('paid','void')");
            $amount = abs((int) $tx['amount_pence']);
            $hit = null;
            foreach ($candidates as $p) {
                foreach (array_filter([$p['our_reference'], $p['their_reference']]) as $ref) {
                    if (str_contains($haystack, strtoupper(str_replace([' ', '-'], '', $ref)))) { $hit = $p; break 2; }
                }
            }
            if (!$hit) {
                $exact = array_values(array_filter($candidates,
                    fn($p) => (int) $p['gross_pence'] - (int) $p['paid_pence'] === $amount));
                if (count($exact) === 1) $hit = $exact[0];
            }
            if ($hit) {
                q($db, "UPDATE bank_transactions SET matched_type = 'purchase_invoice', matched_id = ?, matched_at = ? WHERE id = ?",
                    [$hit['id'], now_instant(), $tx['id']]);
                $matched++;
            }
        }
    }
    return $matched;
}

function reconciliation_view(PDO $db, ?string $asOf = null): array {
    $unmatched = rows($db, 'SELECT * FROM bank_transactions WHERE matched_type IS NULL ORDER BY transacted_on DESC LIMIT 200');

    $invoicesAwaiting = rows($db, "SELECT i.id, i.number, i.issue_date, i.due_date, i.gross_pence, i.paid_pence,
              (i.gross_pence - i.paid_pence) AS outstanding, o.name AS client_name
        FROM invoices i JOIN organisations o ON o.id = i.client_org_id
        WHERE i.status IN ('issued','part_paid','overdue') AND i.gross_pence > i.paid_pence
        ORDER BY i.due_date");

    $purchasesAwaiting = rows($db, "SELECT p.id, p.our_reference, p.their_reference, p.invoice_date, p.due_date,
              (p.gross_pence - p.paid_pence) AS outstanding, o.name AS supplier
        FROM purchase_invoices p JOIN organisations o ON o.id = p.organisation_id
        WHERE p.status NOT IN ('paid','void') AND p.gross_pence > p.paid_pence
        ORDER BY p.due_date");

    $inTotal = array_sum(array_map(fn($t) => max(0, (int) $t['amount_pence']), $unmatched));
    $outTotal = array_sum(array_map(fn($t) => max(0, -(int) $t['amount_pence']), $unmatched));

    return ['asOf' => $asOf ?? today_iso(), 'unmatchedTransactions' => $unmatched,
        'invoicesAwaitingPayment' => $invoicesAwaiting, 'purchasesAwaitingPayment' => $purchasesAwaiting,
        'totalUnmatchedInPence' => $inTotal, 'totalUnmatchedOutPence' => $outTotal,
        'message' => !$unmatched
            ? 'Every imported bank transaction is matched to a document.'
            : count($unmatched) . ' bank transaction(s) have no matching document. Every unexplained movement '
              . 'is a question you would rather answer now than in an enquiry.'];
}

function confirm_bank_match(PDO $db, string $bankTxnId, array $target, string $actor = 'system'): void {
    $tx = row($db, 'SELECT * FROM bank_transactions WHERE id = ?', [$bankTxnId]);
    if (!$tx) throw new DomainException('Bank transaction not found');
    q($db, 'UPDATE bank_transactions SET matched_type = ?, matched_id = ?, matched_at = ? WHERE id = ?',
        [$target['type'], $target['id'], now_instant(), $bankTxnId]);
    record_audit($db, [
        'entityType' => 'bank_transaction', 'entityId' => $bankTxnId, 'action' => 'matched',
        'summary' => 'Bank transaction of ' . number_format($tx['amount_pence'] / 100, 2)
            . " on {$tx['transacted_on']} matched to {$target['type']}",
        'actor' => $actor, 'after' => $target,
    ]);
}

function export_sales_csv(PDO $db, string $from, string $to): string {
    $esc = fn($v) => preg_match('/[",\n]/', (string) $v)
        ? '"' . str_replace('"', '""', (string) $v) . '"' : (string) $v;
    $lines = ['Invoice number,Issue date,Due date,Client,PO reference,Currency,Net,VAT,Gross,Paid,Status'];
    foreach (rows($db, 'SELECT i.number, i.issue_date, i.due_date, o.name AS client, i.po_reference,
              i.currency, i.net_pence, i.vat_pence, i.gross_pence, i.paid_pence, i.status
        FROM invoices i JOIN organisations o ON o.id = i.client_org_id
        WHERE i.issue_date BETWEEN ? AND ? ORDER BY i.number', [$from, $to]) as $r) {
        $lines[] = implode(',', array_map($esc, [
            $r['number'], $r['issue_date'], $r['due_date'], $r['client'], $r['po_reference'], $r['currency'],
            number_format($r['net_pence'] / 100, 2, '.', ''), number_format($r['vat_pence'] / 100, 2, '.', ''),
            number_format($r['gross_pence'] / 100, 2, '.', ''), number_format($r['paid_pence'] / 100, 2, '.', ''),
            $r['status']]));
    }
    return implode("\n", $lines);
}

function export_ledger_csv(PDO $db, string $from, string $to): string {
    $esc = fn($v) => preg_match('/[",\n]/', (string) $v)
        ? '"' . str_replace('"', '""', (string) $v) . '"' : (string) $v;
    $lines = ['Date,Narrative,Account code,Account name,Debit,Credit,Description'];
    foreach (rows($db, 'SELECT j.journal_date, j.narrative, jl.account_code, a.name AS account_name,
              jl.debit_pence, jl.credit_pence, jl.description
        FROM journals j
        JOIN journal_lines jl ON jl.journal_id = j.id
        JOIN accounts a ON a.code = jl.account_code
        WHERE j.journal_date BETWEEN ? AND ?
        ORDER BY j.journal_date, j.id', [$from, $to]) as $r) {
        $lines[] = implode(',', array_map($esc, [
            $r['journal_date'], $r['narrative'], $r['account_code'], $r['account_name'],
            number_format($r['debit_pence'] / 100, 2, '.', ''),
            number_format($r['credit_pence'] / 100, 2, '.', ''), $r['description']]));
    }
    return implode("\n", $lines);
}

// ---------------------------------------------------------------------------
// Evidence files
// ---------------------------------------------------------------------------

const DOCUMENT_MIME = [
    'pdf' => 'application/pdf', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
    'png' => 'image/png', 'heic' => 'image/heic', 'tif' => 'image/tiff', 'tiff' => 'image/tiff',
    'doc' => 'application/msword',
    'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function attach_document(PDO $db, string $storeRoot, array $input): string {
    if (!is_file($input['sourcePath'])) throw new DomainException('Uploaded file not found');

    $dir = $storeRoot . '/' . $input['entityType'] . '/' . $input['entityId'];
    if (!is_dir($dir) && !mkdir($dir, 0750, true)) throw new RuntimeException('Cannot create the document store');

    $id = new_id('doc');
    $ext = strtolower(pathinfo($input['filename'], PATHINFO_EXTENSION));
    if (!isset(DOCUMENT_MIME[$ext])) {
        throw new DomainException('Only PDF, image and Word files can be attached as evidence.');
    }
    $storedPath = "$dir/$id.$ext";
    if (!rename($input['sourcePath'], $storedPath) && !copy($input['sourcePath'], $storedPath)) {
        throw new RuntimeException('Could not store the uploaded file');
    }

    $sha256 = hash_file('sha256', $storedPath);
    q($db, 'INSERT INTO documents (id, entity_type, entity_id, category, filename, stored_path,
              mime_type, size_bytes, sha256, uploaded_at, uploaded_by, notes)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [$id, $input['entityType'], $input['entityId'], $input['category'] ?? null,
         $input['filename'], $storedPath, DOCUMENT_MIME[$ext], filesize($storedPath), $sha256,
         now_instant(), $input['uploadedBy'] ?? 'operator', $input['notes'] ?? null]);

    record_audit($db, [
        'entityType' => $input['entityType'], 'entityId' => $input['entityId'], 'action' => 'document_attached',
        'summary' => ($input['category'] ?? 'Document') . " attached: {$input['filename']} (sha256 "
            . substr($sha256, 0, 12) . '…)',
        'actor' => $input['uploadedBy'] ?? 'operator',
        'after' => ['documentId' => $id, 'filename' => $input['filename'], 'sha256' => $sha256],
    ]);
    return $id;
}

function verify_documents(PDO $db): array {
    return array_map(function ($d) {
        if (!is_file($d['stored_path'])) {
            return ['documentId' => $d['id'], 'filename' => $d['filename'], 'present' => false,
                'hashMatches' => false, 'message' => 'File is missing from the document store.'];
        }
        $matches = hash_file('sha256', $d['stored_path']) === $d['sha256'];
        return ['documentId' => $d['id'], 'filename' => $d['filename'], 'present' => true,
            'hashMatches' => $matches,
            'message' => $matches ? 'Verified unchanged since upload.' : 'FILE HAS CHANGED since it was attached.'];
    }, rows($db, 'SELECT id, filename, stored_path, sha256 FROM documents'));
}

// ---------------------------------------------------------------------------
// Backups — VACUUM INTO gives a consistent snapshot while the file is in use
// ---------------------------------------------------------------------------

function backup_database(PDO $db, string $backupDir): array {
    if (!is_dir($backupDir)) mkdir($backupDir, 0750, true);
    $stamp = str_replace([':', '.'], '-', now_instant());
    $target = "$backupDir/cerviz-$stamp.sqlite";

    $db->exec("VACUUM INTO " . $db->quote($target));

    $chain = verify_audit_chain($db);
    record_audit($db, [
        'entityType' => 'backup', 'entityId' => basename($target), 'action' => 'created',
        'summary' => 'Backup written (' . number_format(filesize($target) / 1048576, 1) . ' MB), audit chain '
            . ($chain['ok'] ? 'intact' : 'BROKEN'),
        'after' => ['path' => $target, 'sha256' => hash_file('sha256', $target), 'auditChainOk' => $chain['ok']],
    ]);

    // Rolling window of 30.
    $files = glob("$backupDir/cerviz-*.sqlite");
    rsort($files);
    foreach (array_slice($files, 30) as $old) @unlink($old);

    return ['path' => $target, 'sizeBytes' => filesize($target),
        'sha256' => hash_file('sha256', $target), 'takenAt' => now_instant(),
        'auditChainOk' => $chain['ok']];
}

function list_backups(string $backupDir): array {
    if (!is_dir($backupDir)) return [];
    $out = [];
    foreach (glob("$backupDir/cerviz-*.sqlite") as $path) {
        $out[] = ['name' => basename($path), 'path' => $path, 'sizeBytes' => filesize($path),
            'takenAt' => gmdate('Y-m-d\TH:i:s\Z', filemtime($path))];
    }
    usort($out, fn($a, $b) => strcmp($b['takenAt'], $a['takenAt']));
    return $out;
}

/** One backup per day, taken opportunistically — shared hosting has no daemon. */
function daily_backup_if_due(PDO $db, string $dataDir): void {
    $marker = "$dataDir/.last-backup-day";
    $today = today_iso();
    if (is_file($marker) && trim((string) file_get_contents($marker)) === $today) return;
    try {
        backup_database($db, "$dataDir/backups");
        file_put_contents($marker, $today);
    } catch (Throwable) {
        // A failed opportunistic backup must not break the request; the next
        // request retries, and Settings shows the backup list going stale.
    }
}
