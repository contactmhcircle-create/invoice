import React, { useState } from 'react';
import { useQuery, call, ukDate, type CurrentUser, type RoleId } from '../lib/api.js';
import { Loading, Empty, Modal, Status, Field, ErrorNote, Confirm } from '../components/ui.js';

const ROLES: Array<{ id: RoleId; label: string; description: string }> = [
  { id: 'owner', label: 'Owner', description: 'Full access, including managing users and company settings.' },
  { id: 'compliance', label: 'Compliance & vetting', description: 'Workers, licences, right to work and BS 7858 screening. No rates, margins or invoices.' },
  { id: 'scheduler', label: 'Scheduler', description: 'Rotas, allocation and timesheet entry. Worker personal details are hidden.' },
  { id: 'finance', label: 'Finance', description: 'Invoicing, purchases, reports and statutory returns. Worker personal details are hidden.' },
  { id: 'readonly', label: 'Read only', description: 'Can view everything except worker personal details. Cannot change anything.' },
];

export default function Users({ me }: { me: CurrentUser }) {
  const { data: users, loading, refresh } = useQuery<any[]>('users:list');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [resetting, setResetting] = useState<any>(null);
  const [signingOut, setSigningOut] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); refresh(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Users &amp; access</div>
          <div className="page-sub">
            Roles decide what each person can reach. Permissions are enforced on the server, so hiding a
            button is presentation — the restriction is real either way.
          </div>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>Add user</button>
      </div>

      <ErrorNote error={error} />

      <div className="alert info">
        <strong>Two-factor authentication is required for every account</strong>
        A new user signs in with the password you set, is made to change it, and then must set up an
        authenticator app before reaching any data.
      </div>

      <div className="card">
        <div className="card-body tight">
          {loading ? <Loading /> : !users?.length ? (
            <Empty>No users yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Last signed in</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong>
                      {u.id === me.id && <span className="badge blue" style={{ marginLeft: 6 }}>you</span>}
                    </td>
                    <td className="small">{u.email}</td>
                    <td className="small">{ROLES.find((r) => r.id === u.role)?.label ?? u.role}</td>
                    <td>
                      {u.totp_enabled
                        ? <span className="badge green">on</span>
                        : <span className="badge red">not set up</span>}
                    </td>
                    <td className="small nowrap">
                      {u.last_login_at
                        ? new Date(u.last_login_at).toLocaleString('en-GB')
                        : <span className="muted">never</span>}
                    </td>
                    <td>
                      <Status value={u.status} />
                      {u.locked_until && u.locked_until > new Date().toISOString() && (
                        <span className="badge amber" style={{ marginLeft: 4 }}>locked</span>
                      )}
                    </td>
                    <td className="nowrap">
                      <div className="btn-row">
                        <button className="btn small" onClick={() => setEditing(u)}>Edit</button>
                        <button className="btn small" onClick={() => setResetting(u)}>Reset password</button>
                        <button className="btn small" onClick={() => setSigningOut(u)}>Sign out</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="chain-note">
          Changing someone's role or suspending them ends their active sessions immediately, rather than
          at their next sign-in.
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">What each role can do</div></div>
        <div className="card-body tight">
          <table>
            <thead><tr><th>Role</th><th>Scope</th></tr></thead>
            <tbody>
              {ROLES.map((r) => (
                <tr key={r.id}><td><strong>{r.label}</strong></td><td className="small">{r.description}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {adding && <AddUser onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
      {editing && (
        <EditUser
          user={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); refresh(); }}
        />
      )}
      {resetting && (
        <ResetPassword
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => { setResetting(null); refresh(); }}
        />
      )}
      {signingOut && (
        <Confirm
          title={`Sign out ${signingOut.name}?`}
          message="Every active session for this user ends immediately. They can sign in again straight away unless you also suspend the account."
          confirmLabel="Sign them out"
          onCancel={() => setSigningOut(null)}
          onConfirm={async () => {
            const target = signingOut;
            setSigningOut(null);
            await act(() => call('users:revokeSessions', { id: target.id }));
          }}
        />
      )}
    </div>
  );
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState<any>({ role: 'readonly' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    try {
      await call('users:create', form);
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Create account</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Full name"><input type="text" onChange={set('name')} autoFocus /></Field>
      <Field label="Email address"><input type="email" onChange={set('email')} /></Field>
      <Field label="Role">
        <select value={form.role} onChange={set('role')}>
          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <div className="hint">{ROLES.find((r) => r.id === form.role)?.description}</div>
      </Field>
      <Field
        label="Temporary password"
        hint="At least 12 characters. They will be made to change it on first sign-in, then set up two-factor. Send it to them by a different channel to their email."
      >
        <input type="text" onChange={set('password')} />
      </Field>
    </Modal>
  );
}

function EditUser({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<RoleId>(user.role);
  const [status, setStatus] = useState(user.status);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      await call('users:update', { id: user.id, name, role, status });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title={`Edit ${user.name}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save changes</button></>}
    >
      <ErrorNote error={error} />
      <Field label="Full name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Role">
        <select value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
          {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
        <div className="hint">{ROLES.find((r) => r.id === role)?.description}</div>
      </Field>
      <Field label="Status" hint="Suspending an account ends its sessions immediately and blocks sign-in.">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </Field>
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      await call('users:resetPassword', { id: user.id, password });
      onDone();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <Modal
      title={`Reset password for ${user.name}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Set password</button></>}
    >
      <ErrorNote error={error} />
      <div className="alert warn">
        This ends all of their sessions and forces a change at next sign-in. Send the new password by a
        channel other than email, and never reuse one.
      </div>
      <Field label="New temporary password" hint="At least 12 characters.">
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}
