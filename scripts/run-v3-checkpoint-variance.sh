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

adb="/opt/homebrew/share/android-commandlinetools/platform-tools/adb"
if ! "$adb" get-state >/dev/null 2>&1; then
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
    /opt/homebrew/share/android-commandlinetools/emulator/emulator \
    -avd CrossBorderCompetitors \
    -netdelay none \
    -netspeed full \
    -dns-server 8.8.8.8,1.1.1.1 \
    -no-audio \
    -no-snapshot-save \
    >/tmp/crossborder-v3-emulator.log 2>&1 &
  "$adb" wait-for-device
fi

for _ in {1..60}; do
  [[ "$("$adb" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
  sleep 2
done

mkdir -p "$COMPETITOR_CAPTURE_DIR/logs"
{
  echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") V3 Checkpoint variance ====="
  if ! CAPTURE_GOOGLE_MAPS=false /opt/homebrew/bin/npm run capture:competitors; then
    echo "Checkpoint.sg capture failed; recording the CrossBorder timing sheet without a variance point."
  fi
  /opt/homebrew/bin/node scripts/report-v3-checkpoint-variance.mjs
  echo
} >> "$COMPETITOR_CAPTURE_DIR/logs/v3-checkpoint-variance.log" 2>&1
