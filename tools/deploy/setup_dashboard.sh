#!/usr/bin/env bash
set -euo pipefail

# One-time setup for the Sales Review Dashboard (tools/dashboard/) on this
# OVH VPS. Installs Python deps into their own venv and registers two
# systemd units:
#   sales-dashboard.service        - the FastAPI web app (uvicorn)
#   sales-dashboard-sync.service/.timer - pulls the Sheet into SQLite every 10min
#
# Per DASHBOARD_RESEARCH_REPORT.md:
#   - This box already runs FASTPANEL (nginx/php-fpm/mariadb for client
#     sites) and owns ports 80/443 and iptables. This script does NOT touch
#     either — it only binds the app to 127.0.0.1 (or a Tailscale IP, for
#     Phase A) and installs plain systemd units, matching transcribe-all's
#     style. No Docker, no Caddy, no ufw changes.
#   - Phase A (first pass): no public exposure, no auth code. Set
#     DASHBOARD_BIND_HOST below to this box's Tailscale IP (`tailscale ip -4`)
#     so the app is reachable only over the tailnet. Phase B later moves this
#     behind FASTPANEL's nginx + Google OAuth and rebinds to 127.0.0.1 — see
#     tools/dashboard/README.md.
#
# Run this ONCE by hand, as a user with sudo, after:
#   1. Creating a read-only Google service account key and saving it at
#      tools/dashboard/service_account.json (see tools/dashboard/README.md)
#   2. Sharing the Sales Call Log spreadsheet with that service account's
#      email as Viewer
#   3. Installing and joining Tailscale on this box (`tailscale up`), if
#      using the Phase A access posture (recommended first)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_DIR/tools/dashboard"
VENV_DIR="$APP_DIR/.venv"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
ENV_FILE="/etc/sales-dashboard/env"

if [[ ! -f "$APP_DIR/service_account.json" ]]; then
  echo "Missing $APP_DIR/service_account.json." >&2
  echo "See tools/dashboard/README.md for how to create one." >&2
  exit 1
fi

echo "==> Installing system packages (python3, venv)"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip

echo "==> Creating Python virtualenv at $VENV_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "==> Writing $ENV_FILE (edit DASHBOARD_BIND_HOST after install — see README)"
sudo mkdir -p /etc/sales-dashboard
if [[ ! -f "$ENV_FILE" ]]; then
  sudo tee "$ENV_FILE" > /dev/null <<'EOF'
# Bind address for the web app. Phase A (recommended first): set this to
# this box's Tailscale IP (`tailscale ip -4`) so the dashboard is reachable
# only over the tailnet, with no public exposure and no auth code needed.
# Phase B: switch to 127.0.0.1 once it's behind FASTPANEL's nginx + OAuth.
DASHBOARD_BIND_HOST=127.0.0.1
DASHBOARD_BIND_PORT=8000
EOF
  sudo chmod 0600 "$ENV_FILE"
  echo "    Created $ENV_FILE with a 127.0.0.1 placeholder — edit it before starting the service."
else
  echo "    $ENV_FILE already exists, leaving it alone."
fi

echo "==> Installing sales-dashboard.service (the web app)"
sudo tee /etc/systemd/system/sales-dashboard.service > /dev/null <<EOF
[Unit]
Description=Sales Review Dashboard (FastAPI web app)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=DASHBOARD_DB_PATH=$APP_DIR/dashboard.db
Environment=DASHBOARD_SERVICE_ACCOUNT_FILE=$APP_DIR/service_account.json
ExecStart=$VENV_DIR/bin/uvicorn app:app --host \${DASHBOARD_BIND_HOST} --port \${DASHBOARD_BIND_PORT}
Restart=always
RestartSec=5

# Hardening — see DASHBOARD_RESEARCH_REPORT.md §3.4. This box also hosts
# client websites via FASTPANEL; these directives keep a crash or a bug in
# this app from touching anything outside its own directory.
#
# Deliberately NO ProtectHome=yes here (confirmed by hand 22/08/2026): even
# with a matching ReadWritePaths= override, ProtectHome=yes reliably breaks
# exec of anything under the app's own venv (systemd fails with
# code=exited, status=203/EXEC) — a known quirk where ReadWritePaths
# doesn't fully restore execute permission when layered under ProtectHome.
# ProtectSystem=strict already covers the rest of the filesystem; this
# app's own directory has to stay executable anyway since it lives under
# /home, so there's nothing ProtectHome would add here besides breakage.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=$APP_DIR
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=512M

[Install]
WantedBy=multi-user.target
EOF

echo "==> Installing sales-dashboard-sync.service + .timer (Sheets -> SQLite, every 10min)"
sudo tee /etc/systemd/system/sales-dashboard-sync.service > /dev/null <<EOF
[Unit]
Description=Pull Sales Call Log into local SQLite mirror for the dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=DASHBOARD_DB_PATH=$APP_DIR/dashboard.db
Environment=DASHBOARD_SERVICE_ACCOUNT_FILE=$APP_DIR/service_account.json
ExecStart=$VENV_DIR/bin/python $APP_DIR/sync.py
# Deliberately NOT idle priority (unlike transcribe-all) — this job takes
# milliseconds against a ~400-row sheet and should stay timely so the
# dashboard's freshness banner reflects reality, not a deprioritized queue.
Nice=10

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/sales-dashboard-sync.timer > /dev/null <<EOF
[Unit]
Description=Run sales-dashboard-sync every 10 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now sales-dashboard-sync.timer
sudo systemctl start sales-dashboard-sync.service   # populate dashboard.db before the app starts
sudo systemctl enable --now sales-dashboard.service

echo ""
echo "==> Done."
echo "    Edit $ENV_FILE if DASHBOARD_BIND_HOST needs to change, then:"
echo "      sudo systemctl restart sales-dashboard"
echo "    Check the app:    sudo systemctl status sales-dashboard"
echo "    Check the sync:   journalctl -u sales-dashboard-sync.service -f"
echo "    Force a sync now: sudo systemctl start sales-dashboard-sync.service"
