import React, { useState, useEffect, useCallback } from 'react';
import { fetchMe, useQuery, logout, setSessionLostHandler, type CurrentUser } from './lib/api.js';
import Login from './pages/Login.js';
import Account, { TwoFactor } from './pages/Account.js';
import Users from './pages/Users.js';
import Dashboard from './pages/Dashboard.js';
import Workers from './pages/Workers.js';
import Rota from './pages/Rota.js';
import Timesheets from './pages/Timesheets.js';
import Invoices from './pages/Invoices.js';
import Purchases from './pages/Purchases.js';
import Clients from './pages/Clients.js';
import Reports from './pages/Reports.js';
import Statutory from './pages/Statutory.js';
import Settings from './pages/Settings.js';

type PageId =
  | 'dashboard' | 'workers' | 'rota' | 'clients' | 'timesheets' | 'invoices'
  | 'purchases' | 'reports' | 'statutory' | 'settings' | 'users' | 'account';

interface NavEntry {
  id: PageId;
  label: string;
  /** Hidden entirely when the signed-in role lacks this. */
  needs?: string;
  badge?: (s: any) => { count: number; tone?: 'warn' } | null;
}

const NAV: Array<{ group: string; items: NavEntry[] }> = [
  {
    group: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard' },
      {
        id: 'workers', label: 'Workers & compliance', needs: 'workers.read',
        badge: (s) => {
          const n = (s?.licencesExpiring ?? 0) + (s?.rtwExpiring ?? 0) + (s?.screeningIncomplete ?? 0);
          return n > 0 ? { count: n } : null;
        },
      },
      {
        id: 'rota', label: 'Rota & shifts', needs: 'rota.read',
        badge: (s) => (s?.unfilledShifts > 0 ? { count: s.unfilledShifts, tone: 'warn' } : null),
      },
      { id: 'clients', label: 'Clients & assignments', needs: 'clients.read' },
    ],
  },
  {
    group: 'Money',
    items: [
      {
        id: 'timesheets', label: 'Timesheets', needs: 'timesheets.read',
        badge: (s) => (s?.unbilledCount > 0 ? { count: s.unbilledCount, tone: 'warn' } : null),
      },
      { id: 'invoices', label: 'Sales invoices', needs: 'invoices.read' },
      {
        id: 'purchases', label: 'Purchases & self-bills', needs: 'purchases.read',
        badge: (s) => {
          const n = (s?.queriedPurchases ?? 0) + (s?.disputedSelfBills ?? 0);
          return n > 0 ? { count: n } : null;
        },
      },
      { id: 'reports', label: 'Reports & margin', needs: 'reports.read' },
    ],
  },
  {
    group: 'Administration',
    items: [
      {
        id: 'statutory', label: 'Statutory & filings', needs: 'statutory.read',
        badge: (s) => {
          const late = (s?.filings ?? []).filter((f: any) => f.overdue).length
            + (s?.intermediary ?? []).filter((i: any) => i.overdue).length;
          return late > 0 ? { count: late } : null;
        },
      },
      { id: 'users', label: 'Users & access', needs: 'users.manage' },
      { id: 'settings', label: 'Settings', needs: 'settings.read' },
      { id: 'account', label: 'My account' },
    ],
  },
];

export default function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(true);

  const reloadMe = useCallback(async () => {
    setMe(await fetchMe());
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => setMe(null));
    fetchMe().then((u) => { setMe(u); setChecking(false); });
  }, []);

  if (checking) {
    return <div className="auth-screen"><div className="spinner">Loading…</div></div>;
  }

  if (!me) return <Login onSignedIn={(u) => setMe(u)} />;

  // Two hard gates before any business data loads.
  if (me.mustChangePassword) return <ForcedPasswordChange me={me} onDone={reloadMe} />;
  if (!me.totpEnabled) return <ForcedTwoFactor me={me} onDone={reloadMe} />;

  return <Shell me={me} onChanged={reloadMe} />;
}

function Shell({ me, onChanged }: { me: CurrentUser; onChanged: () => void }) {
  const [page, setPage] = useState<PageId>('dashboard');
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: summary, refresh } = useQuery<any>('dashboard:summary');

  const allowed = (entry: NavEntry) => !entry.needs || me.capabilities.includes(entry.needs)
    // Read capabilities are not in the summary list the server returns, so
    // anything not explicitly granted falls back to role-independent pages.
    || ['dashboard', 'account'].includes(entry.id);

  const groups = NAV
    .map((g) => ({ ...g, items: g.items.filter(allowed) }))
    .filter((g) => g.items.length > 0);

  const Page = {
    dashboard: Dashboard, workers: Workers, rota: Rota, timesheets: Timesheets,
    invoices: Invoices, purchases: Purchases, clients: Clients, reports: Reports,
    statutory: Statutory, settings: Settings,
    users: (props: any) => <Users me={me} {...props} />,
    account: (props: any) => <Account me={me} onChanged={onChanged} {...props} />,
  }[page];

  return (
    <div className={`app${menuOpen ? ' menu-open' : ''}`}>
      <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
        {menuOpen ? '✕' : '☰'}
      </button>

      <nav className="sidebar">
        <div className="sidebar-brand">
          Cerviz Back Office
          <small>Staffing compliance &amp; billing</small>
        </div>

        {groups.map((group) => (
          <div className="nav-group" key={group.group}>
            <div className="nav-group-label">{group.group}</div>
            {group.items.map((item) => {
              const badge = item.badge?.(summary);
              return (
                <button
                  key={item.id}
                  className={`nav-item${page === item.id ? ' active' : ''}`}
                  onClick={() => { setPage(item.id); setMenuOpen(false); }}
                >
                  <span>{item.label}</span>
                  {badge && (
                    <span className={`nav-badge${badge.tone === 'warn' ? ' warn' : ''}`}>{badge.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}

        {summary && summary.auditChainOk === false && (
          <div className="sidebar-alert">
            <strong>Audit trail broken.</strong> Check Settings immediately.
          </div>
        )}

        <div className="sidebar-user">
          <div className="stack">
            <strong>{me.name}</strong>
            <span className="small">{roleLabel(me.role)}</span>
          </div>
          <button className="link-button" onClick={() => logout().then(() => window.location.reload())}>
            Sign out
          </button>
        </div>
      </nav>

      <main className="main" onClick={() => menuOpen && setMenuOpen(false)}>
        <Page onChange={refresh} summary={summary} />
      </main>
    </div>
  );
}

function roleLabel(role: string): string {
  return {
    owner: 'Owner', compliance: 'Compliance & vetting', scheduler: 'Scheduler',
    finance: 'Finance', readonly: 'Read only',
  }[role] ?? role;
}

function ForcedPasswordChange({ me, onDone }: { me: CurrentUser; onDone: () => void }) {
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    try {
      const { call } = await import('./lib/api.js');
      await call('me:changePassword', { currentPassword: current, newPassword: next });
      // Changing the password ends every session, this one included.
      window.location.reload();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">Choose a new password<small>Signed in as {me.email}</small></div>
        <div className="alert info" style={{ marginBottom: 14 }}>
          Your account was created with a temporary password. Choose your own before continuing.
        </div>
        {error && <div className="alert danger" style={{ marginBottom: 14 }}>{error}</div>}
        <div className="field">
          <label>Temporary password</label>
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus required />
        </div>
        <div className="field">
          <label>New password</label>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          <div className="hint">At least 12 characters. Length matters more than symbols.</div>
        </div>
        <div className="field">
          <label>Confirm new password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </div>
        <button className="btn primary auth-submit" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Set password'}
        </button>
      </form>
    </div>
  );
}

function ForcedTwoFactor({ me, onDone }: { me: CurrentUser; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="auth-screen wide">
      <div className="auth-card wide">
        <div className="auth-brand">Set up two-factor authentication<small>Signed in as {me.email}</small></div>
        {error && <div className="alert danger">{error}</div>}
        <TwoFactor me={me} onChanged={onDone} onError={setError} forced />
        <button
          className="link-button"
          style={{ marginTop: 16 }}
          onClick={() => logout().then(() => window.location.reload())}
        >
          Sign out instead
        </button>
      </div>
    </div>
  );
}
