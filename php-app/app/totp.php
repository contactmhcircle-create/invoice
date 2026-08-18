<?php
/**
 * Time-based one-time passwords (RFC 6238) — port of server/auth/totp.ts.
 * Implemented directly rather than via a dependency: it is sixty lines, and the
 * authentication path is the last place to want a supply-chain surprise.
 */

declare(strict_types=1);

const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_DRIFT = 1;
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function totp_generate_secret(): string {
    return base32_encode(random_bytes(20)); // 160 bits per RFC 4226
}

function base32_encode(string $bytes): string {
    $bits = 0; $value = 0; $out = '';
    foreach (str_split($bytes) as $ch) {
        $value = ($value << 8) | ord($ch);
        $bits += 8;
        while ($bits >= 5) {
            $out .= B32_ALPHABET[($value >> ($bits - 5)) & 31];
            $bits -= 5;
        }
    }
    if ($bits > 0) $out .= B32_ALPHABET[($value << (5 - $bits)) & 31];
    return $out;
}

function base32_decode_str(string $input): string {
    $clean = preg_replace('/\s|=+$/', '', strtoupper($input));
    $bits = 0; $value = 0; $out = '';
    foreach (str_split($clean) as $ch) {
        $index = strpos(B32_ALPHABET, $ch);
        if ($index === false) throw new RuntimeException('Invalid character in TOTP secret');
        $value = ($value << 5) | $index;
        $bits += 5;
        if ($bits >= 8) {
            $out .= chr(($value >> ($bits - 8)) & 255);
            $bits -= 8;
        }
    }
    return $out;
}

function totp_code_for_counter(string $secret, int $counter): string {
    $key = base32_decode_str($secret);
    $binary = pack('J', $counter); // 64-bit big-endian
    $hmac = hash_hmac('sha1', $binary, $key, true);
    $offset = ord($hmac[strlen($hmac) - 1]) & 0x0f;
    $value = ((ord($hmac[$offset]) & 0x7f) << 24)
        | ((ord($hmac[$offset + 1]) & 0xff) << 16)
        | ((ord($hmac[$offset + 2]) & 0xff) << 8)
        | (ord($hmac[$offset + 3]) & 0xff);
    return str_pad((string) ($value % (10 ** TOTP_DIGITS)), TOTP_DIGITS, '0', STR_PAD_LEFT);
}

function totp_current_code(string $secret, ?int $atUnix = null): string {
    $at = $atUnix ?? time();
    return totp_code_for_counter($secret, intdiv($at, TOTP_PERIOD));
}

/** One window either side for clock drift; constant-time comparison. */
function totp_verify(string $secret, string $submitted, ?int $atUnix = null): bool {
    $clean = preg_replace('/\s/', '', $submitted);
    if (!preg_match('/^\d{6}$/', $clean)) return false;
    $counter = intdiv($atUnix ?? time(), TOTP_PERIOD);
    for ($drift = -TOTP_DRIFT; $drift <= TOTP_DRIFT; $drift++) {
        if (hash_equals(totp_code_for_counter($secret, $counter + $drift), $clean)) return true;
    }
    return false;
}

function totp_provisioning_uri(string $secret, string $accountEmail, string $issuer = 'Cerviz Back Office'): string {
    $label = rawurlencode("$issuer:$accountEmail");
    $params = http_build_query([
        'secret' => $secret, 'issuer' => $issuer,
        'algorithm' => 'SHA1', 'digits' => TOTP_DIGITS, 'period' => TOTP_PERIOD,
    ]);
    return "otpauth://totp/$label?$params";
}
