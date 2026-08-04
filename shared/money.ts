/**
 * Money is always handled as integer minor units (pence). Floating point is
 * never used for a monetary value anywhere in this application — 0.1 + 0.2
 * problems in an accounting system are the sort of thing that shows up as an
 * unexplainable penny in a VAT return two years later.
 */

export type Pence = number;

export function poundsToPence(pounds: number | string): Pence {
  const n = typeof pounds === 'string' ? parseFloat(pounds.replace(/[£,\s]/g, '')) : pounds;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function penceToPounds(pence: Pence): number {
  return pence / 100;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
};

export function formatMoney(pence: Pence, currency = 'GBP'): string {
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const whole = Math.floor(abs / 100).toLocaleString('en-GB');
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol}${whole}.${frac}`;
}

/**
 * Charge for a period of work. Rates are per hour in pence; duration is in
 * minutes. Rounding is applied once, at the end, half-up.
 */
export function chargeFor(minutes: number, ratePerHourPence: Pence): Pence {
  return Math.round((minutes * ratePerHourPence) / 60);
}

/** Apply a multiplier (overtime, bank holiday) to an hourly rate. */
export function applyMultiplier(ratePence: Pence, multiplier: number): Pence {
  return Math.round(ratePence * multiplier);
}

/**
 * VAT on a net amount. rate is a percentage (20 for standard rate).
 * HMRC permits rounding down per line, but rounding half-up on the invoice
 * total is the safer and more common treatment, so that is what is used.
 */
export function vatOn(netPence: Pence, ratePercent: number): Pence {
  return Math.round((netPence * ratePercent) / 100);
}

/** Convert to base currency (GBP) at the captured rate. */
export function toBase(pence: Pence, fxRate: number): Pence {
  return Math.round(pence * fxRate);
}

export function sum(values: Pence[]): Pence {
  return values.reduce((a, b) => a + b, 0);
}
