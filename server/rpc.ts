import type { Db } from '../core/db/connection.js';
import { newId } from '../core/db/connection.js';
import { recordAudit, verifyAuditChain, auditTrailFor } from '../core/db/audit.js';

import * as compliance from '../core/services/compliance.js';
import * as shifts from '../core/services/shifts.js';
import * as rates from '../core/services/rates.js';
import * as timesheets from '../core/services/timesheets.js';
import * as invoices from '../core/services/invoices.js';
import * as purchases from '../core/services/purchases.js';
import * as ledger from '../core/services/ledger.js';
import * as supplyChain from '../core/services/supplyChain.js';
import * as statutory from '../core/services/statutory.js';
import * as vat from '../core/services/vat.js';
import * as numbering from '../core/services/numbering.js';
import * as tide from '../core/services/tide.js';
import * as documents from '../core/services/documents.js';
import { buildEnquiryPack } from '../core/services/enquiryPack.js';
import { backupDatabase, listBackups } from '../core/services/backup.js';
import { join as joinPath } from 'node:path';
import { nowInstant, today, addDays } from '../shared/dates.js';

import type { Capability, Role } from './auth/permissions.js';
import { can, capabilitiesFor, maskWorkerPii } from './auth/permissions.js';
import * as accounts from './auth/accounts.js';
import type { SessionUser } from './auth/accounts.js';

/**
 * The application's operation registry.
 *
 * Each entry declares the capability it needs, so authorisation is a property of
 * the operation rather than something a route handler might forget. A new
 * operation with no capability declared fails closed.
 */

export interface RpcContext {
  db: Db;
  user: SessionUser;
  dataDir: string;
  ip?: string;
}

interface Operation {
  capability: Capability | 'authenticated';
  /** Read-only operations run outside a write transaction. */
  readOnly?: boolean;
  /** Strips worker personal data unless the caller holds workers.pii. */
  maskPii?: boolean;
  handler: (ctx: RpcContext, payload: any) => unknown;
}

const ops: Record<string, Operation> = {
  // --- Session and account -------------------------------------------------
  'me': {
    capability: 'authenticated', readOnly: true,
    // The full list, derived from the role rather than hand-maintained — an
    // omission here silently hides working features from the people entitled
    // to them.
    handler: ({ user }) => ({ ...user, capabilities: capabilitiesFor(user.role) }),
  },

  'me:sessions': {
    capability: 'authenticated', readOnly: true,
    handler: ({ db, user }) => accounts.activeSessionsFor(db, user.id),
  },

  'me:changePassword': {
    capability: 'authenticated',
    handler: ({ db, user }, { currentPassword, newPassword }) => {
      const login = accounts.login(db, { email: user.email, password: currentPassword });
      // A correct password with 2FA enabled returns totp_required, which is
      // still proof the password was right.
      if (!login.ok && login.reason !== 'totp_required') {
        throw new Error('Your current password is not correct.');
      }
      accounts.setPassword(db, user.id, newPassword, user.id);
      accounts.revokeAllSessions(db, user.id, 'Password changed');
      return true;
    },
  },

  'me:beginTwoFactor': {
    capability: 'authenticated',
    handler: ({ db, user }) => accounts.beginTwoFactorSetup(db, user.id),
  },

  'me:confirmTwoFactor': {
    capability: 'authenticated',
    handler: ({ db, user }, { code }) => accounts.confirmTwoFactorSetup(db, user.id, code),
  },

  // --- User management -----------------------------------------------------
  'users:list': { capability: 'users.manage', readOnly: true, handler: ({ db }) => accounts.listUsers(db) },

  'users:create': {
    capability: 'users.manage',
    handler: ({ db, user }, payload) =>
      accounts.createUser(db, { ...payload, createdBy: user.id }),
  },

  'users:update': {
    capability: 'users.manage',
    handler: ({ db, user }, { id, ...changes }) => {
      accounts.updateUser(db, id, changes, user.id);
      return true;
    },
  },

  'users:resetPassword': {
    capability: 'users.manage',
    handler: ({ db, user }, { id, password }) => {
      accounts.setPassword(db, id, password, user.id);
      db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(id);
      accounts.revokeAllSessions(db, id, 'Password reset by an owner');
      return true;
    },
  },

  'users:revokeSessions': {
    capability: 'users.manage',
    handler: ({ db, user }, { id }) => {
      const n = accounts.revokeAllSessions(db, id, `Signed out by ${user.email}`);
      return { revoked: n };
    },
  },

  // --- Company and settings ------------------------------------------------
  'company:get': {
    capability: 'settings.read', readOnly: true,
    handler: ({ db }) => db.prepare('SELECT * FROM company WHERE id = 1').get(),
  },

  'company:update': {
    capability: 'settings.write',
    handler: ({ db, user }, payload) => {
      const before = db.prepare('SELECT * FROM company WHERE id = 1').get();
      const allowed = [
        'legal_name', 'trading_name', 'company_number', 'incorporated_on',
        'registered_address_1', 'registered_address_2', 'registered_city', 'registered_postcode',
        'phone', 'email', 'website', 'brand_colour',
        'vat_registered', 'vat_number', 'vat_registered_from', 'vat_scheme', 'vat_basis',
        'paye_reference', 'accounts_office_ref',
        'bank_name', 'bank_account_name', 'bank_sort_code', 'bank_account_number', 'bank_iban',
        'base_currency', 'default_payment_terms_days', 'invoice_footer', 'invoice_terms',
      ];
      const fields = allowed.filter((f) => payload[f] !== undefined);
      if (fields.length === 0) return before;

      db.prepare(`UPDATE company SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = 1`)
        .run(...fields.map((f) => payload[f]), nowInstant());

      recordAudit(db, {
        entityType: 'company', entityId: '1', action: 'updated',
        summary: `Company details updated: ${fields.join(', ')}`,
        actor: user.id, before, after: payload,
      });
      return db.prepare('SELECT * FROM company WHERE id = 1').get();
    },
  },

  'nmw:list': {
    capability: 'settings.read', readOnly: true,
    handler: ({ db }) => db.prepare('SELECT * FROM nmw_rates ORDER BY effective_from DESC, band').all(),
  },

  'nmw:set': {
    capability: 'settings.write',
    handler: ({ db, user }, { effectiveFrom, band, ratePence }) => {
      db.prepare(
        `INSERT INTO nmw_rates (id, effective_from, band, rate_pence, created_at) VALUES (?,?,?,?,?)
         ON CONFLICT(effective_from, band) DO UPDATE SET rate_pence = excluded.rate_pence`,
      ).run(newId('nmw'), effectiveFrom, band, ratePence, nowInstant());
      recordAudit(db, {
        entityType: 'nmw_rate', entityId: `${effectiveFrom}_${band}`, action: 'updated',
        summary: `NMW ${band.replace(/_/g, ' ')} from ${effectiveFrom} set to £${(ratePence / 100).toFixed(2)}`,
        actor: user.id,
      });
      return true;
    },
  },

  // --- Organisations -------------------------------------------------------
  'orgs:list': {
    capability: 'clients.read', readOnly: true,
    handler: ({ db }, payload = {}) => {
      const where: string[] = [];
      if (payload.isClient) where.push('is_client = 1');
      if (payload.isUmbrella) where.push('is_umbrella = 1');
      return db.prepare(
        `SELECT * FROM organisations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`,
      ).all();
    },
  },

  'orgs:get': {
    capability: 'clients.read', readOnly: true,
    handler: ({ db }, { id }) => {
      const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(id);
      if (!org) return null;
      return {
        ...org,
        sites: db.prepare('SELECT * FROM sites WHERE organisation_id = ? ORDER BY name').all(id),
        dueDiligence: supplyChain.dueDiligenceStatus(db, id),
        assignments: db.prepare('SELECT * FROM assignments WHERE client_org_id = ? ORDER BY starts_on DESC').all(id),
      };
    },
  },

  'orgs:save': {
    capability: 'clients.write',
    handler: ({ db, user }, payload) => {
      const now = nowInstant();
      const fields = ['name', 'legal_name', 'company_number', 'vat_number', 'is_client', 'is_end_client',
        'is_umbrella', 'is_supplier', 'address_1', 'address_2', 'city', 'postcode', 'country',
        'contact_name', 'contact_email', 'contact_phone', 'currency', 'payment_terms_days',
        'self_bills_us', 'po_required', 'notes', 'status'];

      if (payload.id) {
        const before = db.prepare('SELECT * FROM organisations WHERE id = ?').get(payload.id);
        const present = fields.filter((f) => payload[f] !== undefined);
        if (present.length) {
          db.prepare(`UPDATE organisations SET ${present.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
            .run(...present.map((f) => payload[f]), now, payload.id);
        }
        recordAudit(db, {
          entityType: 'organisation', entityId: payload.id, action: 'updated',
          summary: `${payload.name ?? 'Organisation'} updated`, actor: user.id, before, after: payload,
        });
        return payload.id;
      }

      const id = newId('org');
      db.prepare(
        `INSERT INTO organisations (id, name, legal_name, company_number, vat_number, is_client,
           is_end_client, is_umbrella, is_supplier, address_1, address_2, city, postcode, country,
           contact_name, contact_email, contact_phone, currency, payment_terms_days, self_bills_us,
           po_required, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, payload.name, payload.legal_name ?? null, payload.company_number ?? null,
        payload.vat_number ?? null, payload.is_client ? 1 : 0, payload.is_end_client ? 1 : 0,
        payload.is_umbrella ? 1 : 0, payload.is_supplier ? 1 : 0,
        payload.address_1 ?? null, payload.address_2 ?? null, payload.city ?? null,
        payload.postcode ?? null, payload.country ?? 'United Kingdom',
        payload.contact_name ?? null, payload.contact_email ?? null, payload.contact_phone ?? null,
        payload.currency ?? 'GBP', payload.payment_terms_days ?? 30,
        payload.self_bills_us ? 1 : 0, payload.po_required ? 1 : 0, payload.notes ?? null, now, now,
      );
      recordAudit(db, {
        entityType: 'organisation', entityId: id, action: 'created',
        summary: `${payload.name} added`, actor: user.id, after: payload,
      });
      return id;
    },
  },

  'orgs:recordDueDiligence': {
    capability: 'clients.write',
    handler: ({ db, user }, payload) =>
      supplyChain.recordDueDiligence(db, { ...payload, performedBy: payload.performedBy ?? user.name }),
  },

  'sites:save': {
    capability: 'clients.write',
    handler: ({ db }, payload) => {
      const now = nowInstant();
      if (payload.id) {
        const fields = ['name', 'address_1', 'address_2', 'city', 'postcode', 'contact_name',
          'contact_phone', 'access_notes', 'status'].filter((f) => payload[f] !== undefined);
        db.prepare(`UPDATE sites SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...fields.map((f) => payload[f]), now, payload.id);
        return payload.id;
      }
      const id = newId('site');
      db.prepare(
        `INSERT INTO sites (id, organisation_id, name, address_1, address_2, city, postcode,
           contact_name, contact_phone, access_notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, payload.organisation_id, payload.name, payload.address_1 ?? null,
        payload.address_2 ?? null, payload.city ?? null, payload.postcode ?? null,
        payload.contact_name ?? null, payload.contact_phone ?? null, payload.access_notes ?? null, now, now);
      return id;
    },
  },

  // --- Workers -------------------------------------------------------------
  'workers:list': {
    capability: 'workers.read', readOnly: true, maskPii: true,
    handler: ({ db }, payload = {}) => {
      const rows = db.prepare(
        `SELECT w.*, u.name AS umbrella_name,
                (SELECT MIN(expires_on) FROM worker_licences l
                  WHERE l.worker_id = w.id AND l.status = 'valid') AS licence_expires
         FROM workers w LEFT JOIN organisations u ON u.id = w.umbrella_org_id
         ${payload.status ? 'WHERE w.status = ?' : ''}
         ORDER BY w.last_name, w.first_name`,
      ).all(...(payload.status ? [payload.status] : [])) as any[];

      return rows.map((w) => {
        const report = compliance.checkWorker(db, w.id);
        return {
          ...w,
          placeable: report.placeable,
          blockerCount: report.blockers.length,
          warningCount: report.warnings.length,
          topIssue: report.blockers[0]?.title ?? report.warnings[0]?.title ?? null,
        };
      });
    },
  },

  'workers:get': {
    capability: 'workers.read', readOnly: true, maskPii: true,
    handler: ({ db }, { id, atDate }) => {
      const worker = db.prepare(
        `SELECT w.*, u.name AS umbrella_name FROM workers w
         LEFT JOIN organisations u ON u.id = w.umbrella_org_id WHERE w.id = ?`,
      ).get(id);
      if (!worker) return null;
      return {
        ...worker,
        compliance: compliance.checkWorker(db, id, atDate ?? today()),
        licences: db.prepare('SELECT * FROM worker_licences WHERE worker_id = ? ORDER BY expires_on DESC').all(id),
        rightToWork: db.prepare('SELECT * FROM worker_rtw WHERE worker_id = ? ORDER BY checked_on DESC').all(id),
        screening: db.prepare('SELECT * FROM screening_checks WHERE worker_id = ?').all(id),
        documents: documents.documentsFor(db, 'worker', id),
        kid: db.prepare('SELECT id, version, issued_on FROM key_information_documents WHERE worker_id = ? ORDER BY version DESC').all(id),
        recentShifts: db.prepare(
          `SELECT s.*, a.title FROM shifts s JOIN assignments a ON a.id = s.assignment_id
           WHERE s.worker_id = ? ORDER BY s.starts_at DESC LIMIT 30`,
        ).all(id),
      };
    },
  },

  'workers:save': {
    capability: 'workers.write',
    handler: ({ db, user }, payload) => {
      const now = nowInstant();
      const fields = ['first_name', 'last_name', 'known_as', 'date_of_birth', 'ni_number', 'email',
        'phone', 'address_1', 'address_2', 'city', 'postcode', 'engagement_type', 'umbrella_org_id',
        'limited_company_no', 'ir35_status', 'ir35_assessed_on', 'ir35_notes', 'default_pay_rate_pence',
        'wtr_opt_out', 'wtr_opt_out_signed_on', 'bank_account_name', 'bank_sort_code',
        'bank_account_number', 'emergency_contact_name', 'emergency_contact_phone', 'status', 'notes'];

      if (payload.id) {
        // Someone without workers.pii must not be able to blank personal fields
        // simply because the interface showed them as dots.
        const editable = can(user.role, 'workers.pii')
          ? fields
          : fields.filter((f) => !['date_of_birth', 'ni_number', 'address_1', 'address_2', 'city',
              'postcode', 'bank_account_name', 'bank_sort_code', 'bank_account_number',
              'emergency_contact_name', 'emergency_contact_phone'].includes(f));

        const before = db.prepare('SELECT * FROM workers WHERE id = ?').get(payload.id);
        const present = editable.filter((f) => payload[f] !== undefined);
        if (present.length) {
          db.prepare(`UPDATE workers SET ${present.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
            .run(...present.map((f) => payload[f]), now, payload.id);
        }
        recordAudit(db, {
          entityType: 'worker', entityId: payload.id, action: 'updated',
          summary: `Worker record updated: ${present.join(', ')}`, actor: user.id, before, after: payload,
        });
        return payload.id;
      }

      const id = newId('wkr');
      db.prepare(
        `INSERT INTO workers (id, reference, first_name, last_name, known_as, date_of_birth, ni_number,
           email, phone, address_1, address_2, city, postcode, engagement_type, umbrella_org_id,
           default_pay_rate_pence, status, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, numbering.allocateNumber(db, 'worker', id), payload.first_name, payload.last_name,
        payload.known_as ?? null, payload.date_of_birth ?? null, payload.ni_number ?? null,
        payload.email ?? null, payload.phone ?? null, payload.address_1 ?? null, payload.address_2 ?? null,
        payload.city ?? null, payload.postcode ?? null, payload.engagement_type ?? 'umbrella',
        payload.umbrella_org_id ?? null, payload.default_pay_rate_pence ?? null,
        payload.status ?? 'onboarding', payload.notes ?? null, now, now,
      );
      compliance.ensureScreeningRows(db, id);
      recordAudit(db, {
        entityType: 'worker', entityId: id, action: 'created',
        summary: `Worker added: ${payload.first_name} ${payload.last_name}`, actor: user.id, after: payload,
      });
      return id;
    },
  },

  'workers:addLicence': {
    capability: 'compliance.write',
    handler: ({ db, user }, payload) => {
      const id = newId('lic');
      const now = nowInstant();
      db.prepare(
        `INSERT INTO worker_licences (id, worker_id, sector, licence_number, issued_on, expires_on,
           verified_on, verified_by, status, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, payload.worker_id, payload.sector, payload.licence_number, payload.issued_on ?? null,
        payload.expires_on, payload.verified_on ?? null, payload.verified_by ?? user.name,
        payload.status ?? 'valid', payload.notes ?? null, now, now);
      recordAudit(db, {
        entityType: 'worker', entityId: payload.worker_id, action: 'licence_added',
        summary: `SIA ${String(payload.sector).replace(/_/g, ' ')} licence ${payload.licence_number} recorded, expires ${payload.expires_on}`,
        actor: user.id, after: payload,
      });
      return id;
    },
  },

  'workers:addRtw': {
    capability: 'compliance.write',
    handler: ({ db, user }, payload) => {
      const id = newId('rtw');
      db.prepare(
        `INSERT INTO worker_rtw (id, worker_id, method, share_code, document_type, document_ref,
           checked_on, checked_by, outcome, expires_on, recheck_due_on, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, payload.worker_id, payload.method, payload.share_code ?? null,
        payload.document_type ?? null, payload.document_ref ?? null, payload.checked_on,
        payload.checked_by ?? user.name, payload.outcome, payload.expires_on ?? null,
        payload.recheck_due_on ?? null, payload.notes ?? null, nowInstant());
      recordAudit(db, {
        entityType: 'worker', entityId: payload.worker_id, action: 'rtw_recorded',
        summary: `Right to work check (${payload.method}) recorded — outcome ${payload.outcome}`,
        actor: user.id, after: payload,
      });
      return id;
    },
  },

  'workers:issueKid': {
    capability: 'compliance.write',
    handler: ({ db, user }, { workerId }) => {
      const w = db.prepare(
        `SELECT w.*, u.name AS umbrella_name FROM workers w
         LEFT JOIN organisations u ON u.id = w.umbrella_org_id WHERE w.id = ?`,
      ).get(workerId) as any;
      if (!w) throw new Error('Worker not found');
      const c = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
      const version = ((db.prepare('SELECT MAX(version) AS v FROM key_information_documents WHERE worker_id = ?')
        .get(workerId) as any)?.v ?? 0) + 1;
      const rate = w.default_pay_rate_pence
        ? `£${(w.default_pay_rate_pence / 100).toFixed(2)} per hour`
        : 'as agreed per assignment';
      const html = `
        <h2>Key Information Document</h2>
        <p>Provided under the Conduct of Employment Agencies and Employment Businesses
           Regulations 2003. This is not a contract of employment.</p>
        <table>
          <tr><th>Employment business</th><td>${c?.legal_name ?? 'Cerviz Ltd'}${c?.company_number ? ` (company no. ${c.company_number})` : ''}</td></tr>
          <tr><th>Your name</th><td>${w.first_name} ${w.last_name}</td></tr>
          <tr><th>Type of contract</th><td>${w.engagement_type === 'umbrella' ? 'Supplied via an umbrella company' : w.engagement_type === 'paye' ? 'Contract for services, PAYE' : 'Off-payroll engagement'}</td></tr>
          <tr><th>Who pays you</th><td>${w.umbrella_name ?? c?.legal_name ?? 'Cerviz Ltd'}</td></tr>
          <tr><th>Rate of pay</th><td>${rate}</td></tr>
          <tr><th>How often you are paid</th><td>Weekly, following approval of your timesheet</td></tr>
          <tr><th>Statutory deductions</th><td>Income tax and National Insurance are deducted by whoever operates PAYE on your pay.</td></tr>
          <tr><th>Holiday entitlement</th><td>Statutory holiday, accruing at 12.07% of hours worked.</td></tr>
          <tr><th>Issued on</th><td>${today()}</td></tr>
        </table>`;
      const id = newId('kid');
      db.prepare(
        `INSERT INTO key_information_documents (id, worker_id, version, issued_on, issued_by,
           engagement_type, pay_rate_pence, umbrella_org_id, content_html, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, workerId, version, today(), user.name, w.engagement_type,
        w.default_pay_rate_pence ?? null, w.umbrella_org_id ?? null, html, nowInstant());
      recordAudit(db, {
        entityType: 'worker', entityId: workerId, action: 'kid_issued',
        summary: `Key Information Document version ${version} issued`, actor: user.id,
      });
      return { id, version, html };
    },
  },

  'workers:setScreening': {
    capability: 'compliance.write',
    handler: ({ db, user }, { workerId, element, status, ...opts }) => {
      compliance.setScreeningElement(db, workerId, element, status, { ...opts, verifiedBy: user.name });
      return compliance.checkWorker(db, workerId);
    },
  },

  'workers:compliance': {
    capability: 'compliance.read', readOnly: true,
    handler: ({ db }, { id, atDate, sector }) => compliance.checkWorker(db, id, atDate ?? today(), sector),
  },

  'compliance:dashboard': {
    capability: 'compliance.read', readOnly: true, maskPii: true,
    handler: ({ db }, payload = {}) => compliance.expiringCompliance(db, payload.withinDays ?? 60),
  },

  // --- Assignments and rates ----------------------------------------------
  'assignments:list': {
    capability: 'clients.read', readOnly: true,
    handler: ({ db }) => db.prepare(
      `SELECT a.*, o.name AS client_name, s.name AS site_name,
              (SELECT COUNT(*) FROM shifts sh WHERE sh.assignment_id = a.id
                AND sh.status IN ('planned','allocated')) AS upcoming_shifts
       FROM assignments a
       JOIN organisations o ON o.id = a.client_org_id
       LEFT JOIN sites s ON s.id = a.site_id
       ORDER BY a.status, a.starts_on DESC`,
    ).all(),
  },

  'assignments:get': {
    capability: 'clients.read', readOnly: true,
    handler: ({ db, user }, { id }) => {
      const a = db.prepare(
        `SELECT a.*, o.name AS client_name, s.name AS site_name FROM assignments a
         JOIN organisations o ON o.id = a.client_org_id
         LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?`,
      ).get(id) as any;
      if (!a) return null;
      return {
        ...a,
        // Rates are commercially sensitive; a scheduler does not see them.
        rates: can(user.role, 'rates.read')
          ? db.prepare(`SELECT * FROM rates WHERE scope = 'assignment' AND scope_id = ? ORDER BY effective_from DESC`).all(id)
          : [],
        supplyChain: supplyChain.supplyChainFor(db, id),
        fillRate: shifts.fillRate(db, id, addDays(today(), -28), addDays(today(), 28)),
      };
    },
  },

  'assignments:save': {
    capability: 'clients.write',
    handler: ({ db, user }, payload) => {
      const now = nowInstant();
      if (payload.id) {
        const fields = ['title', 'site_id', 'sector', 'role', 'required_licence_sector', 'starts_on',
          'ends_on', 'po_reference', 'currency', 'use_rate_bands', 'bank_holiday_multiplier',
          'overtime_after_minutes', 'overtime_multiplier', 'min_shift_minutes', 'invoice_grouping',
          'notes', 'status'].filter((f) => payload[f] !== undefined);
        db.prepare(`UPDATE assignments SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...fields.map((f) => payload[f]), now, payload.id);
        recordAudit(db, {
          entityType: 'assignment', entityId: payload.id, action: 'updated',
          summary: `Assignment updated: ${fields.join(', ')}`, actor: user.id, after: payload,
        });
        return payload.id;
      }

      const id = newId('asg');
      db.prepare(
        `INSERT INTO assignments (id, reference, client_org_id, site_id, title, sector, role,
           required_licence_sector, starts_on, ends_on, po_reference, currency, use_rate_bands,
           min_shift_minutes, notes, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, numbering.allocateNumber(db, 'assignment', id), payload.client_org_id,
        payload.site_id ?? null, payload.title, payload.sector ?? 'security', payload.role ?? null,
        payload.required_licence_sector ?? null, payload.starts_on, payload.ends_on ?? null,
        payload.po_reference ?? null, payload.currency ?? 'GBP', payload.use_rate_bands ? 1 : 0,
        payload.min_shift_minutes ?? null, payload.notes ?? null, payload.status ?? 'active', now, now);

      if (payload.charge_rate_pence && payload.pay_rate_pence && can(user.role, 'rates.write')) {
        rates.setRate(db, {
          scope: 'assignment', scopeId: id,
          chargeRatePence: payload.charge_rate_pence, payRatePence: payload.pay_rate_pence,
          effectiveFrom: payload.starts_on,
        });
      }

      recordAudit(db, {
        entityType: 'assignment', entityId: id, action: 'created',
        summary: `Assignment created: ${payload.title}`, actor: user.id, after: payload,
      });
      return id;
    },
  },

  'rates:set': { capability: 'rates.write', handler: ({ db }, payload) => rates.setRate(db, payload) },

  'supplyChain:get': {
    capability: 'clients.read', readOnly: true,
    handler: ({ db }, { assignmentId }) => supplyChain.supplyChainFor(db, assignmentId),
  },

  'supplyChain:set': {
    capability: 'clients.write',
    handler: ({ db }, { assignmentId, links }) => {
      supplyChain.setSupplyChain(db, assignmentId, links);
      return supplyChain.supplyChainFor(db, assignmentId);
    },
  },

  // --- Shifts --------------------------------------------------------------
  'shifts:list': {
    capability: 'rota.read', readOnly: true,
    handler: ({ db, user }, payload = {}) => {
      const from = payload.from ?? addDays(today(), -7);
      const to = payload.to ?? addDays(today(), 21);
      const rows = db.prepare(
        `SELECT s.*, a.title AS assignment_title, a.required_licence_sector,
                o.name AS client_name, si.name AS site_name, w.first_name, w.last_name
         FROM shifts s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN organisations o ON o.id = a.client_org_id
         LEFT JOIN sites si ON si.id = s.site_id
         LEFT JOIN workers w ON w.id = s.worker_id
         WHERE date(s.starts_at) BETWEEN ? AND ?
           ${payload.assignmentId ? 'AND s.assignment_id = ?' : ''}
         ORDER BY s.starts_at`,
      ).all(...[from, to, ...(payload.assignmentId ? [payload.assignmentId] : [])]) as any[];

      if (can(user.role, 'rates.read')) return rows;
      // Strip rates for roles that should not see commercial terms.
      return rows.map(({ charge_rate_pence, pay_rate_pence, rate_source,
        charge_rate_override_pence, pay_rate_override_pence, ...rest }) => rest);
    },
  },

  'shifts:create': { capability: 'rota.write', handler: ({ db }, payload) => shifts.createShift(db, payload) },

  'shifts:createSeries': {
    capability: 'rota.write',
    handler: ({ db }, payload) => {
      const created: string[] = [];
      let date = payload.from as string;
      let guard = 0;
      while (date <= payload.to && guard++ < 400) {
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (!payload.daysOfWeek || payload.daysOfWeek.includes(dow)) {
          created.push(shifts.createShift(db, {
            assignmentId: payload.assignmentId,
            siteId: payload.siteId,
            startsAt: `${date}T${payload.startTime}:00`,
            endsAt: `${date}T${payload.endTime}:00`,
            breakMinutes: payload.breakMinutes ?? 0,
          }));
        }
        date = addDays(date, 1);
      }
      return created;
    },
  },

  'shifts:eligibleWorkers': {
    capability: 'rota.read', readOnly: true,
    handler: ({ db }, { shiftId }) => shifts.eligibleWorkers(db, shiftId),
  },

  'shifts:checkAllocation': {
    capability: 'rota.read', readOnly: true,
    handler: ({ db }, { shiftId, workerId }) => shifts.checkAllocation(db, shiftId, workerId),
  },

  'shifts:allocate': {
    capability: 'rota.write',
    handler: ({ db, user }, { shiftId, workerId, ...opts }) => {
      const result = shifts.allocateWorker(db, shiftId, workerId, opts);
      // The core records the allocation; this attributes it to a real person.
      recordAudit(db, {
        entityType: 'shift', entityId: shiftId, action: 'allocated_by',
        summary: `Allocation performed by ${user.name}`, actor: user.id,
      });
      return result;
    },
  },

  'shifts:release': {
    capability: 'rota.write',
    handler: ({ db }, { shiftId, reason }) => { shifts.releaseWorker(db, shiftId, reason); return true; },
  },

  'shifts:mark': {
    capability: 'rota.write',
    handler: ({ db }, { shiftId, status, ...opts }) => { shifts.markShiftStatus(db, shiftId, status, opts); return true; },
  },

  'shifts:replace': {
    capability: 'rota.write',
    handler: ({ db }, { shiftId, workerId, reason }) => shifts.replaceShift(db, shiftId, workerId, reason),
  },

  // --- Timesheets ----------------------------------------------------------
  'timesheets:list': {
    capability: 'timesheets.read', readOnly: true,
    handler: ({ db }, payload = {}) => db.prepare(
      `SELECT t.*, a.title AS assignment_title, o.name AS client_name, w.first_name, w.last_name,
              (SELECT COUNT(*) FROM documents d WHERE d.entity_type = 'timesheet'
                AND d.entity_id = t.id AND d.category = 'signed_timesheet') AS scan_count
       FROM timesheets t
       JOIN assignments a ON a.id = t.assignment_id
       JOIN organisations o ON o.id = a.client_org_id
       JOIN workers w ON w.id = t.worker_id
       ${payload.status ? 'WHERE t.status = ?' : ''}
       ORDER BY t.week_ending DESC, w.last_name`,
    ).all(...(payload.status ? [payload.status] : [])),
  },

  'timesheets:get': {
    capability: 'timesheets.read', readOnly: true,
    handler: ({ db }, { id }) => timesheets.timesheetWithLines(db, id),
  },

  'timesheets:create': { capability: 'timesheets.write', handler: ({ db }, payload) => timesheets.createTimesheet(db, payload) },
  'timesheets:populate': { capability: 'timesheets.write', handler: ({ db }, { id }) => timesheets.populateFromShifts(db, id) },
  'timesheets:addLine': { capability: 'timesheets.write', handler: ({ db }, { timesheetId, line }) => timesheets.addLine(db, timesheetId, line) },
  'timesheets:removeLine': { capability: 'timesheets.write', handler: ({ db }, { timesheetId, lineId }) => { timesheets.removeLine(db, timesheetId, lineId); return true; } },

  'timesheets:approve': {
    capability: 'timesheets.approve',
    handler: ({ db, user }, { id, input, opts }) => {
      timesheets.approveTimesheet(db, id, { ...input, approvedBy: user.name }, opts ?? {});
      recordAudit(db, {
        entityType: 'timesheet', entityId: id, action: 'approved_by',
        summary: `Approved by ${user.name} (${user.email})`, actor: user.id,
      });
      return timesheets.timesheetWithLines(db, id);
    },
  },

  'timesheets:reopen': { capability: 'timesheets.approve', handler: ({ db }, { id, reason }) => { timesheets.reopenTimesheet(db, id, reason); return true; } },
  'timesheets:dispute': { capability: 'timesheets.write', handler: ({ db }, { id, reason }) => { timesheets.disputeTimesheet(db, id, reason); return true; } },
  'timesheets:unbilled': { capability: 'timesheets.read', readOnly: true, handler: ({ db }, payload = {}) => timesheets.unbilledTimesheets(db, payload.clientOrgId) },

  // --- Invoicing -----------------------------------------------------------
  'invoices:list': {
    capability: 'invoices.read', readOnly: true,
    handler: ({ db }, payload = {}) => {
      invoices.refreshOverdueStatuses(db);
      return db.prepare(
        `SELECT i.*, o.name AS client_name FROM invoices i
         JOIN organisations o ON o.id = i.client_org_id
         ${payload.status ? 'WHERE i.status = ?' : ''}
         ORDER BY i.created_at DESC`,
      ).all(...(payload.status ? [payload.status] : []));
    },
  },

  'invoices:get': { capability: 'invoices.read', readOnly: true, handler: ({ db }, { id }) => invoices.invoiceWithDetail(db, id) },
  'invoices:createFromTimesheets': { capability: 'invoices.write', handler: ({ db }, payload) => invoices.createInvoiceFromTimesheets(db, payload) },
  'invoices:createManual': { capability: 'invoices.write', handler: ({ db }, payload) => invoices.createManualInvoice(db, payload) },
  'invoices:addLine': { capability: 'invoices.write', handler: ({ db }, { invoiceId, line }) => invoices.addManualLine(db, invoiceId, line) },
  'invoices:updateLine': { capability: 'invoices.write', handler: ({ db }, { invoiceId, lineId, changes }) => { invoices.updateInvoiceLine(db, invoiceId, lineId, changes); return true; } },
  'invoices:removeLine': { capability: 'invoices.write', handler: ({ db }, { invoiceId, lineId }) => { invoices.removeInvoiceLine(db, invoiceId, lineId); return true; } },
  'invoices:updateDraft': { capability: 'invoices.write', handler: ({ db }, { id, changes }) => { invoices.updateDraftInvoice(db, id, changes); return invoices.invoiceWithDetail(db, id); } },

  'invoices:issue': {
    capability: 'invoices.issue',
    handler: ({ db, user }, { id }) => {
      const number = invoices.issueInvoice(db, id);
      recordAudit(db, {
        entityType: 'invoice', entityId: id, action: 'issued_by',
        summary: `Invoice ${number} issued by ${user.name} (${user.email})`, actor: user.id,
      });
      return number;
    },
  },

  'invoices:void': {
    capability: 'invoices.void',
    handler: ({ db, user }, { id, reason }) => {
      invoices.voidInvoice(db, id, reason);
      recordAudit(db, {
        entityType: 'invoice', entityId: id, action: 'voided_by',
        summary: `Voided by ${user.name} (${user.email}): ${reason}`, actor: user.id,
      });
      return true;
    },
  },

  'invoices:recordPayment': { capability: 'invoices.write', handler: ({ db }, payload) => invoices.recordPayment(db, payload) },
  'invoices:creditNote': { capability: 'invoices.write', handler: ({ db }, payload) => invoices.createCreditNote(db, payload) },
  'invoices:issueCreditNote': { capability: 'invoices.issue', handler: ({ db }, { id }) => invoices.issueCreditNote(db, id) },
  'invoices:agedDebtors': { capability: 'invoices.read', readOnly: true, handler: ({ db }) => invoices.agedDebtors(db) },
  'invoices:reminders': { capability: 'invoices.read', readOnly: true, handler: ({ db }) => invoices.dueReminders(db) },
  'invoices:markReminderSent': { capability: 'invoices.write', handler: ({ db }, { id, channel }) => { invoices.markReminderSent(db, id, channel); return true; } },

  // --- Purchases -----------------------------------------------------------
  'purchases:list': {
    capability: 'purchases.read', readOnly: true,
    handler: ({ db }) => db.prepare(
      `SELECT p.*, o.name AS supplier FROM purchase_invoices p
       JOIN organisations o ON o.id = p.organisation_id ORDER BY p.invoice_date DESC`,
    ).all(),
  },
  'purchases:create': { capability: 'purchases.write', handler: ({ db }, payload) => purchases.createPurchaseInvoice(db, payload) },
  'purchases:addLine': { capability: 'purchases.write', handler: ({ db }, { purchaseInvoiceId, line }) => purchases.addPurchaseLine(db, purchaseInvoiceId, line) },
  'purchases:match': { capability: 'purchases.read', handler: ({ db }, { id }) => purchases.matchPurchaseToTimesheets(db, id) },
  'purchases:approve': { capability: 'purchases.write', handler: ({ db, user }, { id }) => { purchases.approvePurchaseInvoice(db, id, user.name); return true; } },
  'purchases:agedCreditors': { capability: 'purchases.read', readOnly: true, handler: ({ db }) => purchases.agedCreditors(db) },

  'selfBills:list': {
    capability: 'purchases.read', readOnly: true,
    handler: ({ db }) => db.prepare(
      `SELECT s.*, o.name AS agency FROM self_bills s
       JOIN organisations o ON o.id = s.organisation_id ORDER BY s.received_on DESC`,
    ).all(),
  },
  'selfBills:record': { capability: 'purchases.write', handler: ({ db }, payload) => purchases.recordSelfBill(db, payload) },
  'selfBills:reconcile': { capability: 'purchases.read', handler: ({ db }, { id }) => purchases.reconcileSelfBill(db, id) },

  // --- Reporting -----------------------------------------------------------
  'reports:margin': { capability: 'reports.read', readOnly: true, handler: ({ db }, { from, to }) => purchases.marginReport(db, from, to) },
  'reports:trialBalance': { capability: 'reports.read', readOnly: true, handler: ({ db }, payload = {}) => ledger.trialBalance(db, payload.asOf) },
  'reports:profitAndLoss': { capability: 'reports.read', readOnly: true, handler: ({ db }, { from, to }) => ledger.profitAndLoss(db, from, to) },
  'reports:balanceSheet': { capability: 'reports.read', readOnly: true, handler: ({ db }, payload = {}) => ledger.balanceSheet(db, payload.asOf) },
  'reports:vatThreshold': { capability: 'reports.read', readOnly: true, handler: ({ db }) => vat.thresholdStatus(db) },
  'reports:vatReturn': { capability: 'reports.read', readOnly: true, handler: ({ db }, { from, to }) => vat.vatReturnWorksheet(db, from, to) },
  'reports:sequenceAudit': { capability: 'reports.read', readOnly: true, handler: ({ db }, payload = {}) => numbering.auditSequence(db, payload.docType ?? 'invoice') },

  // --- Statutory -----------------------------------------------------------
  'statutory:intermediaryObligations': { capability: 'statutory.read', readOnly: true, handler: ({ db }) => statutory.intermediaryObligations(db) },
  'statutory:intermediaryReport': { capability: 'statutory.read', readOnly: true, maskPii: true, handler: ({ db }, { from, to }) => statutory.generateIntermediaryReport(db, from, to) },
  'statutory:filings': { capability: 'statutory.read', readOnly: true, handler: ({ db }) => statutory.upcomingFilings(db) },
  'statutory:markFilingSubmitted': {
    capability: 'statutory.write',
    handler: ({ db }, { id, submittedOn, reference }) => { statutory.markFilingSubmitted(db, id, submittedOn, reference); return true; },
  },

  // --- Bank reconciliation -------------------------------------------------
  'tide:reconciliation': { capability: 'reports.read', readOnly: true, handler: ({ db }) => tide.reconciliationView(db) },
  'tide:autoMatch': { capability: 'purchases.write', handler: ({ db }) => tide.autoMatchTransactions(db) },
  'tide:confirmMatch': { capability: 'purchases.write', handler: ({ db }, { bankTxnId, target }) => { tide.confirmMatch(db, bankTxnId, target); return true; } },

  // --- Evidence ------------------------------------------------------------
  'documents:list': { capability: 'documents.read', readOnly: true, handler: ({ db }, { entityType, entityId }) => documents.documentsFor(db, entityType, entityId) },
  'documents:verify': { capability: 'documents.read', readOnly: true, handler: ({ db }) => documents.verifyDocuments(db) },

  'audit:verify': { capability: 'audit.read', readOnly: true, handler: ({ db }) => verifyAuditChain(db) },
  'audit:trail': { capability: 'audit.read', readOnly: true, handler: ({ db }, { entityType, entityId }) => auditTrailFor(db, entityType, entityId) },
  'audit:recent': {
    capability: 'audit.read', readOnly: true,
    handler: ({ db }, payload = {}) => db.prepare(
      `SELECT id, at, actor, actor_name, actor_email, action, entity_type, entity_id, summary
       FROM audit_log_with_actor ORDER BY id DESC LIMIT ?`,
    ).all(Math.min(payload.limit ?? 200, 1000)),
  },

  'enquiryPack:build': { capability: 'enquiry.generate', readOnly: true, handler: ({ db }, { from, to }) => buildEnquiryPack(db, from, to) },

  'backup:list': {
    capability: 'settings.read', readOnly: true,
    handler: ({ dataDir }) => listBackups(joinPath(dataDir, 'backups')),
  },

  'backup:now': {
    capability: 'settings.write', readOnly: true,
    handler: ({ db, dataDir, user }) => {
      const result = backupDatabase(db, joinPath(dataDir, 'cerviz.sqlite'), joinPath(dataDir, 'backups'));
      recordAudit(db, {
        entityType: 'backup', entityId: result.path, action: 'requested',
        summary: `Backup taken on request by ${user.name}`, actor: user.id,
      });
      return result;
    },
  },

  // --- Dashboard -----------------------------------------------------------
  'dashboard:summary': {
    capability: 'authenticated', readOnly: true, maskPii: true,
    handler: ({ db, user }) => {
      const role = user.role;
      const out: Record<string, unknown> = { asOf: today(), auditChainOk: verifyAuditChain(db).ok };

      if (can(role, 'invoices.read')) {
        invoices.refreshOverdueStatuses(db);
        const aged = invoices.agedDebtors(db);
        out.outstandingPence = aged.totalOutstanding;
        out.overduePence = aged.buckets.days1to30 + aged.buckets.days31to60
          + aged.buckets.days61to90 + aged.buckets.over90;
      }

      if (can(role, 'timesheets.read')) {
        const unbilled = timesheets.unbilledTimesheets(db);
        out.unbilledCount = unbilled.length;
        out.unbilledPence = can(role, 'rates.read')
          ? unbilled.reduce((a: number, t: any) => a + t.charge_total_pence, 0)
          : null;
      }

      if (can(role, 'rota.read')) {
        out.unfilledShifts = (db.prepare(
          `SELECT COUNT(*) AS n FROM shifts WHERE worker_id IS NULL AND status = 'planned'
             AND date(starts_at) BETWEEN ? AND ?`,
        ).get(today(), addDays(today(), 14)) as any).n;
      }

      if (can(role, 'compliance.read')) {
        const dash = compliance.expiringCompliance(db, 60);
        out.compliance = dash;
        out.licencesExpiring = dash.licencesExpiring.length;
        out.rtwExpiring = dash.rightToWorkExpiring.length;
        out.screeningIncomplete = dash.screeningIncomplete.length;
        out.awrApproaching = dash.awrApproaching.filter((a: any) => !a.qualified).length;
        out.awrQualified = dash.awrApproaching.filter((a: any) => a.qualified).length;
      }

      if (can(role, 'purchases.read')) {
        out.queriedPurchases = (db.prepare(`SELECT COUNT(*) AS n FROM purchase_invoices WHERE status = 'queried'`).get() as any).n;
        out.disputedSelfBills = (db.prepare(`SELECT COUNT(*) AS n FROM self_bills WHERE status = 'disputed'`).get() as any).n;
      }

      if (can(role, 'statutory.read')) {
        out.filings = statutory.upcomingFilings(db, today(), 90).slice(0, 5);
        out.intermediary = statutory.intermediaryObligations(db).filter((i: any) => i.status === 'due').slice(0, 2);
        out.vatThreshold = vat.thresholdStatus(db);
      }

      return out;
    },
  },
};

export class AuthorisationError extends Error {
  statusCode = 403;
}

export function listOperations(): string[] {
  return Object.keys(ops);
}

export function invoke(ctx: RpcContext, channel: string, payload: unknown): unknown {
  const op = ops[channel];
  if (!op) throw new Error(`Unknown operation: ${channel}`);

  if (op.capability !== 'authenticated' && !can(ctx.user.role, op.capability)) {
    throw new AuthorisationError(
      `Your role (${ctx.user.role}) does not have permission to do this.`,
    );
  }

  const run = () => op.handler(ctx, payload ?? {});
  const result = op.readOnly ? run() : ctx.db.transaction(run)();

  return op.maskPii ? maskWorkerPii(result, can(ctx.user.role, 'workers.pii')) : result;
}
