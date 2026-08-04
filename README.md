# Cerviz Back Office

Web-based staffing back-office for **Cerviz Ltd** — a UK sub-contractor
supplying SIA-licensed security officers into other agencies and end clients.

Invoicing is the last step, not the whole app. A staffing invoice can only be
correct if you know who worked, on which site, for how many hours, at which rate,
and whether they were compliant at the moment they worked. So the app follows
that chain:

```
client requirement → worker vetting → compliance pack → shift allocation
    → timesheet (signed on site) → invoice → umbrella cost → margin
```

Runs as a single container with a local SQLite database. Multiple users with
distinct roles, mandatory two-factor authentication, and access from any device.

**To put it online at `invoice.cerviz.co.uk`, see [DEPLOYMENT.md](DEPLOYMENT.md).**

---

## Running it locally

```bash
npm install

# One terminal: the API
APP_SECRET=$(openssl rand -base64 48) \
OWNER_EMAIL=you@cerviz.co.uk \
OWNER_PASSWORD=a-long-enough-password \
npm run dev:api

# Another: the interface, proxying to it
npm run dev:web
```

Then open <http://localhost:5173>.

Optionally load a realistic dataset first — 4 organisations, 7 officers, 200
shifts, 26 timesheets, 14 invoices:

```bash
npm run seed:demo -- ./data/cerviz.sqlite
```

| Command | What it does |
|---|---|
| `npm test` | 109 tests against the real schema in memory |
| `npm run typecheck` | TypeScript across core, server, web and tests |
| `npm run build` | Builds the interface and bundles the server |
| `npm start` | Runs the built server |
| `npm run seed:demo -- <path>` | Builds the demo dataset |

---

## How it is put together

```
core/     Domain logic — compliance, rates, timesheets, invoicing, VAT,
          supply chain, enquiry pack. Knows nothing about HTTP or React.
server/   Fastify API, authentication, roles, the operation registry.
web/      React interface.
shared/   Money and date helpers used by both sides.
```

The split matters: `core/` is where the rules that must be right live, and it is
where the tests point. The server is a thin layer that authenticates a request,
checks a capability, and calls into it.

---

## Accounts and roles

Every account needs a password **and** an authenticator app — no exceptions, for
any role. A new user is made to change their password and set up two-factor
before reaching any data.

| Role | Can do | Cannot |
|---|---|---|
| **Owner** | Everything, including managing users | — |
| **Compliance & vetting** | Workers, licences, right to work, BS 7858, and *sees personal data* | Rates, margins, invoices |
| **Scheduler** | Rotas, allocation, timesheet entry | Personal data, rates, approving timesheets |
| **Finance** | Invoicing, purchases, reports, statutory returns | Worker personal data |
| **Read only** | Views everything except personal data | Any change |

Permissions are enforced on the server, per operation. Hiding a button is
presentation; the restriction is real either way. Worker National Insurance
numbers, dates of birth, addresses and bank details are **stripped from the
response** for roles without `workers.pii` — a scheduler cannot see them even by
reading the network traffic.

Changing someone's role or suspending them ends their sessions immediately.

---

## What the app enforces


These are hard blocks. A worker who fails any of them cannot be allocated to a
shift — the rota refuses rather than warning and letting it through, because a
compliance system that can be clicked past is worse than none.

| Rule | Behaviour |
|---|---|
| **SIA licence** | Evaluated against the *shift date*, not today, so a rota running past an expiry is caught when it is built |
| **Licence sector** | An assignment requiring door supervisors will not accept a CCTV-only licence |
| **Right to work** | Must be checked before the first shift; time-limited permission blocks once expired |
| **BS 7858 screening** | All six elements satisfied before placement |
| **National Minimum Wage** | Pay rate checked against the worker's age band on the work date |
| **Double-booking** | Overlapping shifts for the same worker are refused |
| **Umbrella linkage** | An umbrella worker with no umbrella recorded cannot be placed — the pay chain cannot be evidenced |

Warnings never block. They surface on the dashboard: licences expiring within 60
days, right-to-work re-checks falling due, the **AWR 12-week clock** approaching
(with the 6-week break reset applied), and workers scheduled past 48 hours with
no signed opt-out.

---

## What makes the records defensible

**Unbroken traceability.** Every invoice line points at a timesheet, every
timesheet at a shift, every shift at a worker and their compliance record, and
every approved timesheet at the paper sheet signed on site. Point at any figure
in the accounts and the chain is one query away.

**Hash-chained audit log.** Each entry's hash covers the entry before it, so
altering or removing any historic record breaks every hash after it. The
database also refuses `UPDATE` and `DELETE` on the log by trigger. The
difference matters: most systems can show you a log; this one can demonstrate
the log has not been rewritten.

**Immutable invoices.** Once issued, an invoice is frozen by database trigger,
not by convention. Corrections go out as credit notes. Voided invoices keep their
number and stay listed — that is what makes the series *provably* gapless rather
than merely tidy.

**Signed scans required.** A timesheet cannot be approved without the signed
paper sheet attached, unless you record an explicit reason — which is written
verbatim into the audit trail and surfaced in the enquiry pack.

**Money as integer pence.** No floating point anywhere near a monetary value.

**File integrity.** Every attached document is hashed on upload, so a scan
produced two years later can be shown to be the file that was attached.

**One-button enquiry pack.** Pick a date range and get everything — invoices,
backing timesheets, signed scans, workers and their compliance at the time, money
in and out, the supply chain per assignment, and a statement that the audit trail
verified. It also names the gaps an inspector would notice: unsigned timesheets,
missing supply chain maps, counterparties with no due diligence, shifts worked
without a valid licence. Run it on yourself before anyone else does.

---

## The supply chain map

Supplying staff as a sub-contractor puts Cerviz inside a labour supply chain,
which is the most heavily enforced structure in UK tax. Each assignment records
its chain explicitly — end client → agency above → Cerviz → umbrella → worker —
with each party's company number, VAT number and due diligence evidence.

This does two jobs. It is the first document HMRC asks a labour supplier to
produce. And it determines where PAYE responsibility for umbrella workers falls:
since April 2026 that sits with the agency contracting with the end client, which
is sometimes Cerviz and sometimes the agency above. The app derives which, per
assignment, and says so.

Counterparty due diligence exists for the same reason. Under the **Kittel**
principle HMRC can deny VAT recovery and pursue a business for fraud elsewhere in
its chain where it "knew or should have known". Documented checks are the
defence.

---

## Rates

Nothing is global, because Cerviz negotiates every contract separately. A rate
resolves through a fallback chain and the first match wins:

```
shift override → assignment → site → client
```

Banding (night, weekend, bank holiday), overtime uplifts and minimum shift
charges are per-assignment and **off by default**, so a flat-rate contract stays
simple while a complex one is still expressible. Whatever resolves is snapshotted
onto the shift, so a later rate change never retrospectively alters what an
already-worked shift was worth. Margin is computed per shift, assignment, client
and period from the rates that actually applied.

---

## Money in and out

**Sales** — batch approved timesheets into invoices with a shift-level backing
schedule, in GBP, EUR or USD with the FX rate captured at issue. Statutory late
payment interest at Bank of England base plus 8%, with the £40/£70/£100 fixed
compensation, calculated on demand.

**Purchases** — umbrella invoices matched against what your own approved
timesheets say the labour should have cost. An umbrella billing 41 hours for a
40-hour week is flagged for query rather than quietly paid.

**Self-bills** — where an agency raises the invoice on your behalf, the app
compares their figures to yours and flags the variance, including timesheets they
left off entirely.

**Tide** — your books live in Tide, and this app does not try to replace them.
Import the statement CSV and it reconciles bank movements against invoices and
purchase invoices. Matching is deliberately conservative: only an unambiguous
signal counts, because a wrong automatic match hides a real discrepancy. There is
a small internal ledger so the app can show true margin and produce a
self-contained enquiry pack; it reconciles *to* Tide rather than competing.

---

## Statutory

- **Employment intermediaries quarterly report** — generated in HMRC's format for
  every worker supplied without Cerviz operating PAYE, which includes all
  umbrella workers. Periods end 5 Jul / 5 Oct / 5 Jan / 5 Apr, each due one month
  later. Penalties start at £250.
- **Companies House calendar** — confirmation statement and annual accounts,
  derived from the incorporation date, with the consequence of missing each one
  stated plainly.
- **VAT threshold monitoring** — rolling 12-month turnover against £90,000, with
  the month the threshold was crossed, the registration deadline and the date VAT
  becomes chargeable. As an employment business you account for VAT on the full
  charge including the wages element — the staff hire concession was withdrawn in
  2009 — so the threshold arrives faster than it would elsewhere.
- **VAT engine** — built, tested and dormant. Switch on registration with an
  effective date and every invoice from that date carries VAT. Historic invoices
  are untouched.

---

## Backups

A backup runs when the server starts, once a day after that, and whenever you
press the button in Settings — the most recent 30 are kept, each hashed.
Everything the business depends on lives in one directory (`DATA_DIR`), so
backing up the business means copying one folder. See
[DEPLOYMENT.md](DEPLOYMENT.md) for continuous off-site backups and for how to
restore.

---

## Scope

Built for the security division as it operates now. The data model carries sector
on workers and assignments, so warehouse, driving, construction, hospitality,
office and healthcare staffing slot in without a rebuild — construction will
additionally need CIS handling.

Not included: worker pay runs and payroll RTI, self-billing *to* umbrellas, a
client portal, worker check-in, and MTD VAT submission.

---

## A caveat worth stating

This software helps you keep good records and shows you what needs attention. It
is not tax or legal advice. Several areas it touches — where umbrella PAYE
responsibility falls on a given contract, IR35 status for off-payroll workers,
whether a particular engagement is inside the agency rules — depend on the actual
contracts and turn on facts the software cannot see. Get those confirmed by an
accountant who knows staffing. The app is designed to make that person's work
fast and cheap, not to replace them.
