import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db/connection.js';
import { newId } from './db/connection.js';
import { recordAudit, verifyAuditChain, auditTrailFor } from './db/audit.js';

import * as compliance from './services/compliance.js';
import * as shifts from './services/shifts.js';
import * as rates from './services/rates.js';
import * as timesheets from './services/timesheets.js';
import * as invoices from './services/invoices.js';
import * as purchases from './services/purchases.js';
import * as ledger from './services/ledger.js';
import * as supplyChain from './services/supplyChain.js';
import * as statutory from './services/statutory.js';
import * as vat from './services/vat.js';
import * as numbering from './services/numbering.js';
import * as tide from './services/tide.js';
import * as documents from './services/documents.js';
import * as backup from './services/backup.js';
import { buildEnquiryPack, renderEnquiryPackHtml } from './services/enquiryPack.js';
import { renderInvoiceHtml } from './services/invoiceDocument.js';
import { nowInstant, today, addDays } from '../shared/dates.js';

/**
 * IPC surface.
 *
 * One handler per operation, each taking a payload and returning plain data.
 * Everything that changes state runs inside a transaction so a failure part-way
 * through leaves no half-written records — particularly important where a
 * document number has been allocated.
 */

export interface IpcContext {
  db: Db;
  dbPath: string;
  dataDir: string;
}

type Handler = (ctx: IpcContext, payload: any) => unknown;

const handlers: Record<string, Handler> = {
  // --- Company and settings ------------------------------------------------
  'company:get': ({ db }) => db.prepare('SELECT * FROM company WHERE id = 1').get(),

  'company:update': ({ db }, payload) => {
    const before = db.prepare('SELECT * FROM company WHERE id = 1').get();
    const allowed = [
      'legal_name', 'trading_name', 'company_number', 'incorporated_on',
      'registered_address_1', 'registered_address_2', 'registered_city', 'registered_postcode',
      'trading_address_1', 'trading_address_2', 'trading_city', 'trading_postcode',
      'phone', 'email', 'website', 'logo_path', 'brand_colour',
      'vat_registered', 'vat_number', 'vat_registered_from', 'vat_scheme', 'vat_basis',
      'paye_reference', 'accounts_office_ref',
      'bank_name', 'bank_account_name', 'bank_sort_code', 'bank_account_number', 'bank_iban', 'bank_bic',
      'base_currency', 'default_payment_terms_days', 'invoice_footer', 'invoice_terms',
    ];
    const fields = allowed.filter((f) => payload[f] !== undefined);
    if (fields.length === 0) return before;

    db.prepare(
      `UPDATE company SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = 1`,
    ).run(...fields.map((f) => payload[f]), nowInstant());

    recordAudit(db, {
      entityType: 'company', entityId: '1', action: 'updated',
      summary: `Company details updated: ${fields.join(', ')}`,
      before, after: payload,
    });
    return db.prepare('SELECT * FROM company WHERE id = 1').get();
  },

  'settings:set': ({ db }, { key, value }) => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, String(value), nowInstant());
    return { key, value };
  },

  'settings:get': ({ db }, { key }) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value ?? null,

  'nmw:list': ({ db }) =>
    db.prepare('SELECT * FROM nmw_rates ORDER BY effective_from DESC, band').all(),

  'nmw:set': ({ db }, { effectiveFrom, band, ratePence }) => {
    db.prepare(
      `INSERT INTO nmw_rates (id, effective_from, band, rate_pence, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(effective_from, band) DO UPDATE SET rate_pence = excluded.rate_pence`,
    ).run(newId('nmw'), effectiveFrom, band, ratePence, nowInstant());
    recordAudit(db, {
      entityType: 'nmw_rate', entityId: `${effectiveFrom}_${band}`, action: 'updated',
      summary: `NMW ${band.replace(/_/g, ' ')} from ${effectiveFrom} set to £${(ratePence / 100).toFixed(2)}`,
    });
    return true;
  },

  // --- Organisations -------------------------------------------------------
  'orgs:list': ({ db }, payload = {}) => {
    const where: string[] = [];
    if (payload.isClient) where.push('is_client = 1');
    if (payload.isUmbrella) where.push('is_umbrella = 1');
    return db
      .prepare(`SELECT * FROM organisations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`)
      .all();
  },

  'orgs:get': ({ db }, { id }) => {
    const org = db.prepare('SELECT * FROM organisations WHERE id = ?').get(id);
    if (!org) return null;
    return {
      ...org,
      sites: db.prepare('SELECT * FROM sites WHERE organisation_id = ? ORDER BY name').all(id),
      dueDiligence: supplyChain.dueDiligenceStatus(db, id),
      assignments: db.prepare('SELECT * FROM assignments WHERE client_org_id = ? ORDER BY starts_on DESC').all(id),
    };
  },

  'orgs:save': ({ db }, payload) => {
    const now = nowInstant();
    if (payload.id) {
      const before = db.prepare('SELECT * FROM organisations WHERE id = ?').get(payload.id);
      const fields = ['name', 'legal_name', 'company_number', 'vat_number', 'is_client', 'is_end_client',
        'is_umbrella', 'is_supplier', 'address_1', 'address_2', 'city', 'postcode', 'country',
        'contact_name', 'contact_email', 'contact_phone', 'currency', 'payment_terms_days',
        'credit_limit_pence', 'self_bills_us', 'po_required', 'notes', 'status']
        .filter((f) => payload[f] !== undefined);
      db.prepare(`UPDATE organisations SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...fields.map((f) => payload[f]), now, payload.id);
      recordAudit(db, {
        entityType: 'organisation', entityId: payload.id, action: 'updated',
        summary: `${payload.name ?? 'Organisation'} updated`, before, after: payload,
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
      summary: `${payload.name} added`, after: payload,
    });
    return id;
  },

  'orgs:dueDiligence': ({ db }, { organisationId }) => supplyChain.dueDiligenceStatus(db, organisationId),
  'orgs:recordDueDiligence': ({ db }, payload) => supplyChain.recordDueDiligence(db, payload),

  'sites:save': ({ db }, payload) => {
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
    ).run(id, payload.organisation_id, payload.name, payload.address_1 ?? null, payload.address_2 ?? null,
      payload.city ?? null, payload.postcode ?? null, payload.contact_name ?? null,
      payload.contact_phone ?? null, payload.access_notes ?? null, now, now);
    return id;
  },

  // --- Workers and compliance ----------------------------------------------
  'workers:list': ({ db }, payload = {}) => {
    const rows = db
      .prepare(
        `SELECT w.*, u.name AS umbrella_name,
                (SELECT MIN(expires_on) FROM worker_licences l
                  WHERE l.worker_id = w.id AND l.status = 'valid') AS licence_expires
         FROM workers w LEFT JOIN organisations u ON u.id = w.umbrella_org_id
         ${payload.status ? 'WHERE w.status = ?' : ''}
         ORDER BY w.last_name, w.first_name`,
      )
      .all(...(payload.status ? [payload.status] : [])) as any[];

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

  'workers:get': ({ db }, { id, atDate }) => {
    const worker = db
      .prepare(`SELECT w.*, u.name AS umbrella_name FROM workers w
                LEFT JOIN organisations u ON u.id = w.umbrella_org_id WHERE w.id = ?`)
      .get(id);
    if (!worker) return null;
    return {
      ...worker,
      compliance: compliance.checkWorker(db, id, atDate ?? today()),
      licences: db.prepare('SELECT * FROM worker_licences WHERE worker_id = ? ORDER BY expires_on DESC').all(id),
      rightToWork: db.prepare('SELECT * FROM worker_rtw WHERE worker_id = ? ORDER BY checked_on DESC').all(id),
      screening: db.prepare('SELECT * FROM screening_checks WHERE worker_id = ?').all(id),
      documents: documents.documentsFor(db, 'worker', id),
      kid: db.prepare('SELECT * FROM key_information_documents WHERE worker_id = ? ORDER BY version DESC').all(id),
      recentShifts: db
        .prepare(`SELECT s.*, a.title FROM shifts s JOIN assignments a ON a.id = s.assignment_id
                  WHERE s.worker_id = ? ORDER BY s.starts_at DESC LIMIT 30`)
        .all(id),
    };
  },

  'workers:save': ({ db }, payload) => {
    const now = nowInstant();
    if (payload.id) {
      const before = db.prepare('SELECT * FROM workers WHERE id = ?').get(payload.id);
      const fields = ['first_name', 'last_name', 'known_as', 'date_of_birth', 'ni_number', 'email',
        'phone', 'address_1', 'address_2', 'city', 'postcode', 'engagement_type', 'umbrella_org_id',
        'limited_company_no', 'ir35_status', 'ir35_assessed_on', 'ir35_notes', 'default_pay_rate_pence',
        'wtr_opt_out', 'wtr_opt_out_signed_on', 'bank_account_name', 'bank_sort_code',
        'bank_account_number', 'emergency_contact_name', 'emergency_contact_phone', 'status', 'notes']
        .filter((f) => payload[f] !== undefined);
      db.prepare(`UPDATE workers SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...fields.map((f) => payload[f]), now, payload.id);
      recordAudit(db, {
        entityType: 'worker', entityId: payload.id, action: 'updated',
        summary: `Worker record updated: ${fields.join(', ')}`, before, after: payload,
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
      summary: `Worker added: ${payload.first_name} ${payload.last_name}`, after: payload,
    });
    return id;
  },

  'workers:compliance': ({ db }, { id, atDate, sector }) =>
    compliance.checkWorker(db, id, atDate ?? today(), sector),

  'workers:addLicence': ({ db }, payload) => {
    const id = newId('lic');
    const now = nowInstant();
    db.prepare(
      `INSERT INTO worker_licences (id, worker_id, sector, licence_number, issued_on, expires_on,
         verified_on, verified_by, status, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, payload.worker_id, payload.sector, payload.licence_number, payload.issued_on ?? null,
      payload.expires_on, payload.verified_on ?? null, payload.verified_by ?? null,
      payload.status ?? 'valid', payload.notes ?? null, now, now);
    recordAudit(db, {
      entityType: 'worker', entityId: payload.worker_id, action: 'licence_added',
      summary: `SIA ${payload.sector.replace(/_/g, ' ')} licence ${payload.licence_number} recorded, expires ${payload.expires_on}`,
      after: payload,
    });
    return id;
  },

  'workers:addRtw': ({ db }, payload) => {
    const id = newId('rtw');
    db.prepare(
      `INSERT INTO worker_rtw (id, worker_id, method, share_code, document_type, document_ref,
         checked_on, checked_by, outcome, expires_on, recheck_due_on, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, payload.worker_id, payload.method, payload.share_code ?? null,
      payload.document_type ?? null, payload.document_ref ?? null, payload.checked_on,
      payload.checked_by ?? null, payload.outcome, payload.expires_on ?? null,
      payload.recheck_due_on ?? null, payload.notes ?? null, nowInstant());
    recordAudit(db, {
      entityType: 'worker', entityId: payload.worker_id, action: 'rtw_recorded',
      summary: `Right to work check (${payload.method}) recorded — outcome ${payload.outcome}`,
      after: payload,
    });
    return id;
  },

  'workers:setScreening': ({ db }, { workerId, element, status, ...opts }) => {
    compliance.setScreeningElement(db, workerId, element, status, opts);
    return compliance.checkWorker(db, workerId);
  },

  'workers:issueKid': ({ db }, { workerId }) => {
    const w = db
      .prepare(`SELECT w.*, u.name AS umbrella_name FROM workers w
                LEFT JOIN organisations u ON u.id = w.umbrella_org_id WHERE w.id = ?`)
      .get(workerId) as any;
    if (!w) throw new Error('Worker not found');

    const c = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
    const version = ((db.prepare('SELECT MAX(version) AS v FROM key_information_documents WHERE worker_id = ?')
      .get(workerId) as any)?.v ?? 0) + 1;

    const rate = w.default_pay_rate_pence ? `£${(w.default_pay_rate_pence / 100).toFixed(2)} per hour` : 'as agreed per assignment';
    const html = `
      <h2>Key Information Document</h2>
      <p>This document is provided under the Conduct of Employment Agencies and Employment
         Businesses Regulations 2003. It is not a contract of employment.</p>
      <table>
        <tr><th>Employment business</th><td>${c?.legal_name ?? 'Cerviz Ltd'}${c?.company_number ? ` (company no. ${c.company_number})` : ''}</td></tr>
        <tr><th>Your name</th><td>${w.first_name} ${w.last_name}</td></tr>
        <tr><th>Type of contract</th><td>${w.engagement_type === 'umbrella' ? 'Supplied via an umbrella company' : w.engagement_type === 'paye' ? 'Contract for services, PAYE' : 'Off-payroll engagement'}</td></tr>
        ${w.umbrella_name ? `<tr><th>Who pays you</th><td>${w.umbrella_name}</td></tr>` : ''}
        <tr><th>Who is responsible for paying you</th><td>${w.umbrella_name ?? c?.legal_name ?? 'Cerviz Ltd'}</td></tr>
        <tr><th>Rate of pay</th><td>${rate}</td></tr>
        <tr><th>How often you will be paid</th><td>Weekly, following approval of your timesheet</td></tr>
        <tr><th>Statutory deductions</th><td>Income tax and National Insurance are deducted from your pay by whoever operates PAYE on it.</td></tr>
        <tr><th>Holiday entitlement</th><td>Statutory holiday, accruing at 12.07% of hours worked for irregular-hours working.</td></tr>
        <tr><th>Issued on</th><td>${today()}</td></tr>
      </table>
      <p>Where you are paid through an umbrella company, deductions are made from the assignment rate
         before your gross pay is calculated. Ask us for a worked example at any time.</p>`;

    const id = newId('kid');
    db.prepare(
      `INSERT INTO key_information_documents (id, worker_id, version, issued_on, issued_by,
         engagement_type, pay_rate_pence, umbrella_org_id, content_html, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, workerId, version, today(), process.env.USER ?? 'operator', w.engagement_type,
      w.default_pay_rate_pence ?? null, w.umbrella_org_id ?? null, html, nowInstant());

    recordAudit(db, {
      entityType: 'worker', entityId: workerId, action: 'kid_issued',
      summary: `Key Information Document version ${version} issued`,
    });
    return { id, version, html };
  },

  'compliance:dashboard': ({ db }, payload = {}) => compliance.expiringCompliance(db, payload.withinDays ?? 60),

  // --- Assignments and rates -----------------------------------------------
  'assignments:list': ({ db }) =>
    db.prepare(
      `SELECT a.*, o.name AS client_name, s.name AS site_name,
              (SELECT COUNT(*) FROM shifts sh WHERE sh.assignment_id = a.id
                AND sh.status IN ('planned','allocated')) AS upcoming_shifts
       FROM assignments a
       JOIN organisations o ON o.id = a.client_org_id
       LEFT JOIN sites s ON s.id = a.site_id
       ORDER BY a.status, a.starts_on DESC`,
    ).all(),

  'assignments:get': ({ db }, { id }) => {
    const a = db
      .prepare(`SELECT a.*, o.name AS client_name, s.name AS site_name FROM assignments a
                JOIN organisations o ON o.id = a.client_org_id
                LEFT JOIN sites s ON s.id = a.site_id WHERE a.id = ?`)
      .get(id);
    if (!a) return null;
    return {
      ...a,
      rates: db.prepare(`SELECT * FROM rates WHERE scope = 'assignment' AND scope_id = ? ORDER BY effective_from DESC`).all(id),
      supplyChain: supplyChain.supplyChainFor(db, id),
      fillRate: shifts.fillRate(db, id, addDays(today(), -28), addDays(today(), 28)),
    };
  },

  'assignments:save': ({ db }, payload) => {
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
        summary: `Assignment updated: ${fields.join(', ')}`, after: payload,
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

    if (payload.charge_rate_pence && payload.pay_rate_pence) {
      rates.setRate(db, {
        scope: 'assignment', scopeId: id,
        chargeRatePence: payload.charge_rate_pence,
        payRatePence: payload.pay_rate_pence,
        effectiveFrom: payload.starts_on,
      });
    }

    recordAudit(db, {
      entityType: 'assignment', entityId: id, action: 'created',
      summary: `Assignment created: ${payload.title}`, after: payload,
    });
    return id;
  },

  'rates:set': ({ db }, payload) => rates.setRate(db, payload),
  'rates:resolve': ({ db }, payload) => rates.resolveRate(db, payload),

  'supplyChain:set': ({ db }, { assignmentId, links }) => {
    supplyChain.setSupplyChain(db, assignmentId, links);
    return supplyChain.supplyChainFor(db, assignmentId);
  },
  'supplyChain:get': ({ db }, { assignmentId }) => supplyChain.supplyChainFor(db, assignmentId),

  // --- Shifts --------------------------------------------------------------
  'shifts:list': ({ db }, payload = {}) => {
    const from = payload.from ?? addDays(today(), -7);
    const to = payload.to ?? addDays(today(), 21);
    return db
      .prepare(
        `SELECT s.*, a.title AS assignment_title, a.required_licence_sector,
                o.name AS client_name, si.name AS site_name,
                w.first_name, w.last_name
         FROM shifts s
         JOIN assignments a ON a.id = s.assignment_id
         JOIN organisations o ON o.id = a.client_org_id
         LEFT JOIN sites si ON si.id = s.site_id
         LEFT JOIN workers w ON w.id = s.worker_id
         WHERE date(s.starts_at) BETWEEN ? AND ?
           ${payload.assignmentId ? 'AND s.assignment_id = ?' : ''}
         ORDER BY s.starts_at`,
      )
      .all(...[from, to, ...(payload.assignmentId ? [payload.assignmentId] : [])]);
  },

  'shifts:create': ({ db }, payload) => shifts.createShift(db, payload),
  'shifts:createSeries': ({ db }, payload) => {
    // Builds a repeating rota between two dates.
    const created: string[] = [];
    let date = payload.from as string;
    while (date <= payload.to) {
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
  'shifts:checkAllocation': ({ db }, { shiftId, workerId }) => shifts.checkAllocation(db, shiftId, workerId),
  'shifts:eligibleWorkers': ({ db }, { shiftId }) => shifts.eligibleWorkers(db, shiftId),
  'shifts:allocate': ({ db }, { shiftId, workerId, ...opts }) => shifts.allocateWorker(db, shiftId, workerId, opts),
  'shifts:release': ({ db }, { shiftId, reason }) => { shifts.releaseWorker(db, shiftId, reason); return true; },
  'shifts:mark': ({ db }, { shiftId, status, ...opts }) => { shifts.markShiftStatus(db, shiftId, status, opts); return true; },
  'shifts:replace': ({ db }, { shiftId, workerId, reason }) => shifts.replaceShift(db, shiftId, workerId, reason),
  'shifts:value': ({ db }, { shiftId }) => shifts.shiftValue(db, shiftId),

  // --- Timesheets ----------------------------------------------------------
  'timesheets:list': ({ db }, payload = {}) =>
    db.prepare(
      `SELECT t.*, a.title AS assignment_title, o.name AS client_name,
              w.first_name, w.last_name,
              (SELECT COUNT(*) FROM documents d WHERE d.entity_type = 'timesheet'
                AND d.entity_id = t.id AND d.category = 'signed_timesheet') AS scan_count
       FROM timesheets t
       JOIN assignments a ON a.id = t.assignment_id
       JOIN organisations o ON o.id = a.client_org_id
       JOIN workers w ON w.id = t.worker_id
       ${payload.status ? 'WHERE t.status = ?' : ''}
       ORDER BY t.week_ending DESC, w.last_name`,
    ).all(...(payload.status ? [payload.status] : [])),

  'timesheets:get': ({ db }, { id }) => timesheets.timesheetWithLines(db, id),
  'timesheets:create': ({ db }, payload) => timesheets.createTimesheet(db, payload),
  'timesheets:populate': ({ db }, { id }) => timesheets.populateFromShifts(db, id),
  'timesheets:addLine': ({ db }, { timesheetId, line }) => timesheets.addLine(db, timesheetId, line),
  'timesheets:removeLine': ({ db }, { timesheetId, lineId }) => { timesheets.removeLine(db, timesheetId, lineId); return true; },
  'timesheets:approve': ({ db }, { id, ...rest }) => {
    timesheets.approveTimesheet(db, id, rest.input ?? rest, rest.opts ?? {});
    return timesheets.timesheetWithLines(db, id);
  },
  'timesheets:reopen': ({ db }, { id, reason }) => { timesheets.reopenTimesheet(db, id, reason); return true; },
  'timesheets:dispute': ({ db }, { id, reason }) => { timesheets.disputeTimesheet(db, id, reason); return true; },
  'timesheets:unbilled': ({ db }, payload = {}) => timesheets.unbilledTimesheets(db, payload.clientOrgId),

  // --- Invoicing -----------------------------------------------------------
  'invoices:list': ({ db }, payload = {}) => {
    invoices.refreshOverdueStatuses(db);
    return db.prepare(
      `SELECT i.*, o.name AS client_name FROM invoices i
       JOIN organisations o ON o.id = i.client_org_id
       ${payload.status ? 'WHERE i.status = ?' : ''}
       ORDER BY i.created_at DESC`,
    ).all(...(payload.status ? [payload.status] : []));
  },

  'invoices:get': ({ db }, { id }) => invoices.invoiceWithDetail(db, id),
  'invoices:createFromTimesheets': ({ db }, payload) => invoices.createInvoiceFromTimesheets(db, payload),
  'invoices:issue': ({ db }, { id }) => invoices.issueInvoice(db, id),
  'invoices:void': ({ db }, { id, reason }) => { invoices.voidInvoice(db, id, reason); return true; },
  'invoices:recordPayment': ({ db }, payload) => invoices.recordPayment(db, payload),
  'invoices:creditNote': ({ db }, payload) => invoices.createCreditNote(db, payload),
  'invoices:issueCreditNote': ({ db }, { id }) => invoices.issueCreditNote(db, id),
  'invoices:lateInterest': ({ db }, { id }) => invoices.statutoryInterest(db, id),
  'invoices:agedDebtors': ({ db }) => invoices.agedDebtors(db),
  'invoices:reminders': ({ db }) => invoices.dueReminders(db),
  'invoices:markReminderSent': ({ db }, { id, channel }) => { invoices.markReminderSent(db, id, channel); return true; },
  'invoices:html': ({ db }, { id }) => renderInvoiceHtml(db, id),

  'invoices:pdf': async ({ db }, { id }) => {
    const html = renderInvoiceHtml(db, id);
    const inv = db.prepare('SELECT number FROM invoices WHERE id = ?').get(id) as any;
    const suggested = `${inv?.number ?? 'invoice'}.pdf`;

    const result = await dialog.showSaveDialog({
      title: 'Save invoice PDF',
      defaultPath: join(app.getPath('documents'), suggested),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return null;

    const pdf = await htmlToPdf(html);
    writeFileSync(result.filePath, pdf);
    return result.filePath;
  },

  // --- Purchases and self-bills --------------------------------------------
  'purchases:list': ({ db }) =>
    db.prepare(
      `SELECT p.*, o.name AS supplier FROM purchase_invoices p
       JOIN organisations o ON o.id = p.organisation_id ORDER BY p.invoice_date DESC`,
    ).all(),
  'purchases:create': ({ db }, payload) => purchases.createPurchaseInvoice(db, payload),
  'purchases:addLine': ({ db }, { purchaseInvoiceId, line }) => purchases.addPurchaseLine(db, purchaseInvoiceId, line),
  'purchases:match': ({ db }, { id }) => purchases.matchPurchaseToTimesheets(db, id),
  'purchases:approve': ({ db }, { id, approvedBy }) => { purchases.approvePurchaseInvoice(db, id, approvedBy); return true; },
  'purchases:agedCreditors': ({ db }) => purchases.agedCreditors(db),

  'selfBills:list': ({ db }) =>
    db.prepare(
      `SELECT s.*, o.name AS agency FROM self_bills s
       JOIN organisations o ON o.id = s.organisation_id ORDER BY s.received_on DESC`,
    ).all(),
  'selfBills:record': ({ db }, payload) => purchases.recordSelfBill(db, payload),
  'selfBills:reconcile': ({ db }, { id }) => purchases.reconcileSelfBill(db, id),

  // --- Reporting -----------------------------------------------------------
  'reports:margin': ({ db }, { from, to }) => purchases.marginReport(db, from, to),
  'reports:trialBalance': ({ db }, payload = {}) => ledger.trialBalance(db, payload.asOf),
  'reports:profitAndLoss': ({ db }, { from, to }) => ledger.profitAndLoss(db, from, to),
  'reports:balanceSheet': ({ db }, payload = {}) => ledger.balanceSheet(db, payload.asOf),
  'reports:vatThreshold': ({ db }) => vat.thresholdStatus(db),
  'reports:vatReturn': ({ db }, { from, to }) => vat.vatReturnWorksheet(db, from, to),
  'reports:sequenceAudit': ({ db }, { docType }) => numbering.auditSequence(db, docType ?? 'invoice'),

  // --- Statutory -----------------------------------------------------------
  'statutory:intermediaryObligations': ({ db }) => statutory.intermediaryObligations(db),
  'statutory:intermediaryReport': ({ db }, { from, to }) => statutory.generateIntermediaryReport(db, from, to),
  'statutory:filings': ({ db }) => statutory.upcomingFilings(db),
  'statutory:markFilingSubmitted': ({ db }, { id, submittedOn, reference }) => {
    statutory.markFilingSubmitted(db, id, submittedOn, reference);
    return true;
  },
  'statutory:exportIntermediaryCsv': async ({ db }, { from, to }) => {
    const rows = statutory.generateIntermediaryReport(db, from, to);
    const csv = statutory.intermediaryReportCsv(rows);
    const result = await dialog.showSaveDialog({
      title: 'Save employment intermediaries report',
      defaultPath: join(app.getPath('documents'), `intermediaries-${from}-to-${to}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, csv, 'utf8');
    statutory.markIntermediaryReportSubmitted(db, from, to, { csvPath: result.filePath });
    return result.filePath;
  },

  // --- Tide reconciliation -------------------------------------------------
  'tide:import': async ({ db }) => {
    const result = await dialog.showOpenDialog({
      title: 'Import Tide statement CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const { readFileSync } = await import('node:fs');
    const csv = readFileSync(result.filePaths[0], 'utf8');
    return tide.importTideStatement(db, csv);
  },
  'tide:reconciliation': ({ db }) => tide.reconciliationView(db),
  'tide:confirmMatch': ({ db }, { bankTxnId, target }) => { tide.confirmMatch(db, bankTxnId, target); return true; },
  'tide:autoMatch': ({ db }) => tide.autoMatchTransactions(db),

  'export:ledgerCsv': async ({ db }, { from, to }) => saveCsv(tide.exportLedgerCsv(db, from, to), `ledger-${from}-to-${to}.csv`),
  'export:salesCsv': async ({ db }, { from, to }) => saveCsv(tide.exportSalesCsv(db, from, to), `sales-${from}-to-${to}.csv`),

  // --- Evidence ------------------------------------------------------------
  'documents:attach': async ({ db, dataDir }, { entityType, entityId, category }) => {
    const result = await dialog.showOpenDialog({
      title: 'Attach document',
      filters: [{ name: 'Documents', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'tif', 'tiff', 'doc', 'docx'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled) return [];
    return result.filePaths.map((p) =>
      documents.attachDocument(db, join(dataDir, 'documents'), {
        entityType, entityId, category, sourcePath: p,
      }));
  },
  'documents:list': ({ db }, { entityType, entityId }) => documents.documentsFor(db, entityType, entityId),
  'documents:open': ({ db }, { id }) => {
    const doc = db.prepare('SELECT stored_path FROM documents WHERE id = ?').get(id) as any;
    if (!doc) throw new Error('Document not found');
    shell.openPath(doc.stored_path);
    return true;
  },
  'documents:verify': ({ db }) => documents.verifyDocuments(db),

  // --- Audit and integrity -------------------------------------------------
  'audit:verify': ({ db }) => verifyAuditChain(db),
  'audit:trail': ({ db }, { entityType, entityId }) => auditTrailFor(db, entityType, entityId),
  'audit:recent': ({ db }, payload = {}) =>
    db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(payload.limit ?? 200),

  'enquiryPack:build': ({ db }, { from, to }) => buildEnquiryPack(db, from, to),
  'enquiryPack:export': async ({ db }, { from, to }) => {
    const pack = buildEnquiryPack(db, from, to);
    const html = renderEnquiryPackHtml(pack);
    const result = await dialog.showSaveDialog({
      title: 'Save enquiry pack',
      defaultPath: join(app.getPath('documents'), `cerviz-enquiry-pack-${from}-to-${to}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }, { name: 'HTML', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return null;

    if (result.filePath.endsWith('.html')) {
      writeFileSync(result.filePath, html, 'utf8');
    } else {
      writeFileSync(result.filePath, await htmlToPdf(html));
    }
    recordAudit(db, {
      entityType: 'enquiry_pack', entityId: `${from}_${to}`, action: 'exported',
      summary: `Enquiry pack for ${from} to ${to} exported (${pack.gaps.length} gap(s) noted)`,
    });
    return result.filePath;
  },

  // --- Backups -------------------------------------------------------------
  'backup:now': ({ db, dbPath, dataDir }) => backup.backupDatabase(db, dbPath, join(dataDir, 'backups')),
  'backup:list': ({ dataDir }) => backup.listBackups(join(dataDir, 'backups')),
  'backup:restore': async ({ dbPath, dataDir }, { path }) => {
    const confirmed = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Restore'],
      defaultId: 0,
      cancelId: 0,
      title: 'Restore backup',
      message: 'Restore this backup over the current database?',
      detail:
        'The current database will be copied aside first, so this can be undone. ' +
        'The application will close afterwards and must be reopened.',
    });
    if (confirmed.response !== 1) return null;
    const result = backup.restoreBackup(path, dbPath);
    setTimeout(() => app.relaunch(), 300);
    setTimeout(() => app.exit(0), 600);
    return result;
  },

  // --- Dashboard -----------------------------------------------------------
  'dashboard:summary': ({ db }) => {
    invoices.refreshOverdueStatuses(db);
    const aged = invoices.agedDebtors(db);
    const complianceDash = compliance.expiringCompliance(db, 60);
    const unbilled = timesheets.unbilledTimesheets(db);
    const filings = statutory.upcomingFilings(db, today(), 90);
    const intermediary = statutory.intermediaryObligations(db);
    const threshold = vat.thresholdStatus(db);
    const chain = verifyAuditChain(db);

    const unfilledShifts = db
      .prepare(
        `SELECT COUNT(*) AS n FROM shifts
         WHERE worker_id IS NULL AND status = 'planned' AND date(starts_at) BETWEEN ? AND ?`,
      )
      .get(today(), addDays(today(), 14)) as any;

    const queriedPurchases = db
      .prepare(`SELECT COUNT(*) AS n FROM purchase_invoices WHERE status = 'queried'`)
      .get() as any;

    const disputedSelfBills = db
      .prepare(`SELECT COUNT(*) AS n FROM self_bills WHERE status = 'disputed'`)
      .get() as any;

    return {
      asOf: today(),
      outstandingPence: aged.totalOutstanding,
      overduePence: aged.buckets.days1to30 + aged.buckets.days31to60 + aged.buckets.days61to90 + aged.buckets.over90,
      unbilledCount: unbilled.length,
      unbilledPence: unbilled.reduce((a: number, t: any) => a + t.charge_total_pence, 0),
      unfilledShifts: unfilledShifts.n,
      licencesExpiring: complianceDash.licencesExpiring.length,
      rtwExpiring: complianceDash.rightToWorkExpiring.length,
      screeningIncomplete: complianceDash.screeningIncomplete.length,
      awrApproaching: complianceDash.awrApproaching.filter((a: any) => !a.qualified).length,
      awrQualified: complianceDash.awrApproaching.filter((a: any) => a.qualified).length,
      queriedPurchases: queriedPurchases.n,
      disputedSelfBills: disputedSelfBills.n,
      filings: filings.slice(0, 5),
      intermediary: intermediary.filter((i: any) => i.status === 'due').slice(0, 2),
      vatThreshold: threshold,
      auditChainOk: chain.ok,
      compliance: complianceDash,
    };
  },
};

/** Renders HTML to PDF using an offscreen window — no external dependency. */
async function htmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
  } finally {
    win.destroy();
  }
}

async function saveCsv(csv: string, suggestedName: string): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: 'Save export',
    defaultPath: join(app.getPath('documents'), suggestedName),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return null;
  writeFileSync(result.filePath, csv, 'utf8');
  return result.filePath;
}

/** Operations that only read; everything else is wrapped in a transaction. */
const READ_ONLY = /^(company:get|settings:get|nmw:list|orgs:list|orgs:get|orgs:dueDiligence|workers:list|workers:get|workers:compliance|compliance:dashboard|assignments:list|assignments:get|rates:resolve|supplyChain:get|shifts:list|shifts:checkAllocation|shifts:eligibleWorkers|shifts:value|timesheets:list|timesheets:get|timesheets:unbilled|invoices:list|invoices:get|invoices:lateInterest|invoices:agedDebtors|invoices:reminders|invoices:html|purchases:list|purchases:agedCreditors|selfBills:list|reports:|statutory:intermediaryObligations|statutory:intermediaryReport|statutory:filings|tide:reconciliation|documents:list|documents:verify|documents:open|audit:|enquiryPack:build|backup:list|dashboard:)/;

export function registerIpc(ctx: IpcContext): void {
  ipcMain.handle('cerviz:invoke', async (_event, channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`Unknown channel: ${channel}`);

    try {
      // Async handlers (dialogs, PDF) manage their own consistency; the
      // synchronous state-changing ones run atomically.
      if (READ_ONLY.test(channel) || handler.constructor.name === 'AsyncFunction') {
        return { ok: true, data: await handler(ctx, payload) };
      }
      const txn = ctx.db.transaction(() => handler(ctx, payload));
      return { ok: true, data: txn() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
