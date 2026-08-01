import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";

const adb = process.env.ADB || "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const serial = process.env.ADB_SERIAL || "192.168.0.4:5555";
const monitorKey = process.env.MONITOR_API_KEY;
const apiBase = (process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev").replace(/\/$/, "");
const localPath = "/private/tmp/crossborder-mi6-checkpoint-capture.sh";
const devicePath = "/sdcard/Download/crossborder-mi6-checkpoint-capture.sh";

if (!monitorKey) throw new Error("MONITOR_API_KEY is required to install the Mi6 feeder");

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

const script = `#!/data/data/com.termux/files/usr/bin/bash
set -eu

api_url='${apiBase}/api/monitor/checkpoint'
monitor_key='${monitorKey.replaceAll("'", "'\\''")}'
screenshot_dir='/sdcard/DCIM/Screenshots'
status_path='/sdcard/Download/crossborder-mi6-checkpoint-status.json'
debug_path='/sdcard/Download/crossborder-mi6-checkpoint-debug.txt'

latest="$(ls -t "$screenshot_dir"/*_com.tplusinteractive.checkpointsg.* 2>/dev/null | head -n 1 || true)"
if [ -z "$latest" ] || [ ! -r "$latest" ]; then
  printf '%s\\n' '{"ok":false,"error":"no_checkpoint_screenshot"}' > "$status_path"
  exit 1
fi

if [ ! -x "$PREFIX/bin/tesseract" ]; then
  "$PREFIX/bin/pkg" install -y tesseract >/dev/null 2>&1 || {
    printf '%s\\n' '{"ok":false,"error":"tesseract_install_failed"}' > "$status_path"
    exit 1
  }
fi

ocr="$($PREFIX/bin/tesseract "$latest" stdout --psm 6 2>/dev/null || true)"
# Tesseract occasionally reads a 5 in the camera-overlay font as a section sign.
ocr="$(printf '%s\\n' "$ocr" | sed 's/§/5/g')"
range_on_line() {
  target="$1"
  printf '%s\\n' "$ocr" | awk -v pattern="$target" '$0 ~ pattern { if (match($0, /[0-9]+-[0-9]+/)) { value=substr($0, RSTART, RLENGTH); gsub(/-/, ",", value); print "[" value "]"; exit } }'
}

tuas_ranges="$(printf '%s\\n' "$ocr" | awk '/via[[:space:]]*Tuas/ { if (match($0, /[0-9]+-[0-9]+/)) { value=substr($0, RSTART, RLENGTH); gsub(/-/, ",", value); print "[" value "]" } }')"
woodlands_jb="$(range_on_line 'to[[:space:]]*JB' || true)"
woodlands_sg="$(range_on_line 'to[[:space:]]*SG' || true)"
tuas_jb="$(printf '%s\\n' "$tuas_ranges" | sed -n '1p')"
tuas_sg="$(printf '%s\\n' "$tuas_ranges" | sed -n '2p')"

[ -n "$woodlands_jb" ] || woodlands_jb=null
[ -n "$woodlands_sg" ] || woodlands_sg=null
[ -n "$tuas_jb" ] || tuas_jb=null
[ -n "$tuas_sg" ] || tuas_sg=null
captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
payload="{\\"capturedAt\\":\\"$captured_at\\",\\"readings\\":{\\"woodlands\\":{\\"towardsJb\\":$woodlands_jb,\\"towardsSg\\":$woodlands_sg},\\"tuas\\":{\\"towardsJb\\":$tuas_jb,\\"towardsSg\\":$tuas_sg}}}"

printf 'screenshot=%s\\nocr=\\n%s\\nparsed=%s|%s|%s|%s\\npayload=%s\\n' "$latest" "$ocr" "$woodlands_jb" "$woodlands_sg" "$tuas_jb" "$tuas_sg" "$payload" > "$debug_path"

response="$(curl -sS --connect-timeout 20 --max-time 45 -H "X-Monitor-Key: $monitor_key" -H 'Content-Type: application/json' --data "$payload" "$api_url" 2>&1 || true)"
printf '%s\\n' "$response" > "$status_path"
case "$response" in
  *'"ok":true'*) exit 0 ;;
  *) exit 1 ;;
esac
`;

await writeFile(localPath, script, { mode: 0o600 });
await run(adb, ["-s", serial, "push", localPath, devicePath]);
await run(adb, ["-s", serial, "shell", "pm", "grant", "com.termux", "android.permission.READ_EXTERNAL_STORAGE"]).catch(() => undefined);
await run(adb, ["-s", serial, "shell", "pm", "grant", "com.termux", "android.permission.WRITE_EXTERNAL_STORAGE"]).catch(() => undefined);

console.log(`Installed Mi6 checkpoint feeder at ${devicePath} for ${serial}.`);
