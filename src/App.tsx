import React, { useState } from 'react';
import { useQuery } from './lib/api.js';
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
  | 'dashboard' | 'workers' | 'rota' | 'timesheets' | 'invoices'
  | 'purchases' | 'clients' | 'reports' | 'statutory' | 'settings';

interface NavEntry {
  id: PageId;
  label: string;
  badge?: (s: any) => { count: number; tone?: 'warn' } | null;
}

const NAV: Array<{ group: string; items: NavEntry[] }> = [
  {
    group: 'Operations',
    items: [
      { id: 'dashboard', label: 'Dashboard' },
      {
        id: 'workers',
        label: 'Workers & compliance',
        badge: (s) => {
          const n = (s?.licencesExpiring ?? 0) + (s?.rtwExpiring ?? 0) + (s?.screeningIncomplete ?? 0);
          return n > 0 ? { count: n } : null;
        },
      },
      {
        id: 'rota',
        label: 'Rota & shifts',
        badge: (s) => (s?.unfilledShifts > 0 ? { count: s.unfilledShifts, tone: 'warn' } : null),
      },
      { id: 'clients', label: 'Clients & assignments' },
    ],
  },
  {
    group: 'Money',
    items: [
      {
        id: 'timesheets',
        label: 'Timesheets',
        badge: (s) => (s?.unbilledCount > 0 ? { count: s.unbilledCount, tone: 'warn' } : null),
      },
      { id: 'invoices', label: 'Sales invoices' },
      {
        id: 'purchases',
        label: 'Purchases & self-bills',
        badge: (s) => {
          const n = (s?.queriedPurchases ?? 0) + (s?.disputedSelfBills ?? 0);
          return n > 0 ? { count: n } : null;
        },
      },
      { id: 'reports', label: 'Reports & margin' },
    ],
  },
  {
    group: 'Compliance',
    items: [
      {
        id: 'statutory',
        label: 'Statutory & filings',
        badge: (s) => {
          const late = (s?.filings ?? []).filter((f: any) => f.overdue).length
            + (s?.intermediary ?? []).filter((i: any) => i.overdue).length;
          return late > 0 ? { count: late } : null;
        },
      },
      { id: 'settings', label: 'Settings' },
    ],
  },
];

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const { data: summary, refresh } = useQuery<any>('dashboard:summary');

  const Page = {
    dashboard: Dashboard,
    workers: Workers,
    rota: Rota,
    timesheets: Timesheets,
    invoices: Invoices,
    purchases: Purchases,
    clients: Clients,
    reports: Reports,
    statutory: Statutory,
    settings: Settings,
  }[page];

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-brand">
          Cerviz Back Office
          <small>Staffing compliance & billing</small>
        </div>

        {NAV.map((group) => (
          <div className="nav-group" key={group.group}>
            <div className="nav-group-label">{group.group}</div>
            {group.items.map((item) => {
              const badge = item.badge?.(summary);
              return (
                <button
                  key={item.id}
                  className={`nav-item${page === item.id ? ' active' : ''}`}
                  onClick={() => setPage(item.id)}
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

        {summary && !summary.auditChainOk && (
          <div style={{ margin: '12px 14px', padding: 10, background: 'rgba(198,40,40,0.25)', borderRadius: 6, fontSize: 12 }}>
            <strong>Audit trail broken.</strong> Check Settings immediately.
          </div>
        )}
      </nav>

      <main className="main">
        <Page onChange={refresh} summary={summary} />
      </main>
    </div>
  );
}
