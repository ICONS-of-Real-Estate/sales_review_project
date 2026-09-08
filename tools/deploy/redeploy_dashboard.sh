#!/usr/bin/env bash
set -euo pipefail

# One command to pick up a dashboard code change on this OVH VPS, replacing
# the "git pull / pip install / start the sync / restart the app" ritual
# from tools/dashboard/README.md's "Redeploying after a code change" section
# with a single script — Kris's ask (08/09/2026): "Can we have a script so
# I just run one command?"
#
# Usage (from anywhere, after tools/deploy/setup_dashboard.sh has already
# run once on this box):
#   bash tools/deploy/redeploy_dashboard.sh
#
# What it does, in the order that matters:
#   1. git pull — brings in the latest code.
#   2. pip install -r requirements.txt — safe/fast to run every time even
#      when nothing changed (pip no-ops on already-satisfied requirements);
#      simpler than trying to detect "did requirements.txt change" and
#      cheap enough not to bother.
#   3. Force a sync BEFORE restarting the app — same reasoning as
#      tools/dashboard/README.md's own warning: sales-dashboard.service and
#      sales-dashboard-sync.service/.timer are separate processes, and if
#      the app restarts onto new code that expects a column the live
#      dashboard.db doesn't have yet, every page 500s until the next sync
#      happens on its own 10-minute cadence. Forcing a sync first costs
#      nothing and is always safe, schema change or not.
#   4. Restart the app, then poll /healthz until it actually comes back up
#      (not just "systemctl restart didn't error") before declaring success.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_DIR/tools/dashboard"
VENV_DIR="$APP_DIR/.venv"
ENV_FILE="/etc/sales-dashboard/env"

if [[ ! -x "$VENV_DIR/bin/pip" ]]; then
  echo "No venv at $VENV_DIR — run tools/deploy/setup_dashboard.sh once first." >&2
  exit 1
fi

echo "==> git pull"
git -C "$REPO_DIR" pull

echo "==> Installing/upgrading Python deps (no-ops if nothing changed)"
"$VENV_DIR/bin/pip" install -q -r "$APP_DIR/requirements.txt"

echo "==> Forcing a sync before restart, so new code never runs against a stale schema"
sudo systemctl start sales-dashboard-sync.service

echo "==> Restarting the dashboard app"
sudo systemctl restart sales-dashboard

# Read the real bind host/port instead of assuming 127.0.0.1 — Phase A
# deployments bind to this box's Tailscale IP instead (see
# tools/dashboard/README.md), and hitting 127.0.0.1 there would report a
# false failure even on a perfectly healthy restart.
HOST="127.0.0.1"
PORT="8000"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  HOST="${DASHBOARD_BIND_HOST:-$HOST}"
  PORT="${DASHBOARD_BIND_PORT:-$PORT}"
fi

echo "==> Waiting for it to come back up at $HOST:$PORT"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://$HOST:$PORT/healthz" > /dev/null 2>&1; then
    echo "==> Done — dashboard is responding."
    exit 0
  fi
  sleep 1
done

echo "WARNING: dashboard did not respond to /healthz within 10s of restarting." >&2
echo "Check: sudo systemctl status sales-dashboard && journalctl -u sales-dashboard -n 50" >&2
exit 1
