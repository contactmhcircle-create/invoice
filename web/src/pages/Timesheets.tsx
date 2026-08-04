import React, { useState } from 'react';
import { useQuery, call, uploadDocuments, money, ukDate, todayIso, hours } from '../lib/api.js';
import { Loading, Empty, Modal, Status, Field, ErrorNote, Confirm } from '../components/ui.js';

/**
 * Timesheets are keyed from the paper sheet signed on site. The signed scan is
 * required before approval, because an invoice with no signed sheet behind it is
 * the hardest kind to defend when a client disputes it.
 */
export default function Timesheets({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState('');
  const { data: sheets, loading, refresh } = useQuery<any[]>('timesheets:list', status ? { status } : {});
  const { data: assignments } = useQuery<any[]>('assignments:list');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () => { refresh(); onChange(); };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Timesheets</div>
          <div className="page-sub">
            The evidential anchor for every pound of revenue: invoice line → timesheet → shift → signed
            paper sheet. Approval locks the hours; billing locks the sheet.
          </div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>New timesheet</button>
      </div>

      <div className="filters">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="approved">Approved — ready to bill</option>
            <option value="invoiced">Invoiced</option>
            <option value="disputed">Disputed</option>
          </select>
        </Field>
      </div>

      <div className="card">
        <div className="card-body tight">
          {loading ? <Loading /> : !sheets?.length ? (
            <Empty>No timesheets yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Reference</th><th>Worker</th><th>Client / assignment</th><th>Week ending</th>
                  <th className="num">Hours</th><th className="num">Charge</th><th className="num">Pay</th>
                  <th className="num">Margin</th><th>Scan</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => setSelected(t.id)}>
                    <td className="mono">{t.reference}</td>
                    <td>{t.first_name} {t.last_name}</td>
                    <td className="small">{t.client_name}<div className="muted">{t.assignment_title}</div></td>
                    <td className="nowrap">{ukDate(t.week_ending)}</td>
                    <td className="num">{hours(t.total_minutes)}</td>
                    <td className="num">{money(t.charge_total_pence)}</td>
                    <td className="num">{money(t.pay_total_pence)}</td>
                    <td className="num">{money(t.charge_total_pence - t.pay_total_pence)}</td>
                    <td>
                      {t.scan_count > 0
                        ? <span className="badge green">attached</span>
                        : <span className="badge red">missing</span>}
                    </td>
                    <td><Status value={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected && <TimesheetDetail id={selected} onClose={() => setSelected(null)} onChange={reload} />}
      {creating && (
        <NewTimesheet
          assignments={assignments ?? []}
          onClose={() => setCreating(false)}
          onDone={(id) => { setCreating(false); reload(); setSelected(id); }}
        />
      )}
    </div>
  );
}

function TimesheetDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const { data: t, loading, refresh } = useQuery<any>('timesheets:get', { id });
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [reopening, setReopening] = useState(false);

  const reload = () => { refresh(); onChange(); };

  const populate = async () => {
    try {
      const n = await call<number>('timesheets:populate', { id });
      if (n === 0) setError('No unallocated shifts found for this worker in that week.');
      reload();
    } catch (e: any) { setError(e.message); }
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    try { await uploadDocuments('timesheet', id, 'signed_timesheet', files); reload(); }
    catch (e: any) { setError(e.message); }
  };

  if (loading || !t) return <Modal title="Timesheet" onClose={onClose}><Loading /></Modal>;

  const hasScan = t.documents?.some((d: any) => d.category === 'signed_timesheet');
  const editable = t.status === 'draft';

  return (
    <Modal
      title={`Timesheet ${t.reference}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          {t.status === 'approved' && (
            <button className="btn" onClick={() => setReopening(true)}>Reopen</button>
          )}
          {editable && (
            <button className="btn primary" onClick={() => setApproving(true)}>Approve</button>
          )}
        </>
      }
    >
      <ErrorNote error={error} />

      <div className="row-between" style={{ marginBottom: 14 }}>
        <div className="stack">
          <strong>{t.first_name} {t.last_name}</strong>
          <span className="small muted">
            {t.client_name} · {t.assignment_title} · week ending {ukDate(t.week_ending)}
          </span>
        </div>
        <Status value={t.status} />
      </div>

      {!hasScan && (
        <div className="alert warn">
          <strong>No signed timesheet scan attached</strong>
          Approval requires the signed paper sheet, or an explicit recorded reason for its absence.
        </div>
      )}

      {t.client_signatory && (
        <div className="alert ok">
          <strong>Signed on site</strong>
          By {t.client_signatory} on {ukDate(t.client_signed_on)}
          {t.approved_by ? ` · approved by ${t.approved_by}` : ''}
        </div>
      )}

      <div className="btn-row" style={{ marginBottom: 14 }}>
        {editable && <button className="btn small" onClick={populate}>Pull hours from rota</button>}
        <label className="btn small">
          Attach signed scan
          <input type="file" accept="image/*,application/pdf" capture="environment" hidden
                 onChange={(e) => attach(e.target.files)} />
        </label>
      </div>

      {t.lines?.length ? (
        <table>
          <thead>
            <tr>
              <th>Date</th><th>Times</th><th className="num">Worked</th><th className="num">Billed</th>
              <th>Band</th><th className="num">Charge rate</th><th className="num">Pay rate</th>
              <th className="num">Charge</th><th className="num">Pay</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((l: any) => (
              <tr key={l.id}>
                <td className="nowrap">{ukDate(l.work_date)}</td>
                <td className="small nowrap">{l.start_time}–{l.end_time}</td>
                <td className="num">{hours(l.worked_minutes)}</td>
                <td className="num">{hours(l.billed_minutes)}</td>
                <td className="small">{String(l.band).replace(/_/g, ' ')}</td>
                <td className="num">{money(l.charge_rate_pence)}</td>
                <td className="num">{money(l.pay_rate_pence)}</td>
                <td className="num">{money(l.charge_pence)}</td>
                <td className="num">{money(l.pay_pence)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 650 }}>
              <td colSpan={2}>Total</td>
              <td className="num">{hours(t.total_minutes)}</td>
              <td colSpan={4}></td>
              <td className="num">{money(t.charge_total_pence)}</td>
              <td className="num">{money(t.pay_total_pence)}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <Empty>No hours recorded. Pull them from the rota, or add them manually.</Empty>
      )}

      <div className="divider" />
      <div className="grid cols-3">
        <div><div className="tile-label">Margin</div><div style={{ fontWeight: 650 }}>{money(t.marginPence)}</div></div>
        <div>
          <div className="tile-label">Holiday accrual (12.07%)</div>
          <div style={{ fontWeight: 650 }}>{money(t.holidayAccrualPence)}</div>
        </div>
        <div>
          <div className="tile-label">Documents</div>
          <div style={{ fontWeight: 650 }}>{t.documents?.length ?? 0}</div>
        </div>
      </div>

      {approving && (
        <ApproveTimesheet
          timesheetId={id}
          hasScan={hasScan}
          onClose={() => setApproving(false)}
          onDone={() => { setApproving(false); reload(); }}
        />
      )}
      {reopening && (
        <Confirm
          title="Reopen timesheet"
          message="The hours become editable again. This is recorded in the audit trail."
          confirmLabel="Reopen"
          requireReason
          onCancel={() => setReopening(false)}
          onConfirm={async (reason) => {
            try { await call('timesheets:reopen', { id, reason }); setReopening(false); reload(); }
            catch (e: any) { setError(e.message); setReopening(false); }
          }}
        />
      )}
    </Modal>
  );
}

function ApproveTimesheet({
  timesheetId, hasScan, onClose, onDone,
}: { timesheetId: string; hasScan: boolean; onClose: () => void; onDone: () => void }) {
  const [signatory, setSignatory] = useState('');
  const [signedOn, setSignedOn] = useState(todayIso());
  const [missingReason, setMissingReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    try {
      if (!signatory.trim()) throw new Error('Record who signed the sheet on site.');
      await call('timesheets:approve', {
        id: timesheetId,
        input: { clientSignatory: signatory, clientSignedOn: signedOn },
        opts: hasScan ? {} : { allowMissingScan: true, missingScanReason: missingReason },
      });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Approve timesheet"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!hasScan && missingReason.trim().length < 5}
            onClick={approve}
          >
            Approve and lock
          </button>
        </>
      }
    >
      <ErrorNote error={error} />
      <div className="alert info">
        Approving locks the hours and makes this timesheet billable. After it is invoiced it cannot be
        changed at all — a correction goes out as a credit note.
      </div>
      <Field label="Who signed the sheet on site" hint="The client's representative, as written on the paper sheet.">
        <input type="text" value={signatory} onChange={(e) => setSignatory(e.target.value)} autoFocus />
      </Field>
      <Field label="Date signed">
        <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} />
      </Field>
      {!hasScan && (
        <Field
          label="Reason the signed scan is not attached"
          hint="Recorded verbatim in the audit trail and shown in the enquiry pack. Attach the scan instead if you can."
        >
          <textarea value={missingReason} onChange={(e) => setMissingReason(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

function NewTimesheet({
  assignments, onClose, onDone,
}: { assignments: any[]; onClose: () => void; onDone: (id: string) => void }) {
  const { data: workers } = useQuery<any[]>('workers:list', { status: 'active' });
  const [assignmentId, setAssignmentId] = useState(assignments[0]?.id ?? '');
  const [workerId, setWorkerId] = useState('');
  const [workDate, setWorkDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    try {
      if (!assignmentId || !workerId) throw new Error('Select an assignment and a worker.');
      const id = await call<string>('timesheets:create', { assignmentId, workerId, workDate });
      onDone(id);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="New timesheet"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={create}>Create</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Assignment">
        <select value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)}>
          <option value="">Select…</option>
          {assignments.map((a) => <option key={a.id} value={a.id}>{a.client_name} — {a.title}</option>)}
        </select>
      </Field>
      <Field label="Worker">
        <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
          <option value="">Select…</option>
          {workers?.map((w) => <option key={w.id} value={w.id}>{w.first_name} {w.last_name}</option>)}
        </select>
      </Field>
      <Field label="Any date in the week" hint="The timesheet covers the Monday to Sunday week containing this date.">
        <input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
