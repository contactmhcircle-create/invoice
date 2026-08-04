-- Cerviz Back Office — initial schema
--
-- Conventions that matter for evidential integrity:
--   * All money is INTEGER minor units (pence/cents). Never floats.
--   * All durations are INTEGER minutes. Never fractional hours.
--   * All dates/timestamps are TEXT ISO-8601. Dates as YYYY-MM-DD, instants as UTC with Z.
--   * Nothing that has been issued is ever UPDATEd or DELETEd. Corrections happen by
--     reversal (credit note, adjustment journal, replacement record).
--   * Every mutation writes to audit_log, which is a hash chain: tampering with any
--     historic row breaks every subsequent hash and is therefore detectable.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Company identity and configuration
-- ---------------------------------------------------------------------------

CREATE TABLE company (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  legal_name              TEXT    NOT NULL DEFAULT 'Cerviz Ltd',
  trading_name            TEXT,
  company_number          TEXT,                 -- Companies House registration number
  incorporated_on         TEXT,
  registered_address_1    TEXT,
  registered_address_2    TEXT,
  registered_city         TEXT,
  registered_postcode     TEXT,
  registered_country      TEXT    NOT NULL DEFAULT 'United Kingdom',
  trading_address_1       TEXT,
  trading_address_2       TEXT,
  trading_city            TEXT,
  trading_postcode        TEXT,
  phone                   TEXT,
  email                   TEXT,
  website                 TEXT,
  logo_path               TEXT,
  brand_colour            TEXT    NOT NULL DEFAULT '#1e3a5f',

  -- VAT. Built live-capable but dormant until the company registers.
  vat_registered          INTEGER NOT NULL DEFAULT 0 CHECK (vat_registered IN (0,1)),
  vat_number              TEXT,
  vat_registered_from     TEXT,                 -- invoices dated on/after this carry VAT
  vat_scheme              TEXT    NOT NULL DEFAULT 'standard'
                                  CHECK (vat_scheme IN ('standard','flat_rate','cash')),
  vat_flat_rate_percent   REAL,
  vat_basis               TEXT    NOT NULL DEFAULT 'accrual'
                                  CHECK (vat_basis IN ('accrual','cash')),

  -- Employer / intermediary status
  paye_reference          TEXT,
  accounts_office_ref     TEXT,
  is_employment_intermediary INTEGER NOT NULL DEFAULT 1 CHECK (is_employment_intermediary IN (0,1)),

  -- Banking shown on invoices
  bank_name               TEXT,
  bank_account_name       TEXT,
  bank_sort_code          TEXT,
  bank_account_number     TEXT,
  bank_iban               TEXT,
  bank_bic                TEXT,

  base_currency           TEXT    NOT NULL DEFAULT 'GBP',
  default_payment_terms_days INTEGER NOT NULL DEFAULT 30,
  invoice_footer          TEXT,
  invoice_terms           TEXT,

  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL
);

-- Free-form configuration that does not warrant a column.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Tamper-evident audit log
-- ---------------------------------------------------------------------------
-- Each row's hash covers its own content plus the previous row's hash. Altering
-- or removing any historic row invalidates every hash after it. verifyAuditChain()
-- walks the chain and reports the first break.

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT    NOT NULL,               -- UTC instant
  actor        TEXT    NOT NULL,               -- OS user or named operator
  entity_type  TEXT    NOT NULL,
  entity_id    TEXT    NOT NULL,
  action       TEXT    NOT NULL,               -- created | updated | issued | voided | ...
  summary      TEXT,                           -- human-readable, shown in the UI
  before_json  TEXT,
  after_json   TEXT,
  prev_hash    TEXT    NOT NULL,
  hash         TEXT    NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_at ON audit_log(at);

-- The audit log is append-only. These triggers make that a database guarantee
-- rather than an application convention.
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be modified');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: rows cannot be deleted');
END;

-- ---------------------------------------------------------------------------
-- Document numbering — gapless and sequential, as HMRC expects
-- ---------------------------------------------------------------------------

CREATE TABLE numbering (
  doc_type    TEXT PRIMARY KEY,                -- invoice | credit_note | quote | purchase | timesheet
  prefix      TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1,
  pad_width   INTEGER NOT NULL DEFAULT 4,
  include_year INTEGER NOT NULL DEFAULT 1 CHECK (include_year IN (0,1)),
  updated_at  TEXT NOT NULL
);

-- Every number ever allocated is recorded, including numbers on documents that
-- were later voided. A void leaves the number consumed and visible, which is
-- what makes the sequence provably gapless.
CREATE TABLE number_allocations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type     TEXT NOT NULL,
  number_text  TEXT NOT NULL UNIQUE,
  sequence_no  INTEGER NOT NULL,
  allocated_at TEXT NOT NULL,
  entity_id    TEXT,
  UNIQUE (doc_type, sequence_no)
);

-- ---------------------------------------------------------------------------
-- Organisations — clients, upper-tier agencies, end clients, umbrellas
-- ---------------------------------------------------------------------------
-- One table because a counterparty is often more than one thing: an agency you
-- supply may also be the end client on a different contract.

CREATE TABLE organisations (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  legal_name           TEXT,
  company_number       TEXT,
  vat_number           TEXT,
  is_client            INTEGER NOT NULL DEFAULT 0 CHECK (is_client IN (0,1)),
  is_end_client        INTEGER NOT NULL DEFAULT 0 CHECK (is_end_client IN (0,1)),
  is_umbrella          INTEGER NOT NULL DEFAULT 0 CHECK (is_umbrella IN (0,1)),
  is_supplier          INTEGER NOT NULL DEFAULT 0 CHECK (is_supplier IN (0,1)),

  address_1            TEXT,
  address_2            TEXT,
  city                 TEXT,
  postcode             TEXT,
  country              TEXT NOT NULL DEFAULT 'United Kingdom',
  contact_name         TEXT,
  contact_email        TEXT,
  contact_phone        TEXT,

  currency             TEXT NOT NULL DEFAULT 'GBP',
  payment_terms_days   INTEGER NOT NULL DEFAULT 30,
  credit_limit_pence   INTEGER,
  self_bills_us        INTEGER NOT NULL DEFAULT 0 CHECK (self_bills_us IN (0,1)),
  po_required          INTEGER NOT NULL DEFAULT 0 CHECK (po_required IN (0,1)),

  notes                TEXT,
  status               TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','prospect','on_hold','closed')),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_org_name ON organisations(name);

-- Supply chain due diligence. Under the Kittel principle HMRC may deny VAT
-- recovery where a business "knew or should have known" of fraud in its chain;
-- these records are the evidence that checks were actually performed.
CREATE TABLE org_due_diligence (
  id              TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  check_type      TEXT NOT NULL,               -- companies_house | vat_number | insurance |
                                               -- credit | licence | site_visit | contract | other
  performed_on    TEXT NOT NULL,
  performed_by    TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('pass','fail','query','not_applicable')),
  reference       TEXT,                        -- e.g. the VAT number checked, CH number verified
  notes           TEXT,
  next_review_on  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_dd_org ON org_due_diligence(organisation_id);

CREATE TABLE sites (
  id              TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  address_1       TEXT,
  address_2       TEXT,
  city            TEXT,
  postcode        TEXT,
  what3words      TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  access_notes    TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_sites_org ON sites(organisation_id);

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TABLE workers (
  id                   TEXT PRIMARY KEY,
  reference            TEXT UNIQUE,
  first_name           TEXT NOT NULL,
  last_name            TEXT NOT NULL,
  known_as             TEXT,
  date_of_birth        TEXT,                   -- drives National Minimum Wage age band
  ni_number            TEXT,
  email                TEXT,
  phone                TEXT,
  address_1            TEXT,
  address_2            TEXT,
  city                 TEXT,
  postcode             TEXT,

  -- Engagement determines the pay route and which tax rules apply.
  engagement_type      TEXT NOT NULL DEFAULT 'umbrella'
                            CHECK (engagement_type IN ('paye','umbrella','limited','self_employed')),
  umbrella_org_id      TEXT REFERENCES organisations(id),
  limited_company_no   TEXT,
  ir35_status          TEXT CHECK (ir35_status IN ('inside','outside','not_assessed')),
  ir35_assessed_on     TEXT,
  ir35_notes           TEXT,

  default_pay_rate_pence INTEGER,              -- per hour, before assignment overrides

  -- Working Time Regulations
  wtr_opt_out          INTEGER NOT NULL DEFAULT 0 CHECK (wtr_opt_out IN (0,1)),
  wtr_opt_out_signed_on TEXT,

  -- Pay details (for PAYE workers; umbrella workers are paid via their umbrella)
  bank_account_name    TEXT,
  bank_sort_code       TEXT,
  bank_account_number  TEXT,

  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,

  status               TEXT NOT NULL DEFAULT 'onboarding'
                            CHECK (status IN ('onboarding','active','inactive','left','barred')),
  notes                TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_workers_name ON workers(last_name, first_name);
CREATE INDEX idx_workers_status ON workers(status);

-- SIA licences. Expiry is enforced at allocation time: a worker cannot be placed
-- on a shift that starts after their licence expires.
CREATE TABLE worker_licences (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  licence_type  TEXT NOT NULL DEFAULT 'sia',
  sector        TEXT NOT NULL,                 -- door_supervisor | security_guard | cctv |
                                               -- close_protection | key_holding | vehicle_immobilisation
  licence_number TEXT NOT NULL,
  issued_on     TEXT,
  expires_on    TEXT NOT NULL,
  verified_on   TEXT,                          -- date checked against the SIA register
  verified_by   TEXT,
  status        TEXT NOT NULL DEFAULT 'valid'
                     CHECK (status IN ('valid','expired','suspended','revoked','pending')),
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_licence_worker ON worker_licences(worker_id);
CREATE INDEX idx_licence_expiry ON worker_licences(expires_on);

-- Right to work. The statutory excuse depends on the check being completed
-- before the first shift, so check_date is compared against first allocation.
CREATE TABLE worker_rtw (
  id             TEXT PRIMARY KEY,
  worker_id      TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  method         TEXT NOT NULL CHECK (method IN ('share_code','manual_document','idsp')),
  share_code     TEXT,
  document_type  TEXT,
  document_ref   TEXT,
  checked_on     TEXT NOT NULL,
  checked_by     TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('continuous','time_limited','failed')),
  expires_on     TEXT,                         -- for time-limited permission
  recheck_due_on TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_rtw_worker ON worker_rtw(worker_id);

-- BS 7858 screening. Buyers in security procurement audit this pack directly,
-- so each element is tracked separately with its own evidence.
CREATE TABLE screening_checks (
  id           TEXT PRIMARY KEY,
  worker_id    TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  element      TEXT NOT NULL,                  -- identity | address_history | employment_history |
                                               -- character_references | financial_probity |
                                               -- criminal_record | qualifications | health
  status       TEXT NOT NULL DEFAULT 'not_started'
                    CHECK (status IN ('not_started','in_progress','satisfied','failed','waived')),
  started_on   TEXT,
  completed_on TEXT,
  covers_from  TEXT,                           -- employment history must cover 5 years
  covers_to    TEXT,
  verified_by  TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (worker_id, element)
);

-- Key Information Document — required before terms are agreed with an agency worker.
CREATE TABLE key_information_documents (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL DEFAULT 1,
  issued_on     TEXT NOT NULL,
  issued_by     TEXT,
  engagement_type TEXT NOT NULL,
  pay_rate_pence INTEGER,
  umbrella_org_id TEXT REFERENCES organisations(id),
  deductions_json TEXT,                        -- itemised pay-chain deductions
  content_html  TEXT NOT NULL,                 -- the document as issued, frozen
  acknowledged_on TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_kid_worker ON key_information_documents(worker_id);

-- ---------------------------------------------------------------------------
-- Documents and evidence files
-- ---------------------------------------------------------------------------
-- Generic attachment table. sha256 is recorded so a file can be proven unchanged
-- since upload — signed timesheets in particular.

CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,                  -- worker | shift | timesheet | invoice | organisation | ...
  entity_id    TEXT NOT NULL,
  category     TEXT,                           -- signed_timesheet | licence_scan | rtw_evidence | ...
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   INTEGER,
  sha256       TEXT NOT NULL,
  uploaded_at  TEXT NOT NULL,
  uploaded_by  TEXT,
  notes        TEXT
);

CREATE INDEX idx_docs_entity ON documents(entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Assignments and the supply chain
-- ---------------------------------------------------------------------------

CREATE TABLE assignments (
  id                TEXT PRIMARY KEY,
  reference         TEXT UNIQUE,
  client_org_id     TEXT NOT NULL REFERENCES organisations(id),
  site_id           TEXT REFERENCES sites(id),
  title             TEXT NOT NULL,
  sector            TEXT NOT NULL DEFAULT 'security',
  role              TEXT,                      -- the AWR comparator role
  required_licence_sector TEXT,                -- blocks allocation of unlicensed workers
  starts_on         TEXT NOT NULL,
  ends_on           TEXT,
  po_reference      TEXT,
  currency          TEXT NOT NULL DEFAULT 'GBP',

  -- Rate behaviour. All optional: a flat-rate contract simply leaves these off.
  use_rate_bands       INTEGER NOT NULL DEFAULT 0 CHECK (use_rate_bands IN (0,1)),
  bank_holiday_multiplier REAL,
  overtime_after_minutes  INTEGER,
  overtime_multiplier     REAL,
  min_shift_minutes       INTEGER,

  invoice_grouping  TEXT NOT NULL DEFAULT 'assignment'
                         CHECK (invoice_grouping IN ('assignment','site','client')),
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('draft','active','suspended','ended')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_assign_client ON assignments(client_org_id);
CREATE INDEX idx_assign_status ON assignments(status);

-- Who sits where in the chain for this assignment. This is the first thing HMRC
-- asks a labour supplier to produce, and it determines where PAYE responsibility
-- for umbrella workers falls.
CREATE TABLE supply_chain_links (
  id              TEXT PRIMARY KEY,
  assignment_id   TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,            -- 0 = end client, ascending down to the worker
  role            TEXT NOT NULL CHECK (role IN
                     ('end_client','upper_agency','cerviz','umbrella','worker','other')),
  organisation_id TEXT REFERENCES organisations(id),
  description     TEXT,
  contract_ref    TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (assignment_id, position)
);

-- Rates resolve shift -> assignment -> site -> client. The first match wins.
CREATE TABLE rates (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL CHECK (scope IN ('client','site','assignment')),
  scope_id          TEXT NOT NULL,
  band              TEXT NOT NULL DEFAULT 'standard'
                         CHECK (band IN ('standard','night','weekend','bank_holiday','overtime')),
  charge_rate_pence INTEGER NOT NULL,          -- per hour, to the client
  pay_rate_pence    INTEGER NOT NULL,          -- per hour, to the worker or umbrella
  effective_from    TEXT NOT NULL,
  effective_to      TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_rates_scope ON rates(scope, scope_id, band, effective_from);

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------
-- Rates are snapshotted onto the shift when it is allocated. Later rate changes
-- never retrospectively alter what an already-worked shift was worth.

CREATE TABLE shifts (
  id                 TEXT PRIMARY KEY,
  assignment_id      TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  site_id            TEXT REFERENCES sites(id),
  worker_id          TEXT REFERENCES workers(id),
  starts_at          TEXT NOT NULL,            -- local ISO datetime
  ends_at            TEXT NOT NULL,
  break_minutes      INTEGER NOT NULL DEFAULT 0,
  band               TEXT NOT NULL DEFAULT 'standard',
  is_bank_holiday    INTEGER NOT NULL DEFAULT 0 CHECK (is_bank_holiday IN (0,1)),

  charge_rate_pence  INTEGER,                  -- snapshot at allocation
  pay_rate_pence     INTEGER,
  rate_source        TEXT,                     -- which rule resolved, for explainability
  charge_rate_override_pence INTEGER,
  pay_rate_override_pence    INTEGER,

  actual_start_at    TEXT,
  actual_end_at      TEXT,
  actual_break_minutes INTEGER,

  status             TEXT NOT NULL DEFAULT 'planned'
                          CHECK (status IN ('planned','allocated','worked','no_show',
                                            'cancelled','replaced')),
  replaced_by_shift_id TEXT REFERENCES shifts(id),
  cancellation_reason TEXT,
  notes              TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_shifts_assignment ON shifts(assignment_id);
CREATE INDEX idx_shifts_worker_time ON shifts(worker_id, starts_at);
CREATE INDEX idx_shifts_status ON shifts(status);

-- ---------------------------------------------------------------------------
-- Timesheets
-- ---------------------------------------------------------------------------
-- One timesheet per worker per assignment per week. The signed paper scan
-- attaches here via documents. Approval locks the hours; billing locks the sheet.

CREATE TABLE timesheets (
  id                TEXT PRIMARY KEY,
  reference         TEXT UNIQUE,
  assignment_id     TEXT NOT NULL REFERENCES assignments(id),
  worker_id         TEXT NOT NULL REFERENCES workers(id),
  week_ending       TEXT NOT NULL,             -- Sunday, YYYY-MM-DD
  total_minutes     INTEGER NOT NULL DEFAULT 0,
  charge_total_pence INTEGER NOT NULL DEFAULT 0,
  pay_total_pence   INTEGER NOT NULL DEFAULT 0,

  client_signatory  TEXT,                      -- who signed the paper sheet
  client_signed_on  TEXT,
  entered_by        TEXT,
  entered_at        TEXT,
  approved_by       TEXT,
  approved_at       TEXT,

  status            TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','approved','invoiced','disputed','void')),
  invoice_id        TEXT,
  dispute_reason    TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (assignment_id, worker_id, week_ending)
);

CREATE INDEX idx_ts_status ON timesheets(status);
CREATE INDEX idx_ts_week ON timesheets(week_ending);

CREATE TABLE timesheet_lines (
  id                 TEXT PRIMARY KEY,
  timesheet_id       TEXT NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  shift_id           TEXT REFERENCES shifts(id),
  work_date          TEXT NOT NULL,
  start_time         TEXT,
  end_time           TEXT,
  break_minutes      INTEGER NOT NULL DEFAULT 0,
  worked_minutes     INTEGER NOT NULL,
  billed_minutes     INTEGER NOT NULL,         -- may differ: minimum shift charge, rounding
  band               TEXT NOT NULL DEFAULT 'standard',
  charge_rate_pence  INTEGER NOT NULL,
  pay_rate_pence     INTEGER NOT NULL,
  charge_pence       INTEGER NOT NULL,
  pay_pence          INTEGER NOT NULL,
  notes              TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_tsl_timesheet ON timesheet_lines(timesheet_id);
CREATE INDEX idx_tsl_shift ON timesheet_lines(shift_id);

-- ---------------------------------------------------------------------------
-- Agency Workers Regulations — the 12-week qualifying clock
-- ---------------------------------------------------------------------------
-- A worker in the same role with the same hirer accrues qualifying weeks; at 12
-- they gain equal treatment rights. Breaks of 6+ weeks reset the clock.

CREATE TABLE awr_weeks (
  id            TEXT PRIMARY KEY,
  worker_id     TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  week_ending   TEXT NOT NULL,
  qualifies     INTEGER NOT NULL DEFAULT 1 CHECK (qualifies IN (0,1)),
  cumulative    INTEGER NOT NULL,
  reset_reason  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (worker_id, assignment_id, week_ending)
);

CREATE INDEX idx_awr_worker ON awr_weeks(worker_id, assignment_id);

-- ---------------------------------------------------------------------------
-- National Minimum Wage rate table — editable, so April upratings need no release
-- ---------------------------------------------------------------------------

CREATE TABLE nmw_rates (
  id             TEXT PRIMARY KEY,
  effective_from TEXT NOT NULL,
  band           TEXT NOT NULL CHECK (band IN ('21_and_over','18_to_20','under_18','apprentice')),
  rate_pence     INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (effective_from, band)
);

-- ---------------------------------------------------------------------------
-- Sales: invoices, credit notes, payments
-- ---------------------------------------------------------------------------
-- An invoice is mutable only while status = 'draft'. Once issued it is frozen;
-- corrections are made by credit note.

CREATE TABLE invoices (
  id                  TEXT PRIMARY KEY,
  number              TEXT UNIQUE,
  client_org_id       TEXT NOT NULL REFERENCES organisations(id),
  assignment_id       TEXT REFERENCES assignments(id),
  site_id             TEXT REFERENCES sites(id),

  issue_date          TEXT,
  tax_point_date      TEXT,
  due_date            TEXT,
  period_from         TEXT,
  period_to           TEXT,
  po_reference        TEXT,

  currency            TEXT NOT NULL DEFAULT 'GBP',
  fx_rate             REAL NOT NULL DEFAULT 1.0,   -- to base currency, captured at issue
  net_pence           INTEGER NOT NULL DEFAULT 0,
  vat_pence           INTEGER NOT NULL DEFAULT 0,
  gross_pence         INTEGER NOT NULL DEFAULT 0,
  base_net_pence      INTEGER NOT NULL DEFAULT 0,  -- GBP equivalent for the records
  base_vat_pence      INTEGER NOT NULL DEFAULT 0,
  base_gross_pence    INTEGER NOT NULL DEFAULT 0,
  paid_pence          INTEGER NOT NULL DEFAULT 0,

  vat_applied         INTEGER NOT NULL DEFAULT 0 CHECK (vat_applied IN (0,1)),
  vat_note            TEXT,                         -- e.g. "Not VAT registered"

  status              TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','issued','part_paid','paid','overdue','void')),
  issued_at           TEXT,
  voided_at           TEXT,
  void_reason         TEXT,
  sent_at             TEXT,
  notes               TEXT,
  terms               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_inv_client ON invoices(client_org_id);
CREATE INDEX idx_inv_status ON invoices(status);
CREATE INDEX idx_inv_issue ON invoices(issue_date);

-- Issued invoices are immutable. Only the fields that legitimately change after
-- issue (payment allocation, status, void marking, sent timestamp) may move.
CREATE TRIGGER invoices_immutable_when_issued BEFORE UPDATE ON invoices
WHEN OLD.status <> 'draft'
  AND (NEW.number          IS NOT OLD.number
    OR NEW.client_org_id   IS NOT OLD.client_org_id
    OR NEW.issue_date      IS NOT OLD.issue_date
    OR NEW.tax_point_date  IS NOT OLD.tax_point_date
    OR NEW.currency        IS NOT OLD.currency
    OR NEW.fx_rate         IS NOT OLD.fx_rate
    OR NEW.net_pence       IS NOT OLD.net_pence
    OR NEW.vat_pence       IS NOT OLD.vat_pence
    OR NEW.gross_pence     IS NOT OLD.gross_pence)
BEGIN
  SELECT RAISE(ABORT,
    'This invoice has been issued and cannot be altered. Void it and reissue, or raise a credit note.');
END;

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'Issued invoices cannot be deleted. Void the invoice instead.');
END;

CREATE TABLE invoice_lines (
  id             TEXT PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL,
  description    TEXT NOT NULL,
  timesheet_id   TEXT REFERENCES timesheets(id),   -- traceability back to signed paper
  shift_id       TEXT REFERENCES shifts(id),
  worker_id      TEXT REFERENCES workers(id),
  work_date      TEXT,
  quantity_minutes INTEGER,
  unit_price_pence INTEGER NOT NULL,
  net_pence      INTEGER NOT NULL,
  vat_rate       REAL NOT NULL DEFAULT 0,
  vat_code       TEXT NOT NULL DEFAULT 'none'
                      CHECK (vat_code IN ('none','standard','reduced','zero','exempt','outside_scope','reverse_charge')),
  vat_pence      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_invline_invoice ON invoice_lines(invoice_id);
CREATE INDEX idx_invline_timesheet ON invoice_lines(timesheet_id);

CREATE TABLE credit_notes (
  id              TEXT PRIMARY KEY,
  number          TEXT UNIQUE,
  invoice_id      TEXT REFERENCES invoices(id),
  client_org_id   TEXT NOT NULL REFERENCES organisations(id),
  issue_date      TEXT,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  fx_rate         REAL NOT NULL DEFAULT 1.0,
  net_pence       INTEGER NOT NULL DEFAULT 0,
  vat_pence       INTEGER NOT NULL DEFAULT 0,
  gross_pence     INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','issued','applied','void')),
  issued_at       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE credit_note_lines (
  id             TEXT PRIMARY KEY,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL,
  description    TEXT NOT NULL,
  net_pence      INTEGER NOT NULL,
  vat_rate       REAL NOT NULL DEFAULT 0,
  vat_code       TEXT NOT NULL DEFAULT 'none',
  vat_pence      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  organisation_id TEXT REFERENCES organisations(id),
  worker_id       TEXT REFERENCES workers(id),
  invoice_id      TEXT REFERENCES invoices(id),
  purchase_invoice_id TEXT,
  paid_on         TEXT NOT NULL,
  amount_pence    INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  fx_rate         REAL NOT NULL DEFAULT 1.0,
  method          TEXT NOT NULL DEFAULT 'bank_transfer'
                       CHECK (method IN ('bank_transfer','card','cash','cheque','direct_debit','other')),
  reference       TEXT,
  bank_txn_id     TEXT,
  -- Set when company income was received personally by a director and passed on.
  via_director_loan INTEGER NOT NULL DEFAULT 0 CHECK (via_director_loan IN (0,1)),
  notes           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_pay_invoice ON payments(invoice_id);
CREATE INDEX idx_pay_date ON payments(paid_on);

-- Reminder / dunning schedule for unpaid invoices.
CREATE TABLE invoice_reminders (
  id           TEXT PRIMARY KEY,
  invoice_id   TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  due_on       TEXT NOT NULL,
  stage        TEXT NOT NULL,                  -- pre_due | due | overdue_7 | overdue_14 | overdue_30 | ltb
  sent_at      TEXT,
  channel      TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Purchases: umbrella invoices and other costs
-- ---------------------------------------------------------------------------

CREATE TABLE purchase_invoices (
  id              TEXT PRIMARY KEY,
  our_reference   TEXT UNIQUE,
  organisation_id TEXT NOT NULL REFERENCES organisations(id),
  their_reference TEXT,
  invoice_date    TEXT NOT NULL,
  due_date        TEXT,
  period_from     TEXT,
  period_to       TEXT,
  currency        TEXT NOT NULL DEFAULT 'GBP',
  fx_rate         REAL NOT NULL DEFAULT 1.0,
  net_pence       INTEGER NOT NULL DEFAULT 0,
  vat_pence       INTEGER NOT NULL DEFAULT 0,
  gross_pence     INTEGER NOT NULL DEFAULT 0,
  paid_pence      INTEGER NOT NULL DEFAULT 0,
  expected_pence  INTEGER,                     -- what our own timesheets say it should be
  variance_pence  INTEGER,
  category        TEXT NOT NULL DEFAULT 'umbrella_labour',
  status          TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received','matched','queried','approved','paid','void')),
  query_notes     TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_pinv_org ON purchase_invoices(organisation_id);
CREATE INDEX idx_pinv_status ON purchase_invoices(status);

CREATE TABLE purchase_invoice_lines (
  id                  TEXT PRIMARY KEY,
  purchase_invoice_id TEXT NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  line_no             INTEGER NOT NULL,
  description         TEXT NOT NULL,
  worker_id           TEXT REFERENCES workers(id),
  timesheet_id        TEXT REFERENCES timesheets(id),
  shift_id            TEXT REFERENCES shifts(id),
  quantity_minutes    INTEGER,
  unit_price_pence    INTEGER NOT NULL,
  net_pence           INTEGER NOT NULL,
  vat_rate            REAL NOT NULL DEFAULT 0,
  vat_pence           INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

-- Self-bills received from agencies that invoice themselves on our behalf.
-- The variance against our own timesheet calculation is the whole point.
CREATE TABLE self_bills (
  id                 TEXT PRIMARY KEY,
  organisation_id    TEXT NOT NULL REFERENCES organisations(id),
  their_reference    TEXT NOT NULL,
  received_on        TEXT NOT NULL,
  period_from        TEXT,
  period_to          TEXT,
  currency           TEXT NOT NULL DEFAULT 'GBP',
  their_net_pence    INTEGER NOT NULL,
  their_vat_pence    INTEGER NOT NULL DEFAULT 0,
  their_gross_pence  INTEGER NOT NULL,
  our_expected_net_pence INTEGER,
  variance_pence     INTEGER,
  status             TEXT NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received','agreed','disputed','resolved')),
  dispute_notes      TEXT,
  resolved_on        TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE self_bill_lines (
  id            TEXT PRIMARY KEY,
  self_bill_id  TEXT NOT NULL REFERENCES self_bills(id) ON DELETE CASCADE,
  description   TEXT,
  worker_id     TEXT REFERENCES workers(id),
  timesheet_id  TEXT REFERENCES timesheets(id),
  work_date     TEXT,
  their_minutes INTEGER,
  their_rate_pence INTEGER,
  their_net_pence  INTEGER NOT NULL,
  our_minutes   INTEGER,
  our_rate_pence INTEGER,
  our_net_pence INTEGER,
  variance_pence INTEGER,
  created_at    TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Bank: Tide statement import and reconciliation
-- ---------------------------------------------------------------------------

CREATE TABLE bank_accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'Tide',
  sort_code    TEXT,
  account_number TEXT,
  currency     TEXT NOT NULL DEFAULT 'GBP',
  is_business  INTEGER NOT NULL DEFAULT 1 CHECK (is_business IN (0,1)),
  created_at   TEXT NOT NULL
);

CREATE TABLE bank_transactions (
  id              TEXT PRIMARY KEY,
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  transacted_on   TEXT NOT NULL,
  description     TEXT,
  reference       TEXT,
  amount_pence    INTEGER NOT NULL,            -- positive in, negative out
  balance_pence   INTEGER,
  import_batch    TEXT,
  import_hash     TEXT UNIQUE,                 -- prevents double-importing the same row
  matched_type    TEXT,                        -- invoice | purchase_invoice | payment | none
  matched_id      TEXT,
  matched_at      TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_banktx_date ON bank_transactions(transacted_on);
CREATE INDEX idx_banktx_matched ON bank_transactions(matched_type, matched_id);

-- ---------------------------------------------------------------------------
-- Lightweight double-entry ledger
-- ---------------------------------------------------------------------------
-- Present so the app can show true margin and produce a self-contained enquiry
-- pack. It reconciles to Tide rather than replacing it.

CREATE TABLE accounts (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  is_control  INTEGER NOT NULL DEFAULT 0 CHECK (is_control IN (0,1)),
  created_at  TEXT NOT NULL
);

CREATE TABLE journals (
  id           TEXT PRIMARY KEY,
  journal_date TEXT NOT NULL,
  narrative    TEXT NOT NULL,
  source_type  TEXT,                           -- invoice | purchase_invoice | payment | manual
  source_id    TEXT,
  reversed_by  TEXT REFERENCES journals(id),
  reverses     TEXT REFERENCES journals(id),
  created_at   TEXT NOT NULL,
  created_by   TEXT
);

CREATE INDEX idx_journal_date ON journals(journal_date);
CREATE INDEX idx_journal_source ON journals(source_type, source_id);

CREATE TABLE journal_lines (
  id           TEXT PRIMARY KEY,
  journal_id   TEXT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit_pence  INTEGER NOT NULL DEFAULT 0,
  credit_pence INTEGER NOT NULL DEFAULT 0,
  description  TEXT,
  CHECK (debit_pence >= 0 AND credit_pence >= 0),
  CHECK (NOT (debit_pence > 0 AND credit_pence > 0))
);

CREATE INDEX idx_jline_journal ON journal_lines(journal_id);
CREATE INDEX idx_jline_account ON journal_lines(account_code);

-- Posted journals are never edited; corrections are posted as reversals.
CREATE TRIGGER journals_no_update BEFORE UPDATE ON journals
WHEN NEW.journal_date IS NOT OLD.journal_date OR NEW.narrative IS NOT OLD.narrative
BEGIN
  SELECT RAISE(ABORT, 'Posted journals cannot be edited. Post a reversing journal instead.');
END;

CREATE TRIGGER journal_lines_no_update BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'Posted journal lines cannot be edited. Post a reversing journal instead.');
END;

CREATE TRIGGER journal_lines_no_delete BEFORE DELETE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'Posted journal lines cannot be deleted. Post a reversing journal instead.');
END;

-- ---------------------------------------------------------------------------
-- Statutory obligations and filings
-- ---------------------------------------------------------------------------

CREATE TABLE filings (
  id            TEXT PRIMARY KEY,
  filing_type   TEXT NOT NULL,                 -- confirmation_statement | annual_accounts |
                                               -- corporation_tax | vat_return |
                                               -- employment_intermediary_report | rti_fps
  period_from   TEXT,
  period_to     TEXT,
  due_on        TEXT NOT NULL,
  submitted_on  TEXT,
  reference     TEXT,
  status        TEXT NOT NULL DEFAULT 'due'
                     CHECK (status IN ('due','submitted','late','not_required')),
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_filings_due ON filings(due_on, status);

-- Quarterly employment intermediaries report (5 Aug / 5 Nov / 5 Feb / 5 May).
CREATE TABLE intermediary_reports (
  id            TEXT PRIMARY KEY,
  period_from   TEXT NOT NULL,
  period_to     TEXT NOT NULL,
  due_on        TEXT NOT NULL,
  submitted_on  TEXT,
  worker_count  INTEGER NOT NULL DEFAULT 0,
  csv_path      TEXT,
  status        TEXT NOT NULL DEFAULT 'due'
                     CHECK (status IN ('due','generated','submitted','nil_return')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (period_from, period_to)
);

CREATE TABLE directors (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'director'
                      CHECK (role IN ('director','secretary','psc')),
  appointed_on   TEXT,
  resigned_on    TEXT,
  date_of_birth  TEXT,
  nationality    TEXT,
  address        TEXT,
  psc_nature     TEXT,                         -- nature of control, for the PSC register
  id_verified_on TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- VAT (dormant until the company registers)
-- ---------------------------------------------------------------------------

CREATE TABLE vat_returns (
  id              TEXT PRIMARY KEY,
  period_from     TEXT NOT NULL,
  period_to       TEXT NOT NULL,
  due_on          TEXT,
  box1_vat_due_sales        INTEGER NOT NULL DEFAULT 0,
  box2_vat_due_acquisitions INTEGER NOT NULL DEFAULT 0,
  box3_total_vat_due        INTEGER NOT NULL DEFAULT 0,
  box4_vat_reclaimed        INTEGER NOT NULL DEFAULT 0,
  box5_net_vat              INTEGER NOT NULL DEFAULT 0,
  box6_total_sales_ex_vat   INTEGER NOT NULL DEFAULT 0,
  box7_total_purchases_ex_vat INTEGER NOT NULL DEFAULT 0,
  box8_total_supplies       INTEGER NOT NULL DEFAULT 0,
  box9_total_acquisitions   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','finalised','submitted')),
  submitted_on    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (period_from, period_to)
);

-- Note: schema_migrations is bootstrapped in code before migrations run, so it
-- is deliberately not declared here.
