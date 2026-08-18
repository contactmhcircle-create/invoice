<?php
/**
 * Invoices, ledger, purchases and VAT — ports of core/services/invoices.ts,
 * ledger.ts, purchases.ts and vat.ts, plus the draft-editing and manual-invoice
 * operations added for the web product.
 *
 * The invariants are unchanged: an invoice is mutable only while draft (the
 * database trigger enforces it after issue), corrections go out as credit
 * notes, and voided numbers stay consumed so the series is provably gapless.
 */

declare(strict_types=1);

const VAT_REGISTRATION_THRESHOLD_PENCE = 9000000; // £90,000
const VAT_STANDARD_RATE = 20.0;

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

function vat_policy_for(PDO $db, string $issueDate, string $clientCountry = 'United Kingdom'): array {
    $company = row($db, 'SELECT * FROM company WHERE id = 1');

    $registered = $company && (int) $company['vat_registered'] === 1
        && (!$company['vat_registered_from'] || $issueDate >= $company['vat_registered_from']);

    if (!$registered) {
        return ['applies' => false, 'code' => 'none', 'ratePercent' => 0.0,
            'note' => 'Cerviz Ltd is not registered for VAT. No VAT has been charged on this invoice.'];
    }
    if ($clientCountry && $clientCountry !== 'United Kingdom') {
        return ['applies' => false, 'code' => 'outside_scope', 'ratePercent' => 0.0,
            'note' => 'Supply of staff to a business customer outside the UK — outside the scope of UK VAT. '
                . 'The customer accounts for VAT under the reverse charge in their own country.'];
    }
    return ['applies' => true, 'code' => 'standard', 'ratePercent' => VAT_STANDARD_RATE, 'note' => null];
}

function vat_threshold_status(PDO $db, ?string $asOf = null): array {
    $asOf = $asOf ?? today_iso();
    $company = row($db, 'SELECT * FROM company WHERE id = 1');
    $registered = $company && (int) $company['vat_registered'] === 1;

    $from = add_months($asOf, -12);
    $total = (int) scalar($db, "SELECT COALESCE(SUM(base_net_pence), 0) FROM invoices
        WHERE status IN ('issued','part_paid','paid','overdue')
          AND issue_date > ? AND issue_date <= ?", [$from, $asOf]);

    $percent = round($total / VAT_REGISTRATION_THRESHOLD_PENCE * 1000) / 10;

    $breachedOn = null;
    if ($total >= VAT_REGISTRATION_THRESHOLD_PENCE) {
        $months = rows($db, "SELECT DISTINCT substr(issue_date, 1, 7) AS ym FROM invoices
            WHERE status IN ('issued','part_paid','paid','overdue') ORDER BY ym ASC");
        foreach ($months as $m) {
            $monthEnd = last_day_of_month($m['ym']);
            $windowFrom = add_months($monthEnd, -12);
            $t = (int) scalar($db, "SELECT COALESCE(SUM(base_net_pence),0) FROM invoices
                WHERE status IN ('issued','part_paid','paid','overdue')
                  AND issue_date > ? AND issue_date <= ?", [$windowFrom, $monthEnd]);
            if ($t >= VAT_REGISTRATION_THRESHOLD_PENCE) { $breachedOn = $monthEnd; break; }
        }
    }

    $registerBy = $breachedOn ? add_days($breachedOn, 30) : null;
    $effectiveFrom = $breachedOn ? first_day_of_month_after(add_days($breachedOn, 30)) : null;

    if ($registered) {
        $severity = 'ok';
        $message = 'Registered for VAT. Threshold monitoring is not applicable.';
    } elseif ($breachedOn) {
        $severity = 'breached';
        $message = "Rolling 12-month turnover passed £90,000 at $breachedOn. Registration was required by "
            . "$registerBy, with VAT chargeable from $effectiveFrom. Act on this immediately — VAT is "
            . 'owed on supplies from the effective date whether or not it was charged to clients.';
    } elseif ($percent >= 90) {
        $severity = 'urgent';
        $message = "Rolling 12-month turnover is $percent% of the £90,000 threshold. Registration is imminent — "
            . 'start the process now so VAT can be added to client rates before it becomes a cost to you.';
    } elseif ($percent >= 75) {
        $severity = 'watch';
        $message = "Rolling 12-month turnover is $percent% of the £90,000 threshold. Remember that as an employment "
            . 'business you account for VAT on the full charge including the wages element, so this rises quickly.';
    } else {
        $severity = 'ok';
        $message = "Rolling 12-month turnover is $percent% of the £90,000 threshold.";
    }

    return ['asOf' => $asOf, 'rollingTwelveMonthPence' => $total,
        'thresholdPence' => VAT_REGISTRATION_THRESHOLD_PENCE, 'percentOfThreshold' => $percent,
        'registered' => $registered, 'breachedOn' => $breachedOn, 'registerBy' => $registerBy,
        'effectiveFrom' => $effectiveFrom, 'message' => $message, 'severity' => $severity];
}

function last_day_of_month(string $ym): string {
    [$y, $m] = array_map('intval', explode('-', $ym));
    return (new DateTimeImmutable(sprintf('%04d-%02d-01', $y, $m), new DateTimeZone(UTC)))
        ->modify('last day of this month')->format('Y-m-d');
}

function first_day_of_month_after(string $date): string {
    return iso_date($date)->modify('first day of next month')->format('Y-m-d');
}

function vat_return_worksheet(PDO $db, string $from, string $to): array {
    $company = row($db, 'SELECT * FROM company WHERE id = 1');
    $cashBasis = ($company['vat_basis'] ?? 'accrual') === 'cash';

    $sales = row($db, $cashBasis
        ? "SELECT COALESCE(SUM(i.base_vat_pence),0) AS vat, COALESCE(SUM(i.base_net_pence),0) AS net
           FROM invoices i
           WHERE i.status IN ('paid','part_paid')
             AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.paid_on BETWEEN ? AND ?)"
        : "SELECT COALESCE(SUM(base_vat_pence),0) AS vat, COALESCE(SUM(base_net_pence),0) AS net
           FROM invoices
           WHERE status IN ('issued','part_paid','paid','overdue') AND tax_point_date BETWEEN ? AND ?",
        [$from, $to]);

    $purchases = row($db, "SELECT COALESCE(SUM(vat_pence),0) AS vat, COALESCE(SUM(net_pence),0) AS net
        FROM purchase_invoices WHERE status <> 'void' AND invoice_date BETWEEN ? AND ?", [$from, $to]);

    $box1 = (int) $sales['vat'];
    $box4 = (int) $purchases['vat'];
    return ['periodFrom' => $from, 'periodTo' => $to, 'basis' => $cashBasis ? 'cash' : 'accrual',
        'box1_vatDueOnSales' => $box1, 'box2_vatDueOnAcquisitions' => 0, 'box3_totalVatDue' => $box1,
        'box4_vatReclaimed' => $box4, 'box5_netVatDue' => $box1 - $box4,
        'box6_totalSalesExVat' => (int) $sales['net'], 'box7_totalPurchasesExVat' => (int) $purchases['net'],
        'box8_totalSupplies' => 0, 'box9_totalAcquisitions' => 0];
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function post_journal(PDO $db, array $input): string {
    $debits = array_sum(array_map(fn($l) => (int) ($l['debitPence'] ?? 0), $input['lines']));
    $credits = array_sum(array_map(fn($l) => (int) ($l['creditPence'] ?? 0), $input['lines']));
    if ($debits !== $credits) {
        throw new DomainException(sprintf('Journal does not balance: debits %.2f vs credits %.2f.',
            $debits / 100, $credits / 100));
    }
    if ($debits === 0) throw new DomainException('Journal has no value.');

    $id = new_id('jnl');
    q($db, 'INSERT INTO journals (id, journal_date, narrative, source_type, source_id, created_at, created_by)
            VALUES (?,?,?,?,?,?,?)',
        [$id, $input['date'], $input['narrative'], $input['sourceType'] ?? null,
         $input['sourceId'] ?? null, now_instant(), $input['createdBy'] ?? 'system']);
    foreach ($input['lines'] as $l) {
        q($db, 'INSERT INTO journal_lines (id, journal_id, account_code, debit_pence, credit_pence, description)
                VALUES (?,?,?,?,?,?)',
            [new_id('jl'), $id, $l['accountCode'], (int) ($l['debitPence'] ?? 0),
             (int) ($l['creditPence'] ?? 0), $l['description'] ?? null]);
    }
    return $id;
}

function journal_exists(PDO $db, string $sourceType, string $sourceId): ?string {
    return scalar($db, 'SELECT id FROM journals WHERE source_type = ? AND source_id = ?',
        [$sourceType, $sourceId]);
}

function post_invoice_journal(PDO $db, string $invoiceId): ?string {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv || $inv['status'] === 'draft') return null;
    if (($existing = journal_exists($db, 'invoice', $invoiceId))) return $existing;

    $lines = [
        ['accountCode' => '1100', 'debitPence' => (int) $inv['base_gross_pence'], 'description' => "Invoice {$inv['number']}"],
        ['accountCode' => '4000', 'creditPence' => (int) $inv['base_net_pence'], 'description' => 'Staffing services'],
    ];
    if ((int) $inv['base_vat_pence'] > 0) {
        $lines[] = ['accountCode' => '2200', 'creditPence' => (int) $inv['base_vat_pence'], 'description' => 'Output VAT'];
    }
    return post_journal($db, ['date' => $inv['issue_date'], 'narrative' => "Invoice {$inv['number']}",
        'lines' => $lines, 'sourceType' => 'invoice', 'sourceId' => $invoiceId]);
}

function post_credit_note_journal(PDO $db, string $creditNoteId): ?string {
    $cn = row($db, 'SELECT * FROM credit_notes WHERE id = ?', [$creditNoteId]);
    if (!$cn || $cn['status'] === 'draft') return null;
    if (($existing = journal_exists($db, 'credit_note', $creditNoteId))) return $existing;

    $baseNet = to_base((int) $cn['net_pence'], (float) $cn['fx_rate']);
    $baseVat = to_base((int) $cn['vat_pence'], (float) $cn['fx_rate']);

    $lines = [
        ['accountCode' => '4000', 'debitPence' => $baseNet, 'description' => "Credit note {$cn['number']}"],
        ['accountCode' => '1100', 'creditPence' => $baseNet + $baseVat, 'description' => "Credit note {$cn['number']}"],
    ];
    if ($baseVat > 0) $lines[] = ['accountCode' => '2200', 'debitPence' => $baseVat, 'description' => 'Output VAT reversed'];

    return post_journal($db, ['date' => $cn['issue_date'], 'narrative' => "Credit note {$cn['number']}",
        'lines' => $lines, 'sourceType' => 'credit_note', 'sourceId' => $creditNoteId]);
}

function post_payment_journal(PDO $db, string $paymentId): ?string {
    $p = row($db, 'SELECT * FROM payments WHERE id = ?', [$paymentId]);
    if (!$p) return null;
    if (($existing = journal_exists($db, 'payment', $paymentId))) return $existing;

    $base = to_base((int) $p['amount_pence'], (float) $p['fx_rate']);
    $cashAccount = (int) $p['via_director_loan'] === 1 ? '1210' : '1200';

    if ($p['direction'] === 'in') {
        return post_journal($db, [
            'date' => $p['paid_on'],
            'narrative' => (int) $p['via_director_loan'] === 1
                ? 'Receipt via director’s personal account' : 'Customer receipt',
            'lines' => [
                ['accountCode' => $cashAccount, 'debitPence' => $base, 'description' => $p['reference'] ?? ''],
                ['accountCode' => '1100', 'creditPence' => $base, 'description' => 'Trade debtors'],
            ],
            'sourceType' => 'payment', 'sourceId' => $paymentId,
        ]);
    }
    return post_journal($db, [
        'date' => $p['paid_on'], 'narrative' => 'Supplier payment',
        'lines' => [
            ['accountCode' => '2100', 'debitPence' => $base, 'description' => 'Trade creditors'],
            ['accountCode' => '1200', 'creditPence' => $base, 'description' => $p['reference'] ?? ''],
        ],
        'sourceType' => 'payment', 'sourceId' => $paymentId,
    ]);
}

function post_purchase_journal(PDO $db, string $purchaseInvoiceId): ?string {
    $pi = row($db, 'SELECT * FROM purchase_invoices WHERE id = ?', [$purchaseInvoiceId]);
    if (!$pi || $pi['status'] === 'void') return null;
    if (($existing = journal_exists($db, 'purchase_invoice', $purchaseInvoiceId))) return $existing;

    $baseNet = to_base((int) $pi['net_pence'], (float) $pi['fx_rate']);
    $baseVat = to_base((int) $pi['vat_pence'], (float) $pi['fx_rate']);

    $expenseAccount = match ($pi['category']) {
        'umbrella_labour' => '5000', 'paye_labour' => '5010', 'compliance' => '6100', default => '6000',
    };

    $lines = [
        ['accountCode' => $expenseAccount, 'debitPence' => $baseNet, 'description' => "Purchase {$pi['our_reference']}"],
        ['accountCode' => '2100', 'creditPence' => $baseNet + $baseVat, 'description' => "Purchase {$pi['our_reference']}"],
    ];
    if ($baseVat > 0) $lines[] = ['accountCode' => '2200', 'debitPence' => $baseVat, 'description' => 'Input VAT'];

    return post_journal($db, ['date' => $pi['invoice_date'], 'narrative' => "Purchase invoice {$pi['our_reference']}",
        'lines' => $lines, 'sourceType' => 'purchase_invoice', 'sourceId' => $purchaseInvoiceId]);
}

function trial_balance(PDO $db, ?string $asOf = null): array {
    $asOf = $asOf ?? today_iso();
    $result = rows($db, 'SELECT a.code, a.name, a.type,
              COALESCE(SUM(jl.debit_pence),0) AS debits,
              COALESCE(SUM(jl.credit_pence),0) AS credits
        FROM accounts a
        LEFT JOIN journal_lines jl ON jl.account_code = a.code
        LEFT JOIN journals j ON j.id = jl.journal_id AND j.journal_date <= ?
        GROUP BY a.code ORDER BY a.code', [$asOf]);

    $accounts = [];
    foreach ($result as $r) {
        $net = (int) $r['debits'] - (int) $r['credits'];
        $accounts[] = ['code' => $r['code'], 'name' => $r['name'], 'type' => $r['type'],
            'debitsPence' => (int) $r['debits'], 'creditsPence' => (int) $r['credits'],
            'balancePence' => $net,
            'displayPence' => in_array($r['type'], ['asset', 'expense'], true) ? $net : -$net];
    }

    $totalDebits = array_sum(array_column($accounts, 'debitsPence'));
    $totalCredits = array_sum(array_column($accounts, 'creditsPence'));

    return ['asOf' => $asOf,
        'accounts' => array_values(array_filter($accounts,
            fn($a) => $a['debitsPence'] !== 0 || $a['creditsPence'] !== 0)),
        'totalDebitsPence' => $totalDebits, 'totalCreditsPence' => $totalCredits,
        'balanced' => $totalDebits === $totalCredits];
}

function profit_and_loss(PDO $db, string $from, string $to): array {
    $result = rows($db, "SELECT a.code, a.name, a.type,
              COALESCE(SUM(jl.credit_pence),0) - COALESCE(SUM(jl.debit_pence),0) AS net
        FROM accounts a
        JOIN journal_lines jl ON jl.account_code = a.code
        JOIN journals j ON j.id = jl.journal_id
        WHERE a.type IN ('income','expense') AND j.journal_date BETWEEN ? AND ?
        GROUP BY a.code ORDER BY a.code", [$from, $to]);

    $income = []; $costOfSales = []; $overheads = [];
    foreach ($result as $r) {
        $net = (int) $r['net'];
        if ($r['type'] === 'income') $income[] = $r + ['amountPence' => $net];
        elseif (str_starts_with($r['code'], '5')) $costOfSales[] = $r + ['amountPence' => -$net];
        else $overheads[] = $r + ['amountPence' => -$net];
    }

    $totalIncome = array_sum(array_column($income, 'amountPence'));
    $totalCos = array_sum(array_column($costOfSales, 'amountPence'));
    $totalOverheads = array_sum(array_column($overheads, 'amountPence'));
    $grossProfit = $totalIncome - $totalCos;

    return ['from' => $from, 'to' => $to, 'income' => $income, 'costOfSales' => $costOfSales,
        'overheads' => $overheads, 'totalIncomePence' => $totalIncome,
        'totalCostOfSalesPence' => $totalCos, 'grossProfitPence' => $grossProfit,
        'grossMarginPercent' => $totalIncome > 0 ? round($grossProfit / $totalIncome * 1000) / 10 : 0,
        'totalOverheadsPence' => $totalOverheads, 'netProfitPence' => $grossProfit - $totalOverheads];
}

function balance_sheet(PDO $db, ?string $asOf = null): array {
    $tb = trial_balance($db, $asOf);
    $bucket = fn(string $type) => array_values(array_filter($tb['accounts'], fn($a) => $a['type'] === $type));
    $assets = $bucket('asset'); $liabilities = $bucket('liability'); $equity = $bucket('equity');
    $sum = fn(array $rowsIn) => array_sum(array_column($rowsIn, 'displayPence'));
    $retained = array_sum(array_column(array_filter($tb['accounts'],
        fn($a) => in_array($a['type'], ['income', 'expense'], true)), 'displayPence'));

    return ['asOf' => $tb['asOf'], 'assets' => $assets, 'liabilities' => $liabilities, 'equity' => $equity,
        'totalAssetsPence' => $sum($assets), 'totalLiabilitiesPence' => $sum($liabilities),
        'totalEquityPence' => $sum($equity), 'retainedProfitPence' => $retained,
        'netAssetsPence' => $sum($assets) - $sum($liabilities)];
}

// ---------------------------------------------------------------------------
// Sales invoices
// ---------------------------------------------------------------------------

function create_invoice_from_timesheets(PDO $db, array $input, string $actor = 'system'): string {
    if (empty($input['timesheetIds'])) throw new DomainException('Select at least one timesheet to invoice.');

    $client = row($db, 'SELECT * FROM organisations WHERE id = ?', [$input['clientOrgId']]);
    if (!$client) throw new DomainException('Client not found');

    $placeholders = implode(',', array_fill(0, count($input['timesheetIds']), '?'));
    $timesheets = rows($db, "SELECT t.*, a.title AS assignment_title, a.client_org_id, a.id AS a_id,
              a.site_id, a.po_reference, w.first_name, w.last_name
        FROM timesheets t
        JOIN assignments a ON a.id = t.assignment_id
        JOIN workers w ON w.id = t.worker_id
        WHERE t.id IN ($placeholders)", $input['timesheetIds']);

    if (count($timesheets) !== count($input['timesheetIds'])) {
        throw new DomainException('One or more timesheets could not be found.');
    }
    foreach ($timesheets as $ts) {
        if ($ts['status'] !== 'approved') {
            throw new DomainException("Timesheet {$ts['reference']} is {$ts['status']}, not approved. Only approved timesheets can be invoiced.");
        }
        if ($ts['client_org_id'] !== $input['clientOrgId']) {
            throw new DomainException("Timesheet {$ts['reference']} belongs to a different client.");
        }
        if (!empty($ts['invoice_id'])) {
            throw new DomainException("Timesheet {$ts['reference']} is already on another invoice. Remove it from that draft first.");
        }
    }

    if ((int) $client['po_required'] === 1 && empty($input['poReference']) && empty($timesheets[0]['po_reference'])) {
        throw new DomainException("{$client['name']} requires a purchase order reference on every invoice. Add the PO number before raising this invoice.");
    }

    $issueDate = $input['issueDate'] ?? today_iso();
    $currency = $input['currency'] ?? $client['currency'] ?? 'GBP';
    $fxRate = (float) ($input['fxRate'] ?? 1.0);
    $vat = vat_policy_for($db, $issueDate, $client['country'] ?? 'United Kingdom');

    $id = new_id('inv');
    $now = now_instant();
    $dueDate = add_days($issueDate, (int) ($client['payment_terms_days'] ?? 30));

    $dates = array_column($timesheets, 'week_ending');
    sort($dates);

    q($db, "INSERT INTO invoices
              (id, client_org_id, assignment_id, site_id, issue_date, tax_point_date, due_date,
               period_from, period_to, po_reference, currency, fx_rate, vat_applied, vat_note,
               status, notes, terms, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)",
        [$id, $input['clientOrgId'],
         count($timesheets) === 1 ? $timesheets[0]['a_id'] : null,
         count($timesheets) === 1 ? $timesheets[0]['site_id'] : null,
         $issueDate, $input['taxPointDate'] ?? $issueDate, $dueDate,
         $dates[0], end($dates),
         $input['poReference'] ?? $timesheets[0]['po_reference'] ?? null,
         $currency, $fxRate, $vat['applies'] ? 1 : 0, $vat['note'],
         $input['notes'] ?? null,
         scalar($db, 'SELECT invoice_terms FROM company WHERE id = 1'),
         $now, $now]);

    $lineNo = 1;
    foreach ($timesheets as $ts) {
        $lines = rows($db, 'SELECT * FROM timesheet_lines WHERE timesheet_id = ? ORDER BY work_date, start_time', [$ts['id']]);

        if (!empty($input['summarise'])) {
            $net = (int) $ts['charge_total_pence'];
            $minutes = array_sum(array_map(fn($l) => (int) $l['billed_minutes'], $lines));
            $rate = $minutes > 0 ? (int) round($net * 60 / $minutes) : 0;
            insert_invoice_line($db, $id, $lineNo++, [
                'description' => "{$ts['first_name']} {$ts['last_name']} — {$ts['assignment_title']}, week ending "
                    . format_date_uk($ts['week_ending']) . ' (' . hours_decimal($minutes) . ' hrs)',
                'timesheetId' => $ts['id'], 'workerId' => $ts['worker_id'], 'workDate' => $ts['week_ending'],
                'quantityMinutes' => $minutes, 'unitPricePence' => $rate, 'netPence' => $net,
            ], $vat);
        } else {
            foreach ($lines as $l) {
                $desc = "{$ts['first_name']} {$ts['last_name']} — {$ts['assignment_title']}, "
                    . format_date_uk($l['work_date'])
                    . ($l['start_time'] && $l['end_time'] ? " {$l['start_time']}–{$l['end_time']}" : '')
                    . ' (' . hours_decimal((int) $l['billed_minutes']) . ' hrs @ £'
                    . number_format($l['charge_rate_pence'] / 100, 2) . '/hr'
                    . ($l['band'] !== 'standard' ? ', ' . str_replace('_', ' ', $l['band']) : '') . ')';
                insert_invoice_line($db, $id, $lineNo++, [
                    'description' => $desc, 'timesheetId' => $ts['id'], 'shiftId' => $l['shift_id'],
                    'workerId' => $ts['worker_id'], 'workDate' => $l['work_date'],
                    'quantityMinutes' => (int) $l['billed_minutes'],
                    'unitPricePence' => (int) $l['charge_rate_pence'],
                    'netPence' => (int) $l['charge_pence'],
                ], $vat);
            }
        }
        q($db, 'UPDATE timesheets SET invoice_id = ?, updated_at = ? WHERE id = ?', [$id, $now, $ts['id']]);
    }

    recalculate_invoice($db, $id);

    record_audit($db, [
        'entityType' => 'invoice', 'entityId' => $id, 'action' => 'created',
        'summary' => "Draft invoice created for {$client['name']} from " . count($timesheets) . ' timesheet(s)',
        'actor' => $actor,
        'after' => ['clientOrgId' => $input['clientOrgId'], 'timesheetIds' => $input['timesheetIds'],
            'issueDate' => $issueDate],
    ]);
    return $id;
}

/**
 * A manual invoice: no timesheets behind it, for the goods-and-services billing
 * the reference invoice shows (fire safety products and the like). Lines are
 * added and edited while the invoice is a draft; issue freezes it exactly like
 * a timesheet-backed one.
 */
function create_manual_invoice(PDO $db, array $input, string $actor = 'system'): string {
    $client = row($db, 'SELECT * FROM organisations WHERE id = ?', [$input['clientOrgId']]);
    if (!$client) throw new DomainException('Client not found');

    $issueDate = $input['issueDate'] ?? today_iso();
    $currency = $input['currency'] ?? $client['currency'] ?? 'GBP';
    $vat = vat_policy_for($db, $issueDate, $client['country'] ?? 'United Kingdom');
    $id = new_id('inv');
    $now = now_instant();

    q($db, "INSERT INTO invoices
              (id, client_org_id, issue_date, tax_point_date, due_date, period_from, period_to,
               po_reference, currency, fx_rate, vat_applied, vat_note, status, notes, terms,
               created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?)",
        [$id, $input['clientOrgId'], $issueDate, $input['taxPointDate'] ?? $issueDate,
         add_days($issueDate, (int) ($client['payment_terms_days'] ?? 30)),
         $input['periodFrom'] ?? null, $input['periodTo'] ?? null,
         $input['poReference'] ?? null, $currency, (float) ($input['fxRate'] ?? 1.0),
         $vat['applies'] ? 1 : 0, $vat['note'], $input['notes'] ?? null,
         scalar($db, 'SELECT invoice_terms FROM company WHERE id = 1'), $now, $now]);

    record_audit($db, [
        'entityType' => 'invoice', 'entityId' => $id, 'action' => 'created',
        'summary' => "Draft manual invoice created for {$client['name']}",
        'actor' => $actor, 'after' => $input,
    ]);
    return $id;
}

function assert_invoice_draft(PDO $db, string $invoiceId): array {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv) throw new DomainException('Invoice not found');
    if ($inv['status'] !== 'draft') {
        throw new DomainException('This invoice has been issued and is frozen. Void it and reissue, or raise a credit note.');
    }
    return $inv;
}

function insert_invoice_line(PDO $db, string $invoiceId, int $lineNo, array $l, array $vat): string {
    $id = new_id('invl');
    $net = (int) $l['netPence'];
    q($db, 'INSERT INTO invoice_lines
              (id, invoice_id, line_no, description, timesheet_id, shift_id, worker_id, work_date,
               quantity_minutes, unit_price_pence, net_pence, vat_rate, vat_code, vat_pence, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [$id, $invoiceId, $lineNo, $l['description'], $l['timesheetId'] ?? null, $l['shiftId'] ?? null,
         $l['workerId'] ?? null, $l['workDate'] ?? null, $l['quantityMinutes'] ?? null,
         (int) ($l['unitPricePence'] ?? $net), $net, $vat['ratePercent'], $vat['code'],
         $vat['applies'] ? vat_on($net, $vat['ratePercent']) : 0, now_instant()]);
    return $id;
}

/** Add a free-form line to a draft. Quantity is plain units (not minutes). */
function invoice_add_manual_line(PDO $db, string $invoiceId, array $l): string {
    $inv = assert_invoice_draft($db, $invoiceId);
    $vat = vat_policy_for($db, $inv['issue_date'],
        scalar($db, 'SELECT country FROM organisations WHERE id = ?', [$inv['client_org_id']]) ?? 'United Kingdom');

    $qty = max(1.0, (float) ($l['quantity'] ?? 1));
    $unit = (int) ($l['unitPricePence'] ?? 0);
    $net = array_key_exists('netPence', $l) && $l['netPence'] !== null
        ? (int) $l['netPence'] : (int) round($qty * $unit);
    if ($net === 0 && $unit === 0) throw new DomainException('Give the line an amount.');
    if (trim((string) ($l['description'] ?? '')) === '') throw new DomainException('Give the line a description.');

    $description = trim($l['description']);
    if ($qty != 1.0) {
        $description .= sprintf(' (%s × £%s)', rtrim(rtrim(number_format($qty, 2, '.', ''), '0'), '.'),
            number_format($unit / 100, 2));
    }

    $lineNo = (int) scalar($db, 'SELECT COALESCE(MAX(line_no),0) + 1 FROM invoice_lines WHERE invoice_id = ?', [$invoiceId]);
    $id = insert_invoice_line($db, $invoiceId, $lineNo, [
        'description' => $description, 'unitPricePence' => $unit ?: $net, 'netPence' => $net,
        'workDate' => $l['workDate'] ?? null,
    ], $vat);
    recalculate_invoice($db, $invoiceId);
    return $id;
}

function invoice_update_line(PDO $db, string $invoiceId, string $lineId, array $changes): void {
    $inv = assert_invoice_draft($db, $invoiceId);
    $line = row($db, 'SELECT * FROM invoice_lines WHERE id = ? AND invoice_id = ?', [$lineId, $invoiceId]);
    if (!$line) throw new DomainException('Line not found');

    $vat = vat_policy_for($db, $inv['issue_date'],
        scalar($db, 'SELECT country FROM organisations WHERE id = ?', [$inv['client_org_id']]) ?? 'United Kingdom');

    $description = array_key_exists('description', $changes) ? trim((string) $changes['description']) : $line['description'];
    if ($description === '') throw new DomainException('A line needs a description.');
    $net = array_key_exists('netPence', $changes) ? (int) $changes['netPence'] : (int) $line['net_pence'];
    $unit = array_key_exists('unitPricePence', $changes) ? (int) $changes['unitPricePence'] : (int) $line['unit_price_pence'];

    q($db, 'UPDATE invoice_lines SET description = ?, net_pence = ?, unit_price_pence = ?, vat_pence = ? WHERE id = ?',
        [$description, $net, $unit, $vat['applies'] ? vat_on($net, $vat['ratePercent']) : 0, $lineId]);
    recalculate_invoice($db, $invoiceId);
}

function invoice_remove_line(PDO $db, string $invoiceId, string $lineId): void {
    assert_invoice_draft($db, $invoiceId);
    $line = row($db, 'SELECT * FROM invoice_lines WHERE id = ? AND invoice_id = ?', [$lineId, $invoiceId]);
    if (!$line) throw new DomainException('Line not found');

    q($db, 'DELETE FROM invoice_lines WHERE id = ?', [$lineId]);
    // If that was the last line from a timesheet, release the timesheet so the
    // work does not silently vanish from the unbilled list.
    if ($line['timesheet_id']) {
        $remaining = (int) scalar($db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ? AND timesheet_id = ?',
            [$invoiceId, $line['timesheet_id']]);
        if ($remaining === 0) {
            q($db, "UPDATE timesheets SET invoice_id = NULL, updated_at = ? WHERE id = ? AND status <> 'invoiced'",
                [now_instant(), $line['timesheet_id']]);
        }
    }
    recalculate_invoice($db, $invoiceId);
}

/** Edit draft header fields: dates, PO, notes. Recomputes VAT if the date moved. */
function invoice_update_draft(PDO $db, string $invoiceId, array $changes, string $actor = 'system'): void {
    $inv = assert_invoice_draft($db, $invoiceId);
    $allowed = array_intersect_key($changes,
        array_flip(['issue_date', 'tax_point_date', 'due_date', 'po_reference', 'notes', 'period_from', 'period_to']));
    if (!$allowed) return;

    $sets = implode(', ', array_map(fn($k) => "$k = ?", array_keys($allowed)));
    q($db, "UPDATE invoices SET $sets, updated_at = ? WHERE id = ?",
        [...array_values($allowed), now_instant(), $invoiceId]);

    if (isset($allowed['issue_date'])) {
        $vat = vat_policy_for($db, $allowed['issue_date'],
            scalar($db, 'SELECT country FROM organisations WHERE id = ?', [$inv['client_org_id']]) ?? 'United Kingdom');
        q($db, 'UPDATE invoices SET vat_applied = ?, vat_note = ? WHERE id = ?',
            [$vat['applies'] ? 1 : 0, $vat['note'], $invoiceId]);
        foreach (rows($db, 'SELECT id, net_pence FROM invoice_lines WHERE invoice_id = ?', [$invoiceId]) as $l) {
            q($db, 'UPDATE invoice_lines SET vat_rate = ?, vat_code = ?, vat_pence = ? WHERE id = ?',
                [$vat['ratePercent'], $vat['code'],
                 $vat['applies'] ? vat_on((int) $l['net_pence'], $vat['ratePercent']) : 0, $l['id']]);
        }
    }
    recalculate_invoice($db, $invoiceId);

    record_audit($db, [
        'entityType' => 'invoice', 'entityId' => $invoiceId, 'action' => 'draft_edited',
        'summary' => 'Draft invoice edited: ' . implode(', ', array_keys($allowed)),
        'actor' => $actor, 'before' => array_intersect_key($inv, $allowed), 'after' => $allowed,
    ]);
}

function recalculate_invoice(PDO $db, string $invoiceId): void {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv || $inv['status'] !== 'draft') return;

    $t = row($db, 'SELECT COALESCE(SUM(net_pence),0) AS net, COALESCE(SUM(vat_pence),0) AS vat
                   FROM invoice_lines WHERE invoice_id = ?', [$invoiceId]);
    $net = (int) $t['net']; $vat = (int) $t['vat']; $gross = $net + $vat;
    $fx = (float) $inv['fx_rate'];

    q($db, 'UPDATE invoices SET net_pence = ?, vat_pence = ?, gross_pence = ?,
              base_net_pence = ?, base_vat_pence = ?, base_gross_pence = ?, updated_at = ?
            WHERE id = ?',
        [$net, $vat, $gross, to_base($net, $fx), to_base($vat, $fx), to_base($gross, $fx),
         now_instant(), $invoiceId]);
}

function issue_invoice(PDO $db, string $invoiceId, string $actor = 'system'): string {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv) throw new DomainException('Invoice not found');
    if ($inv['status'] !== 'draft') throw new DomainException('This invoice has already been issued.');
    if ((int) scalar($db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [$invoiceId]) === 0) {
        throw new DomainException('Cannot issue an invoice with no lines.');
    }

    recalculate_invoice($db, $invoiceId);
    $number = allocate_number($db, 'invoice', $invoiceId);
    $now = now_instant();

    q($db, "UPDATE invoices SET number = ?, status = 'issued', issued_at = ?, updated_at = ? WHERE id = ?",
        [$number, $now, $now, $invoiceId]);
    q($db, "UPDATE timesheets SET status = 'invoiced', updated_at = ? WHERE invoice_id = ?", [$now, $invoiceId]);

    schedule_reminders($db, $invoiceId);
    post_invoice_journal($db, $invoiceId);

    $fresh = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    record_audit($db, [
        'entityType' => 'invoice', 'entityId' => $invoiceId, 'action' => 'issued',
        'summary' => "Invoice $number issued — " . number_format($fresh['gross_pence'] / 100, 2) . " {$fresh['currency']}",
        'actor' => $actor,
        'after' => ['number' => $number, 'gross' => (int) $fresh['gross_pence'], 'issueDate' => $fresh['issue_date']],
    ]);
    return $number;
}

function void_invoice(PDO $db, string $invoiceId, string $reason, string $actor = 'system'): void {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv) throw new DomainException('Invoice not found');
    if ((int) $inv['paid_pence'] > 0) {
        throw new DomainException('This invoice has payments recorded against it and cannot be voided. Raise a credit note instead.');
    }
    if (trim($reason) === '') throw new DomainException('A reason is required to void an invoice.');

    $now = now_instant();
    q($db, "UPDATE invoices SET status = 'void', voided_at = ?, void_reason = ?, updated_at = ? WHERE id = ?",
        [$now, $reason, $now, $invoiceId]);
    q($db, "UPDATE timesheets SET status = 'approved', invoice_id = NULL, updated_at = ? WHERE invoice_id = ?",
        [$now, $invoiceId]);

    record_audit($db, [
        'entityType' => 'invoice', 'entityId' => $invoiceId, 'action' => 'voided',
        'summary' => 'Invoice ' . ($inv['number'] ?? '(draft)') . " voided: $reason",
        'actor' => $actor,
        'before' => ['status' => $inv['status']], 'after' => ['status' => 'void', 'reason' => $reason],
    ]);
}

function create_credit_note(PDO $db, array $input, string $actor = 'system'): string {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$input['invoiceId']]);
    if (!$inv) throw new DomainException('Invoice not found');
    if ($inv['status'] === 'draft') {
        throw new DomainException('This invoice has not been issued. Edit or delete the draft rather than crediting it.');
    }
    if (trim($input['reason'] ?? '') === '') throw new DomainException('A reason is required on a credit note.');

    $id = new_id('cn');
    $now = now_instant();
    $issueDate = today_iso();
    $vat = vat_policy_for($db, $issueDate);

    q($db, "INSERT INTO credit_notes (id, invoice_id, client_org_id, issue_date, currency, fx_rate,
              reason, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?, 'draft', ?,?)",
        [$id, $input['invoiceId'], $inv['client_org_id'], $issueDate, $inv['currency'],
         (float) $inv['fx_rate'], $input['reason'], $now, $now]);

    $lines = $input['lines'] ?? array_map(
        fn($l) => ['description' => $l['description'], 'netPence' => (int) $l['net_pence']],
        rows($db, 'SELECT description, net_pence FROM invoice_lines WHERE invoice_id = ?', [$input['invoiceId']]));

    $lineNo = 1;
    foreach ($lines as $l) {
        q($db, 'INSERT INTO credit_note_lines (id, credit_note_id, line_no, description, net_pence, vat_rate, vat_code, vat_pence, created_at)
                VALUES (?,?,?,?,?,?,?,?,?)',
            [new_id('cnl'), $id, $lineNo++, $l['description'], (int) $l['netPence'],
             $vat['ratePercent'], $vat['code'],
             $vat['applies'] ? vat_on((int) $l['netPence'], $vat['ratePercent']) : 0, $now]);
    }

    $t = row($db, 'SELECT COALESCE(SUM(net_pence),0) AS net, COALESCE(SUM(vat_pence),0) AS vat
                   FROM credit_note_lines WHERE credit_note_id = ?', [$id]);
    q($db, 'UPDATE credit_notes SET net_pence = ?, vat_pence = ?, gross_pence = ?, updated_at = ? WHERE id = ?',
        [(int) $t['net'], (int) $t['vat'], (int) $t['net'] + (int) $t['vat'], $now, $id]);

    record_audit($db, [
        'entityType' => 'credit_note', 'entityId' => $id, 'action' => 'created',
        'summary' => "Credit note drafted against invoice {$inv['number']}: {$input['reason']}",
        'actor' => $actor,
        'after' => ['invoiceId' => $input['invoiceId'], 'reason' => $input['reason'], 'net' => (int) $t['net']],
    ]);
    return $id;
}

function issue_credit_note(PDO $db, string $creditNoteId, string $actor = 'system'): string {
    $cn = row($db, 'SELECT * FROM credit_notes WHERE id = ?', [$creditNoteId]);
    if (!$cn) throw new DomainException('Credit note not found');
    if ($cn['status'] !== 'draft') throw new DomainException('This credit note has already been issued.');

    $number = allocate_number($db, 'credit_note', $creditNoteId);
    $now = now_instant();
    q($db, "UPDATE credit_notes SET number = ?, status = 'issued', issued_at = ?, updated_at = ? WHERE id = ?",
        [$number, $now, $now, $creditNoteId]);
    post_credit_note_journal($db, $creditNoteId);

    record_audit($db, [
        'entityType' => 'credit_note', 'entityId' => $creditNoteId, 'action' => 'issued',
        'summary' => "Credit note $number issued — " . number_format($cn['gross_pence'] / 100, 2) . " {$cn['currency']}",
        'actor' => $actor, 'after' => ['number' => $number],
    ]);
    return $number;
}

function record_payment(PDO $db, array $input, string $actor = 'system'): string {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$input['invoiceId']]);
    if (!$inv) throw new DomainException('Invoice not found');
    if ($inv['status'] === 'draft') throw new DomainException('Issue the invoice before recording a payment against it.');
    if ($inv['status'] === 'void') throw new DomainException('This invoice has been voided.');
    if ((int) $input['amountPence'] <= 0) throw new DomainException('Payment amount must be greater than zero.');

    $id = new_id('pay');
    $now = now_instant();
    q($db, "INSERT INTO payments (id, direction, organisation_id, invoice_id, paid_on, amount_pence,
              currency, fx_rate, method, reference, bank_txn_id, via_director_loan, notes, created_at)
            VALUES (?, 'in', ?,?,?,?,?,?,?,?,?,?,?,?)",
        [$id, $inv['client_org_id'], $input['invoiceId'], $input['paidOn'], (int) $input['amountPence'],
         $inv['currency'], (float) $inv['fx_rate'], $input['method'] ?? 'bank_transfer',
         $input['reference'] ?? null, $input['bankTxnId'] ?? null,
         !empty($input['viaDirectorLoan']) ? 1 : 0, $input['notes'] ?? null, $now]);

    $paid = (int) scalar($db, "SELECT COALESCE(SUM(amount_pence),0) FROM payments WHERE invoice_id = ? AND direction = 'in'",
        [$input['invoiceId']]);
    $status = $paid >= (int) $inv['gross_pence'] ? 'paid' : ($paid > 0 ? 'part_paid' : $inv['status']);
    q($db, 'UPDATE invoices SET paid_pence = ?, status = ?, updated_at = ? WHERE id = ?',
        [$paid, $status, $now, $input['invoiceId']]);

    post_payment_journal($db, $id);

    record_audit($db, [
        'entityType' => 'invoice', 'entityId' => $input['invoiceId'], 'action' => 'payment_recorded',
        'summary' => 'Payment of ' . number_format($input['amountPence'] / 100, 2) . " {$inv['currency']} recorded against {$inv['number']}"
            . (!empty($input['viaDirectorLoan']) ? " (received via director's personal account)" : ''),
        'actor' => $actor, 'after' => ['paymentId' => $id] + $input,
    ]);
    return $id;
}

function statutory_interest(PDO $db, string $invoiceId, ?string $asOf = null): array {
    $asOf = $asOf ?? today_iso();
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv) throw new DomainException('Invoice not found');

    $outstanding = (int) $inv['gross_pence'] - (int) $inv['paid_pence'];
    if ($outstanding <= 0 || !$inv['due_date'] || $asOf <= $inv['due_date']) {
        return ['applicable' => false, 'daysLate' => 0, 'outstandingPence' => max(0, $outstanding),
            'interestPence' => 0, 'compensationPence' => 0, 'totalClaimablePence' => 0, 'ratePercent' => 0];
    }

    $baseRate = (float) (scalar($db, "SELECT value FROM settings WHERE key = 'boe_base_rate'") ?? 4.0);
    $ratePercent = $baseRate + 8;
    $daysLate = days_between($inv['due_date'], $asOf);
    $interestPence = (int) round($outstanding * ($ratePercent / 100) * $daysLate / 365);
    $compensationPence = $outstanding < 100000 ? 4000 : ($outstanding < 1000000 ? 7000 : 10000);

    return ['applicable' => true, 'daysLate' => $daysLate, 'outstandingPence' => $outstanding,
        'interestPence' => $interestPence, 'compensationPence' => $compensationPence,
        'totalClaimablePence' => $interestPence + $compensationPence,
        'ratePercent' => $ratePercent, 'baseRate' => $baseRate];
}

function schedule_reminders(PDO $db, string $invoiceId): void {
    $inv = row($db, 'SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
    if (!$inv || !$inv['due_date']) return;
    $now = now_instant();
    foreach ([['pre_due', -3], ['due', 0], ['overdue_7', 7], ['overdue_14', 14], ['overdue_30', 30]] as [$stage, $offset]) {
        q($db, 'INSERT INTO invoice_reminders (id, invoice_id, due_on, stage, created_at) VALUES (?,?,?,?,?)',
            [new_id('rem'), $invoiceId, add_days($inv['due_date'], $offset), $stage, $now]);
    }
}

function due_reminders(PDO $db, ?string $asOf = null): array {
    return rows($db, "SELECT r.*, i.number, i.gross_pence, i.paid_pence, i.due_date,
              o.name AS client_name, o.contact_email
        FROM invoice_reminders r
        JOIN invoices i ON i.id = r.invoice_id
        JOIN organisations o ON o.id = i.client_org_id
        WHERE r.sent_at IS NULL AND r.due_on <= ?
          AND i.status IN ('issued','part_paid','overdue')
        ORDER BY r.due_on ASC", [$asOf ?? today_iso()]);
}

function refresh_overdue_statuses(PDO $db, ?string $asOf = null): int {
    $stmt = q($db, "UPDATE invoices SET status = 'overdue', updated_at = ?
        WHERE status IN ('issued','part_paid') AND due_date < ? AND gross_pence > paid_pence",
        [now_instant(), $asOf ?? today_iso()]);
    return $stmt->rowCount();
}

function aged_debtors(PDO $db, ?string $asOf = null): array {
    $asOf = $asOf ?? today_iso();
    $result = rows($db, "SELECT i.id, i.number, i.issue_date, i.due_date, i.currency,
              i.gross_pence, i.paid_pence, (i.gross_pence - i.paid_pence) AS outstanding,
              o.id AS client_id, o.name AS client_name
        FROM invoices i JOIN organisations o ON o.id = i.client_org_id
        WHERE i.status IN ('issued','part_paid','overdue') AND i.gross_pence > i.paid_pence
        ORDER BY i.due_date ASC");

    $buckets = ['current' => 0, 'days1to30' => 0, 'days31to60' => 0, 'days61to90' => 0, 'over90' => 0];
    $byClient = [];
    foreach ($result as &$r) {
        $daysOverdue = $r['due_date'] ? days_between($r['due_date'], $asOf) : 0;
        $bucket = $daysOverdue <= 0 ? 'current'
            : ($daysOverdue <= 30 ? 'days1to30'
            : ($daysOverdue <= 60 ? 'days31to60'
            : ($daysOverdue <= 90 ? 'days61to90' : 'over90')));
        $out = (int) $r['outstanding'];
        $buckets[$bucket] += $out;
        $r['daysOverdue'] = max(0, $daysOverdue);
        $r['bucket'] = $bucket;

        $cid = $r['client_id'];
        if (!isset($byClient[$cid])) {
            $byClient[$cid] = ['clientId' => $cid, 'clientName' => $r['client_name'], 'total' => 0,
                'current' => 0, 'days1to30' => 0, 'days31to60' => 0, 'days61to90' => 0, 'over90' => 0,
                'invoices' => []];
        }
        $byClient[$cid]['total'] += $out;
        $byClient[$cid][$bucket] += $out;
        $byClient[$cid]['invoices'][] = $r;
    }
    unset($r);

    $clients = array_values($byClient);
    usort($clients, fn($a, $b) => $b['total'] <=> $a['total']);

    return ['asOf' => $asOf,
        'totalOutstanding' => array_sum(array_map(fn($r) => (int) $r['outstanding'], $result)),
        'buckets' => $buckets, 'byClient' => $clients, 'invoices' => $result];
}

function invoice_with_detail(PDO $db, string $invoiceId): ?array {
    $inv = row($db, 'SELECT i.*, o.name AS client_name, o.legal_name AS client_legal_name,
              o.company_number AS client_company_number, o.vat_number AS client_vat_number,
              o.address_1, o.address_2, o.city, o.postcode, o.country
        FROM invoices i JOIN organisations o ON o.id = i.client_org_id WHERE i.id = ?', [$invoiceId]);
    if (!$inv) return null;

    return $inv + [
        'lines' => rows($db, 'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no', [$invoiceId]),
        'payments' => rows($db, "SELECT * FROM payments WHERE invoice_id = ? AND direction = 'in' ORDER BY paid_on", [$invoiceId]),
        'backingTimesheets' => rows($db, "SELECT DISTINCT t.id, t.reference, t.week_ending, t.client_signatory,
                  t.client_signed_on, t.total_minutes, w.first_name, w.last_name,
                  (SELECT COUNT(*) FROM documents d WHERE d.entity_type='timesheet'
                     AND d.entity_id = t.id AND d.category='signed_timesheet') AS scan_count
            FROM invoice_lines il
            JOIN timesheets t ON t.id = il.timesheet_id
            JOIN workers w ON w.id = t.worker_id
            WHERE il.invoice_id = ?", [$invoiceId]),
        'creditNotes' => rows($db, 'SELECT * FROM credit_notes WHERE invoice_id = ?', [$invoiceId]),
        'outstandingPence' => (int) $inv['gross_pence'] - (int) $inv['paid_pence'],
        'lateInterest' => statutory_interest($db, $invoiceId),
    ];
}

// ---------------------------------------------------------------------------
// Purchases and self-bills
// ---------------------------------------------------------------------------

function create_purchase_invoice(PDO $db, array $input, string $actor = 'system'): string {
    $org = row($db, 'SELECT * FROM organisations WHERE id = ?', [$input['organisationId']]);
    if (!$org) throw new DomainException('Supplier not found');

    $id = new_id('pinv');
    $now = now_instant();
    $reference = allocate_number($db, 'purchase', $id);
    $vat = (int) ($input['vatPence'] ?? 0);
    $net = (int) $input['netPence'];

    q($db, "INSERT INTO purchase_invoices
              (id, our_reference, organisation_id, their_reference, invoice_date, due_date,
               period_from, period_to, currency, fx_rate, net_pence, vat_pence, gross_pence,
               category, status, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'received', ?,?,?)",
        [$id, $reference, $input['organisationId'], $input['theirReference'] ?? null,
         $input['invoiceDate'], $input['dueDate'] ?? add_days($input['invoiceDate'], (int) ($org['payment_terms_days'] ?? 14)),
         $input['periodFrom'] ?? null, $input['periodTo'] ?? null,
         $input['currency'] ?? 'GBP', (float) ($input['fxRate'] ?? 1.0),
         $net, $vat, $net + $vat, $input['category'] ?? 'umbrella_labour',
         $input['notes'] ?? null, $now, $now]);

    record_audit($db, [
        'entityType' => 'purchase_invoice', 'entityId' => $id, 'action' => 'created',
        'summary' => "Purchase invoice $reference received from {$org['name']} — £" . number_format($net / 100, 2) . ' net',
        'actor' => $actor, 'after' => $input,
    ]);
    return $id;
}

function add_purchase_line(PDO $db, string $purchaseInvoiceId, array $line): string {
    $pi = row($db, 'SELECT * FROM purchase_invoices WHERE id = ?', [$purchaseInvoiceId]);
    if (!$pi) throw new DomainException('Purchase invoice not found');
    if (in_array($pi['status'], ['paid', 'void'], true)) {
        throw new DomainException("This purchase invoice is {$pi['status']} and cannot be changed.");
    }

    $lineNo = (int) scalar($db, 'SELECT COALESCE(MAX(line_no),0) + 1 FROM purchase_invoice_lines WHERE purchase_invoice_id = ?',
        [$purchaseInvoiceId]);
    $id = new_id('pinvl');
    q($db, 'INSERT INTO purchase_invoice_lines
              (id, purchase_invoice_id, line_no, description, worker_id, timesheet_id, shift_id,
               quantity_minutes, unit_price_pence, net_pence, vat_pence, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [$id, $purchaseInvoiceId, $lineNo, $line['description'], $line['workerId'] ?? null,
         $line['timesheetId'] ?? null, $line['shiftId'] ?? null, $line['quantityMinutes'] ?? null,
         (int) ($line['unitPricePence'] ?? 0), (int) $line['netPence'], (int) ($line['vatPence'] ?? 0),
         now_instant()]);
    return $id;
}

function match_purchase_to_timesheets(PDO $db, string $purchaseInvoiceId, int $tolerancePence = 100): array {
    $pi = row($db, 'SELECT p.*, o.name AS supplier FROM purchase_invoices p
                    JOIN organisations o ON o.id = p.organisation_id WHERE p.id = ?', [$purchaseInvoiceId]);
    if (!$pi) throw new DomainException('Purchase invoice not found');

    $expected = rows($db, "SELECT t.id, t.week_ending, t.pay_total_pence, t.total_minutes,
              w.first_name, w.last_name, w.id AS worker_id
        FROM timesheets t JOIN workers w ON w.id = t.worker_id
        WHERE w.umbrella_org_id = ?
          AND t.status IN ('approved','invoiced')
          AND (? IS NULL OR t.week_ending >= ?)
          AND (? IS NULL OR t.week_ending <= ?)",
        [$pi['organisation_id'], $pi['period_from'], $pi['period_from'], $pi['period_to'], $pi['period_to']]);

    $theirLines = rows($db, 'SELECT worker_id, SUM(quantity_minutes) AS minutes, SUM(net_pence) AS net
        FROM purchase_invoice_lines WHERE purchase_invoice_id = ? GROUP BY worker_id', [$purchaseInvoiceId]);
    $theirByWorker = [];
    foreach ($theirLines as $l) {
        if ($l['worker_id']) {
            $theirByWorker[$l['worker_id']] = [
                'minutes' => (int) ($l['minutes'] ?? 0), 'net' => (int) ($l['net'] ?? 0)];
        }
    }

    $ourExpected = array_sum(array_map(fn($t) => (int) $t['pay_total_pence'], $expected));
    $detail = array_map(function ($t) use ($theirByWorker) {
        $theirs = $theirByWorker[$t['worker_id']] ?? null;
        return [
            'workerName' => "{$t['first_name']} {$t['last_name']}",
            'weekEnding' => $t['week_ending'],
            'ourMinutes' => (int) $t['total_minutes'],
            'ourPayPence' => (int) $t['pay_total_pence'],
            'theirMinutes' => $theirs['minutes'] ?? null,
            'theirNetPence' => $theirs['net'] ?? null,
            'variancePence' => ($theirs['net'] ?? 0) - (int) $t['pay_total_pence'],
        ];
    }, $expected);

    $variance = (int) $pi['net_pence'] - $ourExpected;
    $variancePercent = $ourExpected > 0 ? round($variance / $ourExpected * 1000) / 10 : 0;

    if (!$expected) {
        $status = 'no_expectation';
        $message = 'No approved timesheets found for this umbrella over the invoice period, so this invoice '
            . 'cannot be checked against our own records. Confirm the period and the workers before paying.';
    } elseif (abs($variance) <= $tolerancePence) {
        $status = $variance === 0 ? 'exact' : 'within_tolerance';
        $message = 'Matches our timesheets' . ($variance === 0 ? ' exactly' : ' within rounding tolerance') . '.';
    } elseif ($variance > 0) {
        $status = 'overbilled';
        $message = 'This invoice is £' . number_format($variance / 100, 2) . " ($variancePercent%) HIGHER than our approved "
            . 'timesheets support. Query it before paying — you would be paying for hours no client will fund.';
    } else {
        $status = 'underbilled';
        $message = 'This invoice is £' . number_format(abs($variance) / 100, 2) . ' (' . abs($variancePercent) . '%) lower than '
            . 'our timesheets suggest. Check for missing workers or weeks before treating it as settled.';
    }

    q($db, "UPDATE purchase_invoices SET expected_pence = ?, variance_pence = ?,
              status = CASE WHEN ? IN ('exact','within_tolerance') THEN 'matched' ELSE 'queried' END,
              updated_at = ? WHERE id = ?",
        [$ourExpected, $variance, $status, now_instant(), $purchaseInvoiceId]);

    return ['purchaseInvoiceId' => $purchaseInvoiceId, 'reference' => $pi['our_reference'],
        'supplier' => $pi['supplier'], 'theirNetPence' => (int) $pi['net_pence'],
        'ourExpectedPence' => $ourExpected, 'variancePence' => $variance,
        'variancePercent' => $variancePercent, 'status' => $status, 'detail' => $detail,
        'message' => $message];
}

function approve_purchase_invoice(PDO $db, string $purchaseInvoiceId, string $approvedBy): void {
    $pi = row($db, 'SELECT * FROM purchase_invoices WHERE id = ?', [$purchaseInvoiceId]);
    if (!$pi) throw new DomainException('Purchase invoice not found');
    q($db, "UPDATE purchase_invoices SET status = 'approved', updated_at = ? WHERE id = ?",
        [now_instant(), $purchaseInvoiceId]);
    post_purchase_journal($db, $purchaseInvoiceId);
    record_audit($db, [
        'entityType' => 'purchase_invoice', 'entityId' => $purchaseInvoiceId, 'action' => 'approved',
        'summary' => "Purchase invoice {$pi['our_reference']} approved for payment by $approvedBy",
        'actor' => $approvedBy,
        'before' => ['status' => $pi['status'], 'variance' => $pi['variance_pence']],
    ]);
}

function record_self_bill(PDO $db, array $input, string $actor = 'system'): string {
    $org = row($db, 'SELECT * FROM organisations WHERE id = ?', [$input['organisationId']]);
    if (!$org) throw new DomainException('Agency not found');

    $id = new_id('sb');
    $now = now_instant();
    $vat = (int) ($input['theirVatPence'] ?? 0);
    $net = (int) $input['theirNetPence'];

    q($db, "INSERT INTO self_bills
              (id, organisation_id, their_reference, received_on, period_from, period_to, currency,
               their_net_pence, their_vat_pence, their_gross_pence, status, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?, 'received', ?,?)",
        [$id, $input['organisationId'], $input['theirReference'], $input['receivedOn'],
         $input['periodFrom'] ?? null, $input['periodTo'] ?? null, $input['currency'] ?? 'GBP',
         $net, $vat, $net + $vat, $now, $now]);

    foreach ($input['lines'] ?? [] as $l) {
        $ourMinutes = null; $ourNet = null;
        if (!empty($l['timesheetId'])) {
            $ts = row($db, 'SELECT total_minutes, charge_total_pence FROM timesheets WHERE id = ?', [$l['timesheetId']]);
            $ourMinutes = $ts ? (int) $ts['total_minutes'] : null;
            $ourNet = $ts ? (int) $ts['charge_total_pence'] : null;
        }
        q($db, 'INSERT INTO self_bill_lines
                  (id, self_bill_id, description, worker_id, timesheet_id, work_date, their_minutes,
                   their_rate_pence, their_net_pence, our_minutes, our_rate_pence, our_net_pence, variance_pence, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [new_id('sbl'), $id, $l['description'] ?? null, $l['workerId'] ?? null,
             $l['timesheetId'] ?? null, $l['workDate'] ?? null, $l['theirMinutes'] ?? null,
             $l['theirRatePence'] ?? null, (int) $l['theirNetPence'], $ourMinutes,
             ($ourNet !== null && $ourMinutes) ? (int) round($ourNet * 60 / $ourMinutes) : null,
             $ourNet, $ourNet !== null ? (int) $l['theirNetPence'] - $ourNet : null, $now]);
    }

    record_audit($db, [
        'entityType' => 'self_bill', 'entityId' => $id, 'action' => 'received',
        'summary' => "Self-bill {$input['theirReference']} received from {$org['name']} — £" . number_format($net / 100, 2) . ' net',
        'actor' => $actor, 'after' => $input,
    ]);

    reconcile_self_bill($db, $id);
    return $id;
}

function reconcile_self_bill(PDO $db, string $selfBillId, int $tolerancePence = 100): array {
    $sb = row($db, 'SELECT s.*, o.name AS agency FROM self_bills s
                    JOIN organisations o ON o.id = s.organisation_id WHERE s.id = ?', [$selfBillId]);
    if (!$sb) throw new DomainException('Self-bill not found');

    $ours = rows($db, "SELECT t.id, t.reference, t.week_ending, t.charge_total_pence, w.first_name, w.last_name
        FROM timesheets t
        JOIN assignments a ON a.id = t.assignment_id
        JOIN workers w ON w.id = t.worker_id
        WHERE a.client_org_id = ?
          AND t.status IN ('approved','invoiced')
          AND (? IS NULL OR t.week_ending >= ?)
          AND (? IS NULL OR t.week_ending <= ?)",
        [$sb['organisation_id'], $sb['period_from'], $sb['period_from'], $sb['period_to'], $sb['period_to']]);

    $ourExpected = array_sum(array_map(fn($t) => (int) $t['charge_total_pence'], $ours));
    $variance = (int) $sb['their_net_pence'] - $ourExpected;
    $variancePercent = $ourExpected > 0 ? round($variance / $ourExpected * 1000) / 10 : 0;

    $billedIds = array_filter(array_column(
        rows($db, 'SELECT timesheet_id FROM self_bill_lines WHERE self_bill_id = ?', [$selfBillId]),
        'timesheet_id'));
    $unmatched = array_values(array_map(fn($t) => [
        'reference' => $t['reference'], 'weekEnding' => $t['week_ending'],
        'worker' => "{$t['first_name']} {$t['last_name']}", 'chargePence' => (int) $t['charge_total_pence'],
    ], array_filter($ours, fn($t) => !in_array($t['id'], $billedIds, true))));

    if (!$ours) {
        $status = 'unmatched';
        $message = 'No approved timesheets found for this agency over the self-bill period. Either the period is '
            . 'wrong or the timesheets have not been entered yet — do not treat this self-bill as agreed.';
    } elseif (abs($variance) <= $tolerancePence) {
        $status = 'agreed';
        $message = 'Self-bill agrees with our approved timesheets.';
    } elseif ($variance < 0) {
        $status = 'underpaid';
        $message = 'This self-bill is £' . number_format(abs($variance) / 100, 2) . ' (' . abs($variancePercent) . '%) LESS than our '
            . 'approved timesheets support.'
            . ($unmatched ? ' ' . count($unmatched) . ' timesheet(s) appear to have been left off entirely.'
                : ' Check the rates they have applied.')
            . ' Raise this with the agency in writing.';
    } else {
        $status = 'overpaid';
        $message = 'This self-bill is £' . number_format($variance / 100, 2) . " ($variancePercent%) MORE than our timesheets support. "
            . 'Confirm before accepting — an overpayment you keep quietly becomes a dispute later.';
    }

    q($db, "UPDATE self_bills SET our_expected_net_pence = ?, variance_pence = ?,
              status = CASE WHEN ? = 'agreed' THEN 'agreed' ELSE 'disputed' END, updated_at = ?
            WHERE id = ?", [$ourExpected, $variance, $status, now_instant(), $selfBillId]);

    return ['selfBillId' => $selfBillId, 'agency' => $sb['agency'], 'theirReference' => $sb['their_reference'],
        'theirNetPence' => (int) $sb['their_net_pence'], 'ourExpectedNetPence' => $ourExpected,
        'variancePence' => $variance, 'variancePercent' => $variancePercent, 'status' => $status,
        'message' => $message, 'unmatchedTimesheets' => $unmatched];
}

function margin_report(PDO $db, string $from, string $to): array {
    $decorate = function (array $r): array {
        $charge = (int) $r['charge']; $pay = (int) $r['pay']; $minutes = (int) $r['minutes'];
        return $r + [
            'marginPence' => $charge - $pay,
            'marginPercent' => $charge > 0 ? round(($charge - $pay) / $charge * 1000) / 10 : 0,
            'hours' => round($minutes / 60 * 10) / 10,
            'marginPerHourPence' => $minutes > 0 ? (int) round(($charge - $pay) * 60 / $minutes) : 0,
        ];
    };

    $byAssignment = array_map($decorate, rows($db, "SELECT a.id, a.title, o.name AS client_name,
              COALESCE(SUM(t.charge_total_pence),0) AS charge,
              COALESCE(SUM(t.pay_total_pence),0) AS pay,
              COALESCE(SUM(t.total_minutes),0) AS minutes,
              COUNT(DISTINCT t.worker_id) AS workers
        FROM assignments a
        JOIN organisations o ON o.id = a.client_org_id
        LEFT JOIN timesheets t ON t.assignment_id = a.id
             AND t.week_ending BETWEEN ? AND ? AND t.status IN ('approved','invoiced')
        GROUP BY a.id HAVING charge > 0
        ORDER BY (charge - pay) DESC", [$from, $to]));

    $byClient = array_map($decorate, rows($db, "SELECT o.id, o.name,
              COALESCE(SUM(t.charge_total_pence),0) AS charge,
              COALESCE(SUM(t.pay_total_pence),0) AS pay,
              COALESCE(SUM(t.total_minutes),0) AS minutes
        FROM organisations o
        JOIN assignments a ON a.client_org_id = o.id
        JOIN timesheets t ON t.assignment_id = a.id
        WHERE t.week_ending BETWEEN ? AND ? AND t.status IN ('approved','invoiced')
        GROUP BY o.id ORDER BY (charge - pay) DESC", [$from, $to]));

    $totalCharge = array_sum(array_map(fn($r) => (int) $r['charge'], $byClient));
    $totalPay = array_sum(array_map(fn($r) => (int) $r['pay'], $byClient));

    return ['from' => $from, 'to' => $to, 'byAssignment' => $byAssignment, 'byClient' => $byClient,
        'totalChargePence' => $totalCharge, 'totalPayPence' => $totalPay,
        'totalMarginPence' => $totalCharge - $totalPay,
        'marginPercent' => $totalCharge > 0 ? round(($totalCharge - $totalPay) / $totalCharge * 1000) / 10 : 0];
}

function aged_creditors(PDO $db, ?string $asOf = null): array {
    $result = rows($db, "SELECT p.id, p.our_reference, p.their_reference, p.invoice_date, p.due_date,
              p.gross_pence, p.paid_pence, (p.gross_pence - p.paid_pence) AS outstanding,
              p.variance_pence, p.status, o.name AS supplier
        FROM purchase_invoices p JOIN organisations o ON o.id = p.organisation_id
        WHERE p.status NOT IN ('paid','void') AND p.gross_pence > p.paid_pence
        ORDER BY p.due_date ASC");
    return ['asOf' => $asOf ?? today_iso(),
        'totalOutstandingPence' => array_sum(array_map(fn($r) => (int) $r['outstanding'], $result)),
        'queriedCount' => count(array_filter($result, fn($r) => $r['status'] === 'queried')),
        'invoices' => $result];
}
