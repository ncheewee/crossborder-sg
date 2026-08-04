import { readFile } from "node:fs/promises";
import { join } from "node:path";

const command = process.argv[2] || "status";
const captureRoot = process.env.COMPETITOR_CAPTURE_DIR;
const apiBase = (process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev").replace(/\/$/, "");
const monitorKey = process.env.MONITOR_API_KEY;
const maxAgeMinutes = Number(process.env.CHECKPOINT_MAX_AGE_MINUTES || 75);

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

if (command === "status") {
  const captures = await workerCaptures();
  const latest = captures.slice().reverse().find((capture) => completeWoodlands(capture.readings));
  const capturedAt = latest?.captured_at ?? latest?.capturedAt;
  const ageMinutes = capturedAt ? Math.round((Date.now() - new Date(capturedAt).getTime()) / 60_000) : Infinity;
  if (Number.isFinite(ageMinutes) && ageMinutes <= maxAgeMinutes) {
    console.log(`Fresh ${latest.source || "Mi6"} Checkpoint.sg capture: ${ageMinutes}m old.`);
    process.exit(0);
  }
  console.warn(latest
    ? `Checkpoint.sg capture is ${ageMinutes}m old; emulator fallback required.`
    : "No complete Checkpoint.sg capture found; emulator fallback required.");
  process.exit(10);
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
