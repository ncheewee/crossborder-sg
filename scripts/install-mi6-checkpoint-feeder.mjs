import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";

// MacroDroid must fire this script every 15 minutes (not hourly): open
// Checkpoint.sg, wait for the times, then run this script. Do not take a
// MacroDroid screenshot. Termux snaps to a temp file only while the app is
// in front, then deletes it. The feeder does not schedule itself.
const adb = process.env.ADB || "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const serial = process.env.ADB_SERIAL || "192.168.0.3:5555";
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
tmp_snap='/sdcard/Download/crossborder-mi6-checkpoint-tmp.png'
crop_dir="$PREFIX/tmp/crossborder-checkpoint-ocr"
latest="$crop_dir/screen.png"

run_gmaps() {
  if [ -r /sdcard/Download/crossborder-mi6-gmaps-capture.sh ]; then
    /data/data/com.termux/files/usr/bin/bash /sdcard/Download/crossborder-mi6-gmaps-capture.sh || true
  fi
}
cleanup_images() {
  rm -f "$tmp_snap" "$latest"
  rm -f "$screenshot_dir"/*_com.tplusinteractive.checkpointsg.*
  rm -rf "$crop_dir"
  run_gmaps
}
trap cleanup_images EXIT

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

checkpoint_is_front() {
  local focus=''
  if command -v su >/dev/null 2>&1; then
    focus="$(su -c 'dumpsys window' 2>/dev/null | grep mCurrentFocus || true)"
  fi
  if [ -z "$focus" ]; then
    focus="$(dumpsys window 2>/dev/null | grep mCurrentFocus || true)"
  fi
  printf '%s' "$focus" | grep -q 'com.tplusinteractive.checkpointsg'
}

attempt=0
while [ "$attempt" -lt 20 ]; do
  if checkpoint_is_front; then
    break
  fi
  attempt="$(( attempt + 1 ))"
  sleep 1
done

if ! checkpoint_is_front; then
  printf '%s\\n' '{"ok":false,"error":"checkpoint_not_in_front"}' > "$status_path"
  exit 1
fi

# App in front can still be the splash. Wait for the time images, then
# snap; retry a few times instead of OCRing a blank first frame.
sleep 4

mkdir -p "$crop_dir"
jb_main_crop="$crop_dir/jb-main.png"
jb_tuas_crop="$crop_dir/jb-tuas.png"
sg_main_crop="$crop_dir/sg-main.png"
sg_tuas_crop="$crop_dir/sg-tuas.png"

take_snap() {
  rm -f "$tmp_snap" "$latest"
  now="$(date +%s)"
  fresh="$(ls -t "$screenshot_dir"/*_com.tplusinteractive.checkpointsg.* 2>/dev/null | head -n 1 || true)"
  if [ -n "$fresh" ] && [ -r "$fresh" ]; then
    age="$(( now - $(stat -c %Y "$fresh") ))"
    if [ "$age" -le 60 ]; then
      cp "$fresh" "$latest" 2>/dev/null || true
    fi
  fi
  if [ ! -s "$latest" ]; then
    if command -v su >/dev/null 2>&1; then
      su -c "screencap -p $tmp_snap && cp $tmp_snap $latest && chmod 644 $latest" >/dev/null 2>&1 || true
    fi
  fi
  if [ ! -s "$latest" ]; then
    screencap -p "$latest" >/dev/null 2>&1 || true
  fi
  rm -f "$tmp_snap"
  local size
  size="$(stat -c %s "$latest" 2>/dev/null || echo 0)"
  [ "$size" -gt 100000 ]
}

ranges_from_ocr() {
  printf '%s\\n' "$1" \
    | sed 's/§/5/g; s/[–—]/-/g; s/\\([0-9]\\)\\.\\([0-9]\\)/\\1-\\2/g' \
    | grep -Eo '[0-9]{1,3}[[:space:]]*-[[:space:]]*[0-9]{1,3}' \
    | tr -d ' ' \
    | awk -F- '$1 > 0 && $2 >= $1 && $2 <= 240 { print "[" $1 "," $2 "]" }'
}

woodlands_jb=null
woodlands_sg=null
tuas_jb=null
tuas_sg=null
ocr_jb_main=''
ocr_jb_tuas=''
ocr_sg_main=''
ocr_sg_tuas=''
ocr=''
snap_try=0
while [ "$snap_try" -lt 4 ]; do
  if ! take_snap; then
    printf '%s\\n' '{"ok":false,"error":"screencap_failed"}' > "$status_path"
    exit 1
  fi
  "$image_tool" "$latest" -crop 450x65+0+780 +repage -resize 400% \
    -colorspace Gray -normalize -sharpen 0x1 -threshold 70% "$jb_main_crop"
  "$image_tool" "$latest" -crop 560x110+0+820 +repage -resize 400% \
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
  woodlands_jb="$(ranges_from_ocr "$ocr_jb_main" | sed -n '1p' || true)"
  tuas_jb="$(ranges_from_ocr "$ocr_jb_tuas" | sed -n '1p' || true)"
  woodlands_sg="$(ranges_from_ocr "$ocr_sg_main" | sed -n '1p' || true)"
  tuas_sg="$(ranges_from_ocr "$ocr_sg_tuas" | sed -n '1p' || true)"
  [ -n "$woodlands_jb" ] || woodlands_jb=null
  [ -n "$woodlands_sg" ] || woodlands_sg=null
  [ -n "$tuas_jb" ] || tuas_jb=null
  [ -n "$tuas_sg" ] || tuas_sg=null
  if [ "$woodlands_jb" != null ] && [ "$woodlands_sg" != null ]; then
    break
  fi
  snap_try="$(( snap_try + 1 ))"
  sleep 3
done

[ -n "$woodlands_jb" ] || woodlands_jb=null
[ -n "$woodlands_sg" ] || woodlands_sg=null
[ -n "$tuas_jb" ] || tuas_jb=null
[ -n "$tuas_sg" ] || tuas_sg=null
captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
payload="{\\"capturedAt\\":\\"$captured_at\\",\\"readings\\":{\\"woodlands\\":{\\"towardsJb\\":$woodlands_jb,\\"towardsSg\\":$woodlands_sg},\\"tuas\\":{\\"towardsJb\\":$tuas_jb,\\"towardsSg\\":$tuas_sg}}}"

printf 'screenshot=%s\\nocr=\\n%s\\nparsed=%s|%s|%s|%s\\npayload=%s\\n' "$latest" "$ocr" "$woodlands_jb" "$woodlands_sg" "$tuas_jb" "$tuas_sg" "$payload" > "$debug_path"

if [ "$woodlands_jb" = null ] || [ "$woodlands_sg" = null ]; then
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
