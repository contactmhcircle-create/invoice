import { useCallback, useEffect, useState } from 'react';

/**
 * HTTP client.
 *
 * Every operation goes through one endpoint, mirroring the shape the interface
 * already used, so the screens needed almost no rewrite when this moved from a
 * desktop app to a server. The session lives in an httpOnly cookie the
 * JavaScript cannot read; the CSRF token is a separate readable cookie echoed
 * back in a header.
 */

export class SessionExpired extends Error {
  constructor() {
    super('Your session has ended. Please sign in again.');
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)cerviz_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

let onSessionLost: (() => void) | null = null;
export function setSessionLostHandler(fn: () => void) {
  onSessionLost = fn;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Cerviz-CSRF': csrfToken(),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401) {
    onSessionLost?.();
    throw new SessionExpired();
  }

  const body = await response.json().catch(() => ({ ok: false, error: 'Unexpected response from the server.' }));
  if (!body.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body.data as T;
}

/** Invoke a named operation. */
export async function call<T = any>(channel: string, payload?: unknown): Promise<T> {
  return request<T>('/api/rpc', {
    method: 'POST',
    body: JSON.stringify({ channel, payload: payload ?? {} }),
  });
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export type RoleId = 'owner' | 'compliance' | 'scheduler' | 'finance' | 'readonly';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: RoleId;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  capabilities: string[];
}

export interface LoginResponse {
  ok: boolean;
  error?: string;
  needsTotp?: boolean;
  reason?: string;
  data?: CurrentUser;
}

export async function login(input: {
  email: string; password: string; totpCode?: string; recoveryCode?: string;
}): Promise<LoginResponse> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return response.json();
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Cerviz-CSRF': csrfToken() },
  });
}

/**
 * Who is signed in, if anyone. Uses the dedicated session endpoint so that being
 * signed out is an ordinary answer rather than an error in the browser console.
 */
export async function fetchMe(): Promise<CurrentUser | null> {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    const body = await response.json();
    return body.ok ? (body.data as CurrentUser | null) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Uploads and downloads
// ---------------------------------------------------------------------------

export async function uploadDocuments(
  entityType: string, entityId: string, category: string, files: FileList | File[],
): Promise<string[]> {
  const form = new FormData();
  form.append('entityType', entityType);
  form.append('entityId', entityId);
  form.append('category', category);
  for (const file of Array.from(files)) form.append('file', file);

  const response = await fetch('/api/documents', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Cerviz-CSRF': csrfToken() },
    body: form,
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

export async function uploadTideStatement(file: File): Promise<any> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/tide/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Cerviz-CSRF': csrfToken() },
    body: form,
  });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

/** Opens a printable document; the browser's own Save as PDF does the rest. */
export function openDocument(path: string): void {
  window.open(path, '_blank', 'noopener');
}

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

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
      .catch((e) => { if (!cancelled && !(e instanceof SessionExpired)) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, nonce, ...deps]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

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

/** Personal data the caller is not permitted to see comes back as dots. */
export const isMasked = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('••');
