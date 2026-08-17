#!/bin/zsh
set -euo pipefail

cd /Users/cheewee/Documents/CrossBorder.sg

export PATH="/opt/homebrew/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ -f "$HOME/Library/Application Support/CrossBorder.sg/competitor-telegram.env" ]]; then
  /usr/bin/xattr -d com.apple.provenance "$HOME/Library/Application Support/CrossBorder.sg/competitor-telegram.env" >/dev/null 2>&1 || true
fi
if [[ -f "local-env/competitor-telegram.env" ]]; then
  /usr/bin/xattr -d com.apple.provenance "local-env/competitor-telegram.env" >/dev/null 2>&1 || true
fi

source_env_file() {
  local env_file="$1"
  if [[ ! -f "$env_file" ]]; then
    return 1
  fi
  set -a
  if ! source "$env_file"; then
    local safe_copy
    safe_copy="$(mktemp /tmp/crossborder-env.XXXXXX)"
    /bin/cp "$env_file" "$safe_copy"
    /usr/bin/xattr -c "$safe_copy" >/dev/null 2>&1 || true
    if ! source "$safe_copy"; then
      /bin/rm -f "$safe_copy"
      set +a
      return 1
    fi
    /bin/rm -f "$safe_copy"
  fi
  set +a
  return 0
}

if [[ -f "$HOME/Library/Application Support/CrossBorder.sg/competitor-telegram.env" ]]; then
  source_env_file "$HOME/Library/Application Support/CrossBorder.sg/competitor-telegram.env"
elif [[ -f "local-env/competitor-telegram.env" ]]; then
  source_env_file "local-env/competitor-telegram.env"
fi

mkdir -p .competitor-captures/logs

start_emulator() {
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
    /opt/homebrew/share/android-commandlinetools/emulator/emulator \
    -avd CrossBorderCompetitors \
    -netdelay none \
    -netspeed full \
    -dns-server 8.8.8.8,1.1.1.1 \
    -no-audio \
    -no-snapshot-save \
    >/tmp/crossborder-competitor-emulator.log 2>&1 &
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb wait-for-device
}

wait_boot_completed() {
  for _ in {1..60}; do
    [[ "$(/opt/homebrew/share/android-commandlinetools/platform-tools/adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && return 0
    sleep 2
  done
  return 1
}

repair_android_network() {
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell settings put global airplane_mode_on 0 >/dev/null 2>&1 || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false >/dev/null 2>&1 || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell settings put global private_dns_mode off >/dev/null 2>&1 || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell settings put global captive_portal_mode 0 >/dev/null 2>&1 || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell svc wifi enable >/dev/null 2>&1 || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell svc data enable >/dev/null 2>&1 || true
}

ensure_android_dns() {
  repair_android_network
  for _ in {1..5}; do
    /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell ping -c 1 -W 3 google.com >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "Android DNS preflight failed; restarting emulator with explicit DNS."
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb emu kill >/dev/null 2>&1 || true
  sleep 5
  start_emulator
  wait_boot_completed || true
  repair_android_network
  for _ in {1..10}; do
    /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell ping -c 1 -W 3 google.com >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "Android DNS preflight still failed after emulator restart."
  return 1
}

{
  echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") ====="
  if ! /opt/homebrew/share/android-commandlinetools/platform-tools/adb get-state >/dev/null 2>&1; then
    start_emulator
  fi
  wait_boot_completed || true
  ensure_android_dns || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell settings put system volume_music 0 >/dev/null 2>&1 || true
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb shell settings put system sound_effects_enabled 0 >/dev/null 2>&1 || true
  /opt/homebrew/bin/npm run capture:competitors
  echo "Capture complete; Telegram delivery is handled by the V3 shadow-line reporter."
  echo
} >> .competitor-captures/logs/hourly.log 2>&1
