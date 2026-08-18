import React, { useState } from 'react';
import { useQuery, call, money, ukDate, todayIso } from '../lib/api.js';
import { Loading, Empty, Modal, Status, Field, MoneyInput, ErrorNote, Confirm } from '../components/ui.js';

const CHAIN_ROLES = [
  ['end_client', 'End client — whose site the officers work on'],
  ['upper_agency', 'Agency above Cerviz'],
  ['cerviz', 'Cerviz Ltd'],
  ['umbrella', 'Umbrella company'],
  ['worker', 'Worker'],
  ['other', 'Other party'],
];

export default function Clients({ onChange }: { onChange: () => void }) {
  const { data: orgs, loading, refresh } = useQuery<any[]>('orgs:list');
  const { data: assignments, refresh: refreshAsg } = useQuery<any[]>('assignments:list');
  const [tab, setTab] = useState<'orgs' | 'assignments'>('orgs');
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [selectedAsg, setSelectedAsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingAsg, setAddingAsg] = useState(false);

  const reload = () => { refresh(); refreshAsg(); onChange(); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Clients &amp; assignments</div>
          <div className="page-sub">
            Counterparty records with due diligence evidence, and the supply chain map for each assignment
            — the first document HMRC asks a labour supplier to produce.
          </div>
        </div>
        <button className="btn primary" onClick={() => (tab === 'orgs' ? setAdding(true) : setAddingAsg(true))}>
          {tab === 'orgs' ? 'Add organisation' : 'New assignment'}
        </button>
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button className={`btn${tab === 'orgs' ? ' primary' : ''}`} onClick={() => setTab('orgs')}>Organisations</button>
        <button className={`btn${tab === 'assignments' ? ' primary' : ''}`} onClick={() => setTab('assignments')}>Assignments</button>
      </div>

      <div className="card">
        <div className="card-body tight">
          {tab === 'orgs' ? (
            loading ? <Loading /> : !orgs?.length ? (
              <Empty>No organisations yet. Add the agencies you supply and the umbrellas you pay.</Empty>
            ) : (
              <table>
                <thead>
                  <tr><th>Name</th><th>Company no.</th><th>VAT no.</th><th>Roles</th><th>Terms</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {orgs.map((o) => (
                    <tr key={o.id} className="clickable" onClick={() => setSelectedOrg(o.id)}>
                      <td><strong>{o.name}</strong></td>
                      <td className="mono">{o.company_number ?? <span className="muted">—</span>}</td>
                      <td className="mono">{o.vat_number ?? <span className="muted">—</span>}</td>
                      <td className="small">
                        {[o.is_client && 'client', o.is_umbrella && 'umbrella', o.is_end_client && 'end client',
                          o.is_supplier && 'supplier'].filter(Boolean).join(', ')}
                        {o.self_bills_us ? <span className="badge blue" style={{ marginLeft: 6 }}>self-bills</span> : null}
                      </td>
                      <td className="small">{o.payment_terms_days} days</td>
                      <td><Status value={o.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : (
            !assignments?.length ? (
              <Empty>No assignments yet.</Empty>
            ) : (
              <table>
                <thead>
                  <tr><th>Assignment</th><th>Client</th><th>Licence required</th><th>Starts</th><th className="num">Upcoming shifts</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => setSelectedAsg(a.id)}>
                      <td><strong>{a.title}</strong><div className="small muted">{a.reference}</div></td>
                      <td>{a.client_name}</td>
                      <td className="small">{a.required_licence_sector ? String(a.required_licence_sector).replace(/_/g, ' ') : <span className="muted">any</span>}</td>
                      <td className="nowrap">{ukDate(a.starts_on)}</td>
                      <td className="num">{a.upcoming_shifts}</td>
                      <td><Status value={a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </div>

      {selectedOrg && <OrgDetail id={selectedOrg} onClose={() => setSelectedOrg(null)} onChange={reload} />}
      {selectedAsg && <AssignmentDetail id={selectedAsg} onClose={() => setSelectedAsg(null)} onChange={reload} />}
      {adding && <AddOrg onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {addingAsg && (
        <AddAssignment orgs={orgs ?? []} onClose={() => setAddingAsg(false)} onDone={() => { setAddingAsg(false); reload(); }} />
      )}
    </div>
  );
}

function OrgDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: org, loading, refresh } = useQuery<any>('orgs:get', { id });
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (loading || !org) return <Modal title="Organisation" onClose={onClose}><Loading /></Modal>;

  const dd = org.dueDiligence;

  return (
    <Modal
      title={org.name}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn danger" onClick={() => setDeleting(true)}>Delete</button>
        </>
      }
    >
      <ErrorNote error={error} />

      <div className={`alert ${dd.complete ? 'ok' : dd.failed.length ? 'danger' : 'warn'}`}>
        <strong>Supply chain due diligence</strong>
        {dd.riskNote}
        {dd.missing.length > 0 && <ul>{dd.missing.map((m: string) => <li key={m}>{m}</li>)}</ul>}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div>
          <div className="tile-label">Company number</div>
          <div className="mono">{org.company_number ?? '—'}</div>
        </div>
        <div>
          <div className="tile-label">VAT number</div>
          <div className="mono">{org.vat_number ?? '—'}</div>
        </div>
      </div>

      <div className="row-between" style={{ marginBottom: 10 }}>
        <strong>Checks performed</strong>
        <button className="btn small" onClick={() => setChecking(true)}>Record a check</button>
      </div>
      {dd.checks.length ? (
        <table>
          <thead><tr><th>Check</th><th>Performed</th><th>By</th><th>Outcome</th><th>Review due</th></tr></thead>
          <tbody>
            {dd.checks.map((c: any) => (
              <tr key={c.id}>
                <td className="small">{String(c.check_type).replace(/_/g, ' ')}</td>
                <td className="nowrap">{ukDate(c.performed_on)}</td>
                <td className="small">{c.performed_by ?? '—'}</td>
                <td><Status value={c.outcome === 'pass' ? 'satisfied' : c.outcome} /></td>
                <td className="nowrap small">{ukDate(c.next_review_on)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Empty>No checks recorded for this counterparty.</Empty>}

      {org.assignments?.length > 0 && (
        <>
          <div className="divider" />
          <strong>Assignments</strong>
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Title</th><th>Starts</th><th>Status</th></tr></thead>
            <tbody>
              {org.assignments.map((a: any) => (
                <tr key={a.id}><td>{a.title}</td><td>{ukDate(a.starts_on)}</td><td><Status value={a.status} /></td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {checking && (
        <RecordCheck
          orgId={id}
          onClose={() => setChecking(false)}
          onDone={() => { setChecking(false); refresh(); onChange(); }}
        />
      )}
      {deleting && (
        <Confirm
          title={`Delete ${org.name}`}
          message="An organisation with nothing linked to it — no invoices, assignments, workers or payments — is deleted outright, with a snapshot kept in the audit trail. If anything is on record the deletion is refused, and the right move is to set it to closed instead."
          confirmLabel="Delete organisation"
          danger
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            setDeleting(false);
            try { await call('orgs:delete', { id }); onChange(); onClose(); }
            catch (e: any) { setError(e.message); }
          }}
        />
      )}
    </Modal>
  );
}

function RecordCheck({ orgId, onClose, onDone }: { orgId: string; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState<any>({ checkType: 'companies_house', outcome: 'pass', performedOn: todayIso() });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try { await call('orgs:recordDueDiligence', { ...form, organisationId: orgId }); onDone(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Record a due diligence check"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Record check</button></>}
    >
      <ErrorNote error={error} />
      <div className="alert info">
        Under the Kittel principle HMRC can deny VAT recovery and pursue you for fraud elsewhere in your
        supply chain where you "knew or should have known". Documented checks are the defence.
      </div>
      <Field label="Check type">
        <select value={form.checkType} onChange={set('checkType')}>
          <option value="companies_house">Companies House registration verified</option>
          <option value="vat_number">VAT number verified</option>
          <option value="insurance">Insurance certificates seen</option>
          <option value="contract">Signed contract / terms on file</option>
          <option value="credit">Credit check</option>
          <option value="licence">Licence or accreditation verified</option>
          <option value="site_visit">Site visit</option>
          <option value="other">Other</option>
        </select>
      </Field>
      <div className="grid cols-2">
        <Field label="Performed on"><input type="date" value={form.performedOn} onChange={set('performedOn')} /></Field>
        <Field label="Outcome">
          <select value={form.outcome} onChange={set('outcome')}>
            <option value="pass">Pass</option>
            <option value="query">Query raised</option>
            <option value="fail">Fail</option>
            <option value="not_applicable">Not applicable</option>
          </select>
        </Field>
      </div>
      <Field label="Reference" hint="What you actually checked — the company number, VAT number, policy number.">
        <input type="text" onChange={set('reference')} />
      </Field>
      <Field label="Notes"><textarea onChange={set('notes')} /></Field>
    </Modal>
  );
}

function AssignmentDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: a, loading, refresh } = useQuery<any>('assignments:get', { id });
  const { data: orgs } = useQuery<any[]>('orgs:list');
  const [editingChain, setEditingChain] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading || !a) return <Modal title="Assignment" onClose={onClose}><Loading /></Modal>;

  const paye = a.supplyChain?.payeResponsibility;

  return (
    <Modal
      title={a.title}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn danger" onClick={() => setDeleting(true)}>Delete</button>
        </>
      }
    >
      <ErrorNote error={error} />

      <div className="row-between" style={{ marginBottom: 14 }}>
        <div className="stack">
          <strong>{a.client_name}{a.site_name ? ` · ${a.site_name}` : ''}</strong>
          <span className="small muted">
            {a.reference} · from {ukDate(a.starts_on)}
            {a.required_licence_sector ? ` · requires SIA ${String(a.required_licence_sector).replace(/_/g, ' ')}` : ''}
          </span>
        </div>
        <Status value={a.status} />
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Fill rate (last/next 4 weeks)</div>
          <div className="tile-value">{a.fillRate.fillRatePercent}%</div>
          <div className="tile-note">{a.fillRate.filled} of {a.fillRate.total} filled · {a.fillRate.noShows} no-show(s)</div>
        </div>
      </div>

      <strong>Rates</strong>
      <p className="small muted" style={{ margin: '4px 0 8px' }}>
        Rates resolve shift override → assignment → site → client. The first match wins, so nothing here
        is global.
      </p>
      {a.rates?.length ? (
        <table>
          <thead><tr><th>Band</th><th className="num">Charge</th><th className="num">Pay</th><th className="num">Margin</th><th>From</th></tr></thead>
          <tbody>
            {a.rates.map((r: any) => (
              <tr key={r.id}>
                <td className="small">{String(r.band).replace(/_/g, ' ')}</td>
                <td className="num">{money(r.charge_rate_pence)}</td>
                <td className="num">{money(r.pay_rate_pence)}</td>
                <td className="num">
                  {money(r.charge_rate_pence - r.pay_rate_pence)}
                  <div className="small muted">
                    {Math.round(((r.charge_rate_pence - r.pay_rate_pence) / r.charge_rate_pence) * 1000) / 10}%
                  </div>
                </td>
                <td className="nowrap">{ukDate(r.effective_from)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <Empty>No rates set for this assignment.</Empty>}

      <div className="divider" />

      <div className="row-between" style={{ marginBottom: 8 }}>
        <strong>Labour supply chain</strong>
        <button className="btn small" onClick={() => setEditingChain(true)}>
          {a.supplyChain?.links?.length ? 'Edit chain' : 'Map the chain'}
        </button>
      </div>

      {paye && (
        <div className={`alert ${paye.responsibility === 'cerviz' ? 'warn' : paye.responsibility === 'unclear' ? 'danger' : 'info'}`}>
          <strong>{paye.summary}</strong>
          {paye.detail}
          {paye.actions?.length > 0 && <ul>{paye.actions.map((x: string) => <li key={x}>{x}</li>)}</ul>}
        </div>
      )}

      {a.supplyChain?.links?.length ? (
        <table>
          <thead><tr><th>#</th><th>Role</th><th>Party</th><th>Company no.</th><th>Due diligence</th></tr></thead>
          <tbody>
            {a.supplyChain.links.map((l: any) => (
              <tr key={l.id}>
                <td className="num">{l.position}</td>
                <td className="small">{String(l.role).replace(/_/g, ' ')}</td>
                <td>{l.organisation_name ?? l.description ?? '—'}</td>
                <td className="mono">{l.company_number ?? '—'}</td>
                <td>
                  {l.dueDiligence
                    ? l.dueDiligence.complete
                      ? <span className="badge green">complete</span>
                      : <span className="badge red">{l.dueDiligence.missing.length} missing</span>
                    : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="alert warn">
          No supply chain recorded. Without it, PAYE responsibility for umbrella workers on this
          assignment cannot be determined, and the enquiry pack will flag it as a gap.
        </div>
      )}

      {editingChain && (
        <EditChain
          assignmentId={id}
          orgs={orgs ?? []}
          existing={a.supplyChain?.links ?? []}
          onClose={() => setEditingChain(false)}
          onDone={() => { setEditingChain(false); refresh(); onChange(); }}
        />
      )}
      {deleting && (
        <Confirm
          title={`Delete ${a.title}`}
          message="An assignment with no shifts, timesheets or invoices behind it is deleted outright, with a snapshot kept in the audit trail. Once work has been rostered against it the deletion is refused — set it to ended instead."
          confirmLabel="Delete assignment"
          danger
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            setDeleting(false);
            try { await call('assignments:delete', { id }); onChange(); onClose(); }
            catch (e: any) { setError(e.message); }
          }}
        />
      )}
    </Modal>
  );
}

function EditChain({
  assignmentId, orgs, existing, onClose, onDone,
}: { assignmentId: string; orgs: any[]; existing: any[]; onClose: () => void; onDone: () => void }) {
  const [links, setLinks] = useState<any[]>(
    existing.length
      ? existing.map((l) => ({ role: l.role, organisationId: l.organisation_id, description: l.description }))
      : [{ role: 'end_client', organisationId: '', description: '' }, { role: 'cerviz', description: 'Cerviz Ltd' }],
  );
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: any) => setLinks(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => setLinks(links.filter((_, j) => j !== i));
  const add = () => setLinks([...links, { role: 'upper_agency', organisationId: '', description: '' }]);

  const save = async () => {
    try { await call('supplyChain:set', { assignmentId, links }); onDone(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Map the labour supply chain"
      onClose={onClose}
      wide
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save chain</button></>}
    >
      <ErrorNote error={error} />
      <div className="alert info">
        List the chain from the top down: the end client whose site the officers work on, then anyone
        between them and Cerviz, then Cerviz, then any umbrella. This determines where PAYE responsibility
        for umbrella workers falls, and it is the first record HMRC asks a labour supplier to produce.
      </div>

      {links.map((l, i) => (
        <div key={i} className="card" style={{ marginBottom: 10 }}>
          <div className="card-body">
            <div className="row-between" style={{ marginBottom: 8 }}>
              <strong>Position {i}</strong>
              <button className="btn small" onClick={() => remove(i)}>Remove</button>
            </div>
            <div className="grid cols-2">
              <Field label="Role">
                <select value={l.role} onChange={(e) => update(i, { role: e.target.value })}>
                  {CHAIN_ROLES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </Field>
              <Field label="Organisation" hint="Leave blank and use the description if they are not a saved record.">
                <select value={l.organisationId ?? ''} onChange={(e) => update(i, { organisationId: e.target.value })}>
                  <option value="">—</option>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Description">
              <input type="text" value={l.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} />
            </Field>
          </div>
        </div>
      ))}

      <button className="btn" onClick={add}>Add a party</button>
    </Modal>
  );
}

function AddOrg({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState<any>({ is_client: true, payment_terms_days: 30, country: 'United Kingdom' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async () => {
    try {
      if (!form.name) throw new Error('Name is required.');
      await call('orgs:save', form);
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Add organisation"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Add</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Name"><input type="text" onChange={set('name')} autoFocus /></Field>
      <div className="grid cols-2">
        <Field label="Company number" hint="Verify it on Companies House and record the check.">
          <input type="text" onChange={set('company_number')} />
        </Field>
        <Field label="VAT number"><input type="text" onChange={set('vat_number')} /></Field>
      </div>
      <Field label="Roles">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label className="checkbox"><input type="checkbox" checked={!!form.is_client} onChange={set('is_client')} /> Client we supply</label>
          <label className="checkbox"><input type="checkbox" checked={!!form.is_umbrella} onChange={set('is_umbrella')} /> Umbrella company</label>
          <label className="checkbox"><input type="checkbox" checked={!!form.is_end_client} onChange={set('is_end_client')} /> End client</label>
        </div>
      </Field>
      <div className="grid cols-2">
        <Field label="Payment terms (days)">
          <input type="number" value={form.payment_terms_days} onChange={set('payment_terms_days')} />
        </Field>
        <Field label="Currency">
          <select value={form.currency ?? 'GBP'} onChange={set('currency')}>
            <option value="GBP">GBP</option><option value="EUR">EUR</option><option value="USD">USD</option>
          </select>
        </Field>
      </div>
      <Field label="Address">
        <input type="text" placeholder="Line 1" onChange={set('address_1')} style={{ marginBottom: 6 }} />
        <input type="text" placeholder="City" onChange={set('city')} style={{ marginBottom: 6 }} />
        <input type="text" placeholder="Postcode" onChange={set('postcode')} />
      </Field>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <label className="checkbox"><input type="checkbox" onChange={set('self_bills_us')} /> They self-bill us</label>
        <label className="checkbox"><input type="checkbox" onChange={set('po_required')} /> PO required on invoices</label>
      </div>
    </Modal>
  );
}

function AddAssignment({ orgs, onClose, onDone }: { orgs: any[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState<any>({
    starts_on: todayIso(), sector: 'security', required_licence_sector: 'security_guard',
  });
  const [charge, setCharge] = useState<number | null>(null);
  const [pay, setPay] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      if (!form.client_org_id || !form.title) throw new Error('Client and title are required.');
      await call('assignments:save', { ...form, charge_rate_pence: charge, pay_rate_pence: pay });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  const margin = charge && pay ? charge - pay : null;

  return (
    <Modal
      title="New assignment"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Create assignment</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Client">
        <select value={form.client_org_id ?? ''} onChange={set('client_org_id')}>
          <option value="">Select…</option>
          {orgs.filter((o) => o.is_client).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </Field>
      <Field label="Title" hint="How this appears on invoices, e.g. 'Riverside Depot — night cover'.">
        <input type="text" onChange={set('title')} />
      </Field>
      <div className="grid cols-2">
        <Field label="Required SIA sector" hint="Allocation is blocked for workers without a valid licence in this sector.">
          <select value={form.required_licence_sector} onChange={set('required_licence_sector')}>
            <option value="">Any</option>
            <option value="security_guard">Security guard</option>
            <option value="door_supervisor">Door supervisor</option>
            <option value="cctv">CCTV</option>
            <option value="close_protection">Close protection</option>
          </select>
        </Field>
        <Field label="Starts on"><input type="date" value={form.starts_on} onChange={set('starts_on')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Charge rate per hour"><MoneyInput valuePence={charge} onChange={setCharge} /></Field>
        <Field label="Pay rate per hour" hint="Validated against National Minimum Wage on every allocation.">
          <MoneyInput valuePence={pay} onChange={setPay} />
        </Field>
      </div>
      {margin != null && (
        <div className={`alert ${margin <= 0 ? 'danger' : margin < 200 ? 'warn' : 'ok'}`}>
          <strong>Margin: {money(margin)} per hour</strong>
          {charge ? `${Math.round((margin / charge) * 1000) / 10}% of the charge rate.` : ''}
          {margin <= 0 ? ' This assignment loses money on every hour worked.' : ''}
        </div>
      )}
      <Field label="Purchase order reference"><input type="text" onChange={set('po_reference')} /></Field>
    </Modal>
  );
}
