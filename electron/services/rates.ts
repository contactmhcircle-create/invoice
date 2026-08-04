import type { Db } from '../db/connection.js';
import { newId } from '../db/connection.js';
import { applyMultiplier } from '../../shared/money.js';
import { isWeekend, nowInstant } from '../../shared/dates.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Rate resolution.
 *
 * Cerviz negotiates every contract separately, so nothing here is global. A rate
 * is looked up through a fallback chain and the first match wins:
 *
 *     shift override  ->  assignment  ->  site  ->  client
 *
 * Rate banding (night/weekend/bank holiday) and uplifts are per-assignment and
 * default to off, so a simple flat-rate contract stays simple while a complex
 * one is still expressible. Whatever resolves is snapshotted onto the shift, so
 * a later rate change never retrospectively alters what a worked shift was worth.
 */

export type RateBand = 'standard' | 'night' | 'weekend' | 'bank_holiday' | 'overtime';

export interface ResolvedRate {
  chargeRatePence: number;
  payRatePence: number;
  band: RateBand;
  /** Which rule produced this rate — shown in the UI so a rate is never a mystery. */
  source: string;
}

/** Night work is 23:00–06:00 under the Working Time Regulations. */
export function isNightShift(startsAt: string, endsAt: string): boolean {
  const startHour = new Date(startsAt).getHours();
  const endHour = new Date(endsAt).getHours();
  return startHour >= 22 || startHour < 6 || endHour <= 6;
}

export function determineBand(
  startsAt: string,
  endsAt: string,
  isBankHoliday: boolean,
  useBands: boolean,
): RateBand {
  if (!useBands) return 'standard';
  if (isBankHoliday) return 'bank_holiday';
  const date = startsAt.slice(0, 10);
  if (isWeekend(date)) return 'weekend';
  if (isNightShift(startsAt, endsAt)) return 'night';
  return 'standard';
}

function lookup(
  db: Db,
  scope: 'client' | 'site' | 'assignment',
  scopeId: string,
  band: RateBand,
  on: IsoDate,
) {
  return db
    .prepare(
      `SELECT * FROM rates
       WHERE scope = ? AND scope_id = ? AND band = ?
         AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to >= ?)
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(scope, scopeId, band, on, on) as any | undefined;
}

export interface RateContext {
  assignmentId: string;
  siteId?: string | null;
  clientOrgId: string;
  band: RateBand;
  on: IsoDate;
  chargeOverridePence?: number | null;
  payOverridePence?: number | null;
}

export function resolveRate(db: Db, ctx: RateContext): ResolvedRate | null {
  // 1. Explicit override on the shift always wins.
  if (ctx.chargeOverridePence != null && ctx.payOverridePence != null) {
    return {
      chargeRatePence: ctx.chargeOverridePence,
      payRatePence: ctx.payOverridePence,
      band: ctx.band,
      source: 'Shift override',
    };
  }

  const chain: Array<{ scope: 'assignment' | 'site' | 'client'; id: string | null; label: string }> = [
    { scope: 'assignment', id: ctx.assignmentId, label: 'Assignment rate' },
    { scope: 'site', id: ctx.siteId ?? null, label: 'Site default' },
    { scope: 'client', id: ctx.clientOrgId, label: 'Client default' },
  ];

  for (const link of chain) {
    if (!link.id) continue;

    let row = lookup(db, link.scope, link.id, ctx.band, ctx.on);
    let sourceLabel = `${link.label} (${ctx.band.replace(/_/g, ' ')})`;

    // Fall back to the standard band if no band-specific rate exists at this level.
    if (!row && ctx.band !== 'standard') {
      row = lookup(db, link.scope, link.id, 'standard', ctx.on);
      sourceLabel = `${link.label} (standard rate, no ${ctx.band.replace(/_/g, ' ')} rate set)`;
    }

    if (row) {
      let charge = row.charge_rate_pence;
      let pay = row.pay_rate_pence;

      // Bank holiday multiplier, where the assignment defines one and no explicit
      // bank holiday rate was found.
      if (ctx.band === 'bank_holiday' && sourceLabel.includes('standard rate')) {
        const asg = db
          .prepare('SELECT bank_holiday_multiplier FROM assignments WHERE id = ?')
          .get(ctx.assignmentId) as any;
        if (asg?.bank_holiday_multiplier) {
          charge = applyMultiplier(charge, asg.bank_holiday_multiplier);
          pay = applyMultiplier(pay, asg.bank_holiday_multiplier);
          sourceLabel += ` x${asg.bank_holiday_multiplier}`;
        }
      }

      return {
        chargeRatePence: ctx.chargeOverridePence ?? charge,
        payRatePence: ctx.payOverridePence ?? pay,
        band: ctx.band,
        source: sourceLabel,
      };
    }
  }

  // Partial override with no underlying rate still beats failing outright.
  if (ctx.chargeOverridePence != null || ctx.payOverridePence != null) {
    return {
      chargeRatePence: ctx.chargeOverridePence ?? 0,
      payRatePence: ctx.payOverridePence ?? 0,
      band: ctx.band,
      source: 'Shift override (partial)',
    };
  }

  return null;
}

export function setRate(
  db: Db,
  input: {
    scope: 'client' | 'site' | 'assignment';
    scopeId: string;
    band?: RateBand;
    chargeRatePence: number;
    payRatePence: number;
    effectiveFrom: IsoDate;
    effectiveTo?: IsoDate | null;
    notes?: string;
  },
): string {
  const id = newId('rate');
  db.prepare(
    `INSERT INTO rates (id, scope, scope_id, band, charge_rate_pence, pay_rate_pence,
                        effective_from, effective_to, notes, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.scope,
    input.scopeId,
    input.band ?? 'standard',
    input.chargeRatePence,
    input.payRatePence,
    input.effectiveFrom,
    input.effectiveTo ?? null,
    input.notes ?? null,
    nowInstant(),
  );
  return id;
}

/** Margin in pence per hour, and as a percentage of the charge rate. */
export function marginOf(chargeRatePence: number, payRatePence: number) {
  const marginPence = chargeRatePence - payRatePence;
  const marginPercent = chargeRatePence > 0 ? (marginPence / chargeRatePence) * 100 : 0;
  return { marginPence, marginPercent: Math.round(marginPercent * 10) / 10 };
}
