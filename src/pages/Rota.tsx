import React, { useState } from 'react';
import { useQuery, call, money, ukDate, todayIso, addDays, hours } from '../lib/api.js';
// The one implementation of "how long is this shift" — it handles crossing
// midnight, which a naive end-minus-start does not.
import { workedMinutes } from '../../shared/dates.js';
import { Loading, Empty, Modal, Status, Findings, Field, ErrorNote, Confirm } from '../components/ui.js';

/**
 * The rota. Allocation runs through the compliance gate: workers who cannot
 * legally cover a shift are shown with the reason rather than simply hidden, so
 * the operator knows what to fix.
 */
export default function Rota({ onChange }: { onChange: () => void }) {
  const [from, setFrom] = useState(addDays(todayIso(), -7));
  const [to, setTo] = useState(addDays(todayIso(), 21));
  const { data: shifts, loading, refresh } = useQuery<any[]>('shifts:list', { from, to });
  const { data: assignments } = useQuery<any[]>('assignments:list');
  const [allocating, setAllocating] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => { refresh(); onChange(); };

  const mark = async (shiftId: string, status: string) => {
    try { await call('shifts:mark', { shiftId, status }); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const byDate = new Map<string, any[]>();
  for (const s of shifts ?? []) {
    const d = s.starts_at.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(s);
  }

  const unfilled = (shifts ?? []).filter((s) => !s.worker_id && s.status === 'planned').length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Rota &amp; shifts</div>
          <div className="page-sub">
            Allocation is gated on compliance at the shift date. A worker whose licence expires before the
            shift runs cannot be placed on it.
          </div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>Create shifts</button>
      </div>

      <ErrorNote error={error} />

      {unfilled > 0 && (
        <div className="alert warn">
          <strong>{unfilled} unfilled shift(s) in this range</strong>
          Unfilled shifts are unbilled revenue and, on a live contract, a service failure.
        </div>
      )}

      <div className="filters">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {loading ? <Loading /> : !shifts?.length ? (
        <Empty>No shifts in this date range.</Empty>
      ) : (
        [...byDate.entries()].map(([date, dayShifts]) => (
          <div className="card" key={date}>
            <div className="card-head">
              <div className="card-title">
                {new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', {
                  weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
                })}
              </div>
              <span className="small muted">{dayShifts.length} shift{dayShifts.length === 1 ? '' : 's'}</span>
            </div>
            <div className="card-body tight">
              <table>
                <thead>
                  <tr>
                    <th>Times</th><th>Client / site</th><th>Assignment</th><th>Officer</th>
                    <th className="num">Charge</th><th className="num">Pay</th><th className="num">Margin</th>
                    <th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {dayShifts.map((s) => {
                    const mins = workedMinutes(s.starts_at, s.ends_at, s.break_minutes);
                    const charge = Math.round((mins * (s.charge_rate_pence ?? 0)) / 60);
                    const pay = Math.round((mins * (s.pay_rate_pence ?? 0)) / 60);
                    return (
                      <tr key={s.id}>
                        <td className="nowrap">
                          <strong>{s.starts_at.slice(11, 16)}–{s.ends_at.slice(11, 16)}</strong>
                          <div className="small muted">{hours(mins)} hrs</div>
                        </td>
                        <td className="small">{s.client_name}{s.site_name ? ` · ${s.site_name}` : ''}</td>
                        <td className="small">{s.assignment_title}</td>
                        <td>
                          {s.worker_id
                            ? <strong>{s.first_name} {s.last_name}</strong>
                            : <span className="badge amber">Unfilled</span>}
                        </td>
                        <td className="num">{money(charge)}</td>
                        <td className="num">{money(pay)}</td>
                        <td className="num">
                          {money(charge - pay)}
                          <div className="small muted">
                            {charge > 0 ? `${Math.round(((charge - pay) / charge) * 1000) / 10}%` : '—'}
                          </div>
                        </td>
                        <td><Status value={s.status} /></td>
                        <td className="nowrap">
                          {!s.worker_id ? (
                            <button className="btn small primary" onClick={() => setAllocating(s.id)}>Allocate</button>
                          ) : s.status === 'allocated' ? (
                            <div className="btn-row">
                              <button className="btn small" onClick={() => mark(s.id, 'worked')}>Worked</button>
                              <button className="btn small" onClick={() => mark(s.id, 'no_show')}>No-show</button>
                              <button className="btn small" onClick={() => setReleasing(s.id)}>Release</button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {allocating && (
        <Allocate shiftId={allocating} onClose={() => setAllocating(null)} onDone={() => { setAllocating(null); reload(); }} />
      )}
      {creating && (
        <CreateShifts assignments={assignments ?? []} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />
      )}
      {releasing && (
        <Confirm
          title="Release worker from shift"
          message="The shift returns to unfilled. The change is recorded in the audit trail."
          confirmLabel="Release"
          requireReason
          onCancel={() => setReleasing(null)}
          onConfirm={async (reason) => {
            try { await call('shifts:release', { shiftId: releasing, reason }); setReleasing(null); reload(); }
            catch (e: any) { setError(e.message); setReleasing(null); }
          }}
        />
      )}
    </div>
  );
}

function Allocate({ shiftId, onClose, onDone }: { shiftId: string; onClose: () => void; onDone: () => void }) {
  const { data: candidates, loading } = useQuery<any[]>('shifts:eligibleWorkers', { shiftId });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = candidates?.find((c) => c.workerId === selected);

  const allocate = async () => {
    try {
      await call('shifts:allocate', { shiftId, workerId: selected, acknowledgeWarnings: true });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  const eligible = candidates?.filter((c) => c.eligible) ?? [];
  const blocked = candidates?.filter((c) => !c.eligible) ?? [];

  return (
    <Modal
      title="Allocate a worker to this shift"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!chosen?.eligible} onClick={allocate}>
            Allocate worker
          </button>
        </>
      }
    >
      <ErrorNote error={error} />
      {loading ? <Loading /> : (
        <>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <strong>Available ({eligible.length})</strong>
            <span className="small muted">{blocked.length} blocked by compliance</span>
          </div>

          {eligible.length === 0 ? (
            <div className="alert danger">
              <strong>No worker can legally cover this shift</strong>
              Every candidate has at least one compliance blocker. Resolve one of them below, or the shift
              cannot be filled.
            </div>
          ) : (
            <table>
              <thead><tr><th></th><th>Worker</th><th>Warnings</th></tr></thead>
              <tbody>
                {eligible.map((c) => (
                  <tr key={c.workerId} className="clickable" onClick={() => setSelected(c.workerId)}>
                    <td><input type="radio" checked={selected === c.workerId} onChange={() => setSelected(c.workerId)} /></td>
                    <td><strong>{c.name}</strong></td>
                    <td>
                      {c.warnings.length === 0
                        ? <span className="badge green">Clear</span>
                        : <span className="badge amber">{c.warnings.length} warning{c.warnings.length === 1 ? '' : 's'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {chosen && chosen.warnings.length > 0 && (
            <>
              <div className="divider" />
              <strong>Warnings for {chosen.name}</strong>
              <p className="small muted" style={{ margin: '4px 0 10px' }}>
                These do not block allocation. Proceeding records that you were shown them.
              </p>
              <Findings findings={chosen.warnings} />
            </>
          )}

          {blocked.length > 0 && (
            <>
              <div className="divider" />
              <strong>Blocked ({blocked.length})</strong>
              <div style={{ marginTop: 8 }}>
                {blocked.map((c) => (
                  <div key={c.workerId} className="finding blocker">
                    <div className="finding-title">{c.name}</div>
                    <div className="finding-detail">
                      {c.blockers.map((b: any) => b.title).join(' · ') || 'Not placeable'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function CreateShifts({ assignments, onClose, onDone }: { assignments: any[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState<any>({
    assignmentId: assignments[0]?.id ?? '',
    from: todayIso(),
    to: addDays(todayIso(), 6),
    startTime: '18:00',
    endTime: '06:00',
    breakMinutes: 0,
    daysOfWeek: [1, 2, 3, 4, 5],
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const toggleDay = (d: number) => {
    const days = form.daysOfWeek.includes(d)
      ? form.daysOfWeek.filter((x: number) => x !== d)
      : [...form.daysOfWeek, d];
    setForm({ ...form, daysOfWeek: days });
  };

  const create = async () => {
    try {
      if (!form.assignmentId) throw new Error('Select an assignment.');
      const ids = await call<string[]>('shifts:createSeries', {
        ...form, breakMinutes: Number(form.breakMinutes) || 0,
      });
      if (ids.length === 0) throw new Error('No shifts matched those days — check the day selection.');
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  const DAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]] as const;

  return (
    <Modal
      title="Create a run of shifts"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={create}>Create shifts</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Assignment" hint="Rates resolve from this assignment, or from the site or client above it.">
        <select value={form.assignmentId} onChange={set('assignmentId')}>
          <option value="">Select…</option>
          {assignments.map((a) => <option key={a.id} value={a.id}>{a.client_name} — {a.title}</option>)}
        </select>
      </Field>
      <div className="grid cols-2">
        <Field label="From"><input type="date" value={form.from} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={form.to} onChange={set('to')} /></Field>
      </div>
      <div className="grid cols-3">
        <Field label="Start time"><input type="time" value={form.startTime} onChange={set('startTime')} /></Field>
        <Field label="End time" hint="Crossing midnight is handled.">
          <input type="time" value={form.endTime} onChange={set('endTime')} />
        </Field>
        <Field label="Unpaid break (minutes)"><input type="number" value={form.breakMinutes} onChange={set('breakMinutes')} /></Field>
      </div>
      <Field label="Days of the week">
        <div className="btn-row">
          {DAYS.map(([label, d]) => (
            <button
              key={d}
              className={`btn small${form.daysOfWeek.includes(d) ? ' primary' : ''}`}
              onClick={() => toggleDay(d)}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
    </Modal>
  );
}
