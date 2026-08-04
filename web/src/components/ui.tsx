import React, { useState } from 'react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="spinner">{label}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="alert danger">
      <strong>Something went wrong</strong>
      {error}
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  draft: 'grey', planned: 'grey', received: 'grey', not_started: 'grey', onboarding: 'blue',
  issued: 'blue', allocated: 'blue', approved: 'blue', active: 'green', matched: 'green',
  paid: 'green', agreed: 'green', worked: 'green', satisfied: 'green', valid: 'green',
  part_paid: 'amber', queried: 'amber', in_progress: 'amber', disputed: 'amber', on_hold: 'amber',
  overdue: 'red', void: 'red', no_show: 'red', failed: 'red', expired: 'red', barred: 'red',
  invoiced: 'blue', replaced: 'grey', cancelled: 'grey', inactive: 'grey', left: 'grey',
};

export function Status({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const tone = STATUS_TONES[value] ?? 'grey';
  return <span className={`badge ${tone}`}>{value.replace(/_/g, ' ')}</span>;
}

export function Modal({
  title, children, onClose, footer, wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          {footer ?? <button className="btn" onClick={onClose}>Close</button>}
        </div>
      </div>
    </div>
  );
}

export interface Finding {
  code: string;
  severity: 'blocker' | 'warning' | 'info';
  title: string;
  detail: string;
  action?: string;
}

export function Findings({ findings, emptyLabel }: { findings: Finding[]; emptyLabel?: string }) {
  if (!findings || findings.length === 0) {
    return <div className="alert ok">{emptyLabel ?? 'No issues found.'}</div>;
  }
  return (
    <>
      {findings.map((f, i) => (
        <div key={`${f.code}-${i}`} className={`finding ${f.severity}`}>
          <div className="finding-title">{f.title}</div>
          <div className="finding-detail">{f.detail}</div>
          {f.action && <div className="finding-action">{f.action}</div>}
        </div>
      ))}
    </>
  );
}

export function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Money input in pounds that reports integer pence, so nothing rounds badly. */
export function MoneyInput({
  valuePence, onChange, placeholder,
}: { valuePence: number | null; onChange: (pence: number | null) => void; placeholder?: string }) {
  const [text, setText] = useState(valuePence == null ? '' : (valuePence / 100).toFixed(2));
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder ?? '0.00'}
      onChange={(e) => {
        setText(e.target.value);
        const cleaned = e.target.value.replace(/[£,\s]/g, '');
        if (cleaned === '') onChange(null);
        else {
          const n = parseFloat(cleaned);
          if (Number.isFinite(n)) onChange(Math.round(n * 100));
        }
      }}
    />
  );
}

export function Confirm({
  title, message, confirmLabel, onConfirm, onCancel, requireReason, danger,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  requireReason?: boolean;
  danger?: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            disabled={requireReason && reason.trim().length < 3}
            onClick={() => onConfirm(reason)}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ marginBottom: requireReason ? 14 : 0 }}>{message}</div>
      {requireReason && (
        <Field label="Reason" hint="Recorded in the audit trail and shown on the document.">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  );
}
