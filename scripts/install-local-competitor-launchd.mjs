import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const label = "sg.crossborder.competitor-capture";
const repoRoot = "/Users/cheewee/Documents/CrossBorder.sg";
const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const supportDir = join(homedir(), "Library", "Application Support", "CrossBorder.sg");
const scriptPath = join(supportDir, "run-local-competitor-loop.sh");
const captureDir = join(supportDir, "captures");
const domain = `gui/${process.getuid()}`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${scriptPath}</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${supportDir}/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${supportDir}/logs/launchd.err.log</string>
</dict>
</plist>
`;

const runner = `#!/bin/zsh
set -euo pipefail

cd ${repoRoot}

export PATH="/opt/homebrew/bin:/opt/homebrew/share/android-commandlinetools/platform-tools:/usr/bin:/bin:/usr/sbin:/sbin"
export COMPETITOR_CAPTURE_DIR="${captureDir}"

if [[ -f "${supportDir}/competitor-telegram.env" ]]; then
  /usr/bin/xattr -d com.apple.provenance "${supportDir}/competitor-telegram.env" >/dev/null 2>&1 || true
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

if [[ -f "${supportDir}/competitor-telegram.env" ]]; then
  source_env_file "${supportDir}/competitor-telegram.env"
elif [[ -f "local-env/competitor-telegram.env" ]]; then
  source_env_file "local-env/competitor-telegram.env"
fi

mkdir -p "${supportDir}/logs" "${captureDir}"

start_emulator() {
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \\
    /opt/homebrew/share/android-commandlinetools/emulator/emulator \\
    -avd CrossBorderCompetitors \\
    -netdelay none \\
    -netspeed full \\
    -dns-server 8.8.8.8,1.1.1.1 \\
    -no-audio \\
    -no-snapshot-save \\
    >/tmp/crossborder-competitor-emulator.log 2>&1 &
  /opt/homebrew/share/android-commandlinetools/platform-tools/adb wait-for-device
}

wait_boot_completed() {
  for _ in {1..60}; do
    [[ "$(/opt/homebrew/share/android-commandlinetools/platform-tools/adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')" == "1" ]] && return 0
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
} >> "${supportDir}/logs/hourly.log" 2>&1
`;

await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
await mkdir(supportDir, { recursive: true });
await mkdir(join(supportDir, "logs"), { recursive: true });
await mkdir(captureDir, { recursive: true });
await writeFile(scriptPath, runner);
await writeFile(plistPath, plist);
await run("chmod", ["755", scriptPath]);
await run("launchctl", ["bootout", domain, plistPath]).catch(() => {});
await run("launchctl", ["bootstrap", domain, plistPath]);
await run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);

console.log(`Installed ${label}`);
console.log(plistPath);
