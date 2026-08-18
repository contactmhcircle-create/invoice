<?php
/**
 * Shifts and timesheets — ports of core/services/shifts.ts and timesheets.ts.
 * The rule that matters: a worker cannot be allocated to a shift they are not
 * compliant to work on the date the shift runs.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

function create_shift(PDO $db, array $input, string $actor = 'system'): string {
    $assignment = row($db, 'SELECT * FROM assignments WHERE id = ?', [$input['assignmentId']]);
    if (!$assignment) throw new DomainException('Assignment not found');

    $id = new_id('shift');
    $now = now_instant();
    $band = determine_band($input['startsAt'], $input['endsAt'],
        (bool) ($input['isBankHoliday'] ?? false), (bool) (int) $assignment['use_rate_bands']);

    $rate = resolve_rate($db, [
        'assignmentId' => $input['assignmentId'],
        'siteId' => $input['siteId'] ?? $assignment['site_id'],
        'clientOrgId' => $assignment['client_org_id'],
        'band' => $band,
        'on' => substr($input['startsAt'], 0, 10),
        'chargeOverridePence' => $input['chargeRateOverridePence'] ?? null,
        'payOverridePence' => $input['payRateOverridePence'] ?? null,
    ]);

    q($db, "INSERT INTO shifts
              (id, assignment_id, site_id, worker_id, starts_at, ends_at, break_minutes, band,
               is_bank_holiday, charge_rate_pence, pay_rate_pence, rate_source,
               charge_rate_override_pence, pay_rate_override_pence, status, notes, created_at, updated_at)
            VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?, 'planned', ?,?,?)",
        [$id, $input['assignmentId'], $input['siteId'] ?? $assignment['site_id'],
         $input['startsAt'], $input['endsAt'], (int) ($input['breakMinutes'] ?? 0), $band,
         ($input['isBankHoliday'] ?? false) ? 1 : 0,
         $rate['chargeRatePence'] ?? null, $rate['payRatePence'] ?? null,
         $rate['source'] ?? 'No rate found',
         $input['chargeRateOverridePence'] ?? null, $input['payRateOverridePence'] ?? null,
         $input['notes'] ?? null, $now, $now]);

    record_audit($db, [
        'entityType' => 'shift', 'entityId' => $id, 'action' => 'created',
        'summary' => "Shift created {$input['startsAt']} – {$input['endsAt']} on {$assignment['title']}",
        'actor' => $actor, 'after' => $input + ['band' => $band, 'rate' => $rate],
    ]);

    if (!empty($input['workerId'])) allocate_worker($db, $id, $input['workerId'], [], $actor);
    return $id;
}

function check_allocation(PDO $db, string $shiftId, string $workerId): array {
    $shift = row($db, 'SELECT * FROM shifts WHERE id = ?', [$shiftId]);
    if (!$shift) throw new DomainException('Shift not found');
    $assignment = row($db, 'SELECT * FROM assignments WHERE id = ?', [$shift['assignment_id']]);

    $shiftDate = substr($shift['starts_at'], 0, 10);
    $report = check_worker($db, $workerId, $shiftDate, $assignment['required_licence_sector'] ?? null);

    $clashes = rows($db, "SELECT s.id AS shiftId, s.starts_at AS startsAt, s.ends_at AS endsAt, a.title AS assignment
        FROM shifts s JOIN assignments a ON a.id = s.assignment_id
        WHERE s.worker_id = ? AND s.id <> ?
          AND s.status IN ('planned','allocated','worked')
          AND s.starts_at < ? AND s.ends_at > ?",
        [$workerId, $shiftId, $shift['ends_at'], $shift['starts_at']]);

    $blockers = $report['blockers'];
    if ($clashes) {
        $n = count($clashes);
        $blockers[] = [
            'code' => 'SHIFT_CLASH', 'severity' => 'blocker',
            'title' => "Worker is already booked on $n overlapping shift" . ($n === 1 ? '' : 's'),
            'detail' => implode('; ', array_map(fn($c) =>
                "{$c['assignment']}: " . substr($c['startsAt'], 11, 5) . '–' . substr($c['endsAt'], 11, 5)
                . ' on ' . substr($c['startsAt'], 0, 10), $clashes)),
            'action' => 'Release the clashing shift, or allocate a different worker.',
        ];
    }

    $nmw = null;
    if ($shift['pay_rate_pence'] !== null) {
        $nmw = check_nmw($db, $workerId, (int) $shift['pay_rate_pence'], $shiftDate);
        if (!$nmw['ok']) {
            $blockers[] = [
                'code' => 'NMW_BREACH', 'severity' => 'blocker',
                'title' => 'Pay rate is below the National Minimum Wage',
                'detail' => sprintf(
                    'The resolved pay rate is £%.2f/hour but the %s minimum on %s is £%.2f/hour — a shortfall of £%.2f/hour.',
                    $nmw['actualPence'] / 100, str_replace('_', ' ', (string) $nmw['band']),
                    $shiftDate, ($nmw['requiredPence'] ?? 0) / 100, $nmw['shortfallPence'] / 100),
                'action' => 'Raise the pay rate. NMW penalties reach 200% of the underpayment and HMRC publishes the names of employers who breach it.',
            ];
        }
    }

    return ['allowed' => count($blockers) === 0, 'blockers' => $blockers,
        'warnings' => $report['warnings'], 'clashes' => $clashes, 'nmw' => $nmw];
}

function allocate_worker(PDO $db, string $shiftId, string $workerId, array $opts = [], string $actor = 'system'): array {
    $check = check_allocation($db, $shiftId, $workerId);
    if (!$check['allowed']) {
        $reasons = implode("\n", array_map(fn($b) => "• {$b['title']}: {$b['detail']}", $check['blockers']));
        throw new DomainException("This worker cannot be allocated to this shift.\n\n$reasons");
    }

    $shift = row($db, 'SELECT * FROM shifts WHERE id = ?', [$shiftId]);
    $assignment = row($db, 'SELECT * FROM assignments WHERE id = ?', [$shift['assignment_id']]);
    $worker = row($db, 'SELECT * FROM workers WHERE id = ?', [$workerId]);

    $payOverride = $shift['pay_rate_override_pence']
        ?? ($shift['pay_rate_pence'] === null ? $worker['default_pay_rate_pence'] : null);

    $rate = resolve_rate($db, [
        'assignmentId' => $shift['assignment_id'],
        'siteId' => $shift['site_id'],
        'clientOrgId' => $assignment['client_org_id'],
        'band' => $shift['band'],
        'on' => substr($shift['starts_at'], 0, 10),
        'chargeOverridePence' => $shift['charge_rate_override_pence'],
        'payOverridePence' => $payOverride,
    ]);

    q($db, "UPDATE shifts SET worker_id = ?, status = 'allocated',
              charge_rate_pence = COALESCE(?, charge_rate_pence),
              pay_rate_pence = COALESCE(?, pay_rate_pence),
              rate_source = COALESCE(?, rate_source),
              updated_at = ?
            WHERE id = ?",
        [$workerId, $rate['chargeRatePence'] ?? null, $rate['payRatePence'] ?? null,
         $rate['source'] ?? null, now_instant(), $shiftId]);

    $warningNote = count($check['warnings'])
        ? ' (' . count($check['warnings']) . ' warning(s) acknowledged)' : '';
    record_audit($db, [
        'entityType' => 'shift', 'entityId' => $shiftId, 'action' => 'allocated',
        'summary' => "{$worker['first_name']} {$worker['last_name']} allocated to {$assignment['title']} on "
            . substr($shift['starts_at'], 0, 10) . $warningNote,
        'actor' => $actor,
        'after' => ['workerId' => $workerId,
            'warnings' => array_column($check['warnings'], 'code'),
            'acknowledged' => (bool) ($opts['acknowledgeWarnings'] ?? false),
            'reason' => $opts['reason'] ?? null, 'rate' => $rate],
    ]);

    recalculate_awr($db, $workerId, $shift['assignment_id']);
    return $check;
}

function release_worker(PDO $db, string $shiftId, string $reason, string $actor = 'system'): void {
    $shift = row($db, 'SELECT * FROM shifts WHERE id = ?', [$shiftId]);
    if (!$shift) throw new DomainException('Shift not found');
    if ($shift['status'] === 'worked') {
        throw new DomainException('This shift has already been worked and cannot be unallocated. Mark it as an adjustment instead.');
    }

    q($db, "UPDATE shifts SET worker_id = NULL, status = 'planned', updated_at = ? WHERE id = ?",
        [now_instant(), $shiftId]);
    record_audit($db, [
        'entityType' => 'shift', 'entityId' => $shiftId, 'action' => 'released',
        'summary' => "Worker released from shift: $reason", 'actor' => $actor,
        'before' => ['workerId' => $shift['worker_id']],
    ]);
    if ($shift['worker_id']) recalculate_awr($db, $shift['worker_id'], $shift['assignment_id']);
}

function mark_shift_status(PDO $db, string $shiftId, string $status, array $opts = [], string $actor = 'system'): void {
    $before = row($db, 'SELECT * FROM shifts WHERE id = ?', [$shiftId]);
    if (!$before) throw new DomainException('Shift not found');

    q($db, 'UPDATE shifts SET status = ?, cancellation_reason = ?,
              actual_start_at = COALESCE(?, actual_start_at),
              actual_end_at = COALESCE(?, actual_end_at),
              actual_break_minutes = COALESCE(?, actual_break_minutes),
              updated_at = ?
            WHERE id = ?',
        [$status, $opts['reason'] ?? null, $opts['actualStartAt'] ?? null,
         $opts['actualEndAt'] ?? null, $opts['actualBreakMinutes'] ?? null,
         now_instant(), $shiftId]);

    record_audit($db, [
        'entityType' => 'shift', 'entityId' => $shiftId, 'action' => "marked_$status",
        'summary' => "Shift marked $status" . (isset($opts['reason']) ? ": {$opts['reason']}" : ''),
        'actor' => $actor,
        'before' => ['status' => $before['status']], 'after' => ['status' => $status] + $opts,
    ]);

    if ($before['worker_id']) recalculate_awr($db, $before['worker_id'], $before['assignment_id']);
}

function replace_shift(PDO $db, string $shiftId, string $replacementWorkerId, string $reason, string $actor = 'system'): string {
    $original = row($db, 'SELECT * FROM shifts WHERE id = ?', [$shiftId]);
    if (!$original) throw new DomainException('Shift not found');

    $replacementId = create_shift($db, [
        'assignmentId' => $original['assignment_id'],
        'siteId' => $original['site_id'],
        'startsAt' => $original['starts_at'],
        'endsAt' => $original['ends_at'],
        'breakMinutes' => (int) $original['break_minutes'],
        'isBankHoliday' => (bool) (int) $original['is_bank_holiday'],
        'notes' => "Replacement for shift $shiftId: $reason",
    ], $actor);

    allocate_worker($db, $replacementId, $replacementWorkerId, ['reason' => $reason], $actor);

    q($db, "UPDATE shifts SET status = 'replaced', replaced_by_shift_id = ?, cancellation_reason = ?, updated_at = ?
            WHERE id = ?", [$replacementId, $reason, now_instant(), $shiftId]);
    record_audit($db, [
        'entityType' => 'shift', 'entityId' => $shiftId, 'action' => 'replaced',
        'summary' => "Shift replaced by $replacementId: $reason", 'actor' => $actor,
        'after' => ['replacementId' => $replacementId, 'replacementWorkerId' => $replacementWorkerId],
    ]);
    return $replacementId;
}

function shift_value(PDO $db, string $shiftId): array {
    $s = row($db, 'SELECT * FROM shifts WHERE id = ?', [$shiftId]);
    if (!$s) throw new DomainException('Shift not found');
    $assignment = row($db, 'SELECT * FROM assignments WHERE id = ?', [$s['assignment_id']]);

    $minutes = worked_minutes(
        $s['actual_start_at'] ?? $s['starts_at'],
        $s['actual_end_at'] ?? $s['ends_at'],
        (int) ($s['actual_break_minutes'] ?? $s['break_minutes']));

    $billedMinutes = $assignment['min_shift_minutes']
        ? max($minutes, (int) $assignment['min_shift_minutes'])
        : $minutes;

    $chargeRate = (int) ($s['charge_rate_pence'] ?? 0);
    $payRate = (int) ($s['pay_rate_pence'] ?? 0);
    $chargePence = charge_for($billedMinutes, $chargeRate);
    $payPence = charge_for($minutes, $payRate);
    $marginPence = $chargePence - $payPence;

    return [
        'shiftId' => $shiftId, 'workedMinutes' => $minutes, 'billedMinutes' => $billedMinutes,
        'chargeRatePence' => $chargeRate, 'payRatePence' => $payRate,
        'chargePence' => $chargePence, 'payPence' => $payPence,
        'marginPence' => $marginPence,
        'marginPercent' => $chargePence > 0 ? round($marginPence / $chargePence * 1000) / 10 : 0,
        'rateSource' => $s['rate_source'],
    ];
}

function fill_rate(PDO $db, string $assignmentId, string $from, string $to): array {
    $r = row($db, "SELECT COUNT(*) AS total,
              SUM(CASE WHEN worker_id IS NOT NULL AND status IN ('allocated','worked') THEN 1 ELSE 0 END) AS filled,
              SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS noShows
            FROM shifts
            WHERE assignment_id = ? AND date(starts_at) BETWEEN ? AND ? AND status <> 'replaced'",
        [$assignmentId, $from, $to]);

    $total = (int) ($r['total'] ?? 0);
    $filled = (int) ($r['filled'] ?? 0);
    return ['total' => $total, 'filled' => $filled, 'unfilled' => $total - $filled,
        'noShows' => (int) ($r['noShows'] ?? 0),
        'fillRatePercent' => $total > 0 ? round($filled / $total * 1000) / 10 : 0];
}

function eligible_workers(PDO $db, string $shiftId): array {
    // Non-active workers are listed as blocked rather than silently omitted —
    // "0 candidates" with three onboarding workers on the books reads as a bug.
    $candidates = rows($db, "SELECT id, first_name, last_name, status FROM workers
        WHERE status NOT IN ('left','barred') ORDER BY last_name");
    $out = [];
    foreach ($candidates as $w) {
        if ($w['status'] !== 'active') {
            $out[] = ['workerId' => $w['id'], 'name' => "{$w['first_name']} {$w['last_name']}",
                'eligible' => false,
                'blockers' => [[
                    'code' => 'worker_not_active', 'severity' => 'blocker',
                    'title' => "Worker is {$w['status']} — mark them active from their Workers page once vetting is complete",
                    'detail' => 'Only active workers can be allocated to shifts.',
                ]],
                'warnings' => []];
            continue;
        }
        try {
            $check = check_allocation($db, $shiftId, $w['id']);
        } catch (Throwable) {
            $check = ['allowed' => false, 'blockers' => [], 'warnings' => [], 'clashes' => []];
        }
        $out[] = ['workerId' => $w['id'], 'name' => "{$w['first_name']} {$w['last_name']}",
            'eligible' => $check['allowed'], 'blockers' => $check['blockers'], 'warnings' => $check['warnings']];
    }
    return $out;
}

// ---------------------------------------------------------------------------
// Timesheets — editable while draft, locked at approval, frozen once billed
// ---------------------------------------------------------------------------

function create_timesheet(PDO $db, array $input, string $actor = 'system'): string {
    $week = $input['weekEnding'] ?? week_ending($input['workDate'] ?? today_iso());

    $existing = row($db, 'SELECT id FROM timesheets WHERE assignment_id = ? AND worker_id = ? AND week_ending = ?',
        [$input['assignmentId'], $input['workerId'], $week]);
    if ($existing) return $existing['id'];

    $id = new_id('ts');
    $now = now_instant();
    $reference = allocate_number($db, 'timesheet', $id);

    q($db, "INSERT INTO timesheets (id, reference, assignment_id, worker_id, week_ending, status,
              entered_by, entered_at, notes, created_at, updated_at)
            VALUES (?,?,?,?,?, 'draft', ?,?,?,?,?)",
        [$id, $reference, $input['assignmentId'], $input['workerId'], $week,
         $actor, $now, $input['notes'] ?? null, $now, $now]);

    record_audit($db, [
        'entityType' => 'timesheet', 'entityId' => $id, 'action' => 'created',
        'summary' => "Timesheet $reference opened for week ending $week",
        'actor' => $actor, 'after' => $input,
    ]);
    return $id;
}

function assert_timesheet_editable(PDO $db, string $timesheetId): array {
    $ts = row($db, 'SELECT * FROM timesheets WHERE id = ?', [$timesheetId]);
    if (!$ts) throw new DomainException('Timesheet not found');
    if ($ts['status'] === 'invoiced') {
        throw new DomainException('This timesheet has been invoiced and cannot be changed. Raise a credit note against the invoice instead.');
    }
    if ($ts['status'] === 'approved') {
        throw new DomainException('This timesheet has been approved and is locked. Reopen it to make changes.');
    }
    if ($ts['status'] === 'void') throw new DomainException('This timesheet has been voided.');
    return $ts;
}

function timesheet_add_line(PDO $db, string $timesheetId, array $line): string {
    $ts = assert_timesheet_editable($db, $timesheetId);

    $minutes = $line['workedMinutes'] ?? null;
    $chargeRate = $line['chargeRatePence'] ?? null;
    $payRate = $line['payRatePence'] ?? null;
    $band = $line['band'] ?? 'standard';
    $billed = $line['billedMinutes'] ?? null;

    if (!empty($line['shiftId'])) {
        $value = shift_value($db, $line['shiftId']);
        $shift = row($db, 'SELECT * FROM shifts WHERE id = ?', [$line['shiftId']]);
        $minutes = $minutes ?? $value['workedMinutes'];
        $billed = $billed ?? $value['billedMinutes'];
        $chargeRate = $chargeRate ?? $value['chargeRatePence'];
        $payRate = $payRate ?? $value['payRatePence'];
        $band = $line['band'] ?? $shift['band'];
    }

    if ($minutes === null && !empty($line['startTime']) && !empty($line['endTime'])) {
        $minutes = worked_minutes(
            "{$line['workDate']}T{$line['startTime']}",
            "{$line['workDate']}T{$line['endTime']}",
            (int) ($line['breakMinutes'] ?? 0));
    }

    if ($minutes === null) throw new DomainException('Cannot determine hours worked for this line');
    $billed = $billed ?? $minutes;
    $chargeRate = (int) ($chargeRate ?? 0);
    $payRate = (int) ($payRate ?? 0);

    $nmw = check_nmw($db, $ts['worker_id'], $payRate, $line['workDate']);
    if (!$nmw['ok']) {
        throw new DomainException(sprintf(
            'Pay rate £%.2f/hour is below the %s National Minimum Wage of £%.2f/hour on %s.',
            $payRate / 100, str_replace('_', ' ', (string) $nmw['band']),
            ($nmw['requiredPence'] ?? 0) / 100, $line['workDate']));
    }

    $id = new_id('tsl');
    q($db, 'INSERT INTO timesheet_lines
              (id, timesheet_id, shift_id, work_date, start_time, end_time, break_minutes,
               worked_minutes, billed_minutes, band, charge_rate_pence, pay_rate_pence,
               charge_pence, pay_pence, notes, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [$id, $timesheetId, $line['shiftId'] ?? null, $line['workDate'],
         $line['startTime'] ?? null, $line['endTime'] ?? null, (int) ($line['breakMinutes'] ?? 0),
         (int) $minutes, (int) $billed, $band, $chargeRate, $payRate,
         charge_for((int) $billed, $chargeRate), charge_for((int) $minutes, $payRate),
         $line['notes'] ?? null, now_instant()]);

    recalc_timesheet_totals($db, $timesheetId);
    return $id;
}

function timesheet_remove_line(PDO $db, string $timesheetId, string $lineId): void {
    assert_timesheet_editable($db, $timesheetId);
    q($db, 'DELETE FROM timesheet_lines WHERE id = ? AND timesheet_id = ?', [$lineId, $timesheetId]);
    recalc_timesheet_totals($db, $timesheetId);
}

function recalc_timesheet_totals(PDO $db, string $timesheetId): void {
    $t = row($db, 'SELECT COALESCE(SUM(worked_minutes),0) AS minutes,
                          COALESCE(SUM(charge_pence),0) AS charge,
                          COALESCE(SUM(pay_pence),0) AS pay
                   FROM timesheet_lines WHERE timesheet_id = ?', [$timesheetId]);
    q($db, 'UPDATE timesheets SET total_minutes = ?, charge_total_pence = ?, pay_total_pence = ?, updated_at = ?
            WHERE id = ?',
        [(int) $t['minutes'], (int) $t['charge'], (int) $t['pay'], now_instant(), $timesheetId]);
}

function populate_from_shifts(PDO $db, string $timesheetId): int {
    $ts = assert_timesheet_editable($db, $timesheetId);
    $from = add_days($ts['week_ending'], -6);

    $shifts = rows($db, "SELECT * FROM shifts
        WHERE assignment_id = ? AND worker_id = ?
          AND date(starts_at) BETWEEN ? AND ?
          AND status IN ('allocated','worked')
          AND id NOT IN (SELECT COALESCE(shift_id,'') FROM timesheet_lines WHERE timesheet_id = ?)
        ORDER BY starts_at ASC",
        [$ts['assignment_id'], $ts['worker_id'], $from, $ts['week_ending'], $timesheetId]);

    foreach ($shifts as $s) {
        timesheet_add_line($db, $timesheetId, [
            'shiftId' => $s['id'],
            'workDate' => substr($s['starts_at'], 0, 10),
            'startTime' => substr($s['starts_at'], 11, 5),
            'endTime' => substr($s['ends_at'], 11, 5),
            'breakMinutes' => (int) $s['break_minutes'],
        ]);
    }
    return count($shifts);
}

function approve_timesheet(PDO $db, string $timesheetId, array $input, array $opts = [], string $actor = 'system'): void {
    $ts = row($db, 'SELECT * FROM timesheets WHERE id = ?', [$timesheetId]);
    if (!$ts) throw new DomainException('Timesheet not found');
    if ($ts['status'] === 'invoiced') throw new DomainException('This timesheet has already been invoiced.');
    if ($ts['status'] === 'approved') throw new DomainException('This timesheet is already approved.');

    $lineCount = (int) scalar($db, 'SELECT COUNT(*) FROM timesheet_lines WHERE timesheet_id = ?', [$timesheetId]);
    if ($lineCount === 0) throw new DomainException('Cannot approve a timesheet with no hours on it.');

    $scan = $input['signedScanDocumentId']
        ?? scalar($db, "SELECT id FROM documents WHERE entity_type = 'timesheet' AND entity_id = ?
                        AND category = 'signed_timesheet' LIMIT 1", [$timesheetId]);

    if (!$scan && empty($opts['allowMissingScan'])) {
        throw new DomainException('No signed timesheet scan is attached. Attach the signed paper sheet, or approve with an explicit reason recorded for the missing scan.');
    }

    q($db, "UPDATE timesheets SET status = 'approved', client_signatory = ?, client_signed_on = ?,
              approved_by = ?, approved_at = ?, updated_at = ?
            WHERE id = ?",
        [$input['clientSignatory'], $input['clientSignedOn'],
         $input['approvedBy'] ?? $actor, now_instant(), now_instant(), $timesheetId]);

    record_audit($db, [
        'entityType' => 'timesheet', 'entityId' => $timesheetId, 'action' => 'approved',
        'summary' => "Timesheet {$ts['reference']} approved — signed by {$input['clientSignatory']} on {$input['clientSignedOn']}"
            . ($scan ? '' : ' (NO SIGNED SCAN: ' . ($opts['missingScanReason'] ?? 'no reason given') . ')'),
        'actor' => $actor,
        'after' => $input + ['scanDocumentId' => $scan, 'missingScanReason' => $opts['missingScanReason'] ?? null],
    ]);

    $shiftIds = rows($db, 'SELECT shift_id FROM timesheet_lines WHERE timesheet_id = ? AND shift_id IS NOT NULL',
        [$timesheetId]);
    foreach ($shiftIds as $r) {
        q($db, "UPDATE shifts SET status = 'worked', updated_at = ? WHERE id = ? AND status = 'allocated'",
            [now_instant(), $r['shift_id']]);
    }
    recalculate_awr($db, $ts['worker_id'], $ts['assignment_id']);
}

function reopen_timesheet(PDO $db, string $timesheetId, string $reason, string $actor = 'system'): void {
    $ts = row($db, 'SELECT * FROM timesheets WHERE id = ?', [$timesheetId]);
    if (!$ts) throw new DomainException('Timesheet not found');
    if ($ts['status'] === 'invoiced') {
        throw new DomainException('This timesheet has been invoiced. Credit the invoice first, then the timesheet can be reopened.');
    }
    q($db, "UPDATE timesheets SET status = 'draft', approved_at = NULL, updated_at = ? WHERE id = ?",
        [now_instant(), $timesheetId]);
    record_audit($db, [
        'entityType' => 'timesheet', 'entityId' => $timesheetId, 'action' => 'reopened',
        'summary' => "Timesheet {$ts['reference']} reopened: $reason", 'actor' => $actor,
        'before' => ['status' => $ts['status']],
    ]);
}

function dispute_timesheet(PDO $db, string $timesheetId, string $reason, string $actor = 'system'): void {
    $ts = row($db, 'SELECT * FROM timesheets WHERE id = ?', [$timesheetId]);
    if (!$ts) throw new DomainException('Timesheet not found');
    q($db, "UPDATE timesheets SET status = 'disputed', dispute_reason = ?, updated_at = ? WHERE id = ?",
        [$reason, now_instant(), $timesheetId]);
    record_audit($db, [
        'entityType' => 'timesheet', 'entityId' => $timesheetId, 'action' => 'disputed',
        'summary' => "Timesheet {$ts['reference']} marked disputed: $reason", 'actor' => $actor,
    ]);
}

function unbilled_timesheets(PDO $db, ?string $clientOrgId = null): array {
    $sql = "SELECT t.*, a.title AS assignment_title, a.client_org_id,
                   o.name AS client_name, w.first_name, w.last_name,
                   (SELECT COUNT(*) FROM documents d
                     WHERE d.entity_type = 'timesheet' AND d.entity_id = t.id
                       AND d.category = 'signed_timesheet') AS scan_count
            FROM timesheets t
            JOIN assignments a ON a.id = t.assignment_id
            JOIN organisations o ON o.id = a.client_org_id
            JOIN workers w ON w.id = t.worker_id
            WHERE t.status = 'approved' AND t.invoice_id IS NULL" . ($clientOrgId ? ' AND a.client_org_id = ?' : '') . '
            ORDER BY t.week_ending ASC, o.name ASC';
    $result = rows($db, $sql, $clientOrgId ? [$clientOrgId] : []);
    return array_map(fn($r) => $r + [
        'marginPence' => (int) $r['charge_total_pence'] - (int) $r['pay_total_pence'],
        'holidayAccrualPence' => holiday_accrual_pence((int) $r['pay_total_pence']),
    ], $result);
}

function timesheet_with_lines(PDO $db, string $timesheetId): ?array {
    $ts = row($db, 'SELECT t.*, a.title AS assignment_title, o.name AS client_name,
                          w.first_name, w.last_name, w.engagement_type
                   FROM timesheets t
                   JOIN assignments a ON a.id = t.assignment_id
                   JOIN organisations o ON o.id = a.client_org_id
                   JOIN workers w ON w.id = t.worker_id
                   WHERE t.id = ?', [$timesheetId]);
    if (!$ts) return null;

    return $ts + [
        'lines' => rows($db, 'SELECT * FROM timesheet_lines WHERE timesheet_id = ? ORDER BY work_date, start_time', [$timesheetId]),
        'documents' => rows($db, "SELECT * FROM documents WHERE entity_type = 'timesheet' AND entity_id = ?", [$timesheetId]),
        'marginPence' => (int) $ts['charge_total_pence'] - (int) $ts['pay_total_pence'],
        'holidayAccrualPence' => holiday_accrual_pence((int) $ts['pay_total_pence']),
    ];
}
