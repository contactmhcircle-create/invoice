import type { Db } from '../../core/db/connection.js';
import { newId } from '../../core/db/connection.js';
import { recordAudit } from '../../core/db/audit.js';
import { nowInstant, today } from '../../shared/dates.js';
import {
  hashPassword, verifyPassword, needsRehash, generateToken, hashToken,
  encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCodes, consumeRecoveryCode,
} from './crypto.js';
import { generateSecret, verifyCode, provisioningUri } from './totp.js';
import { requiresTwoFactor, type Role } from './permissions.js';

/**
 * Accounts, sign-in and sessions.
 *
 * Two rules shape everything here:
 *   1. A sign-in failure never reveals whether the email exists. Same message,
 *      same timing, whether the account is unknown or the password is wrong.
 *   2. Every outcome is recorded. Repeated failures against a real account are
 *      the earliest warning you get that credentials have leaked elsewhere.
 */

const SESSION_HOURS = 12;
const SESSION_IDLE_MINUTES = 60;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const IP_ATTEMPT_LIMIT = 20;
const IP_WINDOW_MINUTES = 15;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
  mustChangePassword: boolean;
}

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  email: string;
  name: string;
  role: Role;
  password: string;
  createdBy?: string;
  mustChangePassword?: boolean;
}

export function createUser(db: Db, input: CreateUserInput): string {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw new Error('An account with that email address already exists.');

  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);

  const id = newId('usr');
  const now = nowInstant();

  db.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, must_change_password,
       password_changed_at, status, created_at, created_by, updated_at)
     VALUES (?,?,?,?,?,?,?, 'active', ?,?,?)`,
  ).run(
    id, email, input.name.trim(), input.role, hashPassword(input.password),
    input.mustChangePassword === false ? 0 : 1, now, now, input.createdBy ?? null, now,
  );

  recordAudit(db, {
    entityType: 'user',
    entityId: id,
    action: 'created',
    summary: `User account created for ${email} with role ${input.role}`,
    actor: input.createdBy ?? 'system',
    after: { email, name: input.name, role: input.role },
  });

  return id;
}

/**
 * Password rules follow NCSC guidance: length is what matters, and forced
 * complexity rules push people towards predictable substitutions. Length floor
 * plus a check against the obvious choices.
 */
const COMMON_PASSWORDS = [
  'password', 'password1', 'password123', '12345678', '123456789', 'qwertyuiop',
  'letmein', 'welcome', 'admin123', 'cerviz', 'cerviz123', 'security', 'changeme',
];

export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 200) return 'Password must be 200 characters or fewer.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.some((c) => lower === c || lower.startsWith(c))) {
    return 'That password is too easy to guess. Choose something unrelated to the business.';
  }
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character.';
  return null;
}

export function listUsers(db: Db) {
  return db
    .prepare(
      `SELECT id, email, name, role, status, totp_enabled, last_login_at, last_login_ip,
              locked_until, created_at
       FROM users ORDER BY name`,
    )
    .all();
}

export function updateUser(
  db: Db,
  userId: string,
  changes: { name?: string; role?: Role; status?: string },
  actor: string,
): void {
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!before) throw new Error('User not found');

  // The last active owner cannot be demoted or suspended, or nobody can manage
  // the system.
  if (before.role === 'owner' && (changes.role !== undefined && changes.role !== 'owner')) {
    assertNotLastOwner(db, userId);
  }
  if (before.role === 'owner' && changes.status && changes.status !== 'active') {
    assertNotLastOwner(db, userId);
  }

  const fields = Object.entries(changes).filter(([, v]) => v !== undefined);
  if (fields.length === 0) return;

  db.prepare(
    `UPDATE users SET ${fields.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
  ).run(...fields.map(([, v]) => v), nowInstant(), userId);

  // A role change or suspension takes effect immediately, not at next sign-in.
  if (changes.role || changes.status) revokeAllSessions(db, userId, 'Role or status changed');

  recordAudit(db, {
    entityType: 'user',
    entityId: userId,
    action: 'updated',
    summary: `Account ${before.email} updated: ${fields.map(([k, v]) => `${k} → ${v}`).join(', ')}`,
    actor,
    before: { name: before.name, role: before.role, status: before.status },
    after: changes,
  });
}

function assertNotLastOwner(db: Db, userId: string): void {
  const others = db
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND id <> ?`)
    .get(userId) as any;
  if (others.n === 0) {
    throw new Error(
      'This is the only active owner. Promote another user to owner first, or you will lock yourself out.',
    );
  }
}

export function setPassword(db: Db, userId: string, newPassword: string, actor: string): void {
  const problem = passwordProblem(newPassword);
  if (problem) throw new Error(problem);

  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as any;
  if (!user) throw new Error('User not found');

  db.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
       failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
  ).run(hashPassword(newPassword), nowInstant(), nowInstant(), userId);

  recordAudit(db, {
    entityType: 'user',
    entityId: userId,
    action: 'password_changed',
    summary: `Password changed for ${user.email}`,
    actor,
  });
}

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------

export function beginTwoFactorSetup(db: Db, userId: string): { secret: string; uri: string } {
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as any;
  if (!user) throw new Error('User not found');

  const secret = generateSecret();
  db.prepare('UPDATE users SET totp_secret_encrypted = ?, totp_enabled = 0, updated_at = ? WHERE id = ?')
    .run(encryptSecret(secret), nowInstant(), userId);

  return { secret, uri: provisioningUri(secret, user.email) };
}

/**
 * Confirming setup requires a working code, so nobody locks themselves out by
 * enabling two-factor against a secret their app never actually stored.
 */
export function confirmTwoFactorSetup(db: Db, userId: string, code: string): { recoveryCodes: string[] } {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!user?.totp_secret_encrypted) throw new Error('Start two-factor setup first.');

  const secret = decryptSecret(user.totp_secret_encrypted);
  if (!verifyCode(secret, code)) {
    throw new Error('That code is not correct. Check your authenticator app and try again.');
  }

  const recoveryCodes = generateRecoveryCodes();
  db.prepare(
    `UPDATE users SET totp_enabled = 1, totp_confirmed_at = ?, recovery_codes_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nowInstant(), hashRecoveryCodes(recoveryCodes), nowInstant(), userId);

  recordAudit(db, {
    entityType: 'user',
    entityId: userId,
    action: 'two_factor_enabled',
    summary: `Two-factor authentication enabled for ${user.email}`,
    actor: userId,
  });

  return { recoveryCodes };
}

export function disableTwoFactor(db: Db, userId: string, actor: string): void {
  const user = db.prepare('SELECT email, role FROM users WHERE id = ?').get(userId) as any;
  if (!user) throw new Error('User not found');
  if (requiresTwoFactor(user.role)) {
    throw new Error(
      `Two-factor is required for the ${user.role} role. Change the role first if it genuinely must be removed.`,
    );
  }

  db.prepare(
    `UPDATE users SET totp_enabled = 0, totp_secret_encrypted = NULL, recovery_codes_json = NULL,
       updated_at = ? WHERE id = ?`,
  ).run(nowInstant(), userId);

  recordAudit(db, {
    entityType: 'user',
    entityId: userId,
    action: 'two_factor_disabled',
    summary: `Two-factor authentication disabled for ${user.email}`,
    actor,
  });
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; reason: 'credentials' | 'locked' | 'suspended' | 'totp_required' | 'totp_invalid' | 'throttled';
      message: string; needsTotp?: boolean };

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
  ip?: string;
  userAgent?: string;
}

export function login(db: Db, input: LoginInput): LoginResult {
  const email = input.email.trim().toLowerCase();
  const now = nowInstant();

  const record = (outcome: string, userId?: string) => {
    db.prepare(
      `INSERT INTO login_attempts (at, email, ip, user_agent, outcome, user_id) VALUES (?,?,?,?,?,?)`,
    ).run(now, email, input.ip ?? null, input.userAgent ?? null, outcome, userId ?? null);
  };

  // Per-IP throttling, applied before anything else so an attacker cannot use
  // response differences to enumerate accounts.
  if (input.ip) {
    const since = new Date(Date.now() - IP_WINDOW_MINUTES * 60_000).toISOString();
    const recent = db
      .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ? AND outcome <> 'success'`)
      .get(input.ip, since) as any;
    if (recent.n >= IP_ATTEMPT_LIMIT) {
      record('locked');
      return {
        ok: false, reason: 'throttled',
        message: 'Too many sign-in attempts from this connection. Try again in 15 minutes.',
      };
    }
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;

  if (!user) {
    // Hash anyway so the response takes the same time as a real password check;
    // otherwise timing reveals which addresses have accounts.
    verifyPassword(input.password, hashPassword('timing-equalisation'));
    record('unknown_user');
    return { ok: false, reason: 'credentials', message: 'Email address or password is not correct.' };
  }

  if (user.locked_until && user.locked_until > now) {
    record('locked', user.id);
    return {
      ok: false, reason: 'locked',
      message: 'This account is temporarily locked after repeated failed sign-ins. Try again shortly.',
    };
  }

  if (user.status === 'suspended') {
    record('suspended', user.id);
    return { ok: false, reason: 'suspended', message: 'This account has been suspended.' };
  }

  if (!verifyPassword(input.password, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    const lockUntil = attempts >= MAX_FAILED_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : null;

    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
      .run(attempts, lockUntil, now, user.id);
    record('bad_password', user.id);

    return { ok: false, reason: 'credentials', message: 'Email address or password is not correct.' };
  }

  // Password is right. Two-factor next.
  if (user.totp_enabled) {
    if (!input.totpCode && !input.recoveryCode) {
      return {
        ok: false, reason: 'totp_required', needsTotp: true,
        message: 'Enter the 6-digit code from your authenticator app.',
      };
    }

    let passed = false;

    if (input.recoveryCode) {
      const updated = consumeRecoveryCode(user.recovery_codes_json, input.recoveryCode);
      if (updated) {
        db.prepare('UPDATE users SET recovery_codes_json = ?, updated_at = ? WHERE id = ?')
          .run(updated, now, user.id);
        passed = true;
        recordAudit(db, {
          entityType: 'user', entityId: user.id, action: 'recovery_code_used',
          summary: `Recovery code used to sign in as ${user.email}`, actor: user.id,
        });
      }
    } else if (input.totpCode && user.totp_secret_encrypted) {
      passed = verifyCode(decryptSecret(user.totp_secret_encrypted), input.totpCode);
    }

    if (!passed) {
      const attempts = user.failed_attempts + 1;
      const lockUntil = attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
        : null;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(attempts, lockUntil, now, user.id);
      record('bad_totp', user.id);
      return {
        ok: false, reason: 'totp_invalid', needsTotp: true,
        message: 'That code is not correct. Codes change every 30 seconds — check the current one.',
      };
    }
  }

  // Successful sign-in.
  db.prepare(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ?,
       updated_at = ? WHERE id = ?`,
  ).run(now, input.ip ?? null, now, user.id);
  record('success', user.id);

  // Opportunistically upgrade hashes when the cost parameters have been raised.
  if (needsRehash(user.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(input.password), user.id);
  }

  const token = createSession(db, user.id, input.ip, input.userAgent);

  return {
    ok: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      totpEnabled: !!user.totp_enabled,
      mustChangePassword: !!user.must_change_password,
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(db: Db, userId: string, ip?: string, userAgent?: string): string {
  const token = generateToken();
  const now = nowInstant();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(newId('sess'), hashToken(token), userId, now, expires, now, ip ?? null, userAgent ?? null);

  return token;
}

/**
 * Resolves a cookie token to a user, enforcing both absolute expiry and an idle
 * timeout. Returns null for anything invalid — expired, revoked, or belonging to
 * an account that has since been suspended.
 */
export function resolveSession(db: Db, token: string | undefined): SessionUser | null {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.revoked_at,
              u.id, u.email, u.name, u.role, u.status, u.totp_enabled, u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as any;

  if (!row) return null;

  const now = nowInstant();
  if (row.revoked_at) return null;
  if (row.expires_at <= now) return null;
  if (row.status !== 'active') return null;

  const idleCutoff = new Date(Date.now() - SESSION_IDLE_MINUTES * 60_000).toISOString();
  if (row.last_seen_at < idleCutoff) {
    revokeSession(db, row.session_id, 'Idle timeout');
    return null;
  }

  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.session_id);

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    totpEnabled: !!row.totp_enabled,
    mustChangePassword: !!row.must_change_password,
  };
}

export function revokeSession(db: Db, sessionId: string, reason: string): void {
  db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL')
    .run(nowInstant(), reason, sessionId);
}

export function revokeSessionByToken(db: Db, token: string, reason = 'Signed out'): void {
  db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(nowInstant(), reason, hashToken(token));
}

export function revokeAllSessions(db: Db, userId: string, reason: string): number {
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(nowInstant(), reason, userId);
  return result.changes;
}

export function activeSessionsFor(db: Db, userId: string) {
  return db
    .prepare(
      `SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_seen_at DESC`,
    )
    .all(userId, nowInstant());
}

/** Housekeeping: drop sessions and attempt records that are no longer useful. */
export function pruneExpired(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(new Date(Date.now() - 7 * 86400_000).toISOString());
  db.prepare('DELETE FROM login_attempts WHERE at < ?')
    .run(new Date(Date.now() - 90 * 86400_000).toISOString());
}

/**
 * On an empty system, create the first owner from the environment so there is a
 * way in without a chicken-and-egg problem. Runs once and never overwrites.
 */
export function ensureFirstOwner(db: Db): { created: boolean; email?: string; password?: string } {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get() as any;
  if (count.n > 0) return { created: false };

  const email = process.env.OWNER_EMAIL;
  const password = process.env.OWNER_PASSWORD;
  if (!email || !password) {
    return { created: false };
  }

  createUser(db, {
    email, name: process.env.OWNER_NAME ?? 'Owner', role: 'owner',
    password, createdBy: 'system', mustChangePassword: true,
  });

  return { created: true, email };
}
