#!/usr/bin/env bash
set -euo pipefail

# One-time setup for running tools/transcribe_all.py unattended on this OVH
# VPS. Installs system + Python dependencies and registers a systemd timer
# that runs the whole Sean/Joana/Tomas Whisper backlog every 6 hours, at the
# lowest possible CPU/IO priority so it never competes with whatever else
# this box is hosting (websites, etc.) — it only uses cycles/disk the server
# would otherwise leave idle.
#
# Run this ONCE by hand, as a user with sudo. After that, everything is
# automatic:
#   systemctl list-timers transcribe-all.timer   # confirm it's scheduled
#   sudo systemctl start transcribe-all.service   # run it right now
#   journalctl -u transcribe-all.service -f       # watch a run live
#
# credentials.json and token.json are deliberately NOT handled by this
# script — they're per-account Google OAuth secrets, not something to
# automate or commit. Copy both files into this repo's tools/ folder from
# an already-authorized machine (e.g. via scp) BEFORE running this script.
# See tools/DEPLOY_JOANA.md for more on where those files come from.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"
VENV_DIR="$TOOLS_DIR/.venv"
SERVICE_USER="${SUDO_USER:-$(whoami)}"

if [[ ! -f "$TOOLS_DIR/credentials.json" || ! -f "$TOOLS_DIR/token.json" ]]; then
  echo "Missing $TOOLS_DIR/credentials.json and/or token.json." >&2
  echo "Copy both from an already-authorized machine before running this script." >&2
  exit 1
fi

echo "==> Installing system packages (python3, ffmpeg, git)"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip ffmpeg git

echo "==> Creating Python virtualenv at $VENV_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$TOOLS_DIR/requirements.txt"

echo "==> Installing systemd service + timer (idle CPU/IO priority)"
sudo tee /etc/systemd/system/transcribe-all.service > /dev/null <<EOF
[Unit]
Description=Sean/Joana/Tomas call transcription backlog (Whisper, local, free)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$TOOLS_DIR
ExecStart=$VENV_DIR/bin/python $TOOLS_DIR/transcribe_all.py
# Lowest possible scheduling priority so this never competes with anything
# else running on this box (e.g. hosted websites) -- only runs when the
# server would otherwise be idle. If the timer fires again while a run is
# still in progress, systemd just no-ops the new start (a unit already
# "active" refuses a second concurrent start), so runs never overlap.
Nice=19
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
EOF

sudo tee /etc/systemd/system/transcribe-all.timer > /dev/null <<EOF
[Unit]
Description=Run transcribe-all.service every 6 hours

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
RandomizedDelaySec=15min

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now transcribe-all.timer

echo ""
echo "==> Done. transcribe-all.timer is enabled and will fire every ~6h."
echo "    Check schedule:    systemctl list-timers transcribe-all.timer"
echo "    Run it right now:  sudo systemctl start transcribe-all.service"
echo "    Watch a run live:  journalctl -u transcribe-all.service -f"
