import React from 'react';
import { useQuery, money, ukDate, todayIso } from '../lib/api.js';
import { Loading, Empty } from '../components/ui.js';
import { ColumnChart, LineChart } from '../components/charts.js';

/**
 * The dashboard answers one question: what needs attention today. Everything on
 * it is actionable — nothing here is decoration.
 */
export default function Dashboard({ summary }: { summary: any; onChange: () => void }) {
  const { data, loading } = useQuery<any>('dashboard:summary');
  const { data: risks } = useQuery<any[]>('dashboard:risks');
  const { data: analytics } = useQuery<any>('dashboard:analytics');
  const s = data ?? summary;

  if (loading && !s) return <Loading />;
  if (!s) return <Empty>No data yet.</Empty>;

  const vat = s.vatThreshold;
  const overdueFilings = (s.filings ?? []).filter((f: any) => f.overdue);
  const dueIntermediary = (s.intermediary ?? []).filter((i: any) => i.status === 'due');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-sub">As at {ukDate(s.asOf)}</div>
        </div>
      </div>

      {!s.auditChainOk && (
        <div className="alert danger">
          <strong>Audit trail verification failed</strong>
          The hash chain protecting your records is broken, which means a historic record has been
          altered or removed outside the application. Restore from a backup taken before the break
          and do not rely on the current data for any filing.
        </div>
      )}

      {overdueFilings.length > 0 && (
        <div className="alert danger">
          <strong>{overdueFilings.length} statutory filing(s) overdue</strong>
          <ul>
            {overdueFilings.map((f: any) => (
              <li key={f.id}>{f.label} — was due {ukDate(f.dueOn)}, now {Math.abs(f.daysUntilDue)} days late</li>
            ))}
          </ul>
        </div>
      )}

      {dueIntermediary.map((i: any) => (
        <div key={i.periodTo} className={`alert ${i.overdue ? 'danger' : i.daysUntilDue <= 14 ? 'warn' : 'info'}`}>
          <strong>Employment intermediaries report — period to {ukDate(i.periodTo)}</strong>
          {i.message}
        </div>
      ))}

      {vat && vat.severity !== 'ok' && (
        <div className={`alert ${vat.severity === 'breached' ? 'danger' : vat.severity === 'urgent' ? 'warn' : 'info'}`}>
          <strong>VAT registration threshold</strong>
          {vat.message}
          <div className={`progress ${vat.percentOfThreshold >= 90 ? 'danger' : vat.percentOfThreshold >= 75 ? 'warn' : ''}`}>
            <div style={{ width: `${Math.min(100, vat.percentOfThreshold)}%` }} />
          </div>
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Owed to Cerviz</div>
          <div className="tile-value">{money(s.outstandingPence)}</div>
          <div className="tile-note">{money(s.overduePence)} of it overdue</div>
        </div>
        <div className={`tile ${s.unbilledCount > 0 ? 'warn' : 'ok'}`}>
          <div className="tile-label">Approved but not billed</div>
          <div className="tile-value">{money(s.unbilledPence)}</div>
          <div className="tile-note">{s.unbilledCount} timesheet(s) ready to invoice</div>
        </div>
        <div className={`tile ${s.unfilledShifts > 0 ? 'warn' : 'ok'}`}>
          <div className="tile-label">Unfilled shifts</div>
          <div className="tile-value">{s.unfilledShifts}</div>
          <div className="tile-note">In the next 14 days</div>
        </div>
        <div className={`tile ${s.licencesExpiring > 0 ? 'danger' : 'ok'}`}>
          <div className="tile-label">SIA licences expiring</div>
          <div className="tile-value">{s.licencesExpiring}</div>
          <div className="tile-note">Within 60 days</div>
        </div>
        <div className={`tile ${s.screeningIncomplete > 0 ? 'danger' : 'ok'}`}>
          <div className="tile-label">Screening incomplete</div>
          <div className="tile-value">{s.screeningIncomplete}</div>
          <div className="tile-note">BS 7858 elements outstanding</div>
        </div>
        <div className={`tile ${s.awrQualified > 0 ? 'warn' : ''}`}>
          <div className="tile-label">AWR 12-week clock</div>
          <div className="tile-value">{s.awrQualified}</div>
          <div className="tile-note">{s.awrApproaching} more approaching week 12</div>
        </div>
      </div>

      {analytics?.months && (
        <div className="grid cols-2">
          <div className="card">
            <div className="card-head"><div className="card-title">Invoiced per month</div></div>
            <div className="card-body">
              <ColumnChart
                points={analytics.months.map((m: any) => ({ label: m.month, values: [m.invoicedPence] }))}
                seriesName="Invoiced (net)"
              />
            </div>
          </div>
          <div className="card">
            <div className="card-head"><div className="card-title">Charge vs pay per month</div></div>
            <div className="card-body">
              <LineChart
                points={analytics.months.map((m: any) => ({ label: m.month, values: [m.chargePence, m.payPence] }))}
                seriesNames={['Charged to clients', 'Paid for labour']}
              />
            </div>
            <div className="chain-note">The gap between the lines is the gross margin, from approved timesheets.</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="card-title">Risk monitor</div>
          {risks && <span className="small muted">{risks.length ? `${risks.length} finding(s)` : 'all clear'}</span>}
        </div>
        <div className="card-body tight">
          {!risks ? <Loading /> : risks.length === 0 ? (
            <Empty>Nothing needs attention — every monitored risk is clear.</Empty>
          ) : (
            <div>
              {risks.map((r, i) => (
                <div key={i} className={`finding ${r.severity === 'critical' ? 'blocker' : r.severity === 'warning' ? 'warning' : 'info'}`}>
                  <div className="finding-title">
                    <span className={`badge ${r.severity === 'critical' ? 'red' : r.severity === 'warning' ? 'amber' : 'grey'}`}>{r.area}</span>{' '}
                    {r.title}
                  </div>
                  <div className="finding-detail">{r.detail} <strong>{r.action}</strong></div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="chain-note">
          Re-checked on every load, straight from the records: licences, right to work, AWR, minimum wage,
          VAT threshold, debtors, unbilled work, evidence gaps, supply chains, due diligence, duplicates
          and filing deadlines. Every finding is a query you could re-run — nothing is a guess.
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><div className="card-title">SIA licences expiring</div></div>
          <div className="card-body tight">
            {s.compliance?.licencesExpiring?.length ? (
              <table>
                <thead><tr><th>Worker</th><th>Sector</th><th>Licence</th><th>Expires</th></tr></thead>
                <tbody>
                  {s.compliance.licencesExpiring.slice(0, 10).map((l: any) => {
                    const days = Math.round(
                      (new Date(`${l.expires_on}T00:00:00Z`).getTime() - new Date(`${todayIso()}T00:00:00Z`).getTime()) / 86400000,
                    );
                    return (
                      <tr key={`${l.worker_id}-${l.licence_number}`}>
                        <td>{l.first_name} {l.last_name}</td>
                        <td className="small muted">{String(l.sector).replace(/_/g, ' ')}</td>
                        <td className="mono">{l.licence_number}</td>
                        <td className="nowrap">
                          {ukDate(l.expires_on)}{' '}
                          <span className={`badge ${days < 0 ? 'red' : days <= 30 ? 'amber' : 'grey'}`}>
                            {days < 0 ? `${Math.abs(days)}d ago` : `${days}d`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty>No licences expiring in the next 60 days.</Empty>
            )}
          </div>
          <div className="chain-note">
            A worker cannot be allocated to a shift that runs past their licence expiry — allocation is
            blocked, not merely flagged.
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">AWR qualifying clock</div></div>
          <div className="card-body tight">
            {s.compliance?.awrApproaching?.length ? (
              <table>
                <thead><tr><th>Worker</th><th>Assignment</th><th className="num">Weeks</th><th>Status</th></tr></thead>
                <tbody>
                  {s.compliance.awrApproaching.slice(0, 10).map((a: any) => (
                    <tr key={`${a.worker_id}-${a.assignment_id}`}>
                      <td>{a.first_name} {a.last_name}</td>
                      <td className="small">{a.title}</td>
                      <td className="num">{a.weeks}</td>
                      <td>
                        <span className={`badge ${a.qualified ? 'red' : 'amber'}`}>
                          {a.qualified ? 'Qualified — equal treatment applies' : `${a.weeksRemaining} to go`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No workers approaching 12 weeks.</Empty>
            )}
          </div>
          <div className="chain-note">
            At 12 qualifying weeks in the same role, an agency worker becomes entitled to the same basic
            pay and conditions as a comparable direct employee of the hirer.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Upcoming statutory deadlines</div></div>
        <div className="card-body tight">
          {s.filings?.length ? (
            <table>
              <thead><tr><th>Obligation</th><th>Due</th><th className="num">Days</th><th>Why it matters</th></tr></thead>
              <tbody>
                {s.filings.map((f: any) => (
                  <tr key={f.id}>
                    <td>{f.label}</td>
                    <td className="nowrap">{ukDate(f.dueOn)}</td>
                    <td className="num">
                      <span className={`badge ${f.overdue ? 'red' : f.daysUntilDue <= 30 ? 'amber' : 'grey'}`}>
                        {f.overdue ? `${Math.abs(f.daysUntilDue)} late` : f.daysUntilDue}
                      </span>
                    </td>
                    <td className="small muted">{f.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>Set your incorporation date in Settings to generate the filing calendar.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
