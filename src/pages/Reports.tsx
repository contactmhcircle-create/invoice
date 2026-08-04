import React, { useState } from 'react';
import { useQuery, call, money, ukDate, todayIso, addDays } from '../lib/api.js';
import { Loading, Empty, Field, ErrorNote } from '../components/ui.js';

export default function Reports() {
  const [from, setFrom] = useState(addDays(todayIso(), -90));
  const [to, setTo] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);

  const { data: margin, loading } = useQuery<any>('reports:margin', { from, to });
  const { data: pl } = useQuery<any>('reports:profitAndLoss', { from, to });
  const { data: aged } = useQuery<any>('invoices:agedDebtors');
  const { data: tb } = useQuery<any>('reports:trialBalance');
  const { data: recon } = useQuery<any>('tide:reconciliation');

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Reports &amp; margin</div>
          <div className="page-sub">
            What each client and assignment actually earns, and whether the bank agrees with the documents.
          </div>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => act(() => call('tide:import'))}>Import Tide CSV</button>
          <button className="btn" onClick={() => act(() => call('export:salesCsv', { from, to }))}>Export sales</button>
          <button className="btn" onClick={() => act(() => call('export:ledgerCsv', { from, to }))}>Export ledger</button>
        </div>
      </div>

      <ErrorNote error={error} />

      <div className="filters">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Charged to clients</div>
          <div className="tile-value">{money(margin?.totalChargePence)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Cost of labour</div>
          <div className="tile-value">{money(margin?.totalPayPence)}</div>
        </div>
        <div className="tile ok">
          <div className="tile-label">Gross margin</div>
          <div className="tile-value">{money(margin?.totalMarginPence)}</div>
          <div className="tile-note">{margin?.marginPercent ?? 0}% of charge</div>
        </div>
        <div className={`tile ${tb && !tb.balanced ? 'danger' : 'ok'}`}>
          <div className="tile-label">Ledger</div>
          <div className="tile-value">{tb?.balanced ? 'Balanced' : 'Out'}</div>
          <div className="tile-note">{money(tb?.totalDebitsPence)} each side</div>
        </div>
      </div>

      {recon && recon.unmatchedTransactions.length > 0 && (
        <div className="alert warn">
          <strong>{recon.unmatchedTransactions.length} unmatched bank transaction(s)</strong>
          {recon.message} {money(recon.totalUnmatchedInPence)} in and {money(recon.totalUnmatchedOutPence)} out
          have no document behind them.
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><div className="card-title">Margin by client</div></div>
          <div className="card-body tight">
            {loading ? <Loading /> : !margin?.byClient?.length ? (
              <Empty>No billed work in this period.</Empty>
            ) : (
              <table>
                <thead>
                  <tr><th>Client</th><th className="num">Hours</th><th className="num">Charged</th><th className="num">Margin</th><th className="num">£/hr</th></tr>
                </thead>
                <tbody>
                  {margin.byClient.map((c: any) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="num">{c.hours}</td>
                      <td className="num">{money(c.charge)}</td>
                      <td className="num">
                        {money(c.marginPence)}
                        <div className="small muted">{c.marginPercent}%</div>
                      </td>
                      <td className="num">
                        <span className={`badge ${c.marginPerHourPence < 200 ? 'red' : c.marginPerHourPence < 350 ? 'amber' : 'green'}`}>
                          {money(c.marginPerHourPence)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Margin by assignment</div></div>
          <div className="card-body tight">
            {!margin?.byAssignment?.length ? (
              <Empty>No billed work in this period.</Empty>
            ) : (
              <table>
                <thead>
                  <tr><th>Assignment</th><th className="num">Hours</th><th className="num">Margin</th><th className="num">£/hr</th></tr>
                </thead>
                <tbody>
                  {margin.byAssignment.map((a: any) => (
                    <tr key={a.id}>
                      <td>{a.title}<div className="small muted">{a.client_name}</div></td>
                      <td className="num">{a.hours}</td>
                      <td className="num">{money(a.marginPence)}<div className="small muted">{a.marginPercent}%</div></td>
                      <td className="num">
                        <span className={`badge ${a.marginPerHourPence < 200 ? 'red' : a.marginPerHourPence < 350 ? 'amber' : 'green'}`}>
                          {money(a.marginPerHourPence)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Profit and loss</div></div>
        <div className="card-body">
          {pl ? (
            <table>
              <tbody>
                <tr><td>Revenue</td><td className="num">{money(pl.totalIncomePence)}</td></tr>
                <tr><td>Cost of sales — labour</td><td className="num">({money(pl.totalCostOfSalesPence)})</td></tr>
                <tr style={{ fontWeight: 650 }}>
                  <td>Gross profit</td>
                  <td className="num">{money(pl.grossProfitPence)} ({pl.grossMarginPercent}%)</td>
                </tr>
                <tr><td>Overheads</td><td className="num">({money(pl.totalOverheadsPence)})</td></tr>
                <tr style={{ fontWeight: 700, fontSize: 15 }}>
                  <td>Net profit</td><td className="num">{money(pl.netProfitPence)}</td>
                </tr>
              </tbody>
            </table>
          ) : <Loading />}
        </div>
        <div className="chain-note">
          This ledger exists so the app can show true margin and produce a self-contained enquiry pack.
          Your books live in Tide — this reconciles to them rather than replacing them.
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Aged debtors</div></div>
        <div className="card-body tight">
          {!aged?.byClient?.length ? <Empty>Nothing outstanding.</Empty> : (
            <table>
              <thead>
                <tr>
                  <th>Client</th><th className="num">Current</th><th className="num">1–30</th>
                  <th className="num">31–60</th><th className="num">61–90</th><th className="num">90+</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {aged.byClient.map((c: any) => (
                  <tr key={c.clientId}>
                    <td>{c.clientName}</td>
                    <td className="num">{money(c.current)}</td>
                    <td className="num">{money(c.days1to30)}</td>
                    <td className="num">{money(c.days31to60)}</td>
                    <td className="num">{money(c.days61to90)}</td>
                    <td className="num">{c.over90 > 0 ? <span className="badge red">{money(c.over90)}</span> : money(c.over90)}</td>
                    <td className="num"><strong>{money(c.total)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
