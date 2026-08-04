import { describe, it, expect, beforeAll } from 'vitest';
import { freshDb } from './helpers.js';
import {
  hashPassword, verifyPassword, needsRehash, generateToken, hashToken,
  encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCodes, consumeRecoveryCode,
} from '../server/auth/crypto.js';
import { generateSecret, currentCode, verifyCode, provisioningUri } from '../server/auth/totp.js';
import { can, maskWorkerPii, capabilitiesFor, requiresTwoFactor } from '../server/auth/permissions.js';
import * as accounts from '../server/auth/accounts.js';
import { invoke, AuthorisationError } from '../server/rpc.js';

beforeAll(() => {
  process.env.APP_SECRET = 'test-application-secret-that-is-long-enough-for-aes';
});

describe('Password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash each time, so identical passwords are not detectable', () => {
    expect(hashPassword('same password')).not.toBe(hashPassword('same password'));
  });

  it('never stores the password in the hash', () => {
    expect(hashPassword('MySecretPassword123')).not.toContain('MySecretPassword');
  });

  it('does not throw on a malformed stored hash', () => {
    expect(verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
  });

  it('flags hashes made with weaker parameters for upgrade', () => {
    expect(needsRehash(hashPassword('x'.repeat(12)))).toBe(false);
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$a2V5')).toBe(true);
  });
});

describe('Token handling', () => {
  it('generates high-entropy, unique tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(tokens.size).toBe(500);
    expect(generateToken().length).toBeGreaterThanOrEqual(40);
  });

  it('stores only the hash, which cannot be reversed to the token', () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);  // deterministic, so lookup works
  });
});

describe('Secret encryption', () => {
  it('round-trips a TOTP secret', () => {
    const secret = generateSecret();
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces different ciphertext each time', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const payload = encryptSecret('sensitive');
    const [iv, tag, data] = payload.split('.');
    const tampered = `${iv}.${tag}.${Buffer.from('different').toString('base64')}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe('TOTP', () => {
  it('accepts the current code and rejects a wrong one', () => {
    const secret = generateSecret();
    expect(verifyCode(secret, currentCode(secret))).toBe(true);
    expect(verifyCode(secret, '000000')).toBe(false);
    expect(verifyCode(secret, 'abcdef')).toBe(false);
    expect(verifyCode(secret, '')).toBe(false);
  });

  it('tolerates a clock one window out but not five minutes out', () => {
    const secret = generateSecret();
    const now = new Date('2026-08-04T12:00:00Z');
    const thirtySecondsAgo = new Date(now.getTime() - 30_000);
    const fiveMinutesAgo = new Date(now.getTime() - 300_000);

    expect(verifyCode(secret, currentCode(secret, thirtySecondsAgo), now)).toBe(true);
    expect(verifyCode(secret, currentCode(secret, fiveMinutesAgo), now)).toBe(false);
  });

  it('matches the RFC 6238 reference vector', () => {
    // Secret "12345678901234567890" in base32, at T=59s, gives 287082.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(currentCode(secret, new Date(59_000))).toBe('287082');
  });

  it('builds a provisioning URI an authenticator app can read', () => {
    const uri = provisioningUri('ABCDEFGHIJKLMNOP', 'owner@cerviz.co.uk');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=ABCDEFGHIJKLMNOP');
    expect(uri).toContain('digits=6');
  });
});

describe('Recovery codes', () => {
  it('accepts a code once and never again', () => {
    const codes = generateRecoveryCodes();
    let stored = hashRecoveryCodes(codes);

    const updated = consumeRecoveryCode(stored, codes[0]);
    expect(updated).not.toBeNull();
    stored = updated!;

    expect(consumeRecoveryCode(stored, codes[0])).toBeNull();     // already used
    expect(consumeRecoveryCode(stored, codes[1])).not.toBeNull(); // others still work
  });

  it('ignores formatting differences', () => {
    const codes = generateRecoveryCodes();
    const stored = hashRecoveryCodes(codes);
    expect(consumeRecoveryCode(stored, codes[0].toLowerCase().replace('-', ' '))).not.toBeNull();
  });

  it('rejects an invented code', () => {
    expect(consumeRecoveryCode(hashRecoveryCodes(generateRecoveryCodes()), 'AAAAA-BBBBB')).toBeNull();
  });
});

describe('Sign-in', () => {
  function withOwner() {
    const db = freshDb();
    const id = accounts.createUser(db, {
      email: 'owner@cerviz.co.uk', name: 'Owner', role: 'owner',
      password: 'a-long-enough-password', mustChangePassword: false,
    });
    return { db, id };
  }

  it('signs in with the right password', () => {
    const { db } = withOwner();
    const result = accounts.login(db, { email: 'owner@cerviz.co.uk', password: 'a-long-enough-password' });
    expect(result.ok).toBe(true);
  });

  it('gives the same message for a wrong password and an unknown account', () => {
    const { db } = withOwner();
    const wrongPassword = accounts.login(db, { email: 'owner@cerviz.co.uk', password: 'nope-nope-nope' });
    const unknownUser = accounts.login(db, { email: 'nobody@cerviz.co.uk', password: 'nope-nope-nope' });

    expect(wrongPassword.ok).toBe(false);
    expect(unknownUser.ok).toBe(false);
    // Identical wording, so the response cannot be used to discover which
    // addresses have accounts.
    expect((wrongPassword as any).message).toBe((unknownUser as any).message);
  });

  it('locks the account after five failures and records every attempt', () => {
    const { db } = withOwner();
    for (let i = 0; i < 5; i++) {
      accounts.login(db, { email: 'owner@cerviz.co.uk', password: 'wrong-password-here' });
    }
    const result = accounts.login(db, { email: 'owner@cerviz.co.uk', password: 'a-long-enough-password' });
    expect(result.ok).toBe(false);
    expect((result as any).reason).toBe('locked');

    const attempts = db.prepare('SELECT outcome, COUNT(*) AS n FROM login_attempts GROUP BY outcome').all() as any[];
    expect(attempts.find((a) => a.outcome === 'bad_password').n).toBe(5);
  });

  it('throttles by IP so an attacker cannot spread guesses across accounts', () => {
    const db = freshDb();
    for (let i = 0; i < 21; i++) {
      accounts.login(db, { email: `person${i}@example.com`, password: 'guessing-away-here', ip: '203.0.113.9' });
    }
    const result = accounts.login(db, {
      email: 'someone@example.com', password: 'guessing-away-here', ip: '203.0.113.9',
    });
    expect((result as any).reason).toBe('throttled');
  });

  it('refuses a suspended account even with the right password', () => {
    const { db, id } = withOwner();
    accounts.createUser(db, {
      email: 'second@cerviz.co.uk', name: 'Second Owner', role: 'owner', password: 'another-long-password',
    });
    accounts.updateUser(db, id, { status: 'suspended' }, 'system');
    const result = accounts.login(db, { email: 'owner@cerviz.co.uk', password: 'a-long-enough-password' });
    expect((result as any).reason).toBe('suspended');
  });

  it('demands a second factor once two-factor is enabled', () => {
    const { db, id } = withOwner();
    const { secret } = accounts.beginTwoFactorSetup(db, id);
    accounts.confirmTwoFactorSetup(db, id, currentCode(secret));

    const noCode = accounts.login(db, { email: 'owner@cerviz.co.uk', password: 'a-long-enough-password' });
    expect(noCode.ok).toBe(false);
    expect((noCode as any).reason).toBe('totp_required');

    const badCode = accounts.login(db, {
      email: 'owner@cerviz.co.uk', password: 'a-long-enough-password', totpCode: '000000',
    });
    expect(badCode.ok).toBe(false);

    const goodCode = accounts.login(db, {
      email: 'owner@cerviz.co.uk', password: 'a-long-enough-password', totpCode: currentCode(secret),
    });
    expect(goodCode.ok).toBe(true);
  });

  it('will not enable two-factor without a working code', () => {
    const { db, id } = withOwner();
    accounts.beginTwoFactorSetup(db, id);
    expect(() => accounts.confirmTwoFactorSetup(db, id, '000000')).toThrow(/not correct/i);
  });

  it('rejects weak passwords at account creation', () => {
    const db = freshDb();
    const attempt = (password: string) => () => accounts.createUser(db, {
      email: `u${Math.random()}@cerviz.co.uk`, name: 'X', role: 'readonly', password,
    });
    expect(attempt('short')).toThrow(/at least 12/i);
    expect(attempt('password1234')).toThrow(/too easy to guess/i);
    expect(attempt('aaaaaaaaaaaaaa')).toThrow(/repeated character/i);
    expect(attempt('a-perfectly-fine-password')).not.toThrow();
  });
});

describe('Sessions', () => {
  function signedIn() {
    const db = freshDb();
    accounts.createUser(db, {
      email: 'owner@cerviz.co.uk', name: 'Owner', role: 'owner',
      password: 'a-long-enough-password', mustChangePassword: false,
    });
    const result = accounts.login(db, {
      email: 'owner@cerviz.co.uk', password: 'a-long-enough-password',
    }) as any;
    return { db, token: result.token as string };
  }

  it('resolves a valid session and rejects nonsense', () => {
    const { db, token } = signedIn();
    expect(accounts.resolveSession(db, token)?.email).toBe('owner@cerviz.co.uk');
    expect(accounts.resolveSession(db, 'made-up-token')).toBeNull();
    expect(accounts.resolveSession(db, undefined)).toBeNull();
  });

  it('stores only the token hash, so a database copy yields no live sessions', () => {
    const { db, token } = signedIn();
    const stored = db.prepare('SELECT token_hash FROM sessions').get() as any;
    expect(stored.token_hash).not.toBe(token);
    expect(stored.token_hash).toBe(hashToken(token));
  });

  it('stops working once signed out', () => {
    const { db, token } = signedIn();
    accounts.revokeSessionByToken(db, token);
    expect(accounts.resolveSession(db, token)).toBeNull();
  });

  it('ends every session when the role changes, rather than at next sign-in', () => {
    const { db, token } = signedIn();
    const user = accounts.resolveSession(db, token)!;
    accounts.createUser(db, {
      email: 'other@cerviz.co.uk', name: 'Other', role: 'owner', password: 'another-long-password',
    });
    accounts.updateUser(db, user.id, { role: 'readonly' }, 'system');
    expect(accounts.resolveSession(db, token)).toBeNull();
  });

  it('expires an idle session', () => {
    const { db, token } = signedIn();
    db.prepare('UPDATE sessions SET last_seen_at = ?')
      .run(new Date(Date.now() - 3 * 3600_000).toISOString());
    expect(accounts.resolveSession(db, token)).toBeNull();
  });
});

describe('Roles and permissions', () => {
  it('gives the owner everything and read-only nothing that writes', () => {
    expect(can('owner', 'users.manage')).toBe(true);
    expect(can('owner', 'invoices.void')).toBe(true);
    expect(can('readonly', 'invoices.issue')).toBe(false);
    expect(can('readonly', 'workers.write')).toBe(false);
    expect(can('readonly', 'workers.pii')).toBe(false);
  });

  it('keeps compliance out of the money and finance out of personal data', () => {
    expect(can('compliance', 'workers.pii')).toBe(true);
    expect(can('compliance', 'invoices.read')).toBe(false);
    expect(can('compliance', 'rates.read')).toBe(false);

    expect(can('finance', 'invoices.issue')).toBe(true);
    expect(can('finance', 'workers.pii')).toBe(false);
  });

  it('gives the scheduler the rota but not rates or personal data', () => {
    expect(can('scheduler', 'rota.write')).toBe(true);
    expect(can('scheduler', 'timesheets.write')).toBe(true);
    expect(can('scheduler', 'rates.read')).toBe(false);
    expect(can('scheduler', 'workers.pii')).toBe(false);
    expect(can('scheduler', 'timesheets.approve')).toBe(false);
  });

  it('requires two-factor for every role', () => {
    for (const role of ['owner', 'compliance', 'scheduler', 'finance', 'readonly'] as const) {
      expect(requiresTwoFactor(role)).toBe(true);
    }
  });

  it('never leaves a capability unassigned to the owner', () => {
    const ownerCaps = capabilitiesFor('owner');
    for (const role of ['compliance', 'scheduler', 'finance', 'readonly'] as const) {
      for (const cap of capabilitiesFor(role)) expect(ownerCaps).toContain(cap);
    }
  });
});

describe('Personal data masking', () => {
  const worker = {
    id: 'w1', first_name: 'Grace', last_name: 'Okonkwo',
    date_of_birth: '1986-04-30', ni_number: 'JN456789B',
    address_1: '1 Worker Street', postcode: 'M1 3AA',
    bank_account_number: '12345678', default_pay_rate_pence: 1400,
  };

  it('leaves the record intact for someone allowed to see it', () => {
    expect(maskWorkerPii(worker, true).ni_number).toBe('JN456789B');
  });

  it('hides personal fields but keeps what the job needs', () => {
    const masked = maskWorkerPii(worker, false);
    expect(masked.ni_number).not.toBe('JN456789B');
    expect(masked.date_of_birth).not.toBe('1986-04-30');
    expect(masked.bank_account_number).not.toBe('12345678');
    // Name and pay rate are still needed to run a rota and a timesheet.
    expect(masked.first_name).toBe('Grace');
    expect(masked.default_pay_rate_pence).toBe(1400);
  });

  it('masks inside nested structures and arrays', () => {
    const nested = { workers: [worker], meta: { inner: { ni_number: 'JN456789B' } } };
    const masked = maskWorkerPii(nested, false);
    expect(masked.workers[0].ni_number).not.toBe('JN456789B');
    expect(masked.meta.inner.ni_number).not.toBe('JN456789B');
  });

  it('leaves empty values alone rather than inventing data', () => {
    expect(maskWorkerPii({ ni_number: null }, false).ni_number).toBeNull();
  });
});

describe('Operation authorisation', () => {
  function ctxFor(role: any) {
    const db = freshDb();
    return {
      db, dataDir: '/tmp',
      user: { id: 'u1', email: 'x@cerviz.co.uk', name: 'X', role, totpEnabled: true, mustChangePassword: false },
    };
  }

  it('refuses an operation the role does not hold', () => {
    const ctx = ctxFor('scheduler');
    expect(() => invoke(ctx as any, 'invoices:issue', { id: 'x' })).toThrow(AuthorisationError);
    expect(() => invoke(ctx as any, 'users:list', {})).toThrow(AuthorisationError);
  });

  it('allows an operation the role does hold', () => {
    const ctx = ctxFor('scheduler');
    expect(() => invoke(ctx as any, 'shifts:list', {})).not.toThrow();
  });

  it('refuses an unknown operation rather than failing open', () => {
    expect(() => invoke(ctxFor('owner') as any, 'nonexistent:operation', {})).toThrow(/Unknown operation/);
  });

  it('strips worker personal data from list results for a scheduler', () => {
    const ctx = ctxFor('scheduler');
    ctx.db.prepare(
      `INSERT INTO workers (id, first_name, last_name, ni_number, date_of_birth, engagement_type,
         status, created_at, updated_at)
       VALUES ('w1','Grace','Okonkwo','JN456789B','1986-04-30','paye','active','2026-01-01','2026-01-01')`,
    ).run();

    const rows = invoke(ctx as any, 'workers:list', {}) as any[];
    expect(rows[0].last_name).toBe('Okonkwo');
    expect(rows[0].ni_number).not.toBe('JN456789B');
  });

  it('lets compliance see personal data because the job requires it', () => {
    const ctx = ctxFor('compliance');
    ctx.db.prepare(
      `INSERT INTO workers (id, first_name, last_name, ni_number, date_of_birth, engagement_type,
         status, created_at, updated_at)
       VALUES ('w1','Grace','Okonkwo','JN456789B','1986-04-30','paye','active','2026-01-01','2026-01-01')`,
    ).run();

    const rows = invoke(ctx as any, 'workers:list', {}) as any[];
    expect(rows[0].ni_number).toBe('JN456789B');
  });
});

describe('Owner safety', () => {
  it('refuses to demote or suspend the last active owner', () => {
    const db = freshDb();
    const id = accounts.createUser(db, {
      email: 'only@cerviz.co.uk', name: 'Only Owner', role: 'owner', password: 'a-long-enough-password',
    });
    expect(() => accounts.updateUser(db, id, { role: 'readonly' }, 'system')).toThrow(/only active owner/i);
    expect(() => accounts.updateUser(db, id, { status: 'suspended' }, 'system')).toThrow(/only active owner/i);
  });

  it('allows it once a second owner exists', () => {
    const db = freshDb();
    const first = accounts.createUser(db, {
      email: 'first@cerviz.co.uk', name: 'First', role: 'owner', password: 'a-long-enough-password',
    });
    accounts.createUser(db, {
      email: 'second@cerviz.co.uk', name: 'Second', role: 'owner', password: 'another-long-password',
    });
    expect(() => accounts.updateUser(db, first, { role: 'finance' }, 'system')).not.toThrow();
  });

  it('rejects a duplicate email address regardless of case', () => {
    const db = freshDb();
    accounts.createUser(db, {
      email: 'person@cerviz.co.uk', name: 'Person', role: 'finance', password: 'a-long-enough-password',
    });
    expect(() => accounts.createUser(db, {
      email: 'PERSON@cerviz.co.uk', name: 'Impostor', role: 'owner', password: 'another-long-password',
    })).toThrow(/already exists/i);
  });
});

describe('Reported capabilities', () => {
  /**
   * The interface decides which pages to show from the capability list the
   * server reports. A hand-maintained list here once silently hid Workers,
   * Rota, Clients, Timesheets, Invoices and Settings from the owner, so this
   * asserts the reported list is the role's real one.
   */
  function meFor(role: any) {
    const db = freshDb();
    return invoke(
      { db, dataDir: '/tmp', user: { id: 'u1', email: 'x@cerviz.co.uk', name: 'X', role, totpEnabled: true, mustChangePassword: false } } as any,
      'me', {},
    ) as any;
  }

  it('reports every capability the role actually holds', () => {
    for (const role of ['owner', 'compliance', 'scheduler', 'finance', 'readonly'] as const) {
      expect(meFor(role).capabilities.sort()).toEqual(capabilitiesFor(role).sort());
    }
  });

  it('gives the owner every page the navigation can show', () => {
    const caps: string[] = meFor('owner').capabilities;
    for (const needed of ['workers.read', 'rota.read', 'clients.read', 'timesheets.read',
      'invoices.read', 'purchases.read', 'reports.read', 'statutory.read',
      'settings.read', 'users.manage']) {
      expect(caps).toContain(needed);
    }
  });

  it('does not report capabilities the role lacks', () => {
    expect(meFor('scheduler').capabilities).not.toContain('invoices.read');
    expect(meFor('finance').capabilities).not.toContain('workers.pii');
    expect(meFor('readonly').capabilities).not.toContain('users.manage');
  });
});
