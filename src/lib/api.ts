import { useCallback, useEffect, useState } from 'react';

/**
 * Thin client over the single IPC channel. Errors from the main process arrive
 * as `{ ok: false, error }` rather than thrown exceptions, so a compliance
 * refusal reads as a message to show the operator rather than a crash.
 */

interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

declare global {
  interface Window {
    cerviz: {
      invoke<T = unknown>(channel: string, payload?: unknown): Promise<IpcResult<T>>;
      platform: string;
    };
  }
}

export async function call<T = any>(channel: string, payload?: unknown): Promise<T> {
  const result = await window.cerviz.invoke<T>(channel, payload);
  if (!result.ok) throw new Error(result.error ?? 'Unknown error');
  return result.data as T;
}

/** Fetches on mount and whenever a dependency changes, with a manual refresh. */
export function useQuery<T = any>(
  channel: string,
  payload?: unknown,
  deps: unknown[] = [],
): { data: T | null; loading: boolean; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const key = JSON.stringify(payload ?? null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    call<T>(channel, payload)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, nonce, ...deps]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

export const money = (pence: number | null | undefined, currency = 'GBP'): string => {
  if (pence == null) return '—';
  const symbols: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };
  const symbol = symbols[currency] ?? `${currency} `;
  const neg = pence < 0;
  const abs = Math.abs(pence);
  return `${neg ? '-' : ''}${symbol}${Math.floor(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
};

export const ukDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

export const hours = (minutes: number | null | undefined): string =>
  minutes == null ? '—' : `${Math.round((minutes / 60) * 100) / 100}`;

export const todayIso = (): string => new Date().toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
