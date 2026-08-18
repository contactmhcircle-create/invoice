<?php
/**
 * Accounts, sign-in and sessions — port of server/auth/accounts.ts. The two
 * rules that shape it: a failure never reveals whether the email exists, and
 * every outcome is recorded.
 */

declare(strict_types=1);

const SESSION_HOURS = 12;
const SESSION_IDLE_MINUTES = 60;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const IP_ATTEMPT_LIMIT = 20;
const IP_WINDOW_MINUTES = 15;

const COMMON_PASSWORDS = [
    'password', 'password1', 'password123', '12345678', '123456789', 'qwertyuiop',
    'letmein', 'welcome', 'admin123', 'cerviz', 'cerviz123', 'security', 'changeme',
];

function password_problem(string $password): ?string {
    if (mb_strlen($password) < 12) return 'Password must be at least 12 characters.';
    if (mb_strlen($password) > 200) return 'Password must be 200 characters or fewer.';
    $lower = mb_strtolower($password);
    foreach (COMMON_PASSWORDS as $c) {
        if ($lower === $c || str_starts_with($lower, $c)) {
            return 'That password is too easy to guess. Choose something unrelated to the business.';
        }
    }
    if (preg_match('/^(.)\1+$/u', $password)) return 'Password cannot be a single repeated character.';
    return null;
}

function create_user(PDO $db, array $input): string {
    $email = strtolower(trim($input['email'] ?? ''));
    if (!preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) throw new DomainException('Enter a valid email address.');
    if (row($db, 'SELECT id FROM users WHERE email = ?', [$email])) {
        throw new DomainException('An account with that email address already exists.');
    }
    if (($problem = password_problem($input['password'] ?? ''))) throw new DomainException($problem);

    $id = new_id('usr');
    $now = now_instant();
    q($db, "INSERT INTO users (id, email, name, role, password_hash, must_change_password,
              password_changed_at, status, created_at, created_by, updated_at)
            VALUES (?,?,?,?,?,?,?, 'active', ?,?,?)",
        [$id, $email, trim($input['name'] ?? ''), $input['role'],
         hash_password($input['password']),
         ($input['mustChangePassword'] ?? true) ? 1 : 0,
         $now, $now, $input['createdBy'] ?? null, $now]);

    record_audit($db, [
        'entityType' => 'user', 'entityId' => $id, 'action' => 'created',
        'summary' => "User account created for $email with role {$input['role']}",
        'actor' => $input['createdBy'] ?? 'system',
        'after' => ['email' => $email, 'name' => $input['name'], 'role' => $input['role']],
    ]);
    return $id;
}

function list_users(PDO $db): array {
    return rows($db, 'SELECT id, email, name, role, status, totp_enabled, last_login_at, last_login_ip,
                             locked_until, created_at FROM users ORDER BY name');
}

function assert_not_last_owner(PDO $db, string $userId): void {
    $others = (int) scalar($db,
        "SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active' AND id <> ?", [$userId]);
    if ($others === 0) {
        throw new DomainException('This is the only active owner. Promote another user to owner first, or you will lock yourself out.');
    }
}

function update_user(PDO $db, string $userId, array $changes, string $actor): void {
    $before = row($db, 'SELECT * FROM users WHERE id = ?', [$userId]);
    if (!$before) throw new DomainException('User not found');

    if ($before['role'] === 'owner' && isset($changes['role']) && $changes['role'] !== 'owner') {
        assert_not_last_owner($db, $userId);
    }
    if ($before['role'] === 'owner' && isset($changes['status']) && $changes['status'] !== 'active') {
        assert_not_last_owner($db, $userId);
    }

    $allowed = array_intersect_key($changes, array_flip(['name', 'role', 'status']));
    if (!$allowed) return;

    $sets = implode(', ', array_map(fn($k) => "$k = ?", array_keys($allowed)));
    q($db, "UPDATE users SET $sets, updated_at = ? WHERE id = ?",
        [...array_values($allowed), now_instant(), $userId]);

    // A role change or suspension takes effect immediately, not at next sign-in.
    if (isset($changes['role']) || isset($changes['status'])) {
        revoke_all_sessions($db, $userId, 'Role or status changed');
    }

    record_audit($db, [
        'entityType' => 'user', 'entityId' => $userId, 'action' => 'updated',
        'summary' => "Account {$before['email']} updated: " .
            implode(', ', array_map(fn($k, $v) => "$k → $v", array_keys($allowed), $allowed)),
        'actor' => $actor,
        'before' => ['name' => $before['name'], 'role' => $before['role'], 'status' => $before['status']],
        'after' => $allowed,
    ]);
}

function set_password(PDO $db, string $userId, string $newPassword, string $actor): void {
    if (($problem = password_problem($newPassword))) throw new DomainException($problem);
    $user = row($db, 'SELECT email FROM users WHERE id = ?', [$userId]);
    if (!$user) throw new DomainException('User not found');

    q($db, 'UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
              failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
        [hash_password($newPassword), now_instant(), now_instant(), $userId]);

    record_audit($db, [
        'entityType' => 'user', 'entityId' => $userId, 'action' => 'password_changed',
        'summary' => "Password changed for {$user['email']}", 'actor' => $actor,
    ]);
}

// ---------------------------------------------------------------------------
// Two-factor
// ---------------------------------------------------------------------------

function begin_two_factor(PDO $db, string $userId): array {
    $user = row($db, 'SELECT email FROM users WHERE id = ?', [$userId]);
    if (!$user) throw new DomainException('User not found');
    $secret = totp_generate_secret();
    q($db, 'UPDATE users SET totp_secret_encrypted = ?, totp_enabled = 0, updated_at = ? WHERE id = ?',
        [encrypt_secret($secret), now_instant(), $userId]);
    return ['secret' => $secret, 'uri' => totp_provisioning_uri($secret, $user['email'])];
}

/** Requires a working code, so nobody enables 2FA against a secret their app never stored. */
function confirm_two_factor(PDO $db, string $userId, string $code): array {
    $user = row($db, 'SELECT * FROM users WHERE id = ?', [$userId]);
    if (!$user || !$user['totp_secret_encrypted']) throw new DomainException('Start two-factor setup first.');

    if (!totp_verify(decrypt_secret($user['totp_secret_encrypted']), $code)) {
        throw new DomainException('That code is not correct. Check your authenticator app and try again.');
    }

    $recoveryCodes = generate_recovery_codes();
    q($db, 'UPDATE users SET totp_enabled = 1, totp_confirmed_at = ?, recovery_codes_json = ?, updated_at = ?
            WHERE id = ?', [now_instant(), hash_recovery_codes($recoveryCodes), now_instant(), $userId]);

    record_audit($db, [
        'entityType' => 'user', 'entityId' => $userId, 'action' => 'two_factor_enabled',
        'summary' => "Two-factor authentication enabled for {$user['email']}", 'actor' => $userId,
    ]);
    return ['recoveryCodes' => $recoveryCodes];
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

function record_login_attempt(PDO $db, ?string $email, ?string $ip, ?string $ua, string $outcome, ?string $userId = null): void {
    q($db, 'INSERT INTO login_attempts (at, email, ip, user_agent, outcome, user_id) VALUES (?,?,?,?,?,?)',
        [now_instant(), $email, $ip, $ua, $outcome, $userId]);
}

function account_login(PDO $db, array $input): array {
    $email = strtolower(trim($input['email'] ?? ''));
    $ip = $input['ip'] ?? null;
    $ua = isset($input['userAgent']) ? substr($input['userAgent'], 0, 300) : null;
    $now = now_instant();

    // Per-IP throttling first, so response differences cannot enumerate accounts.
    if ($ip) {
        $since = (new DateTimeImmutable('now', new DateTimeZone(UTC)))
            ->modify('-' . IP_WINDOW_MINUTES . ' minutes')->format('Y-m-d\TH:i:s.v\Z');
        $recent = (int) scalar($db,
            "SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND at > ? AND outcome <> 'success'",
            [$ip, $since]);
        if ($recent >= IP_ATTEMPT_LIMIT) {
            record_login_attempt($db, $email, $ip, $ua, 'locked');
            return ['ok' => false, 'reason' => 'throttled',
                'message' => 'Too many sign-in attempts from this connection. Try again in 15 minutes.'];
        }
    }

    $user = row($db, 'SELECT * FROM users WHERE email = ?', [$email]);

    if (!$user) {
        // Hash anyway so the response takes the same time as a real check.
        verify_password($input['password'] ?? '', hash_password('timing-equalisation'));
        record_login_attempt($db, $email, $ip, $ua, 'unknown_user');
        return ['ok' => false, 'reason' => 'credentials',
            'message' => 'Email address or password is not correct.'];
    }

    if ($user['locked_until'] && $user['locked_until'] > $now) {
        record_login_attempt($db, $email, $ip, $ua, 'locked', $user['id']);
        return ['ok' => false, 'reason' => 'locked',
            'message' => 'This account is temporarily locked after repeated failed sign-ins. Try again shortly.'];
    }

    if ($user['status'] === 'suspended') {
        record_login_attempt($db, $email, $ip, $ua, 'suspended', $user['id']);
        return ['ok' => false, 'reason' => 'suspended', 'message' => 'This account has been suspended.'];
    }

    $registerFailure = function (string $outcome) use ($db, $user, $email, $ip, $ua, $now): void {
        $attempts = (int) $user['failed_attempts'] + 1;
        $lockUntil = $attempts >= MAX_FAILED_ATTEMPTS
            ? (new DateTimeImmutable('now', new DateTimeZone(UTC)))
                ->modify('+' . LOCKOUT_MINUTES . ' minutes')->format('Y-m-d\TH:i:s.v\Z')
            : null;
        q($db, 'UPDATE users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?',
            [$attempts, $lockUntil, $now, $user['id']]);
        record_login_attempt($db, $email, $ip, $ua, $outcome, $user['id']);
    };

    if (!verify_password($input['password'] ?? '', $user['password_hash'])) {
        $registerFailure('bad_password');
        return ['ok' => false, 'reason' => 'credentials',
            'message' => 'Email address or password is not correct.'];
    }

    if ((int) $user['totp_enabled'] === 1) {
        $totpCode = $input['totpCode'] ?? null;
        $recoveryCode = $input['recoveryCode'] ?? null;

        if (!$totpCode && !$recoveryCode) {
            return ['ok' => false, 'reason' => 'totp_required', 'needsTotp' => true,
                'message' => 'Enter the 6-digit code from your authenticator app.'];
        }

        $passed = false;
        if ($recoveryCode) {
            $updated = consume_recovery_code($user['recovery_codes_json'], $recoveryCode);
            if ($updated !== null) {
                q($db, 'UPDATE users SET recovery_codes_json = ?, updated_at = ? WHERE id = ?',
                    [$updated, $now, $user['id']]);
                $passed = true;
                record_audit($db, [
                    'entityType' => 'user', 'entityId' => $user['id'], 'action' => 'recovery_code_used',
                    'summary' => "Recovery code used to sign in as {$user['email']}", 'actor' => $user['id'],
                ]);
            }
        } elseif ($totpCode && $user['totp_secret_encrypted']) {
            $passed = totp_verify(decrypt_secret($user['totp_secret_encrypted']), (string) $totpCode);
        }

        if (!$passed) {
            $registerFailure('bad_totp');
            return ['ok' => false, 'reason' => 'totp_invalid', 'needsTotp' => true,
                'message' => 'That code is not correct. Codes change every 30 seconds — check the current one.'];
        }
    }

    q($db, 'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ?,
              updated_at = ? WHERE id = ?', [$now, $ip, $now, $user['id']]);
    record_login_attempt($db, $email, $ip, $ua, 'success', $user['id']);

    if (password_needs_upgrade($user['password_hash'])) {
        q($db, 'UPDATE users SET password_hash = ? WHERE id = ?',
            [hash_password($input['password']), $user['id']]);
    }

    $token = create_session_for($db, $user['id'], $ip, $ua);

    return ['ok' => true, 'token' => $token, 'user' => session_user_shape($user)];
}

function session_user_shape(array $user): array {
    return [
        'id' => $user['id'],
        'email' => $user['email'],
        'name' => $user['name'],
        'role' => $user['role'],
        'totpEnabled' => (int) $user['totp_enabled'] === 1,
        'mustChangePassword' => (int) $user['must_change_password'] === 1,
    ];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function create_session_for(PDO $db, string $userId, ?string $ip, ?string $userAgent): string {
    $token = generate_token();
    $now = now_instant();
    $expires = (new DateTimeImmutable('now', new DateTimeZone(UTC)))
        ->modify('+' . SESSION_HOURS . ' hours')->format('Y-m-d\TH:i:s.v\Z');
    q($db, 'INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
            VALUES (?,?,?,?,?,?,?,?)',
        [new_id('sess'), hash_token($token), $userId, $now, $expires, $now, $ip, $userAgent]);
    return $token;
}

function resolve_session(PDO $db, ?string $token): ?array {
    if (!$token) return null;

    $r = row($db, 'SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.revoked_at,
                          u.id, u.email, u.name, u.role, u.status, u.totp_enabled, u.must_change_password
                   FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = ?', [hash_token($token)]);
    if (!$r) return null;

    $now = now_instant();
    if ($r['revoked_at'] || $r['expires_at'] <= $now || $r['status'] !== 'active') return null;

    $idleCutoff = (new DateTimeImmutable('now', new DateTimeZone(UTC)))
        ->modify('-' . SESSION_IDLE_MINUTES . ' minutes')->format('Y-m-d\TH:i:s.v\Z');
    if ($r['last_seen_at'] < $idleCutoff) {
        q($db, "UPDATE sessions SET revoked_at = ?, revoked_reason = 'Idle timeout' WHERE id = ?",
            [$now, $r['session_id']]);
        return null;
    }

    q($db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', [$now, $r['session_id']]);
    return session_user_shape($r);
}

function revoke_session_by_token(PDO $db, string $token, string $reason = 'Signed out'): void {
    q($db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL',
        [now_instant(), $reason, hash_token($token)]);
}

function revoke_all_sessions(PDO $db, string $userId, string $reason): int {
    $stmt = q($db, 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
        [now_instant(), $reason, $userId]);
    return $stmt->rowCount();
}

function active_sessions_for(PDO $db, string $userId): array {
    return rows($db, 'SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions
                      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
                      ORDER BY last_seen_at DESC', [$userId, now_instant()]);
}

/** Housekeeping, run opportunistically — shared hosting has no daemon to do it. */
function prune_expired(PDO $db): void {
    $weekAgo = (new DateTimeImmutable('-7 days', new DateTimeZone(UTC)))->format('Y-m-d\TH:i:s.v\Z');
    $quarterAgo = (new DateTimeImmutable('-90 days', new DateTimeZone(UTC)))->format('Y-m-d\TH:i:s.v\Z');
    q($db, 'DELETE FROM sessions WHERE expires_at < ?', [$weekAgo]);
    q($db, 'DELETE FROM login_attempts WHERE at < ?', [$quarterAgo]);
}
