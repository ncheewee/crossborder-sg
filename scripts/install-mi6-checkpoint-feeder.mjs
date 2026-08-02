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

started_at="$(date +%s)"
latest=''
screenshot_age=999999
attempt=0
while [ "$attempt" -lt 15 ]; do
  latest="$(ls -t "$screenshot_dir"/*_com.tplusinteractive.checkpointsg.* 2>/dev/null | head -n 1 || true)"
  if [ -n "$latest" ] && [ -r "$latest" ]; then
    screenshot_age="$(( $(date +%s) - $(stat -c %Y "$latest") ))"
    # MacroDroid's screenshot action returns just before the file is flushed.
    # Wait for the screenshot produced by this run instead of OCRing the prior hour.
    if [ "$(stat -c %Y "$latest")" -ge "$(( started_at - 2 ))" ]; then
      break
    fi
  fi
  attempt="$(( attempt + 1 ))"
  sleep 1
done

if [ -z "$latest" ] || [ ! -r "$latest" ]; then
  printf '%s\\n' '{"ok":false,"error":"no_checkpoint_screenshot"}' > "$status_path"
  exit 1
fi
if [ "$screenshot_age" -gt 120 ]; then
  printf '{"ok":false,"error":"stale_checkpoint_screenshot","ageSeconds":%s}\\n' "$screenshot_age" > "$status_path"
  exit 1
fi

if [ ! -x "$PREFIX/bin/tesseract" ]; then
  "$PREFIX/bin/pkg" install -y tesseract >/dev/null 2>&1 || {
    printf '%s\\n' '{"ok":false,"error":"tesseract_install_failed"}' > "$status_path"
    exit 1
  }
fi

if [ ! -x "$PREFIX/bin/magick" ] && [ ! -x "$PREFIX/bin/convert" ]; then
  "$PREFIX/bin/pkg" install -y imagemagick >/dev/null 2>&1 || {
    printf '%s\\n' '{"ok":false,"error":"imagemagick_install_failed"}' > "$status_path"
    exit 1
  }
fi

image_tool="$PREFIX/bin/magick"
[ -x "$image_tool" ] || image_tool="$PREFIX/bin/convert"
crop_dir="$PREFIX/tmp/crossborder-checkpoint-ocr"
mkdir -p "$crop_dir"
jb_main_crop="$crop_dir/jb-main.png"
jb_tuas_crop="$crop_dir/jb-tuas.png"
sg_main_crop="$crop_dir/sg-main.png"
sg_tuas_crop="$crop_dir/sg-tuas.png"

# Checkpoint.sg renders each range at a stable position on the Mi6. Keep each
# value in its own crop so a missed line can never shift Tuas into Woodlands.
"$image_tool" "$latest" -crop 450x65+0+780 +repage -resize 400% \
  -colorspace Gray -normalize -sharpen 0x1 -threshold 70% "$jb_main_crop"
"$image_tool" "$latest" -crop 520x70+0+830 +repage -resize 400% \
  -colorspace Gray -normalize -sharpen 0x1 -threshold 70% "$jb_tuas_crop"
"$image_tool" "$latest" -crop 520x70+560+1390 +repage -resize 400% \
  -colorspace Gray -normalize -sharpen 0x1 -threshold 70% "$sg_main_crop"
"$image_tool" "$latest" -crop 520x75+560+1440 +repage -resize 400% \
  -colorspace Gray -normalize -sharpen 0x1 -threshold 70% "$sg_tuas_crop"

ocr_jb_main="$($PREFIX/bin/tesseract "$jb_main_crop" stdout --psm 7 2>/dev/null || true)"
ocr_jb_tuas="$($PREFIX/bin/tesseract "$jb_tuas_crop" stdout --psm 7 2>/dev/null || true)"
ocr_sg_main="$($PREFIX/bin/tesseract "$sg_main_crop" stdout --psm 7 2>/dev/null || true)"
ocr_sg_tuas="$($PREFIX/bin/tesseract "$sg_tuas_crop" stdout --psm 7 2>/dev/null || true)"
ocr="Woodlands JB:\n$ocr_jb_main\nTuas JB:\n$ocr_jb_tuas\nWoodlands SG:\n$ocr_sg_main\nTuas SG:\n$ocr_sg_tuas"

ranges_from_ocr() {
  printf '%s\\n' "$1" \
    | sed 's/§/5/g; s/[–—]/-/g' \
    | grep -Eo '[0-9]{1,3}[[:space:]]*-[[:space:]]*[0-9]{1,3}' \
    | tr -d ' ' \
    | awk -F- '$1 > 0 && $2 >= $1 && $2 <= 240 { print "[" $1 "," $2 "]" }'
}

woodlands_jb="$(ranges_from_ocr "$ocr_jb_main" | sed -n '1p' || true)"
tuas_jb="$(ranges_from_ocr "$ocr_jb_tuas" | sed -n '1p' || true)"
woodlands_sg="$(ranges_from_ocr "$ocr_sg_main" | sed -n '1p' || true)"
tuas_sg="$(ranges_from_ocr "$ocr_sg_tuas" | sed -n '1p' || true)"

[ -n "$woodlands_jb" ] || woodlands_jb=null
[ -n "$woodlands_sg" ] || woodlands_sg=null
[ -n "$tuas_jb" ] || tuas_jb=null
[ -n "$tuas_sg" ] || tuas_sg=null
captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
payload="{\\"capturedAt\\":\\"$captured_at\\",\\"readings\\":{\\"woodlands\\":{\\"towardsJb\\":$woodlands_jb,\\"towardsSg\\":$woodlands_sg},\\"tuas\\":{\\"towardsJb\\":$tuas_jb,\\"towardsSg\\":$tuas_sg}}}"

printf 'screenshot=%s\\nocr=\\n%s\\nparsed=%s|%s|%s|%s\\npayload=%s\\n' "$latest" "$ocr" "$woodlands_jb" "$woodlands_sg" "$tuas_jb" "$tuas_sg" "$payload" > "$debug_path"

if [ "$woodlands_jb" = null ] || [ "$woodlands_sg" = null ] || [ "$tuas_jb" = null ] || [ "$tuas_sg" = null ]; then
  printf '%s\\n' '{"ok":false,"error":"ocr_incomplete"}' > "$status_path"
  exit 1
fi

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
