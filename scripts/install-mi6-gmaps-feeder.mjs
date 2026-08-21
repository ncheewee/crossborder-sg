import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

// Same 15-minute MacroDroid fire as Checkpoint. This script opens each
// Woodlands route in the Google Maps app, reads "Driving mode: N minutes"
// from the UI dump, and POSTs the seven durations to Apps Script.
const adb = process.env.ADB || "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const serial = process.env.ADB_SERIAL || "192.168.0.3:5555";
const webAppUrl = process.env.CHECKPOINT_SHEET_WEBAPP_URL
  || "https://script.google.com/macros/s/AKfycbzamRGlMzJ8TLjfHPygtw01RU-NaK2TCyzq4iFRVjZRKL9JUef-SR3NSu8-skeGMJoA/exec";
const localPath = "/private/tmp/crossborder-mi6-gmaps-capture.sh";
const devicePath = "/sdcard/Download/crossborder-mi6-gmaps-capture.sh";

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function loadIngestSecret() {
  if (process.env.INGEST_SECRET) return process.env.INGEST_SECRET.trim();
  const skill = await readFile(
    "/Users/cheewee/Documents/Claude/Scheduled/woodlands-checkpoint-route-log/SKILL.md",
    "utf8",
  );
  const match = skill.match(/SEC='([^']+)'/);
  if (!match) throw new Error("INGEST_SECRET is not set and was not found in the scrape skill");
  return match[1];
}

const secret = await loadIngestSecret();

const script = `#!/data/data/com.termux/files/usr/bin/bash
set -eu

url='${webAppUrl}'
secret='${secret.replaceAll("'", "'\\''")}'
status_path='/sdcard/Download/crossborder-mi6-gmaps-status.json'
debug_path='/sdcard/Download/crossborder-mi6-gmaps-debug.txt'
dump_path='/sdcard/Download/crossborder-mi6-gmaps-ui.xml'
: > "$debug_path"

lock_path='/sdcard/Download/crossborder-mi6-gmaps.lock'
now="$(date +%s)"
if [ -f "$lock_path" ]; then
  lock_age="$(( now - $(stat -c %Y "$lock_path" 2>/dev/null || echo 0) ))"
  if [ "$lock_age" -lt 180 ]; then
    printf 'skip: previous gmaps cycle still running (%ss)\\n' "$lock_age" >> "$debug_path"
    exit 0
  fi
fi
printf '%s\\n' "$now" > "$lock_path"

go_home() {
  # Termux cannot inject HOME. Force-stop Maps, then start the launcher.
  if command -v su >/dev/null 2>&1; then
    su -c 'am force-stop com.google.android.apps.maps; am force-stop com.android.chrome; input keyevent 3' >/dev/null 2>&1 || true
  fi
  am force-stop com.google.android.apps.maps >/dev/null 2>&1 || true
  am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1 || true
  am start -n com.miui.home/.launcher.Launcher >/dev/null 2>&1 || true
}
cleanup() {
  rm -f "$lock_path"
  go_home
}
trap cleanup EXIT

dump_ui() {
  rm -f "$dump_path"
  if command -v su >/dev/null 2>&1; then
    su -c "timeout 8 uiautomator dump $dump_path" >/dev/null 2>&1 || su -c "uiautomator dump $dump_path" >/dev/null 2>&1 || true
  fi
  if [ ! -s "$dump_path" ]; then
    timeout 8 uiautomator dump "$dump_path" >/dev/null 2>&1 || uiautomator dump "$dump_path" >/dev/null 2>&1 || true
  fi
  [ -s "$dump_path" ]
}

minutes_from_dump() {
  local desc hm h m total
  desc="$(grep -o 'Driving mode: [^"]*' "$dump_path" 2>/dev/null | head -n 1 || true)"
  printf '%s\\n' "$desc" >> "$debug_path"
  # Match the number after "Driving mode:" — never a later lone digit before "min".
  hm="$(printf '%s' "$desc" | sed -n 's/^Driving mode: \\([0-9][0-9]*\\) hours* \\([0-9][0-9]*\\) min.*/\\1 \\2/p')"
  if [ -n "$hm" ]; then
    set -- $hm
    total="$(( $1 * 60 + $2 ))"
  else
    h="$(printf '%s' "$desc" | sed -n 's/^Driving mode: \\([0-9][0-9]*\\) hours*.*/\\1/p')"
    if [ -n "$h" ]; then
      total="$(( h * 60 ))"
    else
      m="$(printf '%s' "$desc" | sed -n 's/^Driving mode: \\([0-9][0-9]*\\) min.*/\\1/p')"
      total="\${m:-0}"
    fi
  fi
  if [ "$total" -ge 5 ] && [ "$total" -le 240 ]; then
    printf '%s' "$total"
  fi
}

read_route() {
  local maps_url="$1"
  am start -a android.intent.action.VIEW -d "$maps_url" com.google.android.apps.maps >/dev/null 2>&1 || true
  sleep 8
  if ! dump_ui; then
    printf 'ERR'
    return
  fi
  local mins
  mins="$(minutes_from_dump || true)"
  if [ -n "$mins" ]; then
    printf '%s' "$mins"
  else
    printf 'ERR'
  fi
}

day="$(date +%Y-%m-%d)"
hour="$(date +%H)"
minute="$(date +%M)"
quarter="$(( 10#\$minute / 15 * 15 ))"
slot="$(printf '%s %s:%02d' "\$day" "\$hour" "\$quarter")"

# Same order as the Claude scrape / Apps Script ROUTES array.
v1="$(read_route 'https://www.google.com/maps/dir/1.421730,103.771179/1.466582,103.768091/data=!4m2!4m1!3e0')"
v2="$v1"
v3="$(read_route 'https://www.google.com/maps/dir/1.426905,103.763665/1.466582,103.768091/data=!4m2!4m1!3e0')"
v4="$(read_route 'https://www.google.com/maps/dir/1.472085,103.7651/1.4430746,103.7683229/data=!4m2!4m1!3e0')"
v5="$(read_route 'https://www.google.com/maps/dir/1.482406,103.7832/1.4430746,103.7683229/data=!4m2!4m1!3e0')"
v6="$(read_route 'https://www.google.com/maps/dir/1.467340,103.7658/1.4430746,103.7683229/data=!4m2!4m1!3e0')"
v7="$(read_route 'https://www.google.com/maps/dir/1.465356,103.7702/1.4430746,103.7683229/data=!4m2!4m1!3e0')"

go_home

good=0
for v in "$v1" "$v2" "$v3" "$v4" "$v5" "$v6" "$v7"; do
  if [ "$v" != ERR ]; then good="$(( good + 1 ))"; fi
done
if [ "$good" -lt 5 ]; then
  printf 'abort: only %s/7 routes parsed\\n' "$good" >> "$debug_path"
  printf '%s\\n' '{"ok":false,"error":"gmaps_parse_implausible"}' > "$status_path"
  exit 1
fi

json_val() {
  if [ "$1" = ERR ]; then printf '"ERR"'; else printf '%s' "$1"; fi
}

payload="{\\"secret\\":\\"$secret\\",\\"source\\":\\"mi6-maps\\",\\"slot\\":\\"$slot\\",\\"values\\":[$(json_val "$v1"),$(json_val "$v2"),$(json_val "$v3"),$(json_val "$v4"),$(json_val "$v5"),$(json_val "$v6"),$(json_val "$v7")]}"
printf 'slot=%s values=%s/%s/%s/%s/%s/%s/%s\\n' "$slot" "$v1" "$v2" "$v3" "$v4" "$v5" "$v6" "$v7" >> "$debug_path"

ok=0
i=1
while [ "$i" -le 6 ]; do
  resp="$(curl -sS -L --max-time 45 -H 'Content-Type: application/json' --data "$payload" "$url" 2>&1 || true)"
  printf 'attempt %s %s\\n' "$i" "$resp" >> "$debug_path"
  case "$resp" in
    '{'*) printf '%s\\n' "$resp" > "$status_path"; ok=1; break ;;
  esac
  i="$(( i + 1 ))"
  sleep 4
done

if [ "$ok" -ne 1 ]; then
  printf '%s\\n' '{"ok":false,"error":"gmaps_ingest_failed"}' > "$status_path"
  exit 1
fi
case "$(cat "$status_path")" in
  *'"ok":true'*) exit 0 ;;
  *) exit 1 ;;
esac
`;

await writeFile(localPath, script, { mode: 0o600 });
await run(adb, ["-s", serial, "push", localPath, devicePath]);
console.log(`Installed Mi6 GMaps feeder at ${devicePath} for ${serial}.`);
