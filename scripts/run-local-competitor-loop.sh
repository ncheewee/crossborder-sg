#!/bin/zsh
set -euo pipefail

cd /Users/cheewee/Documents/CrossBorder.sg

export PATH="/opt/homebrew/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ -f "local-env/competitor-telegram.env" ]]; then
  set -a
  source "local-env/competitor-telegram.env"
  set +a
fi

mkdir -p .competitor-captures/logs

{
  echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") ====="
  if ! /opt/homebrew/share/android-commandlinetools/platform-tools/adb get-state >/dev/null 2>&1; then
    ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
      /opt/homebrew/share/android-commandlinetools/emulator/emulator \
      -avd CrossBorderCompetitors \
      -netdelay none \
      -netspeed full \
      -no-snapshot-save \
      >/tmp/crossborder-competitor-emulator.log 2>&1 &
    /opt/homebrew/share/android-commandlinetools/platform-tools/adb wait-for-device
  fi
  for _ in {1..60}; do
    [[ "$(/opt/homebrew/share/android-commandlinetools/platform-tools/adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
    sleep 2
  done
  /opt/homebrew/bin/npm run capture:competitors
  /opt/homebrew/bin/npm run report:competitors
  echo
} >> .competitor-captures/logs/hourly.log 2>&1
