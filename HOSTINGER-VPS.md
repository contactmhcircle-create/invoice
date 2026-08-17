# Putting it live on a Hostinger VPS

Everything stays with Hostinger — same account, same bill, same DNS panel. Your
website at `cerviz.co.uk` is not touched; you are adding a separate small server
that runs the invoicing tool, and pointing `invoice.cerviz.co.uk` at it.

**About 30 minutes**, most of which is waiting. You will use a terminal, but
every command is copy-and-paste and the setup is a single script.

---

## Why a VPS and not your existing plan

Your shared hosting runs PHP and MySQL. This application is Node.js and needs a
process that stays running — there is no setting on shared hosting that allows
that. A VPS is a small server where you *can* run it. Hostinger's cheapest one
is about £5/month and is far more machine than this needs.

---

## Step 1 — Buy the VPS

1. Sign in to **hPanel** at [hpanel.hostinger.com](https://hpanel.hostinger.com)
2. Top menu → **VPS** → **Buy new VPS** (or **Get started**)
3. Choose **KVM 1** — 1 vCPU, 4 GB RAM. That is comfortably enough.
4. **Location: London (United Kingdom)** if offered. Keeping the data in the UK
   removes a question you would otherwise have to answer in a privacy notice.
5. When it asks for an **operating system**, choose:

   > **Ubuntu 24.04** (plain — *not* one with a control panel like CyberPanel or
   > Plesk, which would fight with what we install)

6. Set a **root password** when prompted and **save it in your password
   manager**. You need it in the next step.
7. Wait for setup — usually two to five minutes.

When it finishes, hPanel shows the VPS overview. **Write down the IP address**
at the top — something like `31.220.14.207`. You need it twice.

---

## Step 2 — Point the subdomain at it

Do this now, because DNS takes a few minutes to spread and the next step is
faster if it has already happened.

In hPanel: **Domains → cerviz.co.uk → DNS / Nameservers**

Add one record:

| Field | Value |
|---|---|
| **Type** | `A` |
| **Name** | `invoice` |
| **Points to** | *your VPS IP address from step 1* |
| **TTL** | `3600` |

**Leave every other record exactly as it is.** Your website and email use those.
You are only adding one line.

---

## Step 3 — Connect to the server

**On Windows:** open **PowerShell** (Start menu → type "PowerShell").
**On Mac:** open **Terminal** (Cmd+Space → type "Terminal").

Then type this, using your own IP address:

```bash
ssh root@31.220.14.207
```

- It asks `Are you sure you want to continue connecting?` → type `yes` and press Enter
- It asks for a password → paste the root password from step 1

> The password will not appear as you type — no dots, no stars. That is normal.
> Paste it and press Enter.

You are connected when the prompt changes to something like `root@srv123:~#`.

---

## Step 4 — Run the setup

Copy this whole block, paste it into the terminal, and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/contactmhcircle-create/invoice/claude/cerviz-invoicing-billing-zzy9ca/scripts/setup-vps.sh -o setup.sh
sudo bash setup.sh
```

It asks three questions:

| Question | Answer |
|---|---|
| Domain for the app | `invoice.cerviz.co.uk` |
| Your email address | the one you want to sign in with |
| Your full name | your name |

Then it runs for five to ten minutes, installing Node.js, Caddy (which gets the
HTTPS certificate free and renews it automatically for ever), building the
application, and setting it to start on boot.

When it finishes it prints a box containing **your temporary password**.
**Copy that somewhere safe before closing the terminal.**

---

## Step 5 — First sign-in

Open **https://invoice.cerviz.co.uk** in a browser.

1. Sign in with the email and temporary password from step 4
2. You are made to **choose your own password** — do it
3. You are made to **set up two-factor authentication** — scan the QR code with
   Google Authenticator, Authy, 1Password or similar on your phone
4. **Save the ten recovery codes.** They are shown once. Without your phone and
   without these, nobody gets in — including you. Print them or put them in your
   password manager, not in your email.

Then remove the temporary password so it cannot be reused. Back in the terminal:

```bash
sudo sed -i '/^OWNER_PASSWORD=/d' /etc/cerviz.env
sudo systemctl restart cerviz
```

**Done.** It is live, on your own domain, with a valid certificate, and it
restarts by itself if the server reboots.

---

## Adding your colleagues

**Users & access → Add user.** Give the smallest role that lets them do the job:

| Role | For | Sees |
|---|---|---|
| **Owner** | You | Everything, including managing users |
| **Compliance & vetting** | Whoever does screening | Workers, licences, right to work, BS 7858. Personal data yes; rates and invoices no |
| **Scheduler** | Whoever builds rotas | Shifts, allocation, timesheets. No personal data, no rates |
| **Finance** | Your accountant or bookkeeper | Invoices, purchases, reports, statutory. No worker personal data |
| **Read only** | Anyone who just needs to look | Views only, no personal data |

Send the temporary password by text or in person — not by email, since email is
usually how a password gets reset.

**When someone leaves, suspend the account that day.** It ends their sessions
immediately rather than at their next sign-in.

---

## Running it day to day

Reconnect any time with `ssh root@<your IP>`, then:

```bash
sudo systemctl status cerviz      # is it running
sudo journalctl -u cerviz -f      # live logs (Ctrl+C to stop watching)
sudo systemctl restart cerviz     # restart it
```

**Update to the latest version** — safe to run whenever; it keeps your data and
your APP_SECRET:

```bash
sudo bash setup.sh
```

**Copy the database to your own computer.** Run this on *your* machine, not the
server:

```bash
scp root@<your IP>:/var/lib/cerviz/backups/*.sqlite ~/Desktop/
```

---

## Backups

Three layers, all automatic:

1. The application backs itself up on start, daily, and whenever you press the
   button in Settings
2. A nightly job takes a consistent snapshot into `/var/lib/cerviz/backups`,
   keeping 30 days — and it now **reports failure to the system log** rather
   than failing quietly
3. Hostinger takes weekly VPS snapshots — check **VPS → Backups** in hPanel and
   turn them on if they are not already

**Do one restore test in the first month.** Copy a backup to your computer, open
it, confirm your invoices are in it. An untested backup is a belief, not a
backup.

---

## If something goes wrong

**The page does not load at all.** Usually DNS has not spread yet. Wait ten
minutes. Check the record resolves:

```bash
nslookup invoice.cerviz.co.uk
```

It should return your VPS IP.

**"Your connection is not private" / certificate warning.** Caddy could not get
a certificate, almost always because DNS was not pointing at the server when it
tried. Fix the DNS, then:

```bash
sudo systemctl restart caddy
sudo journalctl -u caddy -n 30
```

**The app will not start.**

```bash
sudo journalctl -u cerviz -n 50
```

The last lines say why. The most common cause is a missing `APP_SECRET` in
`/etc/cerviz.env`.

**You are locked out** — lost phone and lost recovery codes. From the server:

```bash
sudo -u cerviz sqlite3 /var/lib/cerviz/cerviz.sqlite \
  "UPDATE users SET totp_enabled = 0, totp_secret_encrypted = NULL WHERE email = 'you@cerviz.co.uk';"
sudo systemctl restart cerviz
```

You will then sign in with just your password and be made to set up two-factor
again. **This is deliberately something only someone with server access can do**,
which is why that access matters.

---

## Security, honestly

This holds National Insurance numbers, dates of birth, home addresses,
right-to-work evidence and bank details for your officers. What the setup does
for you:

- The app runs as a restricted account with no login shell, able to write only
  to its own data directory
- It listens only on the machine itself — Caddy is the only thing facing the
  internet
- The firewall allows SSH, HTTP and HTTPS, and nothing else
- HTTPS is enforced, certificates renew automatically
- Passwords are hashed with scrypt; two-factor is required for every account
- Permissions are enforced server-side, and worker personal data is stripped
  from responses for roles that do not need it

What is on you:

1. **Keep the root password and `APP_SECRET` in a password manager.** Losing
   `APP_SECRET` means every user re-enrols their authenticator app.
2. **Never share accounts.** Two people on one login makes the audit trail
   worthless, which defeats the point of the system.
3. **Suspend leavers the day they leave.**
4. **Run `sudo apt update && sudo apt upgrade -y` monthly** to pick up security
   patches for the operating system.
