#!/usr/bin/env bash
set -euo pipefail

# One-time setup for running tools/transcribe_daily_practice.py unattended
# on this OVH VPS. Separate from setup_ovh.sh's transcribe-all.timer on
# purpose: transcribe_daily_practice.py uses the Gemini API (paid, ~$0.45
# per 45-min call per tools/README.md — daily practice drills are short, so
# real cost here is pennies/day) via GEMINI_API_KEY, while transcribe_all.py
# uses local Whisper (free) and has never needed that key. Kept as its own
# service/timer rather than folded into transcribe-all.service so a bad
# Gemini key or quota issue can't block the free Whisper backlog, and vice
# versa.
#
# Runs hourly, not every 6h like transcribe-all.timer: daily practice is
# same-day time-sensitive (Phase 7's grading trigger runs at 20:00, and the
# compliance nag checks at 8:00/20:00 look for a graded file) — real found
# live 23/08/2026: this step had never been automated at all, so two of
# Sean's practice uploads sat ungraded with no transcript ever produced.
#
# Run this ONCE by hand, as a user with sudo, AFTER tools/deploy/setup_ovh.sh
# (reuses the same credentials.json/token.json and Python venv — this script
# fails loudly if either is missing). Needs one thing setup_ovh.sh doesn't:
# a real Gemini key from aistudio.google.com/apikey, passed as this script's
# first argument or already exported as GEMINI_API_KEY in the calling shell.
#
# After that, everything is automatic:
#   systemctl list-timers daily-practice-transcribe.timer   # confirm scheduled
#   sudo systemctl start daily-practice-transcribe.service  # run it right now
#   journalctl -u daily-practice-transcribe.service -f      # watch a run live

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"
VENV_DIR="$TOOLS_DIR/.venv"
SERVICE_USER="${SUDO_USER:-$(whoami)}"
GEMINI_KEY="${1:-${GEMINI_API_KEY:-}}"

if [[ ! -f "$TOOLS_DIR/credentials.json" || ! -f "$TOOLS_DIR/token.json" ]]; then
  echo "Missing $TOOLS_DIR/credentials.json and/or token.json." >&2
  echo "Run tools/deploy/setup_ovh.sh first (or copy both files from an already-authorized machine)." >&2
  exit 1
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "No venv at $VENV_DIR — run tools/deploy/setup_ovh.sh first (this script reuses that same venv)." >&2
  exit 1
fi

if [[ -z "$GEMINI_KEY" ]]; then
  echo "No Gemini API key given." >&2
  echo "Usage: $0 <gemini-api-key>   (or export GEMINI_API_KEY first)" >&2
  echo "Get one at https://aistudio.google.com/apikey" >&2
  exit 1
fi

echo "==> Verifying the google-genai package is installed in the shared venv"
"$VENV_DIR/bin/pip" install -q google-genai

echo "==> Installing systemd service + timer (hourly, idle CPU/IO priority)"
sudo tee /etc/systemd/system/daily-practice-transcribe.service > /dev/null <<EOF
[Unit]
Description=Daily objection-practice drill transcription (Gemini) — Bens/Sean/Joana
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$TOOLS_DIR
Environment=GEMINI_API_KEY=$GEMINI_KEY
ExecStart=$VENV_DIR/bin/python $TOOLS_DIR/transcribe_daily_practice.py
# Same idle-priority policy as transcribe-all.service — this must never
# compete with anything else this box hosts.
Nice=19
IOSchedulingClass=idle
CPUSchedulingPolicy=idle
EOF

sudo tee /etc/systemd/system/daily-practice-transcribe.timer > /dev/null <<EOF
[Unit]
Description=Run daily-practice-transcribe.service every hour

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now daily-practice-transcribe.timer

echo ""
echo "==> Done. daily-practice-transcribe.timer is enabled and will fire hourly."
echo "    Check schedule:    systemctl list-timers daily-practice-transcribe.timer"
echo "    Run it right now:  sudo systemctl start daily-practice-transcribe.service"
echo "    Watch a run live:  journalctl -u daily-practice-transcribe.service -f"
echo ""
echo "The Gemini key is stored in plain text in the unit file"
echo "(/etc/systemd/system/daily-practice-transcribe.service), same as any systemd"
echo "Environment= secret — readable by root only, standard for this kind of setup."
