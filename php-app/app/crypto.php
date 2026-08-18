<?php
/**
 * Passwords, tokens, secret encryption and recovery codes — the PHP
 * counterpart of server/auth/crypto.ts.
 *
 * Passwords use PHP's native password_hash with Argon2id where the build has
 * it (Hostinger's PHP does) and bcrypt otherwise; password_needs_rehash gives
 * the same opportunistic-upgrade behaviour the Node version had. TOTP secrets
 * are AES-256-GCM encrypted with a key derived from APP_SECRET, which lives in
 * the config file and never in the database — a stolen database file alone
 * cannot generate a user's two-factor codes.
 */

declare(strict_types=1);

function password_algo(): string|int|null {
    return defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT;
}

function hash_password(string $password): string {
    return password_hash(mb_convert_kana($password, '', 'UTF-8') === '' ? $password : $password, password_algo());
}

function verify_password(string $password, string $stored): bool {
    if ($stored === '') return false;
    return password_verify($password, $stored);
}

function password_needs_upgrade(string $stored): bool {
    return password_needs_rehash($stored, password_algo());
}

// ---------------------------------------------------------------------------
// Tokens — high entropy, stored only as hashes
// ---------------------------------------------------------------------------

function generate_token(): string {
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}

function hash_token(string $token): string {
    return hash('sha256', $token);
}

// ---------------------------------------------------------------------------
// Encryption at rest for TOTP secrets
// ---------------------------------------------------------------------------

function application_key(): string {
    $secret = defined('APP_SECRET') ? APP_SECRET : (getenv('APP_SECRET') ?: '');
    if (strlen($secret) < 32) {
        throw new RuntimeException('APP_SECRET must be at least 32 characters. Delete data/config.php and reload to regenerate the installation.');
    }
    return hash('sha256', $secret, true);
}

function encrypt_secret(string $plaintext): string {
    $iv = random_bytes(12);
    $tag = '';
    $ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', application_key(), OPENSSL_RAW_DATA, $iv, $tag);
    if ($ciphertext === false) throw new RuntimeException('Encryption failed');
    return base64_encode($iv) . '.' . base64_encode($tag) . '.' . base64_encode($ciphertext);
}

function decrypt_secret(string $payload): string {
    [$ivB64, $tagB64, $dataB64] = explode('.', $payload);
    $plain = openssl_decrypt(base64_decode($dataB64), 'aes-256-gcm', application_key(),
        OPENSSL_RAW_DATA, base64_decode($ivB64), base64_decode($tagB64));
    if ($plain === false) throw new RuntimeException('Decryption failed — the data or the key has changed');
    return $plain;
}

// ---------------------------------------------------------------------------
// Recovery codes — ten single-use codes, stored hashed
// ---------------------------------------------------------------------------

function generate_recovery_codes(int $count = 10): array {
    $codes = [];
    for ($i = 0; $i < $count; $i++) {
        $raw = strtoupper(bin2hex(random_bytes(5)));
        $codes[] = substr($raw, 0, 5) . '-' . substr($raw, 5, 5);
    }
    return $codes;
}

function normalise_recovery_code(string $code): string {
    return preg_replace('/[^A-Z0-9]/', '', strtoupper($code));
}

function hash_recovery_codes(array $codes): string {
    return json_encode(array_map(
        fn($c) => ['hash' => hash_token(normalise_recovery_code($c)), 'used' => false],
        $codes,
    ));
}

/** Consumes a matching unused code; returns updated JSON, or null if no match. */
function consume_recovery_code(?string $storedJson, string $submitted): ?string {
    if (!$storedJson) return null;
    $codes = json_decode($storedJson, true);
    $target = hash_token(normalise_recovery_code($submitted));
    foreach ($codes as $i => $c) {
        if (!$c['used'] && hash_equals($c['hash'], $target)) {
            $codes[$i]['used'] = true;
            return json_encode($codes);
        }
    }
    return null;
}
