import {
  scryptSync, randomBytes, timingSafeEqual, createHash,
  createCipheriv, createDecipheriv,
} from 'node:crypto';

/**
 * Password hashing, secret encryption and token generation.
 *
 * Everything here uses Node's built-in crypto rather than a native module.
 * That is deliberate: native modules have to be rebuilt per runtime, and an
 * ABI mismatch on the machine that hashes passwords is the kind of deployment
 * failure that tempts people into "temporarily" weakening auth.
 */

// scrypt parameters. N is the dominant cost; 2^16 takes roughly 100ms on modest
// hardware, which is slow enough to make offline cracking expensive and fast
// enough that signing in feels instant.
const SCRYPT_N = 65536;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Returns `scrypt$N$r$p$salt$key`. Parameters travel with the hash so they can
 * be raised later without invalidating existing passwords.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash used weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const [scheme, n] = stored.split('$');
  return scheme !== 'scrypt' || Number(n) < SCRYPT_N;
}

// ---------------------------------------------------------------------------
// Session and reset tokens
// ---------------------------------------------------------------------------

/** 256 bits of entropy, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored hashed, so a database copy does not hand over live
 * sessions. SHA-256 is right here rather than scrypt: the token is already
 * high-entropy, so there is nothing to brute-force, and lookups must be fast.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Encryption at rest for TOTP secrets
// ---------------------------------------------------------------------------

/**
 * The application key comes from the environment and never touches the
 * database, so a stolen database file alone cannot be used to generate a user's
 * two-factor codes.
 */
function applicationKey(): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'APP_SECRET must be set to at least 32 characters. Generate one with: openssl rand -base64 48',
    );
  }
  // Derived rather than used directly, so the env var need not be exactly 32 bytes.
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', applicationKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = createDecipheriv('aes-256-gcm', applicationKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Ten single-use codes, shown once at setup. Without these, a lost phone means
 * losing access to six years of statutory records.
 */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function hashRecoveryCodes(codes: string[]): string {
  return JSON.stringify(codes.map((c) => ({ hash: hashToken(normaliseRecoveryCode(c)), used: false })));
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Consumes a code if it matches an unused one; returns the updated JSON or null. */
export function consumeRecoveryCode(storedJson: string | null, submitted: string): string | null {
  if (!storedJson) return null;
  const codes = JSON.parse(storedJson) as Array<{ hash: string; used: boolean }>;
  const target = hashToken(normaliseRecoveryCode(submitted));
  const match = codes.find((c) => !c.used && constantTimeEquals(c.hash, target));
  if (!match) return null;
  match.used = true;
  return JSON.stringify(codes);
}
