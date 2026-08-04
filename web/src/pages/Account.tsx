import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { useQuery, call, logout, type CurrentUser } from '../lib/api.js';
import { Loading, Empty, Field, ErrorNote } from '../components/ui.js';

/**
 * The signed-in user's own account: password, two-factor and active sessions.
 *
 * Two-factor setup is forced here before anything else loads when it has not
 * been done, so an account cannot sit indefinitely with a password as its only
 * protection.
 */
export default function Account({ me, onChanged }: { me: CurrentUser; onChanged: () => void }) {
  const { data: sessions, refresh } = useQuery<any[]>('me:sessions');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">My account</div>
          <div className="page-sub">{me.name} · {me.email}</div>
        </div>
        <button className="btn" onClick={() => logout().then(() => window.location.reload())}>Sign out</button>
      </div>

      <ErrorNote error={error} />
      {saved && <div className="alert ok">{saved}</div>}

      <ChangePassword onError={setError} onSaved={() => setSaved('Password changed. Other sessions have been signed out.')} />

      <TwoFactor me={me} onChanged={onChanged} onError={setError} />

      <div className="card">
        <div className="card-head"><div className="card-title">Where you are signed in</div></div>
        <div className="card-body tight">
          {!sessions ? <Loading /> : sessions.length === 0 ? (
            <Empty>No active sessions.</Empty>
          ) : (
            <table>
              <thead><tr><th>Signed in</th><th>Last active</th><th>Address</th><th>Device</th></tr></thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="small nowrap">{new Date(s.created_at).toLocaleString('en-GB')}</td>
                    <td className="small nowrap">{new Date(s.last_seen_at).toLocaleString('en-GB')}</td>
                    <td className="small mono">{s.ip ?? '—'}</td>
                    <td className="small" style={{ maxWidth: 380 }}>{s.user_agent ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="chain-note">
          Sessions end after 12 hours, or after an hour of inactivity. If you see an address you do not
          recognise, change your password immediately — that signs out every other session.
        </div>
      </div>
    </div>
  );
}

function ChangePassword({ onError, onSaved }: { onError: (e: string) => void; onSaved: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (next !== confirm) return onError('The new passwords do not match.');
    setBusy(true);
    try {
      await call('me:changePassword', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setConfirm('');
      onSaved();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head"><div className="card-title">Password</div></div>
      <div className="card-body">
        <div className="grid cols-3">
          <Field label="Current password">
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 12 characters. Length matters more than symbols.">
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password">
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        <button className="btn primary" disabled={busy || !current || !next} onClick={save}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </div>
    </div>
  );
}

export function TwoFactor({
  me, onChanged, onError, forced,
}: { me: CurrentUser; onChanged: () => void; onError: (e: string) => void; forced?: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!setup) { setQr(null); return; }
    QRCode.toDataURL(setup.uri, { width: 220, margin: 1 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [setup]);

  const begin = async () => {
    setBusy(true);
    try { setSetup(await call('me:beginTwoFactor')); }
    catch (e: any) { onError(e.message); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await call<{ recoveryCodes: string[] }>('me:confirmTwoFactor', { code });
      setRecoveryCodes(result.recoveryCodes);
      setSetup(null);
      setCode('');
      onChanged();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (recoveryCodes) {
    return (
      <div className="card">
        <div className="card-head"><div className="card-title">Save your recovery codes</div></div>
        <div className="card-body">
          <div className="alert warn">
            <strong>This is the only time these are shown</strong>
            Each code works once and lets you sign in if you lose your phone. Print them or put them in a
            password manager — not in your email.
          </div>
          <div className="recovery-codes">
            {recoveryCodes.map((c) => <div key={c} className="mono">{c}</div>)}
          </div>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => window.print()}>Print</button>
            <button
              className="btn"
              onClick={() => navigator.clipboard?.writeText(recoveryCodes.join('\n'))}
            >
              Copy to clipboard
            </button>
            <button className="btn primary" onClick={() => { setRecoveryCodes(null); onChanged(); }}>
              I have saved them
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <div className="card-title">Two-factor authentication</div>
        {me.totpEnabled && <span className="badge green">on</span>}
      </div>
      <div className="card-body">
        {me.totpEnabled ? (
          <p className="small muted">
            Your account is protected by an authenticator app. Two-factor is required for every role, so
            it cannot be turned off — if you change phones, reset it here first.
          </p>
        ) : setup ? (
          <>
            <p className="small" style={{ marginBottom: 14 }}>
              Scan this with Google Authenticator, Authy, 1Password, Microsoft Authenticator or any other
              authenticator app. Then enter the 6-digit code it shows.
            </p>
            <div className="totp-setup">
              {qr ? <img src={qr} alt="Two-factor setup QR code" width={220} height={220} /> : <Loading />}
              <div>
                <div className="tile-label">Cannot scan? Enter this key manually</div>
                <div className="mono setup-key">{setup.secret.match(/.{1,4}/g)?.join(' ')}</div>
                <Field label="6-digit code from the app">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    className="code-input"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                </Field>
                <button className="btn primary" disabled={busy || code.length !== 6} onClick={confirm}>
                  {busy ? 'Checking…' : 'Turn on two-factor'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={`alert ${forced ? 'danger' : 'warn'}`}>
              <strong>Two-factor is not set up</strong>
              This system holds workers' National Insurance numbers, dates of birth, addresses and
              right-to-work documents. A password alone is not enough protection for that, and two-factor
              is required for every role.
            </div>
            <button className="btn primary" disabled={busy} onClick={begin}>
              {busy ? 'Preparing…' : 'Set up two-factor authentication'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
