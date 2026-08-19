import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';

import { openDatabase } from '../core/db/connection.js';
import type { Db } from '../core/db/connection.js';
import { recordAudit } from '../core/db/audit.js';
import { attachDocument } from '../core/services/documents.js';
import { renderInvoiceHtml, invoiceLinesCsv } from '../core/services/invoiceDocument.js';
import { buildRegister, renderRegisterHtml, registerCsv } from '../core/services/registers.js';
import { buildEnquiryPack, renderEnquiryPackHtml } from '../core/services/enquiryPack.js';
import { importTideStatement, exportLedgerCsv, exportSalesCsv } from '../core/services/tide.js';
import { generateIntermediaryReport, intermediaryReportCsv, markIntermediaryReportSubmitted } from '../core/services/statutory.js';
import { backupDatabase, listBackups } from '../core/services/backup.js';

import { invoke, AuthorisationError } from './rpc.js';
import * as accounts from './auth/accounts.js';
import { can, capabilitiesFor, ROLE_LABELS, ROLE_DESCRIPTIONS } from './auth/permissions.js';

const here = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const COOKIE_NAME = 'cerviz_session';
const CSRF_COOKIE = 'cerviz_csrf';

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(join(DATA_DIR, 'documents'), { recursive: true });
mkdirSync(join(DATA_DIR, 'backups'), { recursive: true });

const dbPath = join(DATA_DIR, 'cerviz.sqlite');
const db: Db = openDatabase(dbPath);

// A backup on every start means the worst case is losing one session's work.
try {
  backupDatabase(db, dbPath, join(DATA_DIR, 'backups'));
} catch (err) {
  console.error('Startup backup failed:', err);
}

const bootstrap = accounts.ensureFirstOwner(db);
if (bootstrap.created) {
  console.log(`Created the first owner account: ${bootstrap.email}`);
  console.log('Sign in and change the password immediately — it is currently the one from the environment.');
}

const app = Fastify({
  logger: { level: IS_PRODUCTION ? 'warn' : 'info' },
  trustProxy: true,          // behind the platform's TLS terminator
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  if (IS_PRODUCTION) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Asset filenames carry a content hash, so they can be cached indefinitely.
  // Everything else must not be, or a deploy leaves people on the old bundle
  // talking to a new API.
  if (request.url.startsWith('/assets/')) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (!request.url.startsWith('/api/')) {
    reply.header('Cache-Control', 'no-store');
  }

  // Printable documents need inline styles; the app shell does not.
  const isDocument = request.url.includes('/document') || request.url.includes('/enquiry-pack');
  reply.header(
    'Content-Security-Policy',
    isDocument
      ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return payload;
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    currentUser?: accounts.SessionUser;
  }
}

const PUBLIC_PATHS = new Set([
  '/api/auth/login', '/api/auth/roles', '/api/auth/session', '/api/health',
]);

app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  if (PUBLIC_PATHS.has(request.url.split('?')[0])) return;

  const token = request.cookies[COOKIE_NAME];
  const user = accounts.resolveSession(db, token);

  if (!user) {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return reply.code(401).send({ ok: false, error: 'Your session has ended. Please sign in again.' });
  }

  // Double-submit CSRF: a cross-site form cannot read the cookie to echo it
  // back in the header, and SameSite=Strict already blocks the common cases.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const headerToken = request.headers['x-cerviz-csrf'];
    const cookieToken = request.cookies[CSRF_COOKIE];
    if (!headerToken || !cookieToken || headerToken !== cookieToken) {
      return reply.code(403).send({ ok: false, error: 'Request rejected. Refresh the page and try again.' });
    }
  }

  request.currentUser = user;
});

function setSessionCookies(reply: any, token: string) {
  const csrf = randomBytes(24).toString('base64url');
  const base = {
    path: '/',
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'strict' as const,
    maxAge: 12 * 3600,
  };
  reply.setCookie(COOKIE_NAME, token, base);
  // Readable by the app so it can echo it back; that is the point of the pattern.
  reply.setCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
}

app.post('/api/auth/login', async (request, reply) => {
  const body = request.body as any;
  const result = accounts.login(db, {
    email: String(body?.email ?? ''),
    password: String(body?.password ?? ''),
    totpCode: body?.totpCode ? String(body.totpCode) : undefined,
    recoveryCode: body?.recoveryCode ? String(body.recoveryCode) : undefined,
    ip: request.ip,
    userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
  });

  if (!result.ok) {
    const code = result.reason === 'totp_required' || result.reason === 'totp_invalid' ? 200 : 401;
    return reply.code(code).send({
      ok: false, error: result.message, needsTotp: result.needsTotp ?? false, reason: result.reason,
    });
  }

  setSessionCookies(reply, result.token);
  return { ok: true, data: result.user };
});

app.post('/api/auth/logout', async (request, reply) => {
  const token = request.cookies[COOKIE_NAME];
  if (token) accounts.revokeSessionByToken(db, token);
  reply.clearCookie(COOKIE_NAME, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
  return { ok: true, data: true };
});

app.get('/api/auth/roles', async () =>
  ({ ok: true, data: Object.entries(ROLE_LABELS).map(([id, label]) => ({ id, label, description: ROLE_DESCRIPTIONS[id as keyof typeof ROLE_DESCRIPTIONS] })) }));

/**
 * Who is signed in, if anyone. Returns 200 with null rather than 401 so that the
 * app's start-up check is not an error — a browser logs every 401 to the
 * console, and real problems should not have to compete with expected ones.
 */
app.get('/api/auth/session', async (request) => {
  const user = accounts.resolveSession(db, request.cookies[COOKIE_NAME]);
  if (!user) return { ok: true, data: null };
  return { ok: true, data: { ...user, capabilities: capabilitiesFor(user.role) } };
});

app.get('/api/health', async () => ({ ok: true, status: 'up', time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// The operation endpoint
// ---------------------------------------------------------------------------

app.post('/api/rpc', async (request, reply) => {
  const { channel, payload } = (request.body ?? {}) as { channel?: string; payload?: unknown };
  if (!channel) return reply.code(400).send({ ok: false, error: 'No operation named.' });

  try {
    const data = invoke(
      { db, user: request.currentUser!, dataDir: DATA_DIR, ip: request.ip },
      channel,
      payload,
    );
    return { ok: true, data };
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof AuthorisationError) return reply.code(403).send({ ok: false, error: message });
    // Business-rule refusals are expected and belong to the user, not the logs.
    request.log.debug({ channel, message }, 'operation refused');
    return reply.code(400).send({ ok: false, error: message });
  }
});

// ---------------------------------------------------------------------------
// Documents and downloads
// ---------------------------------------------------------------------------

function requireCapability(request: any, reply: any, capability: any): boolean {
  if (!can(request.currentUser.role, capability)) {
    reply.code(403).send({ ok: false, error: 'Your role does not have permission to do this.' });
    return false;
  }
  return true;
}

/**
 * Invoices and the enquiry pack are served as printable HTML rather than
 * generated PDFs. The browser's own "Save as PDF" produces a proper file, which
 * avoids shipping a headless browser in the container for something every device
 * can already do.
 */
app.get('/api/invoices/:id/document', async (request, reply) => {
  if (!requireCapability(request, reply, 'invoices.read')) return;
  const { id } = request.params as { id: string };
  const { format = 'html' } = request.query as { format?: string };
  try {
    if (format === 'doc') {
      // Word opens HTML happily when served as msword — an editable copy with
      // no dependency and no conversion step.
      const inv = db.prepare('SELECT number FROM invoices WHERE id = ?').get(id) as any;
      reply.type('application/msword');
      reply.header('Content-Disposition', `attachment; filename="${inv?.number ?? 'invoice'}.doc"`);
      return renderInvoiceHtml(db, id, true);
    }
    if (format === 'csv') {
      const inv = db.prepare('SELECT number FROM invoices WHERE id = ?').get(id) as any;
      reply.type('text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${inv?.number ?? 'invoice'}.csv"`);
      return invoiceLinesCsv(db, id);
    }
    reply.type('text/html; charset=utf-8');
    return renderInvoiceHtml(db, id);
  } catch (err) {
    return reply.code(404).send({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/registers/:type', async (request, reply) => {
  if (!requireCapability(request, reply, 'statutory.read')) return;
  const { type } = request.params as { type: string };
  const { from, to, format = 'html' } = request.query as { from?: string; to?: string; format?: string };
  try {
    const reg = buildRegister(db, type, from, to);
    if (format === 'csv') {
      reply.type('text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${type}-register.csv"`);
      return registerCsv(reg);
    }
    reply.type('text/html; charset=utf-8');
    return renderRegisterHtml(db, reg);
  } catch (err) {
    return reply.code(400).send({ ok: false, error: (err as Error).message });
  }
});

/**
 * Companies House lookup for auto-filling counterparty records. Uses the free
 * official API; the key lives in settings and never reaches the browser.
 */
app.get('/api/companies-house/:number', async (request, reply) => {
  if (!requireCapability(request, reply, 'clients.read')) return;
  const raw = String((request.params as any).number).trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(raw)) {
    return reply.code(400).send({ ok: false, error: 'Enter a company number, e.g. 09985380.' });
  }
  const key = (db.prepare(`SELECT value FROM settings WHERE key = 'companies_house_api_key'`).get() as any)?.value;
  if (!key) {
    return reply.code(400).send({
      ok: false,
      error: 'No Companies House API key is set. Get a free key at developer.company-information.service.gov.uk and save it under Settings.',
    });
  }
  try {
    const res = await fetch(`https://api.company-information.service.gov.uk/company/${raw.padStart(8, '0')}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
    });
    if (res.status === 404) return reply.code(404).send({ ok: false, error: 'No company found with that number.' });
    if (res.status === 401) return reply.code(400).send({ ok: false, error: 'Companies House rejected the API key. Check it under Settings.' });
    if (!res.ok) return reply.code(502).send({ ok: false, error: `Companies House returned ${res.status}. Try again shortly.` });
    const d = (await res.json()) as any;
    return {
      ok: true,
      data: {
        companyNumber: d.company_number,
        name: d.company_name,
        status: d.company_status,
        type: d.type,
        incorporatedOn: d.date_of_creation ?? null,
        sicCodes: d.sic_codes ?? [],
        address: {
          line1: d.registered_office_address?.address_line_1 ?? null,
          line2: d.registered_office_address?.address_line_2 ?? null,
          city: d.registered_office_address?.locality ?? null,
          postcode: d.registered_office_address?.postal_code ?? null,
        },
      },
    };
  } catch {
    return reply.code(502).send({ ok: false, error: 'Could not reach Companies House. Check the server\'s internet access.' });
  }
});

app.get('/api/enquiry-pack', async (request, reply) => {
  if (!requireCapability(request, reply, 'enquiry.generate')) return;
  const { from, to } = request.query as { from?: string; to?: string };
  if (!from || !to) return reply.code(400).send({ ok: false, error: 'Give a date range.' });

  const pack = buildEnquiryPack(db, from, to);
  recordAudit(db, {
    entityType: 'enquiry_pack', entityId: `${from}_${to}`, action: 'generated',
    summary: `Enquiry pack for ${from} to ${to} generated by ${request.currentUser!.name} (${pack.gaps.length} gap(s))`,
    actor: request.currentUser!.id,
  });

  reply.type('text/html; charset=utf-8');
  return renderEnquiryPackHtml(pack);
});

function sendCsv(reply: any, csv: string, filename: string) {
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  reply.type('text/csv; charset=utf-8');
  return csv;
}

app.get('/api/exports/sales.csv', async (request, reply) => {
  if (!requireCapability(request, reply, 'reports.read')) return;
  const { from, to } = request.query as { from: string; to: string };
  return sendCsv(reply, exportSalesCsv(db, from, to), `sales-${from}-to-${to}.csv`);
});

app.get('/api/exports/ledger.csv', async (request, reply) => {
  if (!requireCapability(request, reply, 'reports.read')) return;
  const { from, to } = request.query as { from: string; to: string };
  return sendCsv(reply, exportLedgerCsv(db, from, to), `ledger-${from}-to-${to}.csv`);
});

app.get('/api/exports/intermediaries.csv', async (request, reply) => {
  if (!requireCapability(request, reply, 'statutory.read')) return;
  const { from, to } = request.query as { from: string; to: string };
  const rows = generateIntermediaryReport(db, from, to);
  markIntermediaryReportSubmitted(db, from, to, {});
  return sendCsv(reply, intermediaryReportCsv(rows), `intermediaries-${from}-to-${to}.csv`);
});

/** Signed timesheet scans, licence copies and other evidence. */
app.post('/api/documents', async (request, reply) => {
  if (!requireCapability(request, reply, 'documents.write')) return;

  const parts = request.parts();
  let entityType = '';
  let entityId = '';
  let category = '';
  const created: string[] = [];

  for await (const part of parts) {
    if (part.type === 'field') {
      if (part.fieldname === 'entityType') entityType = String(part.value);
      if (part.fieldname === 'entityId') entityId = String(part.value);
      if (part.fieldname === 'category') category = String(part.value);
      continue;
    }

    if (!entityType || !entityId) {
      return reply.code(400).send({ ok: false, error: 'Say what the document belongs to before the file.' });
    }

    // Written to a temp file first so the store only ever holds complete files.
    const temp = join(tmpdir(), `cerviz-upload-${randomBytes(8).toString('hex')}`);
    writeFileSync(temp, await part.toBuffer());
    try {
      created.push(attachDocument(db, join(DATA_DIR, 'documents'), {
        entityType, entityId, category: category || undefined,
        sourcePath: temp,
      }));
    } finally {
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  return { ok: true, data: created };
});

app.get('/api/documents/:id', async (request, reply) => {
  if (!requireCapability(request, reply, 'documents.read')) return;
  const { id } = request.params as { id: string };
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as any;
  if (!doc || !existsSync(doc.stored_path)) {
    return reply.code(404).send({ ok: false, error: 'Document not found.' });
  }
  reply.header('Content-Disposition', `inline; filename="${doc.filename}"`);
  reply.type(doc.mime_type ?? 'application/octet-stream');
  return createReadStream(doc.stored_path);
});

/** Tide statement import. */
app.post('/api/tide/import', async (request, reply) => {
  if (!requireCapability(request, reply, 'purchases.write')) return;
  const file = await (request as any).file();
  if (!file) return reply.code(400).send({ ok: false, error: 'No file uploaded.' });
  const csv = (await file.toBuffer()).toString('utf8');
  return { ok: true, data: importTideStatement(db, csv) };
});

app.get('/api/backups', async (request, reply) => {
  if (!requireCapability(request, reply, 'settings.read')) return;
  return { ok: true, data: listBackups(join(DATA_DIR, 'backups')) };
});

app.post('/api/backups', async (request, reply) => {
  if (!requireCapability(request, reply, 'settings.write')) return;
  return { ok: true, data: backupDatabase(db, dbPath, join(DATA_DIR, 'backups')) };
});

// ---------------------------------------------------------------------------
// Static application
// ---------------------------------------------------------------------------

const webRoot = join(here, '..', 'web-dist');
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, index: ['index.html'] });

  // Single-page app: any non-API path returns the shell and the client routes.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ ok: false, error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  console.warn(`No built web interface at ${webRoot} — run "npm run build:web" first.`);
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

setInterval(() => {
  try {
    accounts.pruneExpired(db);
  } catch (err) {
    app.log.error({ err }, 'session pruning failed');
  }
}, 3600_000).unref();

// A daily backup, so an idle-but-running instance still has recent copies.
setInterval(() => {
  try {
    backupDatabase(db, dbPath, join(DATA_DIR, 'backups'));
  } catch (err) {
    app.log.error({ err }, 'scheduled backup failed');
  }
}, 24 * 3600_000).unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    app.log.warn(`${signal} received, shutting down`);
    await app.close();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}

await app.listen({ port: PORT, host: HOST });
console.log(`Cerviz Back Office listening on http://${HOST}:${PORT}`);
console.log(`Data directory: ${DATA_DIR}`);
