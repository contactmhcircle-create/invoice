/**
 * Date helpers. All dates are ISO strings: YYYY-MM-DD for dates, and full
 * ISO-8601 with Z for instants. Nothing in this app stores a Date object or a
 * timestamp integer — text dates sort correctly in SQLite and read correctly in
 * an export handed to HMRC.
 */

export type IsoDate = string;    // YYYY-MM-DD
export type IsoInstant = string; // YYYY-MM-DDTHH:MM:SS.sssZ

export function nowInstant(): IsoInstant {
  return new Date().toISOString();
}

export function today(): IsoDate {
  return new Date().toISOString().slice(0, 10);
}

export function toDate(iso: IsoDate): Date {
  return new Date(`${iso}T00:00:00Z`);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: IsoDate, months: number): IsoDate {
  const d = toDate(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);
}

/** True if `date` falls on or after `from` and on or before `to` (either may be null). */
export function withinRange(date: IsoDate, from: IsoDate | null, to: IsoDate | null): boolean {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** The Sunday ending the week containing `date`. UK payroll weeks run Mon–Sun. */
export function weekEnding(date: IsoDate): IsoDate {
  const d = toDate(date);
  const dow = d.getUTCDay();              // 0 = Sunday
  const daysToSunday = dow === 0 ? 0 : 7 - dow;
  return addDays(date, daysToSunday);
}

export function isWeekend(date: IsoDate): boolean {
  const dow = toDate(date).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Minutes between two local ISO datetimes, less any unpaid break. */
export function workedMinutes(startsAt: string, endsAt: string, breakMinutes = 0): number {
  const start = new Date(startsAt).getTime();
  let end = new Date(endsAt).getTime();
  // A shift ending earlier than it starts has crossed midnight.
  if (end < start) end += 86_400_000;
  return Math.max(0, Math.round((end - start) / 60_000) - breakMinutes);
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function hoursDecimal(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

export function formatDateUK(iso: IsoDate | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Age in whole years at a given date — drives the NMW band. */
export function ageAt(dateOfBirth: IsoDate, at: IsoDate): number {
  const dob = toDate(dateOfBirth);
  const on = toDate(at);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = on.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * UK tax quarters for the employment intermediaries report. The reporting
 * periods end 5 Jul, 5 Oct, 5 Jan and 5 Apr; each report is due one month later.
 */
export function intermediaryPeriodFor(date: IsoDate): { from: IsoDate; to: IsoDate; due: IsoDate } {
  const year = parseInt(date.slice(0, 4), 10);
  const periods = [
    { from: `${year - 1}-10-06`, to: `${year}-01-05`, due: `${year}-02-05` },
    { from: `${year}-01-06`, to: `${year}-04-05`, due: `${year}-05-05` },
    { from: `${year}-04-06`, to: `${year}-07-05`, due: `${year}-08-05` },
    { from: `${year}-07-06`, to: `${year}-10-05`, due: `${year}-11-05` },
    { from: `${year}-10-06`, to: `${year + 1}-01-05`, due: `${year + 1}-02-05` },
  ];
  for (const p of periods) {
    if (date >= p.from && date <= p.to) return p;
  }
  return periods[1];
}
