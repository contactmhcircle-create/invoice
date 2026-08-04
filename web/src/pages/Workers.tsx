import React, { useState } from 'react';
import { useQuery, call, uploadDocuments, money, ukDate, todayIso, addDays } from '../lib/api.js';
import { Loading, Empty, Modal, Status, Findings, Field, MoneyInput, ErrorNote } from '../components/ui.js';

const BS7858_LABELS: Record<string, string> = {
  identity: 'Identity verification',
  address_history: 'Address history (5 years)',
  employment_history: 'Employment history (5 years, gaps accounted for)',
  character_references: 'Character references',
  financial_probity: 'Financial probity',
  criminal_record: 'Criminal record / basic disclosure',
};

const SECTORS = [
  ['security_guard', 'Security guard'],
  ['door_supervisor', 'Door supervisor'],
  ['cctv', 'CCTV (public space surveillance)'],
  ['close_protection', 'Close protection'],
  ['key_holding', 'Key holding'],
];

export default function Workers({ onChange }: { onChange: () => void }) {
  const { data: workers, loading, refresh } = useQuery<any[]>('workers:list');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = () => { refresh(); onChange(); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Workers &amp; compliance</div>
          <div className="page-sub">
            Every officer's SIA licence, right to work and BS 7858 screening. A worker with any blocker
            cannot be allocated to a shift — the rota refuses, rather than warning and letting it through.
          </div>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>Add worker</button>
      </div>

      <div className="card">
        <div className="card-body tight">
          {loading ? <Loading /> : !workers?.length ? (
            <Empty>No workers yet. Add your first officer to begin.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Worker</th><th>Engagement</th><th>Umbrella</th>
                  <th>Licence expires</th><th className="num">Pay rate</th>
                  <th>Status</th><th>Compliance</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id} className="clickable" onClick={() => setSelected(w.id)}>
                    <td>
                      <div className="stack">
                        <strong>{w.first_name} {w.last_name}</strong>
                        <span className="small muted">{w.reference}</span>
                      </div>
                    </td>
                    <td className="small">{String(w.engagement_type).replace(/_/g, ' ')}</td>
                    <td className="small">{w.umbrella_name ?? <span className="muted">—</span>}</td>
                    <td className="nowrap">{ukDate(w.licence_expires)}</td>
                    <td className="num">{money(w.default_pay_rate_pence)}</td>
                    <td><Status value={w.status} /></td>
                    <td>
                      {w.placeable
                        ? w.warningCount > 0
                          ? <span className="badge amber">{w.warningCount} warning{w.warningCount === 1 ? '' : 's'}</span>
                          : <span className="badge green">Clear to work</span>
                        : <span className="badge red" title={w.topIssue ?? ''}>Blocked — {w.topIssue}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && <WorkerDetail id={selected} onClose={() => setSelected(null)} onChange={reload} />}
      {adding && <AddWorker onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function WorkerDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: w, loading, refresh } = useQuery<any>('workers:get', { id });
  const [tab, setTab] = useState<'compliance' | 'licences' | 'screening' | 'shifts'>('compliance');
  const [error, setError] = useState<string | null>(null);
  const [addingLicence, setAddingLicence] = useState(false);
  const [addingRtw, setAddingRtw] = useState(false);

  const reload = () => { refresh(); onChange(); };

  const setElement = async (element: string, status: string) => {
    try {
      await call('workers:setScreening', { workerId: id, element, status });
      reload();
    } catch (e: any) { setError(e.message); }
  };

  const issueKid = async () => {
    try { await call('workers:issueKid', { workerId: id }); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    try { await uploadDocuments('worker', id, 'worker_document', files); reload(); }
    catch (e: any) { setError(e.message); }
  };

  if (loading || !w) return <Modal title="Worker" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal title={`${w.first_name} ${w.last_name}`} onClose={onClose} wide>
      <ErrorNote error={error} />

      <div className="row-between" style={{ marginBottom: 16 }}>
        <div className="stack">
          <div><strong>{w.reference}</strong> · <Status value={w.status} /></div>
          <div className="small muted">
            {String(w.engagement_type).replace(/_/g, ' ')}
            {w.umbrella_name ? ` via ${w.umbrella_name}` : ''}
            {w.date_of_birth ? ` · born ${ukDate(w.date_of_birth)}` : ''}
            {w.ni_number ? ` · NI ${w.ni_number}` : ''}
          </div>
        </div>
        <div className="btn-row">
          <button className="btn small" onClick={issueKid}>Issue KID</button>
          <label className="btn small">
            Attach document
            <input type="file" multiple hidden onChange={(e) => attach(e.target.files)} />
          </label>
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        {(['compliance', 'licences', 'screening', 'shifts'] as const).map((t) => (
          <button key={t} className={`btn small${tab === t ? ' primary' : ''}`} onClick={() => setTab(t)}>
            {t === 'compliance' ? 'Compliance' : t === 'licences' ? 'Licence & RTW' : t === 'screening' ? 'BS 7858' : 'Recent shifts'}
          </button>
        ))}
      </div>

      {tab === 'compliance' && (
        <>
          <div className={`alert ${w.compliance.placeable ? 'ok' : 'danger'}`}>
            <strong>{w.compliance.placeable ? 'Clear to be placed on shift' : 'Cannot be placed on shift'}</strong>
            {w.compliance.placeable
              ? `${w.compliance.warnings.length} warning(s) to keep an eye on.`
              : `${w.compliance.blockers.length} blocker(s) must be resolved first.`}
          </div>
          <Findings findings={w.compliance.findings} emptyLabel="Fully compliant with no warnings." />
        </>
      )}

      {tab === 'licences' && (
        <>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <strong>SIA licences</strong>
            <button className="btn small" onClick={() => setAddingLicence(true)}>Add licence</button>
          </div>
          {w.licences.length ? (
            <table>
              <thead><tr><th>Sector</th><th>Number</th><th>Expires</th><th>Verified</th><th>Status</th></tr></thead>
              <tbody>
                {w.licences.map((l: any) => (
                  <tr key={l.id}>
                    <td className="small">{String(l.sector).replace(/_/g, ' ')}</td>
                    <td className="mono">{l.licence_number}</td>
                    <td className="nowrap">{ukDate(l.expires_on)}</td>
                    <td className="small">{l.verified_on ? ukDate(l.verified_on) : <span className="badge amber">not verified</span>}</td>
                    <td><Status value={l.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No licence recorded — this worker cannot be placed.</Empty>}

          <div className="divider" />

          <div className="row-between" style={{ marginBottom: 10 }}>
            <strong>Right to work</strong>
            <button className="btn small" onClick={() => setAddingRtw(true)}>Record check</button>
          </div>
          {w.rightToWork.length ? (
            <table>
              <thead><tr><th>Method</th><th>Checked</th><th>Outcome</th><th>Expires</th><th>Re-check due</th></tr></thead>
              <tbody>
                {w.rightToWork.map((r: any) => (
                  <tr key={r.id}>
                    <td className="small">{String(r.method).replace(/_/g, ' ')}</td>
                    <td>{ukDate(r.checked_on)}</td>
                    <td><Status value={r.outcome === 'continuous' ? 'valid' : r.outcome} /></td>
                    <td>{ukDate(r.expires_on)}</td>
                    <td>{ukDate(r.recheck_due_on)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No right to work check recorded.</Empty>}
        </>
      )}

      {tab === 'screening' && (
        <>
          <p className="small muted" style={{ marginBottom: 12 }}>
            BS 7858 is the screening standard security buyers audit during procurement. Every element must
            be satisfied before this worker is placed.
          </p>
          <table>
            <thead><tr><th>Element</th><th>Status</th><th>Completed</th><th>Set</th></tr></thead>
            <tbody>
              {Object.entries(BS7858_LABELS).map(([key, label]) => {
                const rec = w.screening.find((s: any) => s.element === key);
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td><Status value={rec?.status ?? 'not_started'} /></td>
                    <td className="small">{rec?.completed_on ? ukDate(rec.completed_on) : '—'}</td>
                    <td>
                      <select
                        value={rec?.status ?? 'not_started'}
                        onChange={(e) => setElement(key, e.target.value)}
                        style={{ width: 150 }}
                      >
                        <option value="not_started">Not started</option>
                        <option value="in_progress">In progress</option>
                        <option value="satisfied">Satisfied</option>
                        <option value="failed">Failed</option>
                        <option value="waived">Waived</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {tab === 'shifts' && (
        w.recentShifts?.length ? (
          <table>
            <thead><tr><th>Date</th><th>Assignment</th><th>Times</th><th>Status</th></tr></thead>
            <tbody>
              {w.recentShifts.map((s: any) => (
                <tr key={s.id}>
                  <td className="nowrap">{ukDate(s.starts_at)}</td>
                  <td className="small">{s.title}</td>
                  <td className="small nowrap">{s.starts_at.slice(11, 16)}–{s.ends_at.slice(11, 16)}</td>
                  <td><Status value={s.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No shifts recorded.</Empty>
      )}

      {addingLicence && (
        <AddLicence workerId={id} onClose={() => setAddingLicence(false)} onSaved={() => { setAddingLicence(false); reload(); }} />
      )}
      {addingRtw && (
        <AddRtw workerId={id} onClose={() => setAddingRtw(false)} onSaved={() => { setAddingRtw(false); reload(); }} />
      )}
    </Modal>
  );
}

function AddWorker({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { data: umbrellas } = useQuery<any[]>('orgs:list', { isUmbrella: true });
  const [form, setForm] = useState<any>({ engagement_type: 'umbrella', status: 'onboarding' });
  const [payRate, setPayRate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      if (!form.first_name || !form.last_name) throw new Error('First and last name are required.');
      await call('workers:save', { ...form, default_pay_rate_pence: payRate });
      onSaved();
    } catch (e: any) { setError(e.message); }
  };

  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal
      title="Add worker"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Add worker</button></>}
    >
      <ErrorNote error={error} />
      <div className="grid cols-2">
        <Field label="First name"><input type="text" onChange={set('first_name')} autoFocus /></Field>
        <Field label="Last name"><input type="text" onChange={set('last_name')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Date of birth" hint="Drives the National Minimum Wage age band.">
          <input type="date" onChange={set('date_of_birth')} />
        </Field>
        <Field label="National Insurance number"><input type="text" onChange={set('ni_number')} /></Field>
      </div>
      <div className="grid cols-2">
        <Field label="Engagement type">
          <select value={form.engagement_type} onChange={set('engagement_type')}>
            <option value="umbrella">Umbrella company</option>
            <option value="paye">PAYE employee of Cerviz</option>
            <option value="limited">Own limited company</option>
            <option value="self_employed">Self-employed</option>
          </select>
        </Field>
        {form.engagement_type === 'umbrella' && (
          <Field label="Umbrella company" hint="Required — the pay chain cannot be evidenced without it.">
            <select value={form.umbrella_org_id ?? ''} onChange={set('umbrella_org_id')}>
              <option value="">Select…</option>
              {umbrellas?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label="Default pay rate (per hour)" hint="Checked against National Minimum Wage on every allocation.">
        <MoneyInput valuePence={payRate} onChange={setPayRate} />
      </Field>
      <div className="grid cols-2">
        <Field label="Phone"><input type="text" onChange={set('phone')} /></Field>
        <Field label="Email"><input type="email" onChange={set('email')} /></Field>
      </div>
    </Modal>
  );
}

function AddLicence({ workerId, onClose, onSaved }: { workerId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({ sector: 'security_guard', status: 'valid', verified_on: todayIso() });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      if (!form.licence_number || !form.expires_on) throw new Error('Licence number and expiry date are required.');
      await call('workers:addLicence', { ...form, worker_id: workerId });
      onSaved();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Add SIA licence"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save licence</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Sector">
        <select value={form.sector} onChange={set('sector')}>
          {SECTORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      <Field label="Licence number"><input type="text" onChange={set('licence_number')} autoFocus /></Field>
      <div className="grid cols-2">
        <Field label="Issued on"><input type="date" onChange={set('issued_on')} /></Field>
        <Field label="Expires on" hint="Allocation is blocked for any shift running past this date.">
          <input type="date" onChange={set('expires_on')} />
        </Field>
      </div>
      <Field label="Verified against the SIA register on" hint="Leave blank if you have not checked the public register yet.">
        <input type="date" value={form.verified_on ?? ''} onChange={set('verified_on')} />
      </Field>
    </Modal>
  );
}

function AddRtw({ workerId, onClose, onSaved }: { workerId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<any>({ method: 'share_code', outcome: 'continuous', checked_on: todayIso() });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try { await call('workers:addRtw', { ...form, worker_id: workerId }); onSaved(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Record right to work check"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save check</button></>}
    >
      <ErrorNote error={error} />
      <div className="alert info">
        The statutory excuse against an illegal working penalty depends on the check being completed
        <strong style={{ display: 'inline' }}> before</strong> the worker's first shift.
      </div>
      <Field label="Method">
        <select value={form.method} onChange={set('method')}>
          <option value="share_code">Home Office share code</option>
          <option value="manual_document">Manual document check</option>
          <option value="idsp">Identity service provider (IDSP)</option>
        </select>
      </Field>
      {form.method === 'share_code' && (
        <Field label="Share code"><input type="text" onChange={set('share_code')} /></Field>
      )}
      <div className="grid cols-2">
        <Field label="Checked on"><input type="date" value={form.checked_on} onChange={set('checked_on')} /></Field>
        <Field label="Outcome">
          <select value={form.outcome} onChange={set('outcome')}>
            <option value="continuous">Continuous right to work</option>
            <option value="time_limited">Time-limited permission</option>
            <option value="failed">No right to work established</option>
          </select>
        </Field>
      </div>
      {form.outcome === 'time_limited' && (
        <div className="grid cols-2">
          <Field label="Permission expires"><input type="date" onChange={set('expires_on')} /></Field>
          <Field label="Re-check due" hint="Defaults to the expiry date if left blank.">
            <input type="date" value={form.recheck_due_on ?? form.expires_on ?? ''} onChange={set('recheck_due_on')} />
          </Field>
        </div>
      )}
    </Modal>
  );
}
