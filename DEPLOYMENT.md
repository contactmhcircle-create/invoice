# Deploying to invoice.cerviz.co.uk

Your Hostinger shared plan runs PHP and MySQL, so it cannot run this
application — it needs a persistent Node.js process. What it *can* do is keep
serving `cerviz.co.uk` exactly as it does now, while a single DNS record points
`invoice.cerviz.co.uk` somewhere that can. Nothing about your existing website
changes.

Below is the whole thing, start to finish. Roughly 30 minutes.

---

## Before you start

Have ready:

- Your Hostinger login (for the DNS record)
- A card (Fly.io asks for one even on the free allowance; the cost here is a few
  pounds a month at most)
- A password manager to store the secrets this generates

---

## Step 1 — Generate your secrets

On any machine with a terminal:

```bash
openssl rand -base64 48    # APP_SECRET
openssl rand -base64 18    # your first owner password
```

**Save both in your password manager now.**

`APP_SECRET` encrypts the two-factor secrets in the database. If you lose it,
every user has to set up their authenticator app again. If someone else gets it
*and* a copy of the database, they can generate your two-factor codes — so it
never goes in the repository, in an email, or in a screenshot.

---

## Step 2 — Deploy

```bash
# Install the Fly command line tool
curl -L https://fly.io/install.sh | sh

fly auth signup        # or: fly auth login
cd /path/to/this/repository

# Creates the app without deploying yet
fly launch --no-deploy --name cerviz-invoice --region lhr

# A 3 GB volume in London for the database, documents and backups
fly volumes create cerviz_data --size 3 --region lhr

# Secrets — never in the repository
fly secrets set \
  APP_SECRET='<the long random string from step 1>' \
  OWNER_EMAIL='you@cerviz.co.uk' \
  OWNER_NAME='Your Name' \
  OWNER_PASSWORD='<the owner password from step 1>'

fly deploy
```

`fly deploy` prints a URL like `https://cerviz-invoice.fly.dev`. Open it and
check you get a sign-in page. Do not sign in yet.

**`lhr` is London.** Keeping the data in the UK is not a legal requirement after
Brexit, but it removes a question you would otherwise have to answer in a
privacy notice, so it is the sensible default.

---

## Step 3 — Point the subdomain at it

```bash
fly certs create invoice.cerviz.co.uk
```

That prints the DNS records you need. Then, in Hostinger:

1. Sign in to **hPanel**
2. **Domains → cerviz.co.uk → DNS / Nameservers**
3. Add these two records:

| Type | Name | Points to | TTL |
|---|---|---|---|
| `A` | `invoice` | *(the IPv4 address Fly printed)* | 3600 |
| `AAAA` | `invoice` | *(the IPv6 address Fly printed)* | 3600 |

Leave every existing record alone — your website and email are unaffected.

DNS usually propagates in a few minutes. Check with:

```bash
fly certs show invoice.cerviz.co.uk
```

Once it reports the certificate as issued, `https://invoice.cerviz.co.uk` is
live with a valid certificate that renews itself.

---

## Step 4 — First sign-in

1. Go to `https://invoice.cerviz.co.uk`
2. Sign in with the owner email and password from step 1
3. You will be made to **choose your own password** — do that
4. You will be made to **set up two-factor authentication** — scan the QR code
   with Google Authenticator, Authy, 1Password or similar
5. **Save the ten recovery codes.** They are shown once. Without your phone and
   without these, nobody can get into the system — including you

Then remove the bootstrap password so it cannot be reused:

```bash
fly secrets unset OWNER_PASSWORD
```

---

## Step 5 — Turn on off-site backups

The application backs itself up to the volume automatically. That protects
against mistakes, not against losing the volume. For that you need a copy
somewhere else.

**Cloudflare R2** is free up to 10 GB and charges nothing for retrieval, which
suits backups well.

1. Cloudflare dashboard → **R2** → create a bucket called `cerviz-backups`
2. Create an **API token** with read and write on that bucket
3. Then:

```bash
fly secrets set \
  LITESTREAM_ACCESS_KEY_ID='<key id>' \
  LITESTREAM_SECRET_ACCESS_KEY='<secret>' \
  LITESTREAM_BUCKET='cerviz-backups' \
  LITESTREAM_ENDPOINT='https://<your-account-id>.r2.cloudflarestorage.com'
```

Verify a month later that a backup can actually be restored. An untested backup
is a belief, not a backup.

---

## Adding your colleagues

**Users & access → Add user.** Give the smallest role that lets them do their
job:

| Role | For | Sees |
|---|---|---|
| **Owner** | You | Everything, including user management |
| **Compliance & vetting** | Whoever does screening | Workers, licences, right to work, BS 7858. Personal data yes; rates and invoices no |
| **Scheduler** | Whoever builds rotas | Shifts, allocation, timesheets. No personal data, no rates |
| **Finance** | Your accountant or bookkeeper | Invoices, purchases, reports, statutory. No worker personal data |
| **Read only** | Anyone who just needs to look | Views only, no personal data |

Send the temporary password by a different channel from their email — text
message or in person. They are made to change it and set up two-factor before
reaching any data.

**When someone leaves, suspend the account the same day.** That ends their
sessions immediately rather than at their next sign-in.

---

## Everyday operations

```bash
fly logs                      # live logs
fly status                    # is it running
fly ssh console               # a shell inside the container
fly deploy                    # deploy the current code
```

**Download a backup:**

```bash
fly ssh sftp get /data/backups/<filename> ./
```

**Restore one** (this replaces the live database — be sure):

```bash
fly ssh console
cd /data
cp cerviz.sqlite cerviz.sqlite.before-restore
cp backups/<the backup you want> cerviz.sqlite
exit
fly apps restart cerviz-invoice
```

**Check the audit trail is intact** — Settings → Data & integrity → Re-verify.
Do this before generating any enquiry pack you intend to rely on.

---

## What this costs

| | |
|---|---|
| Fly.io machine (shared-cpu-1x, 512 MB) | ~£3/month |
| 3 GB volume | ~£0.45/month |
| Cloudflare R2 backups | £0 under 10 GB |
| TLS certificate | £0 |
| **Total** | **about £3.50/month** |

Suspend-when-idle is enabled, so an app nobody is using costs less than that. If
you later want it on your own Hostinger VPS, the same container runs there with
`docker compose up -d` — nothing about the application changes.

---

## Security, honestly

This holds National Insurance numbers, dates of birth, home addresses,
right-to-work evidence and bank details for your officers. On the public
internet that is a real responsibility. What is built in:

- Passwords hashed with scrypt; two-factor required for every account
- Sessions in httpOnly cookies, stored only as hashes, 12-hour expiry and a
  1-hour idle timeout
- Account lockout after 5 failures, plus per-IP throttling
- Every permission enforced on the server, not just hidden in the interface
- Worker personal data stripped from responses for roles that do not need it
- Two-factor secrets encrypted at rest with a key that is not in the database
- CSRF protection, strict security headers, HTTPS enforced
- Every sign-in attempt recorded; every change attributed to a named person

What is on you:

1. **Register with the ICO as a data controller.** A legal requirement for a
   company processing personal data — around £52 a year at
   [ico.org.uk/registration](https://ico.org.uk/registration). Not optional.
2. **Write a privacy notice for your workers** saying what you hold, why, and
   for how long.
3. **Never share accounts.** Two people on one login makes the audit trail
   worthless, which defeats the point of the whole system.
4. **Keep `APP_SECRET` safe and never rotate it casually** — doing so
   invalidates every two-factor setup.
5. **Suspend leavers the day they leave.**

If personal data is ever exposed, you have **72 hours** to tell the ICO. The
audit log and sign-in records are what let you establish what actually happened.
