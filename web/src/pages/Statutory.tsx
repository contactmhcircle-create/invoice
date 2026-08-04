import React, { useState } from 'react';
import { useQuery, call, openDocument, money, ukDate, todayIso, addDays } from '../lib/api.js';
import { Loading, Empty, Modal, Field, ErrorNote } from '../components/ui.js';

/**
 * Deadlines and returns. Cerviz has no accountant at present, so this screen is
 * deliberately explicit about what each obligation is and what happens if it is
 * missed.
 */
export default function Statutory({ onChange }: { onChange: () => void }) {
  const { data: filings, refresh: refreshFilings } = useQuery<any[]>('statutory:filings');
  const { data: intermediary, refresh: refreshInt } = useQuery<any[]>('statutory:intermediaryObligations');
  const { data: vat } = useQuery<any>('reports:vatThreshold');
  const { data: sequence } = useQuery<any>('reports:sequenceAudit', { docType: 'invoice' });
  const { data: chain } = useQuery<any>('audit:verify');
  const [previewing, setPreviewing] = useState<any | null>(null);
  const [packing, setPacking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => { refreshFilings(); refreshInt(); onChange(); };

  const exportReport = async (p: any) => {
    try {
      openDocument(`/api/exports/intermediaries.csv?from=${p.periodFrom}&to=${p.periodTo}`);
      setTimeout(reload, 1500);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Statutory &amp; filings</div>
          <div className="page-sub">
            Every deadline that carries an automatic penalty, plus the evidence pack you would hand over
            if HMRC asked.
          </div>
        </div>
        <button className="btn primary" onClick={() => setPacking(true)}>Build enquiry pack</button>
      </div>

      <ErrorNote error={error} />

      <div className="tiles">
        <div className={`tile ${chain?.ok ? 'ok' : 'danger'}`}>
          <div className="tile-label">Audit trail</div>
          <div className="tile-value">{chain?.ok ? 'Intact' : 'Broken'}</div>
          <div className="tile-note">{chain?.entriesChecked ?? 0} entries hash-chained</div>
        </div>
        <div className={`tile ${sequence?.intact ? 'ok' : 'danger'}`}>
          <div className="tile-label">Invoice sequence</div>
          <div className="tile-value">{sequence?.intact ? 'Gapless' : 'Gaps'}</div>
          <div className="tile-note">
            {sequence?.allocated ?? 0} allocated
            {sequence?.missing?.length ? ` · missing ${sequence.missing.join(', ')}` : ''}
          </div>
        </div>
        <div className={`tile ${vat?.severity === 'ok' ? 'ok' : vat?.severity === 'breached' ? 'danger' : 'warn'}`}>
          <div className="tile-label">VAT threshold</div>
          <div className="tile-value">{vat?.percentOfThreshold ?? 0}%</div>
          <div className="tile-note">{money(vat?.rollingTwelveMonthPence)} rolling 12 months</div>
        </div>
      </div>

      {vat && vat.severity !== 'ok' && (
        <div className={`alert ${vat.severity === 'breached' ? 'danger' : vat.severity === 'urgent' ? 'warn' : 'info'}`}>
          <strong>VAT registration</strong>
          {vat.message}
          <div style={{ marginTop: 6 }} className="small">
            As an employment business you account for VAT on the full charge to the client, including the
            wages element — the staff hire concession was withdrawn in 2009. Your VAT turnover is
            effectively your whole invoiced revenue, so this threshold arrives faster than it would in
            most businesses.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="card-title">Employment intermediaries quarterly report</div>
        </div>
        <div className="card-body tight">
          {!intermediary?.length ? <Loading /> : (
            <table>
              <thead>
                <tr><th>Period</th><th>Due</th><th className="num">Workers</th><th>Status</th><th>What this means</th><th></th></tr>
              </thead>
              <tbody>
                {intermediary.slice(0, 4).map((p) => (
                  <tr key={p.periodTo}>
                    <td className="nowrap">{ukDate(p.periodFrom)} – {ukDate(p.periodTo)}</td>
                    <td className="nowrap">{ukDate(p.dueOn)}</td>
                    <td className="num">{p.workerCount}</td>
                    <td>
                      <span className={`badge ${p.overdue ? 'red' : p.status === 'submitted' || p.status === 'nil_return' ? 'green' : p.daysUntilDue <= 14 ? 'amber' : 'grey'}`}>
                        {p.overdue ? `${Math.abs(p.daysUntilDue)}d late` : String(p.status).replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="small">{p.message}</td>
                    <td className="nowrap">
                      <div className="btn-row">
                        <button className="btn small" onClick={() => setPreviewing(p)}>Preview</button>
                        <button className="btn small primary" onClick={() => exportReport(p)}>Export CSV</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="chain-note">
          As an employment intermediary supplying workers you do not operate PAYE on — which includes
          every umbrella worker — you must report to HMRC each quarter. Periods end 5 Jul, 5 Oct, 5 Jan
          and 5 Apr, each due one month later. Penalties start at £250 and rise to £1,000 for repeated
          failures.
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Companies House and HMRC deadlines</div></div>
        <div className="card-body tight">
          {!filings?.length ? (
            <Empty>Set your incorporation date in Settings to generate the filing calendar.</Empty>
          ) : (
            <table>
              <thead><tr><th>Obligation</th><th>Due</th><th className="num">Days</th><th>Consequence of missing it</th><th></th></tr></thead>
              <tbody>
                {filings.map((f) => (
                  <tr key={f.id}>
                    <td>{f.label}</td>
                    <td className="nowrap">{ukDate(f.dueOn)}</td>
                    <td className="num">
                      <span className={`badge ${f.overdue ? 'red' : f.daysUntilDue <= 30 ? 'amber' : 'grey'}`}>
                        {f.overdue ? `${Math.abs(f.daysUntilDue)} late` : f.daysUntilDue}
                      </span>
                    </td>
                    <td className="small muted">{f.notes}</td>
                    <td>
                      <button
                        className="btn small"
                        onClick={() => call('statutory:markFilingSubmitted', { id: f.id }).then(reload)}
                      >
                        Mark filed
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {previewing && (
        <IntermediaryPreview period={previewing} onClose={() => setPreviewing(null)} />
      )}
      {packing && <EnquiryPack onClose={() => setPacking(false)} />}
    </div>
  );
}

function IntermediaryPreview({ period, onClose }: { period: any; onClose: () => void }) {
  const { data: rows, loading } = useQuery<any[]>('statutory:intermediaryReport', {
    from: period.periodFrom, to: period.periodTo,
  });

  return (
    <Modal title={`Intermediaries report — ${ukDate(period.periodFrom)} to ${ukDate(period.periodTo)}`} onClose={onClose} wide>
      {loading ? <Loading /> : !rows?.length ? (
        <div className="alert warn">
          <strong>No reportable workers in this period</strong>
          A nil return is still required once you have started reporting — HMRC treats silence as a missed
          return.
        </div>
      ) : (
        <table>
          <thead>
            <tr><th>Worker</th><th>NI number</th><th>Engagement</th><th>Intermediary</th><th className="num">Paid</th><th>Reason no PAYE</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.workerFirstName} {r.workerLastName}</td>
                <td className="mono">{r.workerNiNumber ?? <span className="badge red">missing</span>}</td>
                <td className="small nowrap">{ukDate(r.engagementStartDate)} – {ukDate(r.engagementEndDate)}</td>
                <td className="small">{r.intermediaryName ?? '—'}</td>
                <td className="num">£{r.paymentToIntermediary.toFixed(2)}</td>
                <td className="small">{r.reasonNoPaye}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function EnquiryPack({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState(addDays(todayIso(), -365));
  const [to, setTo] = useState(todayIso());
  const [pack, setPack] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = async () => {
    setBusy(true);
    try { setPack(await call('enquiryPack:build', { from, to })); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const exportPack = async () => {
    try { openDocument(`/api/enquiry-pack?from=${from}&to=${to}`); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="HMRC enquiry pack"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" onClick={build} disabled={busy}>{busy ? 'Building…' : 'Build'}</button>
          <button className="btn primary" disabled={!pack} onClick={exportPack}>Open full pack</button>
        </>
      }
    >
      <ErrorNote error={error} />
      <p className="small muted" style={{ marginBottom: 12 }}>
        Everything for a date range: invoices, the timesheets behind them, the signed scans, the workers
        who did the work, their compliance at the time, the money in and out, the supply chain for each
        assignment, and a statement that the audit trail is intact. Run it on yourself before anyone else
        does.
      </p>

      <div className="filters">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {pack && (
        <>
          <div className={`alert ${pack.integrity.auditChain.ok ? 'ok' : 'danger'}`}>
            <strong>
              {pack.integrity.auditChain.ok
                ? `Audit trail verified — ${pack.integrity.auditChain.entriesChecked} entries intact`
                : 'Audit trail broken'}
            </strong>
            {pack.integrity.auditChain.ok
              ? 'Every entry cryptographically seals the one before it, so no historic record has been altered or removed.'
              : pack.integrity.auditChain.reason}
          </div>

          {pack.gaps.length > 0 ? (
            <div className="alert warn">
              <strong>{pack.gaps.length} point(s) to address before anyone asks</strong>
              <ul>{pack.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}</ul>
            </div>
          ) : (
            <div className="alert ok"><strong>No gaps detected in this period.</strong></div>
          )}

          <div className="grid cols-4" style={{ marginBottom: 14 }}>
            <div><div className="tile-label">Invoices</div><strong>{pack.summary.invoiceCount}</strong></div>
            <div><div className="tile-label">Invoiced net</div><strong>{money(pack.summary.totalNetPence)}</strong></div>
            <div><div className="tile-label">Workers</div><strong>{pack.summary.workerCount}</strong></div>
            <div><div className="tile-label">Shifts</div><strong>{pack.summary.shiftCount}</strong></div>
            <div><div className="tile-label">Hours</div><strong>{pack.summary.totalHours}</strong></div>
            <div><div className="tile-label">Received</div><strong>{money(pack.summary.totalReceivedPence)}</strong></div>
            <div><div className="tile-label">Labour cost</div><strong>{money(pack.summary.totalPurchasePence)}</strong></div>
            <div><div className="tile-label">Margin</div><strong>{money(pack.margin.totalMarginPence)}</strong></div>
          </div>
        </>
      )}
    </Modal>
  );
}
