<?php
/**
 * Database open, migrate and seed — the port of core/db/connection.ts.
 *
 * The .sql migration files are the same ones the Node application runs, byte
 * for byte. That matters more than convenience: the triggers that freeze issued
 * invoices and make the audit log append-only are DATABASE rules, so they hold
 * here identically without being re-implemented.
 */

declare(strict_types=1);

function open_database(string $filename): PDO {
    if ($filename !== ':memory:') {
        @mkdir(dirname($filename), 0750, true);
    }

    $db = new PDO('sqlite:' . $filename, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    // Shared hosting runs one PHP process per request, so several requests can
    // hit the file at once. WAL plus a busy timeout is what makes that safe.
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('PRAGMA foreign_keys = ON');
    $db->exec('PRAGMA busy_timeout = 5000');
    $db->exec('PRAGMA synchronous = FULL'); // durability over speed; this is accounting data

    migrate_db($db);
    seed_db($db);
    return $db;
}

function migrations_dir(): string {
    return dirname(__DIR__) . '/migrations';
}

function migrate_db(PDO $db): void {
    $db->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');

    $applied = array_map('intval', array_column(
        rows($db, 'SELECT version FROM schema_migrations'), 'version'));

    $files = glob(migrations_dir() . '/*.sql');
    sort($files);

    foreach ($files as $file) {
        $version = (int) explode('_', basename($file))[0];
        if (in_array($version, $applied, true)) continue;

        $sql = file_get_contents($file);
        $db->exec('BEGIN');
        try {
            $db->exec($sql);
            q($db, 'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)',
                [$version, basename($file), now_instant()]);
            $db->exec('COMMIT');
        } catch (Throwable $e) {
            $db->exec('ROLLBACK');
            throw new RuntimeException('Migration ' . basename($file) . ' failed: ' . $e->getMessage());
        }
    }
}

/** Reference data the app cannot function without. Idempotent. */
function seed_db(PDO $db): void {
    $now = now_instant();

    if (!row($db, 'SELECT 1 FROM company WHERE id = 1')) {
        q($db, "INSERT INTO company (id, legal_name, created_at, updated_at) VALUES (1, 'Cerviz Ltd', ?, ?)",
            [$now, $now]);
    }

    foreach ([
        ['invoice', 'CRV-INV', 4, 1], ['credit_note', 'CRV-CN', 4, 1],
        ['timesheet', 'CRV-TS', 5, 1], ['purchase', 'CRV-PUR', 4, 1],
        ['assignment', 'CRV-ASG', 3, 0], ['worker', 'CRV-W', 4, 0],
    ] as [$type, $prefix, $pad, $year]) {
        q($db, 'INSERT OR IGNORE INTO numbering (doc_type, prefix, next_number, pad_width, include_year, updated_at)
                VALUES (?,?,1,?,?,?)', [$type, $prefix, $pad, $year, $now]);
    }

    foreach ([
        ['1100', 'Trade debtors', 'asset', 1],
        ['1200', 'Business bank account', 'asset', 0],
        ['1210', "Director's loan account", 'liability', 0],
        ['2100', 'Trade creditors', 'liability', 1],
        ['2200', 'VAT control', 'liability', 1],
        ['2210', 'PAYE/NIC control', 'liability', 1],
        ['2220', 'Holiday pay accrual', 'liability', 1],
        ['3000', 'Share capital', 'equity', 0],
        ['3100', 'Retained earnings', 'equity', 0],
        ['4000', 'Revenue — staffing services', 'income', 0],
        ['5000', 'Cost of sales — umbrella labour', 'expense', 0],
        ['5010', 'Cost of sales — PAYE labour', 'expense', 0],
        ['5020', 'Cost of sales — employer NIC', 'expense', 0],
        ['5030', 'Cost of sales — holiday pay', 'expense', 0],
        ['6000', 'Administrative expenses', 'expense', 0],
        ['6100', 'Compliance and screening costs', 'expense', 0],
        ['6200', 'Bank charges', 'expense', 0],
        ['9999', 'Suspense — unreconciled', 'asset', 0],
    ] as [$code, $name, $type, $control]) {
        q($db, 'INSERT OR IGNORE INTO accounts (code, name, type, is_control, created_at) VALUES (?,?,?,?,?)',
            [$code, $name, $type, $control, $now]);
    }

    // National Minimum Wage seed values. EDITABLE in Settings — rates are
    // uprated every April, and getting this table wrong is an enforcement
    // matter, so the interface makes it the user's to maintain.
    foreach ([
        ['2025-04-01', '21_and_over', 1221], ['2025-04-01', '18_to_20', 1000],
        ['2025-04-01', 'under_18', 740], ['2025-04-01', 'apprentice', 740],
        ['2026-04-01', '21_and_over', 1271], ['2026-04-01', '18_to_20', 1065],
        ['2026-04-01', 'under_18', 800], ['2026-04-01', 'apprentice', 800],
    ] as [$from, $band, $rate]) {
        q($db, 'INSERT OR IGNORE INTO nmw_rates (id, effective_from, band, rate_pence, created_at)
                VALUES (?,?,?,?,?)', ["nmw_{$from}_{$band}", $from, $band, $rate, $now]);
    }
}

/** Runs $fn inside a transaction unless one is already open (SQLite does not nest). */
function in_txn(PDO $db, callable $fn): mixed {
    if ($db->inTransaction()) {
        return $fn();
    }
    $db->beginTransaction();
    try {
        $result = $fn();
        $db->commit();
        return $result;
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}
