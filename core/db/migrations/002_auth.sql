-- Multi-user access: accounts, roles, sessions and two-factor authentication.
--
-- Once the system is reachable from the internet the audit log's "actor" has to
-- mean a real person rather than an OS username, so every table here exists to
-- make "who did this" answerable.

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                  TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'readonly'
                             CHECK (role IN ('owner','compliance','scheduler','finance','readonly')),

  -- scrypt: salt and parameters are stored alongside the derived key in one
  -- string, so parameters can be raised later without invalidating old hashes.
  password_hash         TEXT NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  password_changed_at   TEXT,

  -- TOTP secret, encrypted at rest with the application key. Mandatory for any
  -- role that can see worker personal data or issue invoices.
  totp_secret_encrypted TEXT,
  totp_enabled          INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0,1)),
  totp_confirmed_at     TEXT,
  -- Single-use recovery codes, stored hashed. Losing a phone must not mean
  -- losing access to the business records.
  recovery_codes_json   TEXT,

  status                TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','suspended','invited')),

  -- Brute-force protection is per account as well as per IP, because an
  -- attacker with a botnet defeats IP-only throttling.
  failed_attempts       INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_login_at         TEXT,
  last_login_ip         TEXT,

  created_at            TEXT NOT NULL,
  created_by            TEXT,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
-- The cookie holds a random token; only its SHA-256 is stored. A stolen
-- database therefore does not hand over live sessions.

CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  ip             TEXT,
  user_agent     TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Sign-in attempts
-- ---------------------------------------------------------------------------
-- Kept for throttling and because repeated failures against a real account are
-- exactly what you want to see after a breach elsewhere.

CREATE TABLE login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  email        TEXT,
  ip           TEXT,
  user_agent   TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN
                 ('success','bad_password','unknown_user','bad_totp','locked','suspended')),
  user_id      TEXT
);

CREATE INDEX idx_attempts_at ON login_attempts(at);
CREATE INDEX idx_attempts_email ON login_attempts(email, at);
CREATE INDEX idx_attempts_ip ON login_attempts(ip, at);

-- ---------------------------------------------------------------------------
-- Password reset
-- ---------------------------------------------------------------------------

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  requested_ip TEXT
);

-- ---------------------------------------------------------------------------
-- Attribute audit entries to real people
-- ---------------------------------------------------------------------------
-- The audit log is append-only and its rows are hash-chained, so it cannot be
-- altered to add a column. The mapping lives beside it instead: actor already
-- holds the user id for web-originated changes, and this view resolves it to a
-- name for display without touching the chain.

CREATE VIEW audit_log_with_actor AS
SELECT a.*,
       u.name  AS actor_name,
       u.email AS actor_email,
       u.role  AS actor_role
FROM audit_log a
LEFT JOIN users u ON u.id = a.actor;
