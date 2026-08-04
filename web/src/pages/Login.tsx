import React, { useState } from 'react';
import { login, type CurrentUser } from '../lib/api.js';

/**
 * Sign-in.
 *
 * Deliberately says as little as possible about why an attempt failed: the
 * server gives the same message for a wrong password and an unknown address, so
 * this screen must not undo that by being more helpful.
 */
export default function Login({ onSignedIn }: { onSignedIn: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [stage, setStage] = useState<'credentials' | 'totp'>('credentials');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login({
        email,
        password,
        totpCode: stage === 'totp' && !useRecovery ? totpCode : undefined,
        recoveryCode: stage === 'totp' && useRecovery ? recoveryCode : undefined,
      });

      if (result.ok && result.data) {
        onSignedIn(result.data);
        return;
      }
      if (result.needsTotp) {
        setStage('totp');
        setError(result.reason === 'totp_invalid' ? result.error ?? null : null);
        return;
      }
      setError(result.error ?? 'Sign-in failed.');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          Cerviz Back Office
          <small>Staffing compliance &amp; billing</small>
        </div>

        {error && <div className="alert danger" style={{ marginBottom: 16 }}>{error}</div>}

        {stage === 'credentials' ? (
          <>
            <div className="field">
              <label>Email address</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          </>
        ) : (
          <>
            <p className="small muted" style={{ marginBottom: 14 }}>
              {useRecovery
                ? 'Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once.'
                : 'Enter the current 6-digit code from your authenticator app. Codes change every 30 seconds.'}
            </p>
            {useRecovery ? (
              <div className="field">
                <label>Recovery code</label>
                <input
                  type="text"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  placeholder="XXXXX-XXXXX"
                  autoFocus
                  required
                />
              </div>
            ) : (
              <div className="field">
                <label>Authentication code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  autoComplete="one-time-code"
                  className="code-input"
                  autoFocus
                  required
                />
              </div>
            )}
            <button
              type="button"
              className="link-button"
              onClick={() => { setUseRecovery(!useRecovery); setError(null); }}
            >
              {useRecovery ? 'Use my authenticator app instead' : 'I have lost my phone — use a recovery code'}
            </button>
          </>
        )}

        <button className="btn primary auth-submit" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : stage === 'credentials' ? 'Sign in' : 'Verify'}
        </button>

        {stage === 'totp' && (
          <button
            type="button"
            className="link-button"
            style={{ marginTop: 12 }}
            onClick={() => { setStage('credentials'); setTotpCode(''); setError(null); }}
          >
            Back
          </button>
        )}

        <p className="auth-footer">
          Cerviz Ltd — this system holds personal data about workers. Access is logged and monitored.
        </p>
      </form>
    </div>
  );
}
