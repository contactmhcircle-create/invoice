<?php
/**
 * Date, money and id helpers — a direct port of shared/dates.ts and
 * shared/money.ts. All dates are ISO strings (YYYY-MM-DD for dates, full
 * ISO-8601 UTC for instants); all money is integer pence. Keeping the same
 * representations as the TypeScript original means the same SQL, the same
 * rounding and the same test expectations apply.
 */

declare(strict_types=1);

const UTC = 'UTC';

function now_instant(): string {
    return (new DateTimeImmutable('now', new DateTimeZone(UTC)))->format('Y-m-d\TH:i:s.v\Z');
}

function today_iso(): string {
    return (new DateTimeImmutable('now', new DateTimeZone(UTC)))->format('Y-m-d');
}

function iso_date(string $iso): DateTimeImmutable {
    return new DateTimeImmutable(substr($iso, 0, 10) . 'T00:00:00', new DateTimeZone(UTC));
}

function add_days(string $iso, int $days): string {
    return iso_date($iso)->modify(($days >= 0 ? '+' : '') . $days . ' days')->format('Y-m-d');
}

function add_months(string $iso, int $months): string {
    // Mirror JavaScript setUTCMonth semantics: 31 Jan + 1 month rolls into March.
    $d = iso_date($iso);
    [$y, $m, $day] = array_map('intval', explode('-', $d->format('Y-n-j')));
    $m += $months;
    $y += intdiv($m - 1, 12);
    $m = (($m - 1) % 12 + 12) % 12 + 1;
    $base = new DateTimeImmutable(sprintf('%04d-%02d-01T00:00:00', $y, $m), new DateTimeZone(UTC));
    return $base->modify('+' . ($day - 1) . ' days')->format('Y-m-d');
}

function days_between(string $from, string $to): int {
    $a = iso_date($from)->getTimestamp();
    $b = iso_date($to)->getTimestamp();
    return (int) round(($b - $a) / 86400);
}

/** The Sunday ending the week containing the date. UK payroll weeks run Mon–Sun. */
function week_ending(string $iso): string {
    $dow = (int) iso_date($iso)->format('w'); // 0 = Sunday
    return add_days($iso, $dow === 0 ? 0 : 7 - $dow);
}

function is_weekend(string $iso): bool {
    $dow = (int) iso_date($iso)->format('w');
    return $dow === 0 || $dow === 6;
}

/** Minutes between two local ISO datetimes, less unpaid break; end < start crosses midnight. */
function worked_minutes(string $startsAt, string $endsAt, int $breakMinutes = 0): int {
    $tz = new DateTimeZone(UTC);
    $start = (new DateTimeImmutable($startsAt, $tz))->getTimestamp();
    $end = (new DateTimeImmutable($endsAt, $tz))->getTimestamp();
    if ($end < $start) $end += 86400;
    return max(0, (int) round(($end - $start) / 60) - $breakMinutes);
}

function hours_decimal(int $minutes): float {
    return round($minutes / 60, 2);
}

function format_date_uk(?string $iso): string {
    if (!$iso) return '';
    [$y, $m, $d] = explode('-', substr($iso, 0, 10));
    return "$d/$m/$y";
}

function age_at(string $dateOfBirth, string $at): int {
    $dob = iso_date($dateOfBirth);
    $on = iso_date($at);
    $age = (int) $on->format('Y') - (int) $dob->format('Y');
    if ((int) $on->format('n') < (int) $dob->format('n')
        || ((int) $on->format('n') === (int) $dob->format('n')
            && (int) $on->format('j') < (int) $dob->format('j'))) {
        $age--;
    }
    return $age;
}

/** Employment intermediaries quarters: periods end 5 Jul/5 Oct/5 Jan/5 Apr, due a month later. */
function intermediary_period_for(string $date): array {
    $year = (int) substr($date, 0, 4);
    $periods = [
        ['from' => ($year - 1) . '-10-06', 'to' => "$year-01-05", 'due' => "$year-02-05"],
        ['from' => "$year-01-06", 'to' => "$year-04-05", 'due' => "$year-05-05"],
        ['from' => "$year-04-06", 'to' => "$year-07-05", 'due' => "$year-08-05"],
        ['from' => "$year-07-06", 'to' => "$year-10-05", 'due' => "$year-11-05"],
        ['from' => "$year-10-06", 'to' => ($year + 1) . '-01-05', 'due' => ($year + 1) . '-02-05'],
    ];
    foreach ($periods as $p) {
        if ($date >= $p['from'] && $date <= $p['to']) return $p;
    }
    return $periods[1];
}

// ---------------------------------------------------------------------------
// Money — integer pence everywhere, rounding half-up exactly once
// ---------------------------------------------------------------------------

function charge_for(int $minutes, int $ratePerHourPence): int {
    return (int) round($minutes * $ratePerHourPence / 60);
}

function vat_on(int $netPence, float $ratePercent): int {
    return (int) round($netPence * $ratePercent / 100);
}

function to_base(int $pence, float $fxRate): int {
    return (int) round($pence * $fxRate);
}

function format_money(int $pence, string $currency = 'GBP'): string {
    $symbols = ['GBP' => '£', 'EUR' => '€', 'USD' => '$'];
    $symbol = $symbols[$currency] ?? ($currency . ' ');
    $neg = $pence < 0 ? '-' : '';
    $abs = abs($pence);
    return $neg . $symbol . number_format(intdiv($abs, 100)) . '.' . str_pad((string) ($abs % 100), 2, '0', STR_PAD_LEFT);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

function new_id(string $prefix): string {
    return $prefix . '_' . base_convert((string) (int) (microtime(true) * 1000), 10, 36)
        . bin2hex(random_bytes(4));
}

// ---------------------------------------------------------------------------
// Small conveniences over PDO
// ---------------------------------------------------------------------------

function q(PDO $db, string $sql, array $params = []): PDOStatement {
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt;
}

function row(PDO $db, string $sql, array $params = []): ?array {
    $r = q($db, $sql, $params)->fetch(PDO::FETCH_ASSOC);
    return $r === false ? null : $r;
}

function rows(PDO $db, string $sql, array $params = []): array {
    return q($db, $sql, $params)->fetchAll(PDO::FETCH_ASSOC);
}

function scalar(PDO $db, string $sql, array $params = []): mixed {
    $v = q($db, $sql, $params)->fetchColumn();
    return $v === false ? null : $v;
}
