# Running invoice.cerviz.co.uk for nothing

Two routes that cost **£0/month**. Both give you a real HTTPS address at
`invoice.cerviz.co.uk`, both leave your Hostinger website untouched, and both
run the identical container — so you can switch between them, or move to paid
hosting later, without changing the application.

Pick one:

| | **Option A — Oracle Cloud** | **Option B — a machine you own** |
|---|---|---|
| Cost | £0 forever | £0 (plus the electricity) |
| Always on | Yes | Only while the machine is on |
| Setup | ~45 minutes | ~20 minutes |
| You manage | A Linux server | A computer you already have |
| Main risk | Oracle can reclaim idle free instances | Your internet or the machine goes down |

**If you have a spare computer that can stay switched on, take Option B.** It is
simpler, faster, and there is no third party who can take it away.

---

## Option A — Oracle Cloud Always Free

Oracle's free tier is genuinely free forever, not a trial, and it has a London
region. You get an ARM machine with far more capacity than this needs.

### 1. Create the account and the machine

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) —
   choose **UK South (London)** as your home region. It cannot be changed later.
2. A card is needed for identity verification. Stay on **Always Free** resources
   and you are not charged.
3. **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex**, 1 OCPU, 6 GB memory *(all Always Free)*
   - Save the SSH key it offers you
4. **Networking → Virtual Cloud Network → Security List** — add ingress rules
   allowing TCP **80** and **443** from `0.0.0.0/0`

> Free ARM capacity in popular regions is often exhausted and you may see
> "Out of host capacity". Retry over a day or two, or fall back to Option B.

### 2. Install Docker and deploy

```bash
ssh ubuntu@<your instance's public IP>

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker

# Oracle's images ship with a restrictive firewall; open the web ports
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save

# The application
git clone <this repository> cerviz && cd cerviz
cp .env.example .env
nano .env          # fill in APP_SECRET, OWNER_*, DOMAIN, ACME_EMAIL

docker compose up -d
```

Generate `APP_SECRET` with `openssl rand -base64 48` and keep a copy in your
password manager.

### 3. Point the subdomain at it

In Hostinger **hPanel → Domains → cerviz.co.uk → DNS**:

| Type | Name | Points to | TTL |
|---|---|---|---|
| `A` | `invoice` | *(your instance's public IP)* | 3600 |

Leave every other record alone. Within a few minutes Caddy will obtain a
certificate automatically and `https://invoice.cerviz.co.uk` will be live.

---

## Option B — a computer you already own, via Cloudflare Tunnel

An old laptop, a Mac mini, a Raspberry Pi 4 — anything that can run Docker and
stay switched on. Cloudflare Tunnel makes an **outbound** connection, so:

- no ports opened on your router
- no static IP needed
- no certificate to manage — Cloudflare handles TLS
- your home or office IP address is never exposed

All free on Cloudflare's free plan.

### 1. Move the domain's DNS to Cloudflare

Cloudflare must serve DNS for `cerviz.co.uk` for this to work. Your website
stays on Hostinger — only DNS moves.

1. Sign up at [cloudflare.com](https://cloudflare.com), **Add a site** →
   `cerviz.co.uk`, choose the **Free** plan
2. It imports your existing records. **Check every one against hPanel before
   continuing** — especially `MX` records, or email stops.
3. Cloudflare gives you two nameservers. In Hostinger:
   **Domains → cerviz.co.uk → DNS / Nameservers → Change nameservers**, and
   enter Cloudflare's.
4. Wait for Cloudflare to confirm the domain is active (usually under an hour)

### 2. Create the tunnel

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
2. Type **Cloudflared**, name it `cerviz-invoice`
3. Copy the **token** it shows you
4. **Public hostname** tab → Add:
   - Subdomain `invoice`, Domain `cerviz.co.uk`
   - Type **HTTP**, URL `app:8080`

### 3. Run it

On your machine:

```bash
# Docker Desktop on Mac or Windows; on Linux:
curl -fsSL https://get.docker.com | sudo sh

git clone <this repository> cerviz && cd cerviz
cp .env.example .env
nano .env          # APP_SECRET, OWNER_*, and TUNNEL_TOKEN from step 2

docker compose -f docker-compose.tunnel.yml up -d
```

`https://invoice.cerviz.co.uk` is live. No DNS record to add by hand — creating
the public hostname did it.

### Keeping it running

- **Set the machine never to sleep.** macOS: System Settings → Lock Screen →
  never. Windows: Power → Sleep → Never.
- `restart: unless-stopped` brings the containers back after a reboot, but the
  machine has to actually be on for that to help.
- **This machine now holds your workers' personal data.** Full-disk encryption
  (FileVault or BitLocker), a password on the account, and somewhere it cannot
  be casually walked off with.

---

## Free backups, whichever route you took

The application backs itself up into its own volume automatically. That covers
mistakes, not the machine dying. For that, get a copy somewhere else.

**Cloudflare R2** is free to 10 GB with no charge for retrieval.

1. Cloudflare dashboard → **R2** → create a bucket `cerviz-backups`
2. Create an API token with read and write on it
3. On the server:

```bash
sudo apt install -y rclone
rclone config      # new remote, type "s3", provider "Cloudflare R2"
```

Then a nightly copy at 02:00:

```bash
crontab -e
```

```cron
0 2 * * * docker run --rm -v cerviz_cerviz_data:/data -v /home/ubuntu:/out alpine \
  sh -c 'cp /data/backups/$(ls -t /data/backups | head -1) /out/latest.sqlite' \
  && rclone copy /home/ubuntu/latest.sqlite r2:cerviz-backups/
```

**Test a restore within the first month.** An untested backup is a belief, not a
backup.

---

## Everyday commands

```bash
docker compose ps                  # is it running
docker compose logs -f app         # live logs
docker compose pull && docker compose up -d   # apply an update
docker compose restart app

# Take a backup right now
docker compose exec app node -e "process.exit(0)"   # (or use Settings in the app)

# Copy the database off the machine
docker run --rm -v cerviz_cerviz_data:/data -v $(pwd):/out alpine \
  cp /data/cerviz.sqlite /out/
```

---

## What you give up by not paying

Worth being straight about it:

- **No support.** If Oracle reclaims the instance or your office loses power, it
  is on you to notice and fix it.
- **No uptime commitment.** Nobody owes you availability.
- **Oracle can reclaim idle Always Free instances.** Running continuously makes
  this unlikely, but it is their stated policy, and they have done it.
- **Option B depends on your internet.** If the office broadband drops, so does
  the system.

Nothing here compromises the *security* of the application — the authentication,
permissions, encryption and audit trail are identical. What you are trading away
is somebody else's responsibility for keeping it switched on.

If it later becomes something the business genuinely depends on daily, £3.50 a
month on Fly.io (see [DEPLOYMENT.md](DEPLOYMENT.md)) buys that responsibility
back, and it is the same container either way.
