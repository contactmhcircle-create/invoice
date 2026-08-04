import React, { useState } from 'react';
import { useQuery, call, money, ukDate, todayIso } from '../lib/api.js';
import { Loading, Empty, Modal, Status, Field, MoneyInput, ErrorNote } from '../components/ui.js';

/**
 * Costs in, and self-bills received.
 *
 * Cerviz pays umbrellas rather than running payroll, so the cost of every shift
 * arrives as a purchase invoice. Matching it to the approved timesheets is what
 * catches the umbrella quietly billing 41 hours for a 40-hour week — and the
 * agency above that self-bills a week short.
 */
export default function Purchases({ onChange }: { onChange: () => void }) {
  const [tab, setTab] = useState<'purchases' | 'selfbills'>('purchases');
  const { data: purchases, loading, refresh } = useQuery<any[]>('purchases:list');
  const { data: selfBills, refresh: refreshSb } = useQuery<any[]>('selfBills:list');
  const { data: creditors } = useQuery<any>('purchases:agedCreditors');
  const [addingPurchase, setAddingPurchase] = useState(false);
  const [addingSelfBill, setAddingSelfBill] = useState(false);
  const [match, setMatch] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => { refresh(); refreshSb(); onChange(); };

  const runMatch = async (id: string) => {
    try { setMatch(await call('purchases:match', { id })); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const reconcile = async (id: string) => {
    try { setMatch(await call('selfBills:reconcile', { id })); reload(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Purchases &amp; self-bills</div>
          <div className="page-sub">
            What umbrellas charge you, checked against your own approved timesheets — and what agencies
            self-bill you, checked the same way.
          </div>
        </div>
        <button
          className="btn primary"
          onClick={() => (tab === 'purchases' ? setAddingPurchase(true) : setAddingSelfBill(true))}
        >
          {tab === 'purchases' ? 'Record purchase invoice' : 'Record self-bill'}
        </button>
      </div>

      <ErrorNote error={error} />

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Owed to suppliers</div>
          <div className="tile-value">{money(creditors?.totalOutstandingPence)}</div>
        </div>
        <div className={`tile ${creditors?.queriedCount > 0 ? 'danger' : 'ok'}`}>
          <div className="tile-label">Queried purchase invoices</div>
          <div className="tile-value">{creditors?.queriedCount ?? 0}</div>
          <div className="tile-note">Do not pay until resolved</div>
        </div>
        <div className={`tile ${(selfBills ?? []).filter((s) => s.status === 'disputed').length > 0 ? 'danger' : 'ok'}`}>
          <div className="tile-label">Disputed self-bills</div>
          <div className="tile-value">{(selfBills ?? []).filter((s) => s.status === 'disputed').length}</div>
          <div className="tile-note">Agency figures disagree with ours</div>
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button className={`btn${tab === 'purchases' ? ' primary' : ''}`} onClick={() => setTab('purchases')}>
          Purchase invoices
        </button>
        <button className={`btn${tab === 'selfbills' ? ' primary' : ''}`} onClick={() => setTab('selfbills')}>
          Self-bills received
        </button>
      </div>

      <div className="card">
        <div className="card-body tight">
          {tab === 'purchases' ? (
            loading ? <Loading /> : !purchases?.length ? (
              <Empty>No purchase invoices recorded.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Our ref</th><th>Supplier</th><th>Their ref</th><th>Date</th>
                    <th className="num">Net</th><th className="num">We expected</th><th className="num">Variance</th>
                    <th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.our_reference}</td>
                      <td>{p.supplier}</td>
                      <td className="small">{p.their_reference ?? '—'}</td>
                      <td className="nowrap">{ukDate(p.invoice_date)}</td>
                      <td className="num">{money(p.net_pence)}</td>
                      <td className="num">{p.expected_pence != null ? money(p.expected_pence) : '—'}</td>
                      <td className="num">
                        {p.variance_pence != null ? (
                          <span className={`badge ${Math.abs(p.variance_pence) > 100 ? 'red' : 'green'}`}>
                            {money(p.variance_pence)}
                          </span>
                        ) : '—'}
                      </td>
                      <td><Status value={p.status} /></td>
                      <td className="nowrap">
                        <div className="btn-row">
                          <button className="btn small" onClick={() => runMatch(p.id)}>Match</button>
                          {p.status === 'matched' && (
                            <button className="btn small primary" onClick={() => call('purchases:approve', { id: p.id }).then(reload)}>
                              Approve
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            !selfBills?.length ? (
              <Empty>No self-bills recorded. Add one when an agency sends theirs.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Their ref</th><th>Agency</th><th>Received</th><th>Period</th>
                    <th className="num">They billed</th><th className="num">We expected</th>
                    <th className="num">Variance</th><th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {selfBills.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.their_reference}</td>
                      <td>{s.agency}</td>
                      <td className="nowrap">{ukDate(s.received_on)}</td>
                      <td className="small nowrap">{ukDate(s.period_from)} – {ukDate(s.period_to)}</td>
                      <td className="num">{money(s.their_net_pence)}</td>
                      <td className="num">{s.our_expected_net_pence != null ? money(s.our_expected_net_pence) : '—'}</td>
                      <td className="num">
                        {s.variance_pence != null ? (
                          <span className={`badge ${Math.abs(s.variance_pence) > 100 ? 'red' : 'green'}`}>
                            {money(s.variance_pence)}
                          </span>
                        ) : '—'}
                      </td>
                      <td><Status value={s.status} /></td>
                      <td><button className="btn small" onClick={() => reconcile(s.id)}>Re-check</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </div>

      {match && (
        <Modal title="Reconciliation result" onClose={() => setMatch(null)} wide>
          <div className={`alert ${
            ['exact', 'within_tolerance', 'agreed'].includes(match.status) ? 'ok'
              : match.status === 'no_expectation' || match.status === 'unmatched' ? 'warn' : 'danger'}`}>
            <strong>{String(match.status).replace(/_/g, ' ')}</strong>
            {match.message}
          </div>
          <div className="grid cols-3" style={{ marginBottom: 14 }}>
            <div><div className="tile-label">They billed</div><strong>{money(match.theirNetPence)}</strong></div>
            <div><div className="tile-label">Our records say</div><strong>{money(match.ourExpectedPence ?? match.ourExpectedNetPence)}</strong></div>
            <div><div className="tile-label">Variance</div><strong>{money(match.variancePence)}</strong></div>
          </div>
          {match.detail?.length > 0 && (
            <table>
              <thead><tr><th>Worker</th><th>Week ending</th><th className="num">Our pay</th><th className="num">They billed</th><th className="num">Variance</th></tr></thead>
              <tbody>
                {match.detail.map((d: any, i: number) => (
                  <tr key={i}>
                    <td>{d.workerName}</td>
                    <td className="nowrap">{ukDate(d.weekEnding)}</td>
                    <td className="num">{money(d.ourPayPence)}</td>
                    <td className="num">{d.theirNetPence != null ? money(d.theirNetPence) : <span className="badge amber">not billed</span>}</td>
                    <td className="num">{money(d.variancePence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {match.unmatchedTimesheets?.length > 0 && (
            <>
              <div className="divider" />
              <strong>Timesheets they left off entirely</strong>
              <table style={{ marginTop: 8 }}>
                <thead><tr><th>Timesheet</th><th>Worker</th><th>Week ending</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {match.unmatchedTimesheets.map((t: any) => (
                    <tr key={t.reference}>
                      <td className="mono">{t.reference}</td>
                      <td>{t.worker}</td>
                      <td className="nowrap">{ukDate(t.weekEnding)}</td>
                      <td className="num">{money(t.chargePence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Modal>
      )}

      {addingPurchase && (
        <AddPurchase onClose={() => setAddingPurchase(false)} onDone={() => { setAddingPurchase(false); reload(); }} />
      )}
      {addingSelfBill && (
        <AddSelfBill onClose={() => setAddingSelfBill(false)} onDone={() => { setAddingSelfBill(false); reload(); }} />
      )}
    </div>
  );
}

function AddPurchase({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { data: orgs } = useQuery<any[]>('orgs:list');
  const [form, setForm] = useState<any>({ invoiceDate: todayIso(), category: 'umbrella_labour' });
  const [net, setNet] = useState<number | null>(null);
  const [vat, setVat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      if (!form.organisationId || net == null) throw new Error('Select the supplier and enter the net amount.');
      const id = await call<string>('purchases:create', { ...form, netPence: net, vatPence: vat ?? 0 });
      await call('purchases:match', { id });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Record purchase invoice"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Record and match</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Supplier">
        <select value={form.organisationId ?? ''} onChange={set('organisationId')}>
          <option value="">Select…</option>
          {orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
      <div className="grid cols-2">
        <Field label="Their invoice reference"><input type="text" onChange={set('theirReference')} /></Field>
        <Field label="Invoice date"><input type="date" value={form.invoiceDate} onChange={set('invoiceDate')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Period from" hint="Used to find the timesheets this should match.">
          <input type="date" onChange={set('periodFrom')} />
        </Field>
        <Field label="Period to"><input type="date" onChange={set('periodTo')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Net amount"><MoneyInput valuePence={net} onChange={setNet} /></Field>
        <Field label="VAT"><MoneyInput valuePence={vat} onChange={setVat} /></Field>
      </div>
      <Field label="Category">
        <select value={form.category} onChange={set('category')}>
          <option value="umbrella_labour">Umbrella labour</option>
          <option value="paye_labour">PAYE labour</option>
          <option value="compliance">Compliance and screening</option>
          <option value="overhead">Overhead</option>
        </select>
      </Field>
    </Modal>
  );
}

function AddSelfBill({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { data: orgs } = useQuery<any[]>('orgs:list', { isClient: true });
  const [form, setForm] = useState<any>({ receivedOn: todayIso() });
  const [net, setNet] = useState<number | null>(null);
  const [vat, setVat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      if (!form.organisationId || !form.theirReference || net == null) {
        throw new Error('Agency, their reference and the net amount are all required.');
      }
      await call('selfBills:record', { ...form, theirNetPence: net, theirVatPence: vat ?? 0 });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Record a self-bill received"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Record and reconcile</button></>}
    >
      <ErrorNote error={error} />
      <div className="alert info">
        The agency raises this invoice on your behalf. Your job is to check their figures against your own
        approved timesheets — an agency under-billing itself in its own favour is routine, and nobody else
        is going to notice.
      </div>
      <Field label="Agency">
        <select value={form.organisationId ?? ''} onChange={set('organisationId')}>
          <option value="">Select…</option>
          {orgs?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
      <div className="grid cols-2">
        <Field label="Their reference"><input type="text" onChange={set('theirReference')} /></Field>
        <Field label="Received on"><input type="date" value={form.receivedOn} onChange={set('receivedOn')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Period from"><input type="date" onChange={set('periodFrom')} /></Field>
        <Field label="Period to"><input type="date" onChange={set('periodTo')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Net they billed"><MoneyInput valuePence={net} onChange={setNet} /></Field>
        <Field label="VAT"><MoneyInput valuePence={vat} onChange={setVat} /></Field>
      </div>
    </Modal>
  );
}
