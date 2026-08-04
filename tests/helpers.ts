import { openDatabase, newId } from '../electron/db/connection.js';
import type { Db } from '../electron/db/connection.js';
import { nowInstant, addDays, today } from '../shared/dates.js';
import { ensureScreeningRows, setScreeningElement, BS7858_ELEMENTS } from '../electron/services/compliance.js';
import { setRate } from '../electron/services/rates.js';

/**
 * Test fixtures build against the real schema in memory, so every trigger and
 * constraint that runs in production runs in the tests too.
 */

export function freshDb(): Db {
  return openDatabase(':memory:');
}

export function makeOrg(
  db: Db,
  opts: Partial<{
    name: string;
    isClient: boolean;
    isUmbrella: boolean;
    companyNumber: string;
    vatNumber: string;
    paymentTermsDays: number;
    poRequired: boolean;
    country: string;
  }> = {},
): string {
  const id = newId('org');
  const now = nowInstant();
  db.prepare(
    `INSERT INTO organisations (id, name, company_number, vat_number, is_client, is_umbrella,
       country, payment_terms_days, po_required, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    opts.name ?? 'Test Agency Ltd',
    opts.companyNumber ?? '12345678',
    opts.vatNumber ?? null,
    opts.isClient === false ? 0 : opts.isUmbrella ? 0 : 1,
    opts.isUmbrella ? 1 : 0,
    opts.country ?? 'United Kingdom',
    opts.paymentTermsDays ?? 30,
    opts.poRequired ? 1 : 0,
    now,
    now,
  );
  return id;
}

export function makeWorker(
  db: Db,
  opts: Partial<{
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    engagementType: string;
    umbrellaOrgId: string;
    payRatePence: number;
    status: string;
    fullyCompliant: boolean;
    licenceExpiry: string;
    licenceSector: string;
  }> = {},
): string {
  const id = newId('wkr');
  const now = nowInstant();
  const engagementType = opts.engagementType ?? 'umbrella';

  // An umbrella worker must have an umbrella linked, so fixtures provide one
  // unless the test is deliberately exercising the incomplete case.
  let umbrellaOrgId = opts.umbrellaOrgId ?? null;
  if (engagementType === 'umbrella' && !umbrellaOrgId && opts.fullyCompliant !== false) {
    umbrellaOrgId = makeOrg(db, { name: 'Test Umbrella Ltd', isUmbrella: true, isClient: false });
  }

  db.prepare(
    `INSERT INTO workers (id, first_name, last_name, date_of_birth, engagement_type, umbrella_org_id,
       default_pay_rate_pence, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    opts.firstName ?? 'Test',
    opts.lastName ?? 'Officer',
    opts.dateOfBirth ?? '1990-01-01',
    engagementType,
    umbrellaOrgId,
    opts.payRatePence ?? 1400,
    opts.status ?? 'active',
    now,
    now,
  );

  ensureScreeningRows(db, id);

  if (opts.fullyCompliant !== false) {
    // SIA licence
    db.prepare(
      `INSERT INTO worker_licences (id, worker_id, sector, licence_number, issued_on, expires_on,
         verified_on, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'valid', ?,?)`,
    ).run(
      newId('lic'),
      id,
      opts.licenceSector ?? 'security_guard',
      '1010' + Math.floor(Math.random() * 100000000),
      addDays(today(), -365),
      opts.licenceExpiry ?? addDays(today(), 365),
      today(),
      now,
      now,
    );

    // Right to work
    db.prepare(
      `INSERT INTO worker_rtw (id, worker_id, method, checked_on, outcome, created_at)
       VALUES (?,?, 'share_code', ?, 'continuous', ?)`,
    ).run(newId('rtw'), id, addDays(today(), -30), now);

    // BS 7858 screening — all elements satisfied
    for (const el of BS7858_ELEMENTS) {
      setScreeningElement(db, id, el, 'satisfied', {
        coversFrom: addDays(today(), -365 * 5 - 2),
        coversTo: today(),
      });
    }

    // Key Information Document
    db.prepare(
      `INSERT INTO key_information_documents (id, worker_id, version, issued_on, engagement_type,
         pay_rate_pence, content_html, created_at)
       VALUES (?,?,1,?,?,?,?,?)`,
    ).run(newId('kid'), id, today(), opts.engagementType ?? 'umbrella', opts.payRatePence ?? 1400, '<p>KID</p>', now);
  }

  return id;
}

export function makeAssignment(
  db: Db,
  clientOrgId: string,
  opts: Partial<{
    title: string;
    requiredLicenceSector: string;
    chargeRatePence: number;
    payRatePence: number;
    startsOn: string;
    minShiftMinutes: number;
    useRateBands: boolean;
  }> = {},
): string {
  const id = newId('asg');
  const now = nowInstant();

  db.prepare(
    `INSERT INTO assignments (id, client_org_id, title, sector, required_licence_sector, starts_on,
       min_shift_minutes, use_rate_bands, status, created_at, updated_at)
     VALUES (?,?,?, 'security', ?,?,?,?, 'active', ?,?)`,
  ).run(
    id,
    clientOrgId,
    opts.title ?? 'Test Site Security',
    opts.requiredLicenceSector ?? 'security_guard',
    opts.startsOn ?? addDays(today(), -30),
    opts.minShiftMinutes ?? null,
    opts.useRateBands ? 1 : 0,
    now,
    now,
  );

  setRate(db, {
    scope: 'assignment',
    scopeId: id,
    chargeRatePence: opts.chargeRatePence ?? 1850,
    payRatePence: opts.payRatePence ?? 1400,
    effectiveFrom: addDays(today(), -365),
  });

  return id;
}
