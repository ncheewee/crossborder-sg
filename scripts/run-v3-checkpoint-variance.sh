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
  if /opt/homebrew/bin/node scripts/checkpoint-capture-fallback.mjs status; then
    echo "Using the freshest complete Checkpoint.sg capture from the Worker."
  else
    echo "Physical-device capture is stale; starting Android emulator fallback."
    adb="/opt/homebrew/share/android-commandlinetools/platform-tools/adb"
    emulator="/opt/homebrew/share/android-commandlinetools/emulator/emulator"
    serial="emulator-5554"
    if ! "$adb" -s "$serial" get-state >/dev/null 2>&1; then
      nohup "$emulator" -avd CrossBorderCompetitors -no-window -no-audio -no-boot-anim -no-snapshot-save -gpu swiftshader_indirect > "$COMPETITOR_CAPTURE_DIR/logs/checkpoint-emulator.log" 2>&1 &
      for attempt in {1..60}; do
        if "$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
          break
        fi
        sleep 2
      done
    fi
    "$adb" -s "$serial" shell settings put system volume_music 0 >/dev/null 2>&1 || true
    if CAPTURE_APPS=checkpoint-sg \
        CAPTURE_GOOGLE_MAPS=false \
        ADB_SERIAL="$serial" \
        APP_CAPTURE_ATTEMPTS=3 \
        /opt/homebrew/bin/node scripts/capture-competitor-apps.mjs \
      && /opt/homebrew/bin/node scripts/checkpoint-capture-fallback.mjs upload; then
      echo "Emulator fallback capture uploaded."
    else
      echo "Emulator fallback failed; sending the chart with retained history and an explicit unavailable status."
    fi
  fi
  /opt/homebrew/bin/node scripts/report-v3-checkpoint-variance.mjs
  echo
} >> "$COMPETITOR_CAPTURE_DIR/logs/v3-checkpoint-variance.log" 2>&1
