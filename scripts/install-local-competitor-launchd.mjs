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
  set -a
  source "${supportDir}/competitor-telegram.env"
  set +a
elif [[ -f "local-env/competitor-telegram.env" ]]; then
  set -a
  source "local-env/competitor-telegram.env"
  set +a
fi

mkdir -p "${supportDir}/logs" "${captureDir}"

{
  echo "===== $(date -u +"%Y-%m-%dT%H:%M:%SZ") ====="
  if ! /opt/homebrew/share/android-commandlinetools/platform-tools/adb get-state >/dev/null 2>&1; then
    ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \\
      /opt/homebrew/share/android-commandlinetools/emulator/emulator \\
      -avd CrossBorderCompetitors \\
      -netdelay none \\
      -netspeed full \\
      -no-snapshot-save \\
      >/tmp/crossborder-competitor-emulator.log 2>&1 &
    /opt/homebrew/share/android-commandlinetools/platform-tools/adb wait-for-device
  fi
  for _ in {1..60}; do
    [[ "$(/opt/homebrew/share/android-commandlinetools/platform-tools/adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')" == "1" ]] && break
    sleep 2
  done
  /opt/homebrew/bin/npm run capture:competitors
  /opt/homebrew/bin/npm run report:competitors
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
