import React, { useState } from 'react';
import { useQuery, call, money, ukDate, hours } from '../lib/api.js';
import { Loading, Empty, Modal, Status, Field, ErrorNote, Confirm } from '../components/ui.js';

export default function Invoices({ onChange }: { onChange: () => void }) {
  const { data: invoices, loading, refresh } = useQuery<any[]>('invoices:list');
  const { data: unbilled, refresh: refreshUnbilled } = useQuery<any[]>('timesheets:unbilled');
  const { data: aged } = useQuery<any>('invoices:agedDebtors');
  const [selected, setSelected] = useState<string | null>(null);
  const [billing, setBilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => { refresh(); refreshUnbilled(); onChange(); };

  const unbilledTotal = (unbilled ?? []).reduce((a, t) => a + t.charge_total_pence, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Sales invoices</div>
          <div className="page-sub">
            Built from approved timesheets with a shift-level backing schedule. Numbers are gapless and an
            issued invoice is frozen — corrections go out as credit notes.
          </div>
        </div>
        <button className="btn primary" disabled={!unbilled?.length} onClick={() => setBilling(true)}>
          Bill approved timesheets
        </button>
      </div>

      <ErrorNote error={error} />

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Outstanding</div>
          <div className="tile-value">{money(aged?.totalOutstanding)}</div>
        </div>
        <div className="tile warn">
          <div className="tile-label">1–30 days overdue</div>
          <div className="tile-value">{money(aged?.buckets?.days1to30)}</div>
        </div>
        <div className="tile danger">
          <div className="tile-label">Over 60 days</div>
          <div className="tile-value">{money((aged?.buckets?.days61to90 ?? 0) + (aged?.buckets?.over90 ?? 0))}</div>
        </div>
        <div className={`tile ${unbilledTotal > 0 ? 'warn' : 'ok'}`}>
          <div className="tile-label">Approved, not yet billed</div>
          <div className="tile-value">{money(unbilledTotal)}</div>
          <div className="tile-note">{unbilled?.length ?? 0} timesheet(s)</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">Invoices</div></div>
        <div className="card-body tight">
          {loading ? <Loading /> : !invoices?.length ? (
            <Empty>No invoices yet. Approve some timesheets, then bill them.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Number</th><th>Client</th><th>Issued</th><th>Due</th>
                  <th className="num">Net</th><th className="num">VAT</th><th className="num">Total</th>
                  <th className="num">Outstanding</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => setSelected(i.id)}>
                    <td className="mono">{i.number ?? <span className="muted">draft</span>}</td>
                    <td>{i.client_name}</td>
                    <td className="nowrap">{ukDate(i.issue_date)}</td>
                    <td className="nowrap">{ukDate(i.due_date)}</td>
                    <td className="num">{money(i.net_pence, i.currency)}</td>
                    <td className="num">{i.vat_applied ? money(i.vat_pence, i.currency) : <span className="muted">n/a</span>}</td>
                    <td className="num">{money(i.gross_pence, i.currency)}</td>
                    <td className="num">{money(i.gross_pence - i.paid_pence, i.currency)}</td>
                    <td><Status value={i.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="chain-note">
          Voided invoices keep their number and stay listed. That is what makes the series provably
          gapless rather than merely tidy.
        </div>
      </div>

      {selected && <InvoiceDetail id={selected} onClose={() => setSelected(null)} onChange={reload} />}
      {billing && (
        <BillTimesheets
          unbilled={unbilled ?? []}
          onClose={() => setBilling(false)}
          onDone={(id) => { setBilling(false); reload(); setSelected(id); }}
        />
      )}
    </div>
  );
}

function InvoiceDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: inv, loading, refresh } = useQuery<any>('invoices:get', { id });
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [crediting, setCrediting] = useState(false);

  const reload = () => { refresh(); onChange(); };

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); reload(); } catch (e: any) { setError(e.message); }
  };

  if (loading || !inv) return <Modal title="Invoice" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal
      title={inv.number ?? 'Draft invoice'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn" onClick={() => act(() => call('invoices:pdf', { id }))}>Save PDF</button>
          {inv.status === 'draft' && (
            <button className="btn primary" onClick={() => act(() => call('invoices:issue', { id }))}>
              Issue invoice
            </button>
          )}
          {['issued', 'part_paid', 'overdue'].includes(inv.status) && (
            <>
              <button className="btn" onClick={() => setCrediting(true)}>Credit note</button>
              <button className="btn primary" onClick={() => setPaying(true)}>Record payment</button>
            </>
          )}
          {inv.status !== 'void' && inv.paid_pence === 0 && (
            <button className="btn danger" onClick={() => setVoiding(true)}>Void</button>
          )}
        </>
      }
    >
      <ErrorNote error={error} />

      <div className="row-between" style={{ marginBottom: 14 }}>
        <div className="stack">
          <strong style={{ fontSize: 16 }}>{inv.client_legal_name || inv.client_name}</strong>
          <span className="small muted">
            Issued {ukDate(inv.issue_date)} · due {ukDate(inv.due_date)}
            {inv.po_reference ? ` · PO ${inv.po_reference}` : ''}
          </span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <Status value={inv.status} />
          <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{money(inv.gross_pence, inv.currency)}</div>
          {inv.paid_pence > 0 && (
            <div className="small muted">{money(inv.paid_pence, inv.currency)} paid · {money(inv.outstandingPence, inv.currency)} outstanding</div>
          )}
        </div>
      </div>

      {inv.void_reason && (
        <div className="alert danger"><strong>Voided</strong>{inv.void_reason}</div>
      )}

      {inv.vat_note && <div className="alert info">{inv.vat_note}</div>}

      {inv.lateInterest?.applicable && (
        <div className="alert warn">
          <strong>{inv.lateInterest.daysLate} days late — statutory interest is claimable</strong>
          Interest at {inv.lateInterest.ratePercent}% (Bank of England base plus 8%) comes to{' '}
          {money(inv.lateInterest.interestPence)}, plus fixed compensation of{' '}
          {money(inv.lateInterest.compensationPence)} under the Late Payment of Commercial Debts
          (Interest) Act 1998 — {money(inv.lateInterest.totalClaimablePence)} in total.
        </div>
      )}

      <strong>Lines</strong>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Date</th><th>Description</th><th className="num">Hours</th><th className="num">Rate</th><th className="num">Net</th></tr></thead>
        <tbody>
          {inv.lines.map((l: any) => (
            <tr key={l.id}>
              <td className="nowrap">{ukDate(l.work_date)}</td>
              <td className="small">{l.description}</td>
              <td className="num">{hours(l.quantity_minutes)}</td>
              <td className="num">{money(l.unit_price_pence, inv.currency)}</td>
              <td className="num">{money(l.net_pence, inv.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="divider" />
      <strong>Evidence chain</strong>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>
        Every line above traces to a timesheet, and every timesheet to the paper sheet signed on site.
      </p>
      {inv.backingTimesheets?.length ? (
        <table>
          <thead><tr><th>Timesheet</th><th>Worker</th><th>Week ending</th><th className="num">Hours</th><th>Signed by</th><th>Scan</th></tr></thead>
          <tbody>
            {inv.backingTimesheets.map((t: any) => (
              <tr key={t.id}>
                <td className="mono">{t.reference}</td>
                <td>{t.first_name} {t.last_name}</td>
                <td className="nowrap">{ukDate(t.week_ending)}</td>
                <td className="num">{hours(t.total_minutes)}</td>
                <td className="small">{t.client_signatory ?? '—'} {t.client_signed_on ? `(${ukDate(t.client_signed_on)})` : ''}</td>
                <td>{t.scan_count > 0 ? <span className="badge green">attached</span> : <span className="badge red">missing</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Empty>No backing timesheets linked.</Empty>}

      {inv.payments?.length > 0 && (
        <>
          <div className="divider" />
          <strong>Payments</strong>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Date</th><th className="num">Amount</th><th>Method</th><th>Reference</th></tr></thead>
            <tbody>
              {inv.payments.map((p: any) => (
                <tr key={p.id}>
                  <td>{ukDate(p.paid_on)}</td>
                  <td className="num">{money(p.amount_pence, p.currency)}</td>
                  <td className="small">
                    {String(p.method).replace(/_/g, ' ')}
                    {p.via_director_loan ? <span className="badge amber" style={{ marginLeft: 6 }}>via director account</span> : null}
                  </td>
                  <td className="small">{p.reference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {voiding && (
        <Confirm
          title="Void this invoice"
          message="The invoice keeps its number and stays visible as a void, which is what keeps the series gapless. The timesheets are released so the work can be billed correctly."
          confirmLabel="Void invoice"
          danger
          requireReason
          onCancel={() => setVoiding(false)}
          onConfirm={async (reason) => {
            setVoiding(false);
            await act(() => call('invoices:void', { id, reason }));
          }}
        />
      )}
      {crediting && (
        <Confirm
          title="Raise a credit note"
          message="This credits the invoice in full. The original invoice stays in the record unchanged."
          confirmLabel="Raise credit note"
          requireReason
          onCancel={() => setCrediting(false)}
          onConfirm={async (reason) => {
            setCrediting(false);
            await act(async () => {
              const cnId = await call<string>('invoices:creditNote', { invoiceId: id, reason });
              await call('invoices:issueCreditNote', { id: cnId });
            });
          }}
        />
      )}
      {paying && (
        <RecordPayment
          invoice={inv}
          onClose={() => setPaying(false)}
          onDone={() => { setPaying(false); reload(); }}
        />
      )}
    </Modal>
  );
}

function RecordPayment({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState((invoice.outstandingPence / 100).toFixed(2));
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [viaDirector, setViaDirector] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      const pence = Math.round(parseFloat(amount.replace(/[£,\s]/g, '')) * 100);
      if (!Number.isFinite(pence) || pence <= 0) throw new Error('Enter a valid amount.');
      await call('invoices:recordPayment', {
        invoiceId: invoice.id, paidOn, amountPence: pence, reference, viaDirectorLoan: viaDirector,
      });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Record payment"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Record</button></>}
    >
      <ErrorNote error={error} />
      <div className="grid cols-2">
        <Field label="Amount received"><input type="text" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></Field>
        <Field label="Date received"><input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      </div>
      <Field label="Bank reference"><input type="text" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      <Field
        label=""
        hint="Not illegal, but it must be documented. An undocumented pattern of company income landing in a personal account is what HMRC treats as suspected income diversion — and it should be corrected by changing the bank details the client holds."
      >
        <label className="checkbox">
          <input type="checkbox" checked={viaDirector} onChange={(e) => setViaDirector(e.target.checked)} />
          Received into a director's personal account and passed to the company
        </label>
      </Field>
    </Modal>
  );
}

function BillTimesheets({
  unbilled, onClose, onDone,
}: { unbilled: any[]; onClose: () => void; onDone: (id: string) => void }) {
  const [clientId, setClientId] = useState<string>(unbilled[0]?.client_org_id ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [summarise, setSummarise] = useState(false);
  const [poReference, setPoReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const forClient = unbilled.filter((t) => t.client_org_id === clientId);
  const clients = [...new Map(unbilled.map((t) => [t.client_org_id, t.client_name])).entries()];
  const total = forClient.filter((t) => selected.has(t.id)).reduce((a, t) => a + t.charge_total_pence, 0);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const create = async () => {
    try {
      if (selected.size === 0) throw new Error('Select at least one timesheet.');
      const id = await call<string>('invoices:createFromTimesheets', {
        clientOrgId: clientId,
        timesheetIds: [...selected],
        summarise,
        poReference: poReference || undefined,
      });
      onDone(id);
    } catch (e: any) { setError(e.message); }
  };

  const missingScans = forClient.filter((t) => selected.has(t.id) && t.scan_count === 0);

  return (
    <Modal
      title="Bill approved timesheets"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={selected.size === 0} onClick={create}>
            Create draft invoice ({selected.size})
          </button>
        </>
      }
    >
      <ErrorNote error={error} />

      <Field label="Client">
        <select value={clientId} onChange={(e) => { setClientId(e.target.value); setSelected(new Set()); }}>
          {clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </Field>

      {missingScans.length > 0 && (
        <div className="alert warn">
          <strong>{missingScans.length} selected timesheet(s) have no signed scan</strong>
          The invoice will still be raised, but the enquiry pack will flag it and a client dispute will be
          harder to defend.
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th></th><th>Reference</th><th>Worker</th><th>Assignment</th><th>Week ending</th>
            <th className="num">Hours</th><th className="num">Charge</th><th>Scan</th>
          </tr>
        </thead>
        <tbody>
          {forClient.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => toggle(t.id)}>
              <td><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} /></td>
              <td className="mono">{t.reference}</td>
              <td>{t.first_name} {t.last_name}</td>
              <td className="small">{t.assignment_title}</td>
              <td className="nowrap">{ukDate(t.week_ending)}</td>
              <td className="num">{hours(t.total_minutes)}</td>
              <td className="num">{money(t.charge_total_pence)}</td>
              <td>{t.scan_count > 0 ? <span className="badge green">yes</span> : <span className="badge red">no</span>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 650 }}>
            <td colSpan={6}>Selected total</td>
            <td className="num">{money(total)}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <div className="divider" />
      <Field label="Purchase order reference (if the client requires one)">
        <input type="text" value={poReference} onChange={(e) => setPoReference(e.target.value)} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={summarise} onChange={(e) => setSummarise(e.target.checked)} />
        Summarise to one line per worker per week rather than a line per shift
      </label>
    </Modal>
  );
}
