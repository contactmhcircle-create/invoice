import React, { useState, useEffect } from 'react';
import { useQuery, call, money, ukDate } from '../lib/api.js';
import { Loading, Empty, Field, MoneyInput, ErrorNote, Modal } from '../components/ui.js';

export default function Settings({ onChange }: { onChange: () => void }) {
  const { data: company, loading, refresh } = useQuery<any>('company:get');
  const { data: nmw, refresh: refreshNmw } = useQuery<any[]>('nmw:list');
  const { data: backups, refresh: refreshBackups } = useQuery<any[]>('backup:list');
  const { data: chain, refresh: refreshChain } = useQuery<any>('audit:verify');
  const [form, setForm] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'company' | 'vat' | 'bank' | 'rates' | 'data'>('company');

  useEffect(() => { if (company) setForm(company); }, [company]);

  const set = (k: string) => (e: any) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value });

  const save = async () => {
    try {
      await call('company:update', form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      refresh(); onChange();
    } catch (e: any) { setError(e.message); }
  };

  const runBackup = async () => {
    try { await call('backup:now'); refreshBackups(); }
    catch (e: any) { setError(e.message); }
  };

  if (loading) return <div className="page"><Loading /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-sub">
            Company details appear on every invoice. A UK limited company must show its registered name,
            registered office and company number on its invoices.
          </div>
        </div>
        <button className="btn primary" onClick={save}>{saved ? 'Saved' : 'Save changes'}</button>
      </div>

      <ErrorNote error={error} />

      <div className="btn-row" style={{ marginBottom: 16 }}>
        {([['company', 'Company'], ['vat', 'VAT'], ['bank', 'Bank & invoices'], ['rates', 'Minimum wage'], ['data', 'Data & integrity']] as const)
          .map(([id, label]) => (
            <button key={id} className={`btn${tab === id ? ' primary' : ''}`} onClick={() => setTab(id)}>{label}</button>
          ))}
      </div>

      {tab === 'company' && (
        <div className="card">
          <div className="card-body">
            <div className="grid cols-2">
              <Field label="Registered name"><input type="text" value={form.legal_name ?? ''} onChange={set('legal_name')} /></Field>
              <Field label="Trading name"><input type="text" value={form.trading_name ?? ''} onChange={set('trading_name')} /></Field>
            </div>
            <div className="grid cols-2">
              <Field label="Company registration number" hint="Must appear on every invoice.">
                <input type="text" value={form.company_number ?? ''} onChange={set('company_number')} />
              </Field>
              <Field label="Date of incorporation" hint="Drives the Companies House filing calendar.">
                <input type="date" value={form.incorporated_on ?? ''} onChange={set('incorporated_on')} />
              </Field>
            </div>
            <Field label="Registered office address">
              <input type="text" placeholder="Line 1" value={form.registered_address_1 ?? ''} onChange={set('registered_address_1')} style={{ marginBottom: 6 }} />
              <input type="text" placeholder="Line 2" value={form.registered_address_2 ?? ''} onChange={set('registered_address_2')} style={{ marginBottom: 6 }} />
              <div className="grid cols-2">
                <input type="text" placeholder="City" value={form.registered_city ?? ''} onChange={set('registered_city')} />
                <input type="text" placeholder="Postcode" value={form.registered_postcode ?? ''} onChange={set('registered_postcode')} />
              </div>
            </Field>
            <div className="grid cols-3">
              <Field label="Phone"><input type="text" value={form.phone ?? ''} onChange={set('phone')} /></Field>
              <Field label="Email"><input type="email" value={form.email ?? ''} onChange={set('email')} /></Field>
              <Field label="Brand colour"><input type="text" value={form.brand_colour ?? ''} onChange={set('brand_colour')} /></Field>
            </div>
            <div className="grid cols-2">
              <Field label="PAYE reference" hint="Leave blank until you register as an employer with HMRC.">
                <input type="text" value={form.paye_reference ?? ''} onChange={set('paye_reference')} />
              </Field>
              <Field label="Accounts Office reference">
                <input type="text" value={form.accounts_office_ref ?? ''} onChange={set('accounts_office_ref')} />
              </Field>
            </div>
          </div>
        </div>
      )}

      {tab === 'vat' && (
        <div className="card">
          <div className="card-body">
            <div className="alert info">
              <strong>The VAT engine is built and dormant</strong>
              Until you switch registration on, invoices carry no VAT and show the correct "not VAT
              registered" wording. Turn it on with an effective date and every invoice dated on or after
              that date carries VAT automatically — historic invoices are untouched.
            </div>
            <div className="alert warn">
              <strong>Note for an employment business</strong>
              VAT is due on the full charge to the client including the wages element. The staff hire
              concession that once allowed margin-only VAT was withdrawn in 2009, so your VAT turnover is
              effectively your whole invoiced revenue and the £90,000 threshold arrives quickly.
            </div>
            <label className="checkbox" style={{ marginBottom: 14 }}>
              <input type="checkbox" checked={!!form.vat_registered} onChange={set('vat_registered')} />
              Registered for VAT
            </label>
            {!!form.vat_registered && (
              <>
                <div className="grid cols-2">
                  <Field label="VAT registration number"><input type="text" value={form.vat_number ?? ''} onChange={set('vat_number')} /></Field>
                  <Field label="Registered from" hint="Invoices dated on or after this carry VAT.">
                    <input type="date" value={form.vat_registered_from ?? ''} onChange={set('vat_registered_from')} />
                  </Field>
                </div>
                <div className="grid cols-2">
                  <Field label="Scheme">
                    <select value={form.vat_scheme ?? 'standard'} onChange={set('vat_scheme')}>
                      <option value="standard">Standard</option>
                      <option value="flat_rate">Flat rate</option>
                    </select>
                  </Field>
                  <Field label="Accounting basis">
                    <select value={form.vat_basis ?? 'accrual'} onChange={set('vat_basis')}>
                      <option value="accrual">Accrual (invoice date)</option>
                      <option value="cash">Cash (payment date)</option>
                    </select>
                  </Field>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'bank' && (
        <div className="card">
          <div className="card-body">
            <p className="small muted" style={{ marginBottom: 14 }}>
              These appear in the payment box on every invoice. Keep them as the business account —
              company income arriving in a personal account is what turns a routine check into an enquiry.
            </p>
            <div className="grid cols-2">
              <Field label="Bank name"><input type="text" value={form.bank_name ?? ''} onChange={set('bank_name')} /></Field>
              <Field label="Account name"><input type="text" value={form.bank_account_name ?? ''} onChange={set('bank_account_name')} /></Field>
            </div>
            <div className="grid cols-3">
              <Field label="Sort code"><input type="text" value={form.bank_sort_code ?? ''} onChange={set('bank_sort_code')} /></Field>
              <Field label="Account number"><input type="text" value={form.bank_account_number ?? ''} onChange={set('bank_account_number')} /></Field>
              <Field label="Default payment terms (days)">
                <input type="number" value={form.default_payment_terms_days ?? 30} onChange={set('default_payment_terms_days')} />
              </Field>
            </div>
            <Field label="Invoice terms" hint="Printed on every invoice.">
              <textarea value={form.invoice_terms ?? ''} onChange={set('invoice_terms')} />
            </Field>
            <Field label="Invoice footer"><input type="text" value={form.invoice_footer ?? ''} onChange={set('invoice_footer')} /></Field>
          </div>
        </div>
      )}

      {tab === 'rates' && (
        <div className="card">
          <div className="card-head"><div className="card-title">National Minimum Wage rates</div></div>
          <div className="card-body">
            <div className="alert warn">
              <strong>Check these against GOV.UK each April</strong>
              Rates are uprated every April. They are editable here so you never wait for a software
              update. NMW penalties reach 200% of the underpayment and HMRC publishes the names of
              employers who breach it — a pay rate below the minimum blocks allocation outright.
            </div>
            {!nmw?.length ? <Empty>No rates configured.</Empty> : (
              <table>
                <thead><tr><th>Effective from</th><th>Band</th><th className="num">Rate per hour</th><th></th></tr></thead>
                <tbody>
                  {nmw.map((r) => (
                    <NmwRow key={r.id} row={r} onSaved={refreshNmw} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'data' && (
        <>
          <div className={`alert ${chain?.ok ? 'ok' : 'danger'}`}>
            <strong>{chain?.ok ? 'Audit trail intact' : 'Audit trail broken'}</strong>
            {chain?.ok
              ? `${chain.entriesChecked} entries verified. Each entry's hash covers the entry before it, so altering or removing any historic record would break every hash after it. This confirms none has been.`
              : chain?.reason}
            <div style={{ marginTop: 8 }}>
              <button className="btn small" onClick={refreshChain}>Re-verify</button>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">Backups</div>
              <button className="btn small primary" onClick={runBackup}>Back up now</button>
            </div>
            <div className="card-body tight">
              {!backups?.length ? <Empty>No backups yet.</Empty> : (
                <table>
                  <thead><tr><th>Taken</th><th className="num">Size</th></tr></thead>
                  <tbody>
                    {backups.slice(0, 12).map((b) => (
                      <tr key={b.name}>
                        <td>{new Date(b.takenAt).toLocaleString('en-GB')}</td>
                        <td className="num">{(b.sizeBytes / 1024 / 1024).toFixed(1)} MB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="chain-note">
              A backup runs when the server starts, once a day after that, and whenever you press the
              button — the most recent 30 are kept, each with a checksum. Restoring is deliberately not
              available from this screen: replacing the live database is a server operation that should be
              done knowingly, from the deployment guide, rather than by a mis-click in a browser.
            </div>
          </div>

          <DocumentIntegrity />
        </>
      )}
    </div>
  );
}

function NmwRow({ row, onSaved }: { row: any; onSaved: () => void }) {
  const [rate, setRate] = useState<number | null>(row.rate_pence);
  const [dirty, setDirty] = useState(false);

  return (
    <tr>
      <td className="nowrap">{ukDate(row.effective_from)}</td>
      <td>{String(row.band).replace(/_/g, ' ').replace('21 and over', '21 and over (National Living Wage)')}</td>
      <td className="num" style={{ maxWidth: 130 }}>
        <MoneyInput valuePence={rate} onChange={(v) => { setRate(v); setDirty(true); }} />
      </td>
      <td>
        {dirty && (
          <button
            className="btn small primary"
            onClick={async () => {
              await call('nmw:set', { effectiveFrom: row.effective_from, band: row.band, ratePence: rate });
              setDirty(false);
              onSaved();
            }}
          >
            Save
          </button>
        )}
      </td>
    </tr>
  );
}

function DocumentIntegrity() {
  const [results, setResults] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try { setResults(await call('documents:verify')); } finally { setBusy(false); }
  };

  const bad = (results ?? []).filter((r) => !r.present || !r.hashMatches);

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Evidence file integrity</div>
        <button className="btn small" onClick={check} disabled={busy}>{busy ? 'Checking…' : 'Verify files'}</button>
      </div>
      <div className="card-body">
        {results == null ? (
          <p className="small muted">
            Every attached document is hashed on upload. Verifying confirms each file still exists and is
            byte-for-byte the file that was attached — which is what lets a scan produced two years later
            be shown as the original.
          </p>
        ) : bad.length === 0 ? (
          <div className="alert ok">
            <strong>All {results.length} document(s) verified</strong>
            Every file is present and unchanged since upload.
          </div>
        ) : (
          <div className="alert danger">
            <strong>{bad.length} document(s) failed verification</strong>
            <ul>{bad.map((r) => <li key={r.documentId}>{r.filename} — {r.message}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}
