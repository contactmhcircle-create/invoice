import type { Db } from '../db/connection.js';
import { formatDateUK, hoursDecimal } from '../../shared/dates.js';

/**
 * Compliance registers — the documents a UK inspector, department or auditor
 * asks a security labour supplier for, generated from live data on demand:
 *
 *   sia_deployment  SIA / ACS inspection: who was deployed where, on which
 *                   licence, on which dates.
 *   rtw             Home Office: the right-to-work register — the statutory
 *                   excuse log for every worker checked.
 *   screening       BS 7858 audit: every worker's screening elements and state.
 *   kid             EAS inspectorate (Conduct Regulations): the Key Information
 *                   Document issue register.
 *
 * One shape serves HTML print and CSV alike, so a new register is one function.
 */

export interface Register {
  type: string;
  title: string;
  subtitle: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number | null>>;
  footnote: string;
}

export function buildRegister(db: Db, type: string, from?: string, to?: string): Register {
  switch (type) {
    case 'sia_deployment': return siaDeployment(db, from, to);
    case 'rtw': return rtwRegister(db);
    case 'screening': return screeningRegister(db);
    case 'kid': return kidRegister(db);
    default: throw new Error(`Unknown register: ${type}. Available: sia_deployment, rtw, screening, kid.`);
  }
}

function siaDeployment(db: Db, from?: string, to?: string): Register {
  const conds = ['s.worker_id IS NOT NULL', `s.status IN ('allocated','worked','invoiced')`];
  const params: string[] = [];
  if (from) { conds.push('date(s.starts_at) >= ?'); params.push(from); }
  if (to) { conds.push('date(s.starts_at) <= ?'); params.push(to); }

  const rows = db.prepare(
    `SELECT date(s.starts_at) AS date, substr(s.starts_at, 12, 5) AS starts,
            substr(s.ends_at, 12, 5) AS ends,
            w.first_name || ' ' || w.last_name AS officer, w.reference,
            l.licence_number, l.sector, l.expires_on,
            o.name AS client, COALESCE(st.name, '—') AS site, s.status
     FROM shifts s
     JOIN workers w ON w.id = s.worker_id
     JOIN assignments a ON a.id = s.assignment_id
     JOIN organisations o ON o.id = a.client_org_id
     LEFT JOIN sites st ON st.id = s.site_id
     LEFT JOIN worker_licences l ON l.id =
       (SELECT id FROM worker_licences WHERE worker_id = w.id
          AND (a.required_licence_sector IS NULL OR sector = a.required_licence_sector)
        ORDER BY (status = 'valid') DESC, expires_on DESC LIMIT 1)
     WHERE ${conds.join(' AND ')}
     ORDER BY s.starts_at`,
  ).all(...params) as any[];

  return {
    type: 'sia_deployment',
    title: 'SIA officer deployment register',
    subtitle: from || to
      ? `Deployments ${from ? `from ${formatDateUK(from)}` : ''}${to ? ` to ${formatDateUK(to)}` : ''}`.trim()
      : 'All recorded deployments',
    columns: [
      { key: 'date', label: 'Date' }, { key: 'times', label: 'Times' },
      { key: 'officer', label: 'Officer' }, { key: 'reference', label: 'Ref' },
      { key: 'licence_number', label: 'SIA licence' }, { key: 'sector', label: 'Sector' },
      { key: 'expires_on', label: 'Licence expiry' },
      { key: 'client', label: 'Client' }, { key: 'site', label: 'Site' },
      { key: 'status', label: 'Status' },
    ],
    rows: rows.map((r) => ({
      date: formatDateUK(r.date), times: `${r.starts}–${r.ends}`,
      officer: r.officer, reference: r.reference ?? '—',
      licence_number: r.licence_number ?? 'NONE ON FILE',
      sector: r.sector ? String(r.sector).replace(/_/g, ' ') : '—',
      expires_on: r.expires_on ? formatDateUK(r.expires_on) : '—',
      client: r.client, site: r.site, status: r.status,
    })),
    footnote: 'Licence shown is the relevant licence on file for the assignment’s required sector at generation time. '
      + 'Allocation is blocked at source when a licence would be expired on the shift date.',
  };
}

function rtwRegister(db: Db): Register {
  const rows = db.prepare(
    `SELECT w.first_name || ' ' || w.last_name AS worker, w.reference, w.status AS worker_status,
            r.method, r.share_code, r.document_type, r.document_ref,
            r.checked_on, r.checked_by, r.outcome, r.expires_on, r.recheck_due_on
     FROM worker_rtw r JOIN workers w ON w.id = r.worker_id
     ORDER BY w.last_name, r.checked_on`,
  ).all() as any[];

  return {
    type: 'rtw',
    title: 'Right-to-work check register',
    subtitle: 'The statutory excuse log — every check, its method, who performed it and when it must be repeated',
    columns: [
      { key: 'worker', label: 'Worker' }, { key: 'reference', label: 'Ref' },
      { key: 'method', label: 'Method' }, { key: 'evidence', label: 'Share code / document' },
      { key: 'checked_on', label: 'Checked' }, { key: 'checked_by', label: 'By' },
      { key: 'outcome', label: 'Outcome' }, { key: 'recheck', label: 'Expiry / recheck' },
    ],
    rows: rows.map((r) => ({
      worker: r.worker, reference: r.reference ?? '—',
      method: String(r.method).replace(/_/g, ' '),
      evidence: r.share_code ?? [r.document_type, r.document_ref].filter(Boolean).join(' ') ?? '—',
      checked_on: formatDateUK(r.checked_on), checked_by: r.checked_by ?? '—',
      outcome: String(r.outcome).replace(/_/g, ' '),
      recheck: r.expires_on ? formatDateUK(r.expires_on)
        : r.recheck_due_on ? `recheck ${formatDateUK(r.recheck_due_on)}` : 'not time-limited',
    })),
    footnote: 'A compliant check before the first day of work gives a statutory excuse against an illegal working '
      + 'penalty. Time-limited permissions are re-checked before expiry; allocation is blocked once expired.',
  };
}

function screeningRegister(db: Db): Register {
  const workers = db.prepare(
    `SELECT id, first_name || ' ' || last_name AS worker, reference, status
     FROM workers WHERE status <> 'left' ORDER BY last_name`,
  ).all() as any[];

  const elements = ['identity', 'address_history', 'employment_history',
    'character_references', 'financial_probity', 'criminal_record'];

  const rows = workers.map((w) => {
    const checks = new Map<string, any>(
      (db.prepare('SELECT element, status, completed_on FROM screening_checks WHERE worker_id = ?')
        .all(w.id) as any[]).map((c) => [c.element, c]),
    );
    const row: Record<string, string> = {
      worker: w.worker, reference: w.reference ?? '—', worker_status: w.status,
    };
    let complete = true;
    for (const el of elements) {
      const c = checks.get(el);
      const ok = c && (c.status === 'satisfied' || c.status === 'waived');
      if (!ok) complete = false;
      row[el] = c
        ? c.status + (c.completed_on ? ` ${formatDateUK(c.completed_on)}` : '')
        : 'not started';
    }
    row.overall = complete ? 'COMPLETE' : 'INCOMPLETE';
    return row;
  });

  return {
    type: 'screening',
    title: 'BS 7858 screening register',
    subtitle: 'Every screening element per worker — identity, 5-year address and employment history, references, financial probity, criminal record',
    columns: [
      { key: 'worker', label: 'Worker' }, { key: 'reference', label: 'Ref' },
      ...elements.map((el) => ({ key: el, label: el.replace(/_/g, ' ') })),
      { key: 'overall', label: 'Overall' },
    ],
    rows,
    footnote: 'BS 7858:2019 requires all elements before unsupervised deployment; limited screening applies only '
      + 'within the standard’s window. Allocation is blocked while screening is incomplete.',
  };
}

function kidRegister(db: Db): Register {
  const rows = db.prepare(
    `SELECT w.first_name || ' ' || w.last_name AS worker, w.reference,
            k.version, k.issued_on, k.issued_by, k.engagement_type, k.pay_rate_pence,
            o.name AS umbrella
     FROM key_information_documents k
     JOIN workers w ON w.id = k.worker_id
     LEFT JOIN organisations o ON o.id = k.umbrella_org_id
     ORDER BY w.last_name, k.version`,
  ).all() as any[];

  return {
    type: 'kid',
    title: 'Key Information Document register',
    subtitle: 'Every KID issued under the Conduct of Employment Agencies and Employment Businesses Regulations 2003',
    columns: [
      { key: 'worker', label: 'Worker' }, { key: 'reference', label: 'Ref' },
      { key: 'version', label: 'Version' }, { key: 'issued_on', label: 'Issued' },
      { key: 'issued_by', label: 'By' }, { key: 'engagement_type', label: 'Engagement' },
      { key: 'pay_rate', label: 'Pay rate' }, { key: 'umbrella', label: 'Umbrella' },
    ],
    rows: rows.map((r) => ({
      worker: r.worker, reference: r.reference ?? '—', version: r.version,
      issued_on: formatDateUK(r.issued_on), issued_by: r.issued_by ?? '—',
      engagement_type: String(r.engagement_type).replace(/_/g, ' '),
      pay_rate: r.pay_rate_pence != null ? `£${(r.pay_rate_pence / 100).toFixed(2)}/hr` : 'as agreed',
      umbrella: r.umbrella ?? '—',
    })),
    footnote: 'A KID must be given before terms are agreed with a work-seeker, and re-issued when the key facts change.',
  };
}

// ---------------------------------------------------------------------------
// Rendering — one printable layout and one CSV for every register
// ---------------------------------------------------------------------------

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);

export function renderRegisterHtml(db: Db, reg: Register): string {
  const c = (db.prepare('SELECT * FROM company WHERE id = 1').get() ?? {}) as any;
  const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(reg.title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px/1.5 Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 0; padding: 8px; }
  .rule-top { border-top: 4px solid #1a1a1a; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #555; margin-bottom: 4px; }
  .meta { color: #777; font-size: 10px; margin-bottom: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; letter-spacing: 0.5px; text-transform: uppercase;
       color: #444; border-top: 2px solid #1a1a1a; border-bottom: 2px solid #1a1a1a; padding: 6px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  .footnote { margin-top: 14px; font-size: 9.5px; color: #666; border-top: 1px solid #ddd; padding-top: 8px; }
</style></head><body>
<div class="rule-top"></div>
<h1>${esc(reg.title)}</h1>
<div class="sub">${esc(reg.subtitle)}</div>
<div class="meta">${esc(c.legal_name ?? 'Cerviz Ltd')}${c.company_number ? `, company number ${esc(c.company_number)}` : ''}
  · generated ${esc(generated)} · ${reg.rows.length} row(s) · produced from live records by the Cerviz back office</div>
<table>
  <thead><tr>${reg.columns.map((col) => `<th>${esc(col.label)}</th>`).join('')}</tr></thead>
  <tbody>${reg.rows.map((row) =>
    `<tr>${reg.columns.map((col) => `<td>${esc(row[col.key])}</td>`).join('')}</tr>`).join('')}
  </tbody>
</table>
<div class="footnote">${esc(reg.footnote)}</div>
</body></html>`;
}

export function registerCsv(reg: Register): string {
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [reg.columns.map((c) => cell(c.label)).join(',')];
  for (const row of reg.rows) lines.push(reg.columns.map((c) => cell(row[c.key])).join(','));
  return lines.join('\n');
}
