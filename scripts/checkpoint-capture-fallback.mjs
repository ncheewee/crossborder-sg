import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const command = process.argv[2] || "status";
const captureRoot = process.env.COMPETITOR_CAPTURE_DIR;
const apiBase = (process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev").replace(/\/$/, "");
const monitorKey = process.env.MONITOR_API_KEY;
const maxAgeMinutes = Number(process.env.CHECKPOINT_MAX_AGE_MINUTES || 75);
const statusPath = captureRoot ? join(captureRoot, "checkpoint-mi6-status.json") : null;
const adb = process.env.ADB || "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const mi6Serial = process.env.MI6_ADB_SERIAL || "192.168.0.4:5555";
const mi6DeviceStatusPath = "/sdcard/Download/crossborder-mi6-checkpoint-status.json";

if (!monitorKey) throw new Error("MONITOR_API_KEY is not configured");

function validRange(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every((item) => Number.isFinite(Number(item)) && Number(item) > 0)
    && Number(value[1]) >= Number(value[0])
    && Number(value[1]) <= 240;
}

function completeWoodlands(readings) {
  return validRange(readings?.woodlands?.towardsJb) && validRange(readings?.woodlands?.towardsSg);
}

async function workerCaptures() {
  const response = await fetch(`${apiBase}/api/monitor/checkpoint?hours=4`, {
    headers: { "X-Monitor-Key": monitorKey },
  });
  if (!response.ok) throw new Error(`Checkpoint capture API returned ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.captures) ? payload.captures : [];
}

function captureTimestamp(capture) {
  return capture?.captured_at ?? capture?.capturedAt ?? null;
}

function captureAgeMinutes(capture) {
  const capturedAt = captureTimestamp(capture);
  if (!capturedAt) return Infinity;
  return Math.max(0, Math.round((Date.now() - new Date(capturedAt).getTime()) / 60_000));
}

function missingWoodlandsDirections(readings) {
  const missing = [];
  if (!validRange(readings?.woodlands?.towardsJb)) missing.push("SG-JB");
  if (!validRange(readings?.woodlands?.towardsSg)) missing.push("JB-SG");
  return missing;
}

async function recordMi6Status(status) {
  if (!statusPath) return;
  await writeFile(statusPath, `${JSON.stringify({ checkedAt: new Date().toISOString(), ...status }, null, 2)}\n`);
}

function deviceErrorMessage(status) {
  const messages = {
    no_checkpoint_screenshot: "MacroDroid did not produce a Checkpoint.sg screenshot",
    stale_checkpoint_screenshot: `MacroDroid supplied a stale screenshot${status?.ageSeconds ? ` (${status.ageSeconds}s old)` : ""}`,
    ocr_incomplete: "Mi6 OCR missed one or more of the four checkpoint ranges",
    tesseract_install_failed: "Tesseract was unavailable and its installation failed",
    imagemagick_install_failed: "ImageMagick was unavailable and its installation failed",
  };
  return messages[status?.error] || (status?.error ? `Mi6 feeder reported ${status.error}` : null);
}

async function mi6DeviceFailureDetail() {
  try {
    await execFileAsync(adb, ["connect", mi6Serial], { timeout: 8_000 }).catch(() => undefined);
    await execFileAsync(adb, ["-s", mi6Serial, "get-state"], { timeout: 5_000 });
    const { stdout } = await execFileAsync(adb, [
      "-s", mi6Serial, "shell", "sh", "-c",
      `status_path='${mi6DeviceStatusPath}'; [ -r "$status_path" ] || exit 2; stat -c %Y "$status_path"; cat "$status_path"`,
    ], { timeout: 8_000, maxBuffer: 128 * 1024 });
    const [modifiedLine, ...jsonLines] = stdout.trim().split(/\r?\n/);
    const modifiedAt = Number(modifiedLine) * 1000;
    const statusAgeMinutes = Number.isFinite(modifiedAt)
      ? Math.max(0, Math.round((Date.now() - modifiedAt) / 60_000))
      : null;
    let deviceStatus = null;
    try {
      deviceStatus = JSON.parse(jsonLines.join("\n"));
    } catch {
      return `Mi6 feeder status was unreadable${statusAgeMinutes == null ? "" : ` and ${statusAgeMinutes}m old`}`;
    }
    const errorMessage = deviceErrorMessage(deviceStatus);
    if (errorMessage) return `${errorMessage}; device status ${statusAgeMinutes ?? "?"}m old`;
    if (statusAgeMinutes != null && statusAgeMinutes > maxAgeMinutes) {
      return `Mi6 feeder status is ${statusAgeMinutes}m old, suggesting MacroDroid did not run recently`;
    }
    return `Mi6 feeder returned an unexpected response ${statusAgeMinutes ?? "?"}m ago`;
  } catch {
    return `Mi6 was unreachable over ADB at ${mi6Serial}`;
  }
}

if (command === "status") {
  try {
    const captures = await workerCaptures();
    const mi6Captures = captures.filter((capture) => (capture.source || "mi6-macrodroid") === "mi6-macrodroid");
    const latestMi6 = mi6Captures.at(-1) ?? null;
    const latestCompleteMi6 = mi6Captures.slice().reverse().find((capture) => completeWoodlands(capture.readings)) ?? null;
    const completeAgeMinutes = captureAgeMinutes(latestCompleteMi6);
    const latestAgeMinutes = captureAgeMinutes(latestMi6);
    const latestIsNewerIncomplete = latestMi6
      && !completeWoodlands(latestMi6.readings)
      && (!latestCompleteMi6 || new Date(captureTimestamp(latestMi6)).getTime() > new Date(captureTimestamp(latestCompleteMi6)).getTime());

    if (Number.isFinite(completeAgeMinutes) && completeAgeMinutes <= maxAgeMinutes) {
      const mi6Log = latestIsNewerIncomplete
        ? `Mi6 issue: latest capture ${latestAgeMinutes}m old is incomplete (missing ${missingWoodlandsDirections(latestMi6.readings).join(" and ")}); using prior complete Mi6 capture ${completeAgeMinutes}m old.`
        : `OK: complete Mi6 capture ${completeAgeMinutes}m old.`;
      await recordMi6Status({
        ok: true,
        fallbackRequired: false,
        captureAt: captureTimestamp(latestCompleteMi6),
        ageMinutes: completeAgeMinutes,
        mi6Log,
      });
      console.log(mi6Log);
      process.exit(0);
    }

    let mi6Log;
    if (latestIsNewerIncomplete || (latestMi6 && !latestCompleteMi6)) {
      mi6Log = `Mi6 failure: latest capture ${latestAgeMinutes}m old is incomplete (missing ${missingWoodlandsDirections(latestMi6.readings).join(" and ")}).`;
    } else if (latestCompleteMi6) {
      mi6Log = `Mi6 failure: latest complete capture is ${completeAgeMinutes}m old; freshness limit is ${maxAgeMinutes}m.`;
    } else {
      mi6Log = "Mi6 failure: no capture received in the last 4 hours.";
    }
    const deviceDetail = await mi6DeviceFailureDetail();
    mi6Log = `${mi6Log} Device detail: ${deviceDetail}.`;
    await recordMi6Status({
      ok: false,
      fallbackRequired: true,
      captureAt: captureTimestamp(latestCompleteMi6 ?? latestMi6),
      ageMinutes: Number.isFinite(completeAgeMinutes) ? completeAgeMinutes : null,
      mi6Log,
    });
    console.warn(`${mi6Log} Emulator fallback required.`);
    process.exit(10);
  } catch (error) {
    const mi6Log = `Mi6 failure: Worker feed check failed (${error.message}).`;
    await recordMi6Status({
      ok: false,
      fallbackRequired: true,
      captureAt: null,
      ageMinutes: null,
      mi6Log,
    });
    console.warn(`${mi6Log} Emulator fallback required.`);
    process.exit(10);
  }
}

if (command === "upload") {
  if (!captureRoot) throw new Error("COMPETITOR_CAPTURE_DIR is not configured");
  const records = JSON.parse(await readFile(join(captureRoot, "latest-summary.json"), "utf8"));
  const checkpoint = records.find((record) => record.app === "Checkpoint.sg" && record.captureStatus !== "failed");
  if (!checkpoint || !completeWoodlands(checkpoint.normalizedReadings)) {
    throw new Error("Emulator capture did not contain both Woodlands directions");
  }
  const response = await fetch(`${apiBase}/api/monitor/checkpoint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Monitor-Key": monitorKey,
    },
    body: JSON.stringify({
      capturedAt: checkpoint.capturedAt,
      source: "android-emulator",
      readings: checkpoint.normalizedReadings,
      rawOcr: checkpoint.ocrText,
    }),
  });
  if (!response.ok) throw new Error(`Checkpoint capture upload returned ${response.status}`);
  console.log(`Uploaded emulator Checkpoint.sg capture from ${checkpoint.capturedAt}.`);
  process.exit(0);
}

throw new Error(`Unknown command: ${command}`);
