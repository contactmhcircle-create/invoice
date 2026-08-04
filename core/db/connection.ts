import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowInstant } from '../../shared/dates.js';

export type Db = Database.Database;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Opens the database, applies pending migrations and seeds reference data.
 * `filename` may be ':memory:' — the test suite runs against an in-memory copy
 * of the real schema so that triggers and constraints are exercised for real.
 */
export function openDatabase(filename: string): Db {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const db = new Database(filename);
  db.pragma('journal_mode = WAL');     // survives an unclean shutdown
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');     // durability over speed; this is accounting data

  migrate(db);
  seed(db);
  return db;
}

/**
 * Migrations are plain .sql files, so they have to be findable both when running
 * from source and from a bundle where `here` is the output directory. MIGRATIONS_DIR
 * overrides everything, which is what the container image sets.
 */
function migrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    join(here, 'migrations'),                              // running from source
    join(here, '..', 'migrations'),                        // bundled beside the output
    join(process.cwd(), 'core', 'db', 'migrations'),       // from the project root
    join(process.cwd(), 'migrations'),                     // container working directory
  ].filter(Boolean) as string[];

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `Cannot find the database migrations. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
        'Set MIGRATIONS_DIR to the directory holding the .sql files.',
    );
  }
  return found;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);

  const applied = new Set<number>(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version),
  );

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (applied.has(version)) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    // Each migration is one transaction: it applies completely or not at all.
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)')
        .run(version, file, nowInstant());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

/** Reference data that must exist for the app to function. Idempotent. */
function seed(db: Db): void {
  const now = nowInstant();

  const companyExists = db.prepare('SELECT 1 FROM company WHERE id = 1').get();
  if (!companyExists) {
    db.prepare(
      `INSERT INTO company (id, legal_name, created_at, updated_at) VALUES (1, 'Cerviz Ltd', ?, ?)`,
    ).run(now, now);
  }

  const seq = db.prepare(
    `INSERT OR IGNORE INTO numbering (doc_type, prefix, next_number, pad_width, include_year, updated_at)
     VALUES (?,?,1,?,?,?)`,
  );
  seq.run('invoice', 'CRV-INV', 4, 1, now);
  seq.run('credit_note', 'CRV-CN', 4, 1, now);
  seq.run('timesheet', 'CRV-TS', 5, 1, now);
  seq.run('purchase', 'CRV-PUR', 4, 1, now);
  seq.run('assignment', 'CRV-ASG', 3, 0, now);
  seq.run('worker', 'CRV-W', 4, 0, now);

  seedChartOfAccounts(db, now);
  seedNmwRates(db, now);
}

/**
 * A deliberately small chart of accounts. It exists to produce margin and a
 * self-contained enquiry pack, not to compete with Tide's bookkeeping.
 */
function seedChartOfAccounts(db: Db, now: string): void {
  const rows: Array<[string, string, string, number]> = [
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
  ];
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO accounts (code, name, type, is_control, created_at) VALUES (?,?,?,?,?)',
  );
  for (const [code, name, type, isControl] of rows) stmt.run(code, name, type, isControl, now);
}

/**
 * National Minimum Wage / National Living Wage rates.
 *
 * These are seeded as a starting point only and are EDITABLE in Settings. Rates
 * are uprated every April; check the current figures on GOV.UK and update them
 * there rather than waiting for a new build. NMW enforcement carries penalties
 * of up to 200% of the underpayment plus public naming, so this table being
 * right matters more than almost anything else in the app.
 */
function seedNmwRates(db: Db, now: string): void {
  const rows: Array<[string, string, number]> = [
    ['2025-04-01', '21_and_over', 1221],
    ['2025-04-01', '18_to_20', 1000],
    ['2025-04-01', 'under_18', 740],
    ['2025-04-01', 'apprentice', 740],
    ['2026-04-01', '21_and_over', 1271],
    ['2026-04-01', '18_to_20', 1065],
    ['2026-04-01', 'under_18', 800],
    ['2026-04-01', 'apprentice', 800],
  ];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO nmw_rates (id, effective_from, band, rate_pence, created_at)
     VALUES (?,?,?,?,?)`,
  );
  for (const [from, band, rate] of rows) {
    stmt.run(`nmw_${from}_${band}`, from, band, rate, now);
  }
}

/** Stable, sortable, collision-resistant identifier. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const rand = createHash('sha256')
    .update(`${prefix}${Date.now()}${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `${prefix}_${time}${rand}`;
}
