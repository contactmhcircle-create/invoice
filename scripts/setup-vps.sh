#!/usr/bin/env bash
#
# One-command setup for Cerviz Back Office on a fresh Ubuntu VPS.
#
# Installs Node.js, Caddy (which obtains and renews the HTTPS certificate),
# builds the application, creates a systemd service so it starts on boot and
# restarts if it crashes, and opens the firewall.
#
# Run as root on a fresh Ubuntu 22.04 or 24.04 server:
#
#   curl -fsSL https://raw.githubusercontent.com/contactmhcircle-create/invoice/claude/cerviz-invoicing-billing-zzy9ca/scripts/setup-vps.sh -o setup.sh
#   sudo bash setup.sh
#
# Safe to run again: it will not overwrite an existing database, and it keeps
# the APP_SECRET it generated the first time.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/contactmhcircle-create/invoice.git}"
BRANCH="${BRANCH:-claude/cerviz-invoicing-billing-zzy9ca}"
APP_DIR="/opt/cerviz"
DATA_DIR="/var/lib/cerviz"
ENV_FILE="/etc/cerviz.env"
SERVICE_USER="cerviz"

say()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash setup.sh"

# ---------------------------------------------------------------------------
# What are we deploying, and for whom
# ---------------------------------------------------------------------------

if [ -z "${DOMAIN:-}" ]; then
  read -rp "Domain for the app (e.g. invoice.cerviz.co.uk): " DOMAIN
fi
[ -n "$DOMAIN" ] || die "A domain is required — Caddy needs it to obtain a certificate."

if [ -z "${OWNER_EMAIL:-}" ]; then
  read -rp "Your email address (used to sign in, and by Let's Encrypt): " OWNER_EMAIL
fi
[ -n "$OWNER_EMAIL" ] || die "An email address is required."

if [ -z "${OWNER_NAME:-}" ]; then
  read -rp "Your full name: " OWNER_NAME
fi
OWNER_NAME="${OWNER_NAME:-Owner}"

FIRST_RUN=true
[ -f "$DATA_DIR/cerviz.sqlite" ] && FIRST_RUN=false

# ---------------------------------------------------------------------------
# System packages
# ---------------------------------------------------------------------------

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# python3/make/g++ are needed to compile the SQLite driver.
apt-get install -y -qq \
  curl git ca-certificates gnupg ufw \
  python3 make g++ sqlite3 \
  debian-keyring debian-archive-keyring apt-transport-https

# ---------------------------------------------------------------------------
# Node.js 22
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ] 2>/dev/null; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
say "Node.js $(node -v)"
NODE_BIN="$(command -v node)"
[ -x "$NODE_BIN" ] || die "node was installed but cannot be found on PATH"

# ---------------------------------------------------------------------------
# Caddy — handles HTTPS certificates automatically, for free, for ever
# ---------------------------------------------------------------------------

if ! command -v caddy >/dev/null 2>&1; then
  say "Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# ---------------------------------------------------------------------------
# Application user and directories
# ---------------------------------------------------------------------------

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  say "Creating the $SERVICE_USER service account"
  # No login shell: if the app is ever compromised, there is no shell to get.
  useradd --system --create-home --home-dir /home/$SERVICE_USER --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$DATA_DIR"/{documents,backups}
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------------------------------------------------------------------------
# Code
# ---------------------------------------------------------------------------

if [ -d "$APP_DIR/.git" ]; then
  say "Updating the application"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  say "Downloading the application"
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

say "Building (this takes a few minutes on a small server)"
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
# Drop the build-only dependencies to save disk and reduce what is installed.
npm prune --omit=dev
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

if [ -f "$ENV_FILE" ]; then
  say "Keeping the existing $ENV_FILE"
  # Never regenerate APP_SECRET: doing so would invalidate every user's
  # two-factor setup.
else
  say "Creating $ENV_FILE"
  APP_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  OWNER_PASSWORD="$(openssl rand -base64 15 | tr -d '\n/+=' | cut -c1-16)"

  # Values are quoted so that a name containing a space survives. systemd
  # strips the quotes, and it keeps the file safe to `source` when debugging.
  cat > "$ENV_FILE" <<EOF
# Cerviz Back Office configuration. Keep this file private.
NODE_ENV="production"
PORT="8080"
DATA_DIR="$DATA_DIR"
MIGRATIONS_DIR="$APP_DIR/core/db/migrations"

# Encrypts the two-factor secrets in the database.
# Back this up. Changing or losing it means every user must set up their
# authenticator app again.
APP_SECRET="$APP_SECRET"

# Used once, to create the first owner account on an empty database.
OWNER_EMAIL="$OWNER_EMAIL"
OWNER_NAME="$OWNER_NAME"
OWNER_PASSWORD="$OWNER_PASSWORD"
EOF
fi

chmod 600 "$ENV_FILE"
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ---------------------------------------------------------------------------
# systemd service — starts on boot, restarts on failure
# ---------------------------------------------------------------------------

say "Creating the system service"
cat > /etc/systemd/system/cerviz.service <<EOF
[Unit]
Description=Cerviz Back Office
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server-dist/index.js
Restart=always
RestartSec=5

# Only ever listens locally; Caddy is what faces the internet.
Environment=HOST=127.0.0.1

# Containment: the service can write to its data directory and nowhere else.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

StandardOutput=journal
StandardError=journal
SyslogIdentifier=cerviz

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# Caddy site
# ---------------------------------------------------------------------------

say "Configuring HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	tls $OWNER_EMAIL

	encode gzip zstd

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}

	# Signed timesheet scans can be large.
	request_body {
		max_size 30MB
	}

	reverse_proxy 127.0.0.1:8080 {
		header_up X-Forwarded-For {remote_host}
		header_up X-Real-IP {remote_host}
	}
}
EOF

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

say "Configuring the firewall"
ufw allow OpenSSH   >/dev/null
ufw allow 80/tcp    >/dev/null
ufw allow 443/tcp   >/dev/null
ufw --force enable  >/dev/null

# ---------------------------------------------------------------------------
# Nightly backup
# ---------------------------------------------------------------------------

cat > /etc/cron.daily/cerviz-backup <<EOF
#!/bin/sh
# Consistent copy of the database, taken safely while the app is writing to it.
# Errors are reported rather than swallowed: a backup that fails quietly is
# worse than no backup, because you believe you have one.
set -e

if ! command -v sqlite3 >/dev/null 2>&1; then
  logger -t cerviz-backup -p user.err "sqlite3 is not installed - no backup taken"
  exit 1
fi

TARGET="$DATA_DIR/backups/nightly-\$(date +%F).sqlite"

if sqlite3 "$DATA_DIR/cerviz.sqlite" ".backup '\$TARGET'"; then
  logger -t cerviz-backup -p user.info "backup written to \$TARGET"
else
  logger -t cerviz-backup -p user.err "BACKUP FAILED for $DATA_DIR/cerviz.sqlite"
  exit 1
fi

# Keep 30 days.
find "$DATA_DIR/backups" -name 'nightly-*.sqlite' -mtime +30 -delete
EOF
chmod +x /etc/cron.daily/cerviz-backup

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

say "Starting"
systemctl daemon-reload
systemctl enable --now cerviz >/dev/null
systemctl restart caddy

sleep 5

if ! systemctl is-active --quiet cerviz; then
  warn "The application did not start. The last few log lines:"
  journalctl -u cerviz -n 30 --no-pager || true
  die "See above. Fix, then run: systemctl restart cerviz"
fi

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then break; fi
  sleep 1
done

curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1 \
  || die "The app is running but not answering. Check: journalctl -u cerviz -n 50"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

cat <<EOF

────────────────────────────────────────────────────────────────────────
 Cerviz Back Office is running.

   https://$DOMAIN

EOF

if [ "$FIRST_RUN" = true ]; then
  cat <<EOF
 Sign in with:
   Email:    $OWNER_EMAIL
   Password: $(grep '^OWNER_PASSWORD=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')

 You will be made to choose your own password, then set up two-factor
 authentication. SAVE THE TEN RECOVERY CODES it shows you — they are
 displayed once, and they are the only way back in if you lose your phone.

 Once you have signed in, remove the temporary password:
   sudo sed -i '/^OWNER_PASSWORD=/d' $ENV_FILE && sudo systemctl restart cerviz

EOF
fi

cat <<EOF
 If the page does not load, the DNS record is usually the reason. Point
 an A record for the subdomain at this server's IP address, then wait a
 few minutes and try again.

 Useful commands:
   sudo systemctl status cerviz      is it running
   sudo journalctl -u cerviz -f      live logs
   sudo systemctl restart cerviz     restart it
   sudo bash setup.sh                update to the latest code

 Your data lives in $DATA_DIR — that directory is the business.
 Backups run nightly into $DATA_DIR/backups.
────────────────────────────────────────────────────────────────────────

EOF
