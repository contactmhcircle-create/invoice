<?php
/**
 * Numbering, rates and the compliance engine — ports of core/services/
 * numbering.ts, rates.ts and compliance.ts. The SQL is copied from the
 * TypeScript verbatim (same SQLite dialect); PHP is only the glue, so the
 * behaviour the 109-test suite pinned down carries over formula-for-formula.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Gapless document numbering
// ---------------------------------------------------------------------------

function allocate_number(PDO $db, string $docType, ?string $entityId = null): string {
    $seq = row($db, 'SELECT * FROM numbering WHERE doc_type = ?', [$docType]);
    if (!$seq) throw new DomainException("No numbering sequence configured for '$docType'");

    $sequenceNo = (int) $seq['next_number'];
    $padded = str_pad((string) $sequenceNo, (int) $seq['pad_width'], '0', STR_PAD_LEFT);
    $numberText = (int) $seq['include_year'] === 1
        ? "{$seq['prefix']}-" . gmdate('Y') . "-$padded"
        : "{$seq['prefix']}-$padded";

    q($db, 'UPDATE numbering SET next_number = next_number + 1, updated_at = ? WHERE doc_type = ?',
        [now_instant(), $docType]);
    q($db, 'INSERT INTO number_allocations (doc_type, number_text, sequence_no, allocated_at, entity_id)
            VALUES (?,?,?,?,?)', [$docType, $numberText, $sequenceNo, now_instant(), $entityId]);
    return $numberText;
}

function audit_sequence(PDO $db, string $docType): array {
    $nums = array_map('intval', array_column(
        rows($db, 'SELECT sequence_no FROM number_allocations WHERE doc_type = ? ORDER BY sequence_no ASC', [$docType]),
        'sequence_no'));
    if (!$nums) return ['docType' => $docType, 'allocated' => 0, 'lowest' => null,
        'highest' => null, 'missing' => [], 'intact' => true];

    $lowest = $nums[0];
    $highest = end($nums);
    $missing = array_values(array_diff(range($lowest, $highest), $nums));
    return ['docType' => $docType, 'allocated' => count($nums), 'lowest' => $lowest,
        'highest' => $highest, 'missing' => $missing, 'intact' => count($missing) === 0];
}

// ---------------------------------------------------------------------------
// Rates: shift override → assignment → site → client, first match wins
// ---------------------------------------------------------------------------

const NIGHT_START_MINUTE = 23 * 60;
const NIGHT_END_MINUTE = 6 * 60;
const NIGHT_QUALIFYING_MINUTES = 180;

/** At least three hours inside 23:00–06:00, handling shifts that cross midnight. */
function is_night_shift(string $startsAt, string $endsAt): bool {
    $tz = new DateTimeZone(UTC);
    $start = new DateTimeImmutable($startsAt, $tz);
    $end = new DateTimeImmutable($endsAt, $tz);

    $startMinute = (int) $start->format('G') * 60 + (int) $start->format('i');
    $endMinute = (int) $end->format('G') * 60 + (int) $end->format('i');
    if ($endMinute <= $startMinute) $endMinute += 1440;

    $overlap = fn(int $aFrom, int $aTo, int $bFrom, int $bTo): int =>
        max(0, min($aTo, $bTo) - max($aFrom, $bFrom));

    $minutesInNight =
        $overlap($startMinute, $endMinute, NIGHT_START_MINUTE, 1440 + NIGHT_END_MINUTE)
        + $overlap($startMinute, $endMinute, NIGHT_START_MINUTE - 1440, NIGHT_END_MINUTE);

    return $minutesInNight >= NIGHT_QUALIFYING_MINUTES;
}

function determine_band(string $startsAt, string $endsAt, bool $isBankHoliday, bool $useBands): string {
    if (!$useBands) return 'standard';
    if ($isBankHoliday) return 'bank_holiday';
    if (is_weekend(substr($startsAt, 0, 10))) return 'weekend';
    if (is_night_shift($startsAt, $endsAt)) return 'night';
    return 'standard';
}

function rate_lookup(PDO $db, string $scope, string $scopeId, string $band, string $on): ?array {
    return row($db, 'SELECT * FROM rates
                     WHERE scope = ? AND scope_id = ? AND band = ?
                       AND effective_from <= ?
                       AND (effective_to IS NULL OR effective_to >= ?)
                     ORDER BY effective_from DESC LIMIT 1',
        [$scope, $scopeId, $band, $on, $on]);
}

function resolve_rate(PDO $db, array $ctx): ?array {
    $chargeOverride = $ctx['chargeOverridePence'] ?? null;
    $payOverride = $ctx['payOverridePence'] ?? null;
    $band = $ctx['band'];

    if ($chargeOverride !== null && $payOverride !== null) {
        return ['chargeRatePence' => (int) $chargeOverride, 'payRatePence' => (int) $payOverride,
            'band' => $band, 'source' => 'Shift override'];
    }

    $chain = [
        ['assignment', $ctx['assignmentId'] ?? null, 'Assignment rate'],
        ['site', $ctx['siteId'] ?? null, 'Site default'],
        ['client', $ctx['clientOrgId'] ?? null, 'Client default'],
    ];

    foreach ($chain as [$scope, $id, $label]) {
        if (!$id) continue;
        $row = rate_lookup($db, $scope, $id, $band, $ctx['on']);
        $sourceLabel = "$label (" . str_replace('_', ' ', $band) . ')';
        if (!$row && $band !== 'standard') {
            $row = rate_lookup($db, $scope, $id, 'standard', $ctx['on']);
            $sourceLabel = "$label (standard rate, no " . str_replace('_', ' ', $band) . ' rate set)';
        }
        if ($row) {
            $charge = (int) $row['charge_rate_pence'];
            $pay = (int) $row['pay_rate_pence'];
            if ($band === 'bank_holiday' && str_contains($sourceLabel, 'standard rate')) {
                $asg = row($db, 'SELECT bank_holiday_multiplier FROM assignments WHERE id = ?',
                    [$ctx['assignmentId']]);
                if ($asg && $asg['bank_holiday_multiplier']) {
                    $m = (float) $asg['bank_holiday_multiplier'];
                    $charge = (int) round($charge * $m);
                    $pay = (int) round($pay * $m);
                    $sourceLabel .= " x$m";
                }
            }
            return [
                'chargeRatePence' => $chargeOverride !== null ? (int) $chargeOverride : $charge,
                'payRatePence' => $payOverride !== null ? (int) $payOverride : $pay,
                'band' => $band, 'source' => $sourceLabel,
            ];
        }
    }

    if ($chargeOverride !== null || $payOverride !== null) {
        return ['chargeRatePence' => (int) ($chargeOverride ?? 0), 'payRatePence' => (int) ($payOverride ?? 0),
            'band' => $band, 'source' => 'Shift override (partial)'];
    }
    return null;
}

function set_rate(PDO $db, array $input): string {
    $id = new_id('rate');
    q($db, 'INSERT INTO rates (id, scope, scope_id, band, charge_rate_pence, pay_rate_pence,
              effective_from, effective_to, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [$id, $input['scope'], $input['scopeId'], $input['band'] ?? 'standard',
         (int) $input['chargeRatePence'], (int) $input['payRatePence'],
         $input['effectiveFrom'], $input['effectiveTo'] ?? null, $input['notes'] ?? null, now_instant()]);
    return $id;
}

// ---------------------------------------------------------------------------
// Compliance engine
// ---------------------------------------------------------------------------

const BS7858_ELEMENTS = ['identity', 'address_history', 'employment_history',
    'character_references', 'financial_probity', 'criminal_record'];

const BS7858_LABELS = [
    'identity' => 'Identity verification',
    'address_history' => 'Address history (5 years)',
    'employment_history' => 'Employment history (5 years, gaps accounted for)',
    'character_references' => 'Character references obtained and verified',
    'financial_probity' => 'Financial probity check',
    'criminal_record' => 'Criminal record declaration / basic disclosure',
];

const LICENCE_WARNING_DAYS = 60;
const RTW_WARNING_DAYS = 30;
const AWR_QUALIFYING_WEEKS = 12;
const AWR_WARNING_AT_WEEK = 10;
const AWR_RESET_WEEKS = 6;
const WTR_WEEKLY_LIMIT_MINUTES = 48 * 60;
const HOLIDAY_ACCRUAL_RATE = 0.1207;

function holiday_accrual_pence(int $payPence): int {
    return (int) round($payPence * HOLIDAY_ACCRUAL_RATE);
}

function active_licences(PDO $db, string $workerId): array {
    return rows($db, "SELECT * FROM worker_licences
                      WHERE worker_id = ? AND status IN ('valid','pending')
                      ORDER BY expires_on DESC", [$workerId]);
}

function nmw_band_for(?string $dateOfBirth, string $at): ?string {
    if (!$dateOfBirth) return null;
    $age = age_at($dateOfBirth, $at);
    if ($age >= 21) return '21_and_over';
    if ($age >= 18) return '18_to_20';
    return 'under_18';
}

function nmw_rate_pence(PDO $db, string $band, string $at): ?int {
    $v = scalar($db, 'SELECT rate_pence FROM nmw_rates
                      WHERE band = ? AND effective_from <= ?
                      ORDER BY effective_from DESC LIMIT 1', [$band, $at]);
    return $v === null ? null : (int) $v;
}

function check_nmw(PDO $db, string $workerId, int $payRatePence, string $at): array {
    $worker = row($db, 'SELECT date_of_birth FROM workers WHERE id = ?', [$workerId]);
    $band = nmw_band_for($worker['date_of_birth'] ?? null, $at);
    if (!$band) return ['ok' => true, 'band' => null, 'requiredPence' => null,
        'actualPence' => $payRatePence, 'shortfallPence' => 0];
    $required = nmw_rate_pence($db, $band, $at);
    if ($required === null) return ['ok' => true, 'band' => $band, 'requiredPence' => null,
        'actualPence' => $payRatePence, 'shortfallPence' => 0];
    $shortfall = max(0, $required - $payRatePence);
    return ['ok' => $shortfall === 0, 'band' => $band, 'requiredPence' => $required,
        'actualPence' => $payRatePence, 'shortfallPence' => $shortfall];
}

/** Recomputes the AWR clock from worked shifts; a 6+ week gap resets it. */
function recalculate_awr(PDO $db, string $workerId, string $assignmentId): int {
    $worked = rows($db, "SELECT DISTINCT date(starts_at) AS d FROM shifts
                         WHERE worker_id = ? AND assignment_id = ? AND status IN ('worked','allocated')
                         ORDER BY d ASC", [$workerId, $assignmentId]);
    $weeks = array_values(array_unique(array_map(fn($r) => week_ending($r['d']), $worked)));
    sort($weeks);

    q($db, 'DELETE FROM awr_weeks WHERE worker_id = ? AND assignment_id = ?', [$workerId, $assignmentId]);

    $cumulative = 0;
    $previousWeek = null;
    $now = now_instant();

    foreach ($weeks as $week) {
        $resetReason = null;
        if ($previousWeek !== null) {
            $gapWeeks = (int) round(days_between($previousWeek, $week) / 7);
            if ($gapWeeks >= AWR_RESET_WEEKS) {
                $cumulative = 0;
                $resetReason = "Break of $gapWeeks weeks reset the qualifying clock";
            }
        }
        $cumulative++;
        q($db, 'INSERT INTO awr_weeks (id, worker_id, assignment_id, week_ending, qualifies, cumulative, reset_reason, created_at)
                VALUES (?,?,?,?,1,?,?,?)',
            [new_id('awr'), $workerId, $assignmentId, $week, $cumulative, $resetReason, $now]);
        $previousWeek = $week;
    }
    return $cumulative;
}

function wtr_weekly_minutes(PDO $db, string $workerId, string $weekEndingDate): int {
    $from = add_days($weekEndingDate, -6);
    $v = scalar($db, "SELECT COALESCE(SUM(
            (julianday(ends_at) - julianday(starts_at)) * 24 * 60 - break_minutes), 0)
         FROM shifts
         WHERE worker_id = ? AND status IN ('worked','allocated')
           AND date(starts_at) BETWEEN ? AND ?", [$workerId, $from, $weekEndingDate]);
    return (int) round((float) $v);
}

/**
 * The full compliance picture for a worker on a date. Blockers stop allocation;
 * warnings surface on the dashboard and never block, because a compliance
 * system that blocks on everything gets worked around.
 */
function check_worker(PDO $db, string $workerId, ?string $atDate = null, ?string $requiredSector = null): array {
    $atDate = $atDate ?? today_iso();
    $worker = row($db, 'SELECT * FROM workers WHERE id = ?', [$workerId]);
    if (!$worker) throw new DomainException("Worker $workerId not found");

    $findings = [];
    $add = function (string $code, string $severity, string $title, string $detail,
                     ?string $action = null, ?string $expiresOn = null, ?int $daysRemaining = null)
                     use (&$findings): void {
        $f = ['code' => $code, 'severity' => $severity, 'title' => $title, 'detail' => $detail];
        if ($action !== null) $f['action'] = $action;
        if ($expiresOn !== null) $f['expiresOn'] = $expiresOn;
        if ($daysRemaining !== null) $f['daysRemaining'] = $daysRemaining;
        $findings[] = $f;
    };

    if ($worker['status'] === 'barred') {
        $add('WORKER_BARRED', 'blocker', 'Worker is barred',
            'This worker has been barred and cannot be allocated to any shift.',
            'Change the worker status if this is no longer correct.');
    } elseif (in_array($worker['status'], ['left', 'inactive'], true)) {
        $add('WORKER_INACTIVE', 'blocker', "Worker is marked {$worker['status']}",
            'Only active workers can be allocated to shifts.',
            'Set the worker back to active to place them.');
    }

    // --- SIA licence ---------------------------------------------------------
    $licences = active_licences($db, $workerId);
    $relevant = $requiredSector
        ? array_values(array_filter($licences, fn($l) => $l['sector'] === $requiredSector))
        : $licences;

    if (!$relevant) {
        $sectorLabel = $requiredSector ? str_replace('_', ' ', $requiredSector) : null;
        $add('SIA_MISSING', 'blocker',
            $sectorLabel ? "No $sectorLabel licence on file" : 'No SIA licence on file',
            $sectorLabel
                ? "This assignment requires an SIA $sectorLabel licence and none is recorded for this worker."
                : 'No SIA licence is recorded for this worker.',
            'Add the licence and verify it against the SIA public register.');
    } else {
        $valid = null;
        foreach ($relevant as $l) {
            if ($l['status'] === 'valid' && $l['expires_on'] >= $atDate) { $valid = $l; break; }
        }
        if (!$valid) {
            $mostRecent = $relevant[0];
            $add('SIA_EXPIRED', 'blocker', 'SIA licence not valid on this date',
                $mostRecent['status'] !== 'valid'
                    ? "The licence on file is marked {$mostRecent['status']}."
                    : "Licence {$mostRecent['licence_number']} expired on {$mostRecent['expires_on']}, before this shift date ($atDate).",
                'Obtain and record the renewed licence before allocating this worker.',
                $mostRecent['expires_on']);
        } else {
            $days = days_between($atDate, $valid['expires_on']);
            if ($days <= LICENCE_WARNING_DAYS) {
                $add('SIA_EXPIRING', 'warning',
                    "SIA licence expires in $days day" . ($days === 1 ? '' : 's'),
                    "Licence {$valid['licence_number']} (" . str_replace('_', ' ', $valid['sector']) . ") expires on {$valid['expires_on']}.",
                    'Start the renewal now — SIA renewals routinely take several weeks.',
                    $valid['expires_on'], $days);
            }
            if (!$valid['verified_on']) {
                $add('SIA_UNVERIFIED', 'warning', 'Licence not verified against the SIA register',
                    "Licence {$valid['licence_number']} has been recorded but never checked against the SIA public register.",
                    'Check the number on the SIA register and record the verification date.');
            }
        }
    }

    // --- Right to work -------------------------------------------------------
    $rtw = row($db, 'SELECT * FROM worker_rtw WHERE worker_id = ? ORDER BY checked_on DESC LIMIT 1', [$workerId]);
    if (!$rtw) {
        $add('RTW_MISSING', 'blocker', 'No right to work check recorded',
            'A right to work check must be completed before the worker starts their first shift. '
            . 'Without it there is no statutory excuse against an illegal working civil penalty.',
            'Complete a share code or document check and record it before allocating.');
    } elseif ($rtw['outcome'] === 'failed') {
        $add('RTW_FAILED', 'blocker', 'Right to work check failed',
            'The recorded right to work check did not establish a right to work in the UK.',
            'This worker must not be allocated to any shift.');
    } elseif ($rtw['outcome'] === 'time_limited') {
        if ($rtw['expires_on'] && $rtw['expires_on'] < $atDate) {
            $add('RTW_EXPIRED', 'blocker', 'Right to work permission has expired',
                "Time-limited permission expired on {$rtw['expires_on']}, before this shift date ($atDate).",
                'Carry out a follow-up check before this worker takes any further shift.',
                $rtw['expires_on']);
        } elseif ($rtw['expires_on']) {
            $days = days_between($atDate, $rtw['expires_on']);
            if ($days <= RTW_WARNING_DAYS) {
                $add('RTW_EXPIRING', 'warning',
                    "Right to work expires in $days day" . ($days === 1 ? '' : 's'),
                    "Time-limited permission expires on {$rtw['expires_on']}.",
                    'Schedule the follow-up check now.', $rtw['expires_on'], $days);
            }
        }
        if ($rtw['recheck_due_on'] && $rtw['recheck_due_on'] <= $atDate) {
            $add('RTW_RECHECK_DUE', 'warning', 'Right to work re-check is due',
                "A follow-up check was due on {$rtw['recheck_due_on']}.",
                'Carry out the follow-up check to maintain the statutory excuse.');
        }
    }

    // --- BS 7858 screening ---------------------------------------------------
    $screening = rows($db, 'SELECT element, status, covers_from, covers_to FROM screening_checks WHERE worker_id = ?', [$workerId]);
    $byElement = array_column($screening, null, 'element');

    $outstanding = array_values(array_filter(BS7858_ELEMENTS, function ($el) use ($byElement) {
        $rec = $byElement[$el] ?? null;
        return !$rec || !in_array($rec['status'], ['satisfied', 'waived'], true);
    }));

    if ($outstanding) {
        $failed = array_filter(BS7858_ELEMENTS, fn($el) => ($byElement[$el]['status'] ?? '') === 'failed');
        $n = count($outstanding);
        $add($failed ? 'BS7858_FAILED' : 'BS7858_INCOMPLETE', 'blocker',
            $failed
                ? 'BS 7858 screening has a failed element'
                : "BS 7858 screening incomplete — $n element" . ($n === 1 ? '' : 's') . ' outstanding',
            implode('; ', array_map(fn($el) => BS7858_LABELS[$el], $outstanding)),
            'Complete the outstanding screening elements. Security buyers audit this pack during procurement.');
    } else {
        $employment = $byElement['employment_history'] ?? null;
        if ($employment && $employment['covers_from'] && $employment['covers_to']) {
            $years = days_between($employment['covers_from'], $employment['covers_to']) / 365.25;
            if ($years < 4.95) {
                $add('BS7858_SHORT_HISTORY', 'warning', 'Employment history covers less than 5 years',
                    sprintf('Recorded history covers %.1f years (%s to %s). BS 7858 requires 5 years with all gaps accounted for.',
                        $years, $employment['covers_from'], $employment['covers_to']),
                    'Extend the employment history record or document the gaps.');
            }
        }
    }

    // --- Key Information Document -------------------------------------------
    if (!row($db, 'SELECT id FROM key_information_documents WHERE worker_id = ? ORDER BY version DESC LIMIT 1', [$workerId])) {
        $add('KID_MISSING', 'warning', 'No Key Information Document issued',
            'A Key Information Document must be given to an agency worker before terms are agreed, '
            . 'under the Conduct of Employment Agencies and Employment Businesses Regulations.',
            'Generate and issue the KID from the worker record.');
    }

    // --- Engagement route ----------------------------------------------------
    if ($worker['engagement_type'] === 'umbrella' && !$worker['umbrella_org_id']) {
        $add('UMBRELLA_MISSING', 'blocker', 'Umbrella worker has no umbrella company recorded',
            'This worker is set to be paid through an umbrella, but no umbrella company is linked. '
            . 'The pay chain cannot be evidenced and the invoice cannot be matched.',
            'Link the umbrella company on the worker record.');
    }

    if (in_array($worker['engagement_type'], ['limited', 'self_employed'], true)) {
        if (!$worker['ir35_status'] || $worker['ir35_status'] === 'not_assessed') {
            $add('IR35_NOT_ASSESSED', 'warning', 'No IR35 status determination on file',
                'This worker is engaged off-payroll with no status determination recorded. '
                . 'Security officers working under a client’s supervision, direction and control are '
                . 'treated as employed for tax in almost all cases.',
                'Complete a status determination, or move this worker onto PAYE or an umbrella.');
        } elseif ($worker['ir35_status'] === 'inside') {
            $add('IR35_INSIDE', 'warning', 'Worker assessed as inside IR35',
                'PAYE and NIC must be operated on payments to this worker.',
                'Ensure deductions are being made through the correct pay route.');
        }
    }

    // --- Working time --------------------------------------------------------
    $weekMinutes = wtr_weekly_minutes($db, $workerId, week_ending($atDate));
    if ($weekMinutes > WTR_WEEKLY_LIMIT_MINUTES && !(int) $worker['wtr_opt_out']) {
        $add('WTR_OVER_48', 'warning',
            'Scheduled ' . round($weekMinutes / 60) . ' hours this week with no 48-hour opt-out',
            'The Working Time Regulations limit average weekly working time to 48 hours unless the '
            . 'worker has signed an opt-out.',
            'Obtain a signed opt-out, or reduce the hours allocated this week.');
    }

    $blockers = array_values(array_filter($findings, fn($f) => $f['severity'] === 'blocker'));
    $warnings = array_values(array_filter($findings, fn($f) => $f['severity'] === 'warning'));

    return [
        'workerId' => $workerId,
        'workerName' => "{$worker['first_name']} {$worker['last_name']}",
        'atDate' => $atDate,
        'findings' => $findings,
        'blockers' => $blockers,
        'warnings' => $warnings,
        'placeable' => count($blockers) === 0,
    ];
}

function ensure_screening_rows(PDO $db, string $workerId): void {
    $now = now_instant();
    foreach (BS7858_ELEMENTS as $element) {
        q($db, "INSERT OR IGNORE INTO screening_checks (id, worker_id, element, status, created_at, updated_at)
                VALUES (?,?,?,'not_started',?,?)", [new_id('scr'), $workerId, $element, $now, $now]);
    }
}

function set_screening_element(PDO $db, string $workerId, string $element, string $status, array $opts = []): void {
    $now = now_instant();
    $before = row($db, 'SELECT * FROM screening_checks WHERE worker_id = ? AND element = ?', [$workerId, $element]);

    q($db, "INSERT INTO screening_checks
              (id, worker_id, element, status, completed_on, covers_from, covers_to, verified_by, notes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(worker_id, element) DO UPDATE SET
              status = excluded.status,
              completed_on = excluded.completed_on,
              covers_from = COALESCE(excluded.covers_from, screening_checks.covers_from),
              covers_to = COALESCE(excluded.covers_to, screening_checks.covers_to),
              verified_by = COALESCE(excluded.verified_by, screening_checks.verified_by),
              notes = COALESCE(excluded.notes, screening_checks.notes),
              updated_at = excluded.updated_at",
        [new_id('scr'), $workerId, $element, $status,
         $status === 'satisfied' ? today_iso() : null,
         $opts['coversFrom'] ?? null, $opts['coversTo'] ?? null,
         $opts['verifiedBy'] ?? null, $opts['notes'] ?? null, $now, $now]);

    record_audit($db, [
        'entityType' => 'worker', 'entityId' => $workerId, 'action' => 'screening_updated',
        'summary' => 'BS 7858 — ' . (BS7858_LABELS[$element] ?? $element) . " set to $status",
        'actor' => $opts['actor'] ?? 'system',
        'before' => $before, 'after' => ['element' => $element, 'status' => $status] + $opts,
    ]);
}

/** Dashboard feed: everything expiring or overdue across the workforce. */
function expiring_compliance(PDO $db, int $withinDays = 60): array {
    $horizon = add_days(today_iso(), $withinDays);

    $licences = rows($db, "SELECT w.id AS worker_id, w.first_name, w.last_name, l.licence_number, l.sector, l.expires_on
        FROM worker_licences l JOIN workers w ON w.id = l.worker_id
        WHERE l.status = 'valid' AND l.expires_on <= ? AND w.status IN ('active','onboarding')
        ORDER BY l.expires_on ASC", [$horizon]);

    $rtw = rows($db, "SELECT w.id AS worker_id, w.first_name, w.last_name, r.expires_on, r.recheck_due_on
        FROM worker_rtw r JOIN workers w ON w.id = r.worker_id
        WHERE r.outcome = 'time_limited' AND (r.expires_on <= ? OR r.recheck_due_on <= ?)
          AND w.status IN ('active','onboarding')
        ORDER BY r.expires_on ASC", [$horizon, $horizon]);

    $awr = rows($db, 'SELECT a.worker_id, w.first_name, w.last_name, a.assignment_id, asg.title,
              MAX(a.cumulative) AS weeks
        FROM awr_weeks a
        JOIN workers w ON w.id = a.worker_id
        JOIN assignments asg ON asg.id = a.assignment_id
        GROUP BY a.worker_id, a.assignment_id
        HAVING weeks >= ' . AWR_WARNING_AT_WEEK . '
        ORDER BY weeks DESC');

    $screening = rows($db, "SELECT w.id AS worker_id, w.first_name, w.last_name, COUNT(s.id) AS satisfied
        FROM workers w
        LEFT JOIN screening_checks s ON s.worker_id = w.id AND s.status IN ('satisfied','waived')
        WHERE w.status IN ('active','onboarding')
        GROUP BY w.id
        HAVING COUNT(s.id) < " . count(BS7858_ELEMENTS));

    return [
        'asOf' => today_iso(),
        'licencesExpiring' => $licences,
        'rightToWorkExpiring' => $rtw,
        'awrApproaching' => array_map(fn($r) => $r + [
            'qualified' => (int) $r['weeks'] >= AWR_QUALIFYING_WEEKS,
            'weeksRemaining' => max(0, AWR_QUALIFYING_WEEKS - (int) $r['weeks']),
        ], $awr),
        'screeningIncomplete' => $screening,
    ];
}
