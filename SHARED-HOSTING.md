# Putting it on your Hostinger shared hosting — invoice.cerviz.co.uk

This is the £0 route. It uses the Business/Premium hosting you already pay
for — no VPS, no KVM, no extra plan. The application runs as plain PHP with a
SQLite database file, which is exactly what shared hosting is built for.

Total time: about 15 minutes. You need: your hPanel login, and the file
`cerviz-invoice.zip` (in this repository under `dist/`, or ask Claude to
send it to you).

---

## Step 1 — Create the subdomain

1. Log in to **hPanel** at hostinger.com.
2. Open **Websites**, find **cerviz.co.uk** and click **Manage**.
3. In the left menu search for **Subdomains** (under *Domains*).
4. In the "Create a New Subdomain" box type: **invoice**
5. Leave "Custom folder for subdomain" ticked/default and click **Create**.

Hostinger creates the subdomain with its own folder, usually:
`domains/cerviz.co.uk/public_html/invoice`
(the Subdomains page shows the exact path — note it down).

Wait a few minutes, then check that `http://invoice.cerviz.co.uk` shows
*something* (a Hostinger placeholder page is fine). If it doesn't resolve yet,
give DNS up to an hour.

## Step 2 — Turn on free SSL for the subdomain

1. In hPanel search for **SSL** in the left menu.
2. If invoice.cerviz.co.uk is listed without a certificate, click
   **Install SSL** (Hostinger's free lifetime SSL). Wait until it says Active.
3. While you're there, search **Force HTTPS** and turn it on for the
   subdomain. Sign-in pages must never travel over plain HTTP.

## Step 3 — Check the PHP version

1. In hPanel search for **PHP Configuration**.
2. Make sure the version for cerviz.co.uk (which covers the subdomain) is
   **PHP 8.1 or newer** — pick 8.2 or 8.3 if offered.
3. On the same page, open the **PHP extensions** tab and confirm
   **pdo_sqlite** and **sqlite3** are ticked (they are on by default;
   just don't untick them).

## Step 4 — Upload the application

1. In hPanel open **File Manager**.
2. Navigate into the subdomain folder from Step 1
   (`domains/cerviz.co.uk/public_html/invoice`).
3. Delete any placeholder file Hostinger put there (e.g. `default.php`).
4. Click the **Upload** icon and upload `cerviz-invoice.zip`.
5. Right-click the uploaded zip → **Extract**. Extract it **into the current
   folder** (not into a new sub-folder).
6. After extraction you should see `index.php`, `.htaccess`, `index.html`,
   and the folders `app/`, `assets/`, `migrations/` directly inside the
   subdomain folder. If they ended up inside a nested folder instead, move
   them up one level (select all → Move), then delete the zip and the empty
   folder.

> File Manager hides dot-files by default. If you can't see `.htaccess`, open
> File Manager settings and enable "Show hidden files" to confirm it arrived —
> it's the file that protects your database, so it matters.

## Step 5 — Run the installer

1. Visit **https://invoice.cerviz.co.uk** in your browser.
2. You'll see the one-time setup screen. Enter:
   - your name,
   - **contactmhcircle@gmail.com** (or whichever email you want to sign in with),
   - a password of at least 12 characters.
3. Click install. This creates the `data/` folder, the database (with a random
   unguessable filename), and your owner account. The installer locks itself
   after this — it cannot run twice.

## Step 6 — Sign in and set up two-factor

1. Sign in with the email and password from Step 5.
2. You'll be asked to set up **two-factor authentication** — this is
   mandatory for every account. Install **Google Authenticator** or
   **Microsoft Authenticator** on your phone, scan the QR code, type the
   6-digit code.
3. **Save the recovery codes it shows you** — write them down or store them in
   a password manager. They are shown once. If you lose your phone, a recovery
   code is how you get back in.

## Step 7 — Verify the security walls (one minute, do not skip)

Open these URLs in your browser. **All three must show "Forbidden" or a
denied/error page — never file contents:**

- `https://invoice.cerviz.co.uk/data/`
- `https://invoice.cerviz.co.uk/data/config.php`
- `https://invoice.cerviz.co.uk/app/db.php`

If any of them shows readable code or downloads a file, stop and check that
`.htaccess` from the zip is present in the subdomain folder (Step 4's note).

## Step 8 — First settings

In the app, open **Settings** and fill in:

- Company details: legal name, registered office, company number — these
  print on every invoice (a legal requirement for a limited company).
- Bank details — the "please pay into this account" block on invoices.
- Invoice numbering is already set to CRV-INV-year-sequence and is gapless;
  you don't need to touch it.

Optional but worth two minutes: **Companies House auto-fill**. Create a free
account at developer.company-information.service.gov.uk, register an
application, and paste its REST API key into Settings → Company → Companies
House API key. From then on, adding any client or umbrella is: type the
company number, click auto-fill — the registered name and office fill in,
and a dissolved or struck-off company is flagged in red before you trade
with it.

Then add your other admins under **Users & access** — each person gets their
own login, role (owner / compliance / scheduler / finance / read-only) and
their own two-factor. Never share one login.

---

## Day-to-day

- Access it from any device at https://invoice.cerviz.co.uk — phone included.
- **Backups**: the app snapshots its own database daily into `data/backups/`
  (it keeps 30). Hostinger's weekly hosting backups cover the whole folder on
  top of that. For belt-and-braces, occasionally download the `data/` folder
  from File Manager to your own computer.
- **Updating the app**: upload the new zip and extract over the top, same as
  Step 4. Your `data/` folder (database, uploads, backups, config) is never
  inside the zip, so an update cannot touch your records.
- **Invoices**: every invoice can be printed / saved as PDF (browser print),
  downloaded as **Word** (editable .doc) or **CSV**, straight from the
  invoice screen.

## If something goes wrong

| Symptom | Fix |
|---|---|
| "404" or Hostinger placeholder at the subdomain | DNS still propagating — wait up to an hour; check the subdomain folder path matches where you extracted |
| White page or "500" error | PHP version below 8.1 — set 8.2 in PHP Configuration |
| "The application has not been set up yet" | You're fine — that's the API answering before the installer has run; go to the site root and run the installer |
| Setup screen asks again after install | The `data/config.php` file couldn't be written — in File Manager check the subdomain folder permissions (folders 755, files 644) |
| Locked out (lost phone) | Sign in with a recovery code, then re-enrol two-factor under My account. Another owner can also reset your two-factor from Users & access |

One honest caveat: shared hosting suits this app at Cerviz's scale (a handful
of users, thousands of invoices — SQLite handles far more). If the business
grows to constant heavy multi-user load, that's the point to revisit
[HOSTINGER-VPS.md](HOSTINGER-VPS.md) — same data, the Node version reads the
identical database schema.
