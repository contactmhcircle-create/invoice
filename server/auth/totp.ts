import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), implemented directly.
 *
 * It is about sixty lines and removes a dependency from the authentication
 * path, which is the last place you want a supply-chain surprise. Works with
 * Google Authenticator, Authy, 1Password, Microsoft Authenticator and any other
 * standard app.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** Accept the previous and next window, so a phone clock a few seconds out still works. */
const DRIFT_WINDOWS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(): string {
  const buffer = randomBytes(20); // 160 bits, as RFC 4226 recommends
  return base32Encode(buffer);
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid character in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function codeForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);

  const buffer = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer; JavaScript bitwise ops are 32-bit,
  // so the high and low halves are written separately.
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', key).update(buffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentCode(secret: string, at: Date = new Date()): string {
  return codeForCounter(secret, Math.floor(at.getTime() / 1000 / PERIOD_SECONDS));
}

/**
 * Verifies a submitted code, allowing one window either side for clock drift.
 * Comparison is constant-time so a response cannot be timed to leak digits.
 */
export function verifyCode(secret: string, submitted: string, at: Date = new Date()): boolean {
  const clean = submitted.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;

  const counter = Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
  for (let drift = -DRIFT_WINDOWS; drift <= DRIFT_WINDOWS; drift++) {
    const expected = codeForCounter(secret, counter + drift);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans as a QR code. */
export function provisioningUri(secret: string, accountEmail: string, issuer = 'Cerviz Back Office'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
