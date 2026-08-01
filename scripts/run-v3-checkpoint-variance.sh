#!/bin/zsh
set -euo pipefail

cd /Users/cheewee/Documents/CrossBorder.sg
export PATH="/opt/homebrew/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/usr/bin:/bin:/usr/sbin:/sbin"
export COMPETITOR_CAPTURE_DIR="$HOME/Library/Application Support/CrossBorder.sg/captures"

env_file="$HOME/Library/Application Support/CrossBorder.sg/competitor-telegram.env"
if [[ -f "$env_file" ]]; then
  set -a
  source "$env_file"
  set +a
fi

mkdir -p "$COMPETITOR_CAPTURE_DIR/logs"
{
  echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") V3 Checkpoint variance ====="
  echo "Using the latest Mi6 Checkpoint.sg capture from the Worker."
  /opt/homebrew/bin/node scripts/report-v3-checkpoint-variance.mjs
  echo
} >> "$COMPETITOR_CAPTURE_DIR/logs/v3-checkpoint-variance.log" 2>&1
