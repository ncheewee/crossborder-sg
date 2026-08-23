import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const captureRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegramDisabled = process.env.TELEGRAM_DISABLED === "1" || process.env.TELEGRAM_DISABLED === "true";
const telegramSender = process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local-launchd";
const sheetId = "1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo";
const timingSources = [
  {
    id: "ours",
    label: "Crossborder",
    url: process.env.CROSSBORDER_SHEET_URL || `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=94841451`,
    suffix: "",
  },
];
const historyPath = join(captureRoot, "v3-four-source-history.csv");
const sharedTimingsSnapshotPath = join(captureRoot, "v3-crossborder-timings-cache.json");
const mi6StatusPath = join(captureRoot, "checkpoint-mi6-status.json");
const checkpointMaxAgeMs = 90 * 60 * 1000;
const apiBase = (process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev").replace(/\/$/, "");
const monitorKey = process.env.MONITOR_API_KEY;

const routeSets = [
  {
    label: "Singapore to JB (Woodlands)",
    directionKey: "towardsJb",
    clearance: { latitude: 1.466582, longitude: 103.768091 },
    routes: [
      { id: "A", sourceColumn: "SG-JB A | BKE Flyover", origin: { latitude: 1.421730, longitude: 103.771179 } },
      { id: "B", sourceColumn: "SG-JB B | BKE Junction", origin: { latitude: 1.421730, longitude: 103.771179 } },
      { id: "C", sourceColumn: "SG-JB C | Woodlands Rd", origin: { latitude: 1.426905, longitude: 103.763665 } },
    ],
  },
  {
    label: "JB to Singapore (Woodlands)",
    directionKey: "towardsSg",
    clearance: { latitude: 1.4430746, longitude: 103.7683229 },
    routes: [
      { id: "A", sourceColumn: "JB-SG A | Lingkaran Dalam S", origin: { latitude: 1.472085, longitude: 103.7651 } },
      { id: "B", sourceColumn: "JB-SG B | AH2", origin: { latitude: 1.482406, longitude: 103.7832 } },
      { id: "C", sourceColumn: "JB-SG C | Bukit Chagar", origin: { latitude: 1.46734, longitude: 103.7658 } },
      { id: "D", sourceColumn: "JB-SG D | Lingkaran Dalam N", origin: { latitude: 1.465356, longitude: 103.7702 } },
    ],
  },
];

function midpoint(range) {
  return Array.isArray(range) ? Math.round((Number(range[0]) + Number(range[1])) / 2) : null;
}

function plausibleRange(range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [low, high] = range.map(Number);
  return Number.isFinite(low) && Number.isFinite(high) && low > 0 && high >= low && high <= 240 ? [low, high] : null;
}

function signedMinutes(value) {
  return `${value >= 0 ? "+" : ""}${value}m`;
}

function shortDirection(label) {
  return label.startsWith("Singapore") ? "SG→JB" : "JB→SG";
}

function formatMinutes(value) {
  return Number.isFinite(value) ? `${value}m` : "—";
}

function gapVsCheckpoint(oursMid, checkpointMid) {
  if (!Number.isFinite(oursMid) || !Number.isFinite(checkpointMid)) return null;
  return oursMid - checkpointMid;
}

function describeMovement(currentMid, previousMid) {
  if (!Number.isFinite(currentMid) || !Number.isFinite(previousMid)) return null;
  const delta = currentMid - previousMid;
  if (Math.abs(delta) < 8) return null;
  return `${delta > 0 ? "up" : "down"} ${Math.abs(delta)}m`;
}

function buildHourlyInsight(routeReports, checkpointSource) {
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  const sourceNote = checkpointSource === "mi6-macrodroid" ? "Mi6"
    : checkpointSource === "android-emulator" ? "emulator, no Mi6"
      : "Checkpoint missing";

  const lines = routeReports.map((report) => {
    const name = shortDirection(report.label);
    const ours = formatMinutes(report.oursMid);
    if (!Number.isFinite(report.checkpointMid)) return `${name}  CB ${ours}  ·  no Checkpoint`;
    const gap = gapVsCheckpoint(report.oursMid, report.checkpointMid);
    const match = Math.abs(gap) <= 8 ? "match" : `${signedMinutes(gap)} vs CP`;
    return `${name}  CB ${ours}  ·  CP ${formatMinutes(report.checkpointMid)}  ·  ${match}`;
  });

  const takeaways = [];
  if (checkpointSource === "android-emulator") {
    takeaways.push("Checkpoint is emulator — treat it as a stand-in.");
  } else if (checkpointSource !== "mi6-macrodroid") {
    takeaways.push("No fresh Checkpoint this hour.");
  }

  for (const report of routeReports) {
    const name = shortDirection(report.label);
    const gap = gapVsCheckpoint(report.oursMid, report.checkpointMid);
    if (gap !== null && gap <= -12) {
      takeaways.push(`${name} Crossborder is ${Math.abs(gap)}m under Checkpoint.`);
    } else if (gap !== null && gap >= 12) {
      takeaways.push(`${name} Crossborder is ${gap}m over Checkpoint.`);
    }
    const move = describeMovement(report.oursMid, report.previousOursMid);
    if (move) takeaways.push(`${name} ${move} since the last chart.`);
  }

  if (!takeaways.length) {
    takeaways.push("Both sides sit with Checkpoint. Nothing to change.");
  }

  return [`${stamp}  ·  Crossborder vs Checkpoint  ·  CP ${sourceNote}`, "", ...lines, "", takeaways[0]].join("\n");
}

async function readCsv(path) {
  try {
    const text = await readFile(path, "utf8");
    const [header, ...rows] = text.trim().split("\n");
    if (!header) return [];
    const keys = header.split(",");
    return rows.filter(Boolean).map((line) => Object.fromEntries(line.split(",").map((value, index) => [keys[index], value])));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function checkpointRecordFromWorker(capture) {
  if (!capture || typeof capture !== "object") return null;
  const capturedAt = capture.captured_at ?? capture.capturedAt;
  if (!capturedAt || Number.isNaN(new Date(capturedAt).getTime())) return null;
  return {
    app: "Checkpoint.sg",
    captureStatus: "completed",
    capturedAt: new Date(capturedAt).toISOString(),
    source: capture.source || "mi6-macrodroid",
    normalizedReadings: capture.readings,
  };
}

async function loadWorkerCheckpointCaptures() {
  if (!monitorKey) throw new Error("MONITOR_API_KEY is not configured");
  const response = await fetch(`${apiBase}/api/monitor/checkpoint?hours=36`, {
    headers: { "X-Monitor-Key": monitorKey },
  });
  if (!response.ok) throw new Error(`Checkpoint capture API returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.captures)) throw new Error("Checkpoint capture API returned an invalid payload");
  return payload.captures.map(checkpointRecordFromWorker).filter(Boolean);
}

function checkpointSourceRank(source) {
  const text = String(source || "").toLowerCase();
  if (text.includes("mi6")) return 3;
  if (text.includes("emulator")) return 1;
  return 2;
}

async function loadCheckpointSheetRecords() {
  const response = await fetch(
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=734892105`,
    { headers: { Accept: "text/csv" } },
  );
  if (!response.ok) throw new Error(`Checkpoint.sg sheet returned ${response.status}`);
  const [header = [], ...data] = parseCsv(await response.text());
  const timestampIndex = header.indexOf("Timestamp (SGT)");
  const jbLow = header.indexOf("SG-JB | Woodlands (low)");
  const jbHigh = header.indexOf("SG-JB | Woodlands (high)");
  const sgLow = header.indexOf("JB-SG | Woodlands (low)");
  const sgHigh = header.indexOf("JB-SG | Woodlands (high)");
  const sourceIndex = header.indexOf("Source");
  if (timestampIndex === -1 || jbLow === -1 || sgLow === -1) {
    throw new Error("Checkpoint.sg sheet is missing Woodlands columns");
  }
  return data.map((row) => {
    const capturedAt = parseSingaporeTimestamp(row[timestampIndex]);
    if (!capturedAt) return null;
    return {
      app: "Checkpoint.sg",
      captureStatus: "completed",
      capturedAt,
      source: String(row[sourceIndex] || "sheet").trim() || "sheet",
      normalizedReadings: {
        woodlands: {
          towardsJb: [Number(row[jbLow]), Number(row[jbHigh])],
          towardsSg: [Number(row[sgLow]), Number(row[sgHigh])],
        },
      },
    };
  }).filter(Boolean);
}

function mergeCheckpointRecords(...lists) {
  const byBucket = new Map();
  for (const record of lists.flat().filter(Boolean)) {
    const bucket = quarterBucket(record.capturedAt);
    if (bucket === null) continue;
    const existing = byBucket.get(bucket);
    if (!existing) {
      byBucket.set(bucket, record);
      continue;
    }
    const nextRank = checkpointSourceRank(record.source);
    const existingRank = checkpointSourceRank(existing.source);
    if (nextRank > existingRank) {
      byBucket.set(bucket, record);
      continue;
    }
    if (nextRank === existingRank) {
      const nextDist = Math.abs(new Date(record.capturedAt).getTime() - bucket);
      const existingDist = Math.abs(new Date(existing.capturedAt).getTime() - bucket);
      if (nextDist < existingDist) byBucket.set(bucket, record);
    }
  }
  return [...byBucket.values()].sort((left, right) => (
    new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime()
  ));
}

function checkpointByQuarter(checkpointRecords) {
  const map = new Map();
  for (const record of checkpointRecords) {
    const bucket = quarterBucket(record.capturedAt);
    if (bucket === null) continue;
    const existing = map.get(bucket);
    if (!existing || Math.abs(new Date(record.capturedAt).getTime() - bucket) < Math.abs(new Date(existing.capturedAt).getTime() - bucket)) {
      map.set(bucket, record);
    }
  }
  return map;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += character;
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseSingaporeTimestamp(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return new Date(`${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:00+08:00`).toISOString();
}

async function loadTimingSource(source) {
  const response = await fetch(source.url, { headers: { Accept: "text/csv" } });
  if (!response.ok) throw new Error(`${source.label} sheet returned ${response.status}`);
  const [header = [], ...data] = parseCsv(await response.text());
  const timestampIndex = header.indexOf("Timestamp (SGT)");
  if (timestampIndex === -1 || data.length === 0) throw new Error(`${source.label} sheet has no timestamped readings`);
  const requiredColumns = routeSets.flatMap((route) => route.routes.map((item) => `${item.sourceColumn}${source.suffix}`));
  const records = data.map((row) => {
    const capturedAt = parseSingaporeTimestamp(row[timestampIndex]);
    const readings = Object.fromEntries(header.map((key, index) => [key, Number(row[index])]));
    return {
      capturedAt,
      readings,
      source: source.label,
    };
  }).filter((record) => {
    if (!record.capturedAt) return false;
    const hits = requiredColumns.filter((column) => Number.isFinite(record.readings[column]) && record.readings[column] > 0);
    return hits.length >= 2;
  });
  const latest = records.at(-1);
  if (!latest) throw new Error(`${source.label} sheet has no complete positive route reading`);
  return {
    ...source,
    ...latest,
    records,
  };
}

function sourceRange(route, source) {
  if (!source) return null;
  const values = route.routes
    .map((item) => source.readings[`${item.sourceColumn}${source.suffix}`])
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length >= Math.min(2, route.routes.length)
    ? [Math.min(...values), Math.max(...values)]
    : null;
}

function sourcePoint(route, source, record) {
  if (!record?.readings || !record.capturedAt) return null;
  const range = sourceRange(route, { ...source, ...record });
  if (!range) return null;
  return {
    capturedAt: record.capturedAt,
    label: route.label,
    oursLow: range[0],
    oursHigh: range[1],
    oursMid: midpoint(range),
  };
}

function quarterBucket(timestamp) {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? Math.floor(time / 900_000) * 900_000 : null;
}

function closestRecord(records, slotMs, maxDistMs = 7.5 * 60 * 1000) {
  let best = null;
  let bestDist = maxDistMs + 1;
  for (const record of records) {
    const time = new Date(record.capturedAt).getTime();
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - slotMs);
    if (distance < bestDist) {
      best = record;
      bestDist = distance;
    }
  }
  return bestDist <= maxDistMs ? best : null;
}

function buildQuarterDayPoints(route, sources, checkpointRecords, reportDate) {
  const start = new Date(`${reportDate}T00:00:00+08:00`).getTime();
  const end = Math.min(Date.now(), start + 24 * 3_600_000 - 1);
  const checkpointSlots = checkpointByQuarter(checkpointRecords);
  const points = [];
  let lastCheckpoint = null;
  for (let slot = start; slot <= end; slot += 900_000) {
    const oursRecord = closestRecord(sources.ours?.records ?? [], slot);
    const checkpointRecord = checkpointSlots.get(slot) ?? null;
    const ours = oursRecord ? sourcePoint(route, sources.ours, oursRecord) : null;
    if (ours && (!Number.isFinite(ours.oursMid) || ours.oursMid < 5 || ours.oursHigh < 5)) {
      ours.oursLow = ours.oursHigh = ours.oursMid = null;
    }
    const observedRange = checkpointRecord
      ? plausibleRange(checkpointRecord.normalizedReadings?.woodlands?.[route.directionKey])
      : null;
    let checkpointRange = observedRange;
    if (observedRange) {
      lastCheckpoint = observedRange;
    } else if (lastCheckpoint) {
      checkpointRange = lastCheckpoint;
    }
    const point = {
      capturedAt: new Date(slot).toISOString(),
      label: route.label,
      oursLow: ours?.oursLow ?? null,
      oursHigh: ours?.oursHigh ?? null,
      oursMid: ours?.oursMid ?? null,
      checkpointLow: checkpointRange?.[0] ?? null,
      checkpointHigh: checkpointRange?.[1] ?? null,
      checkpointMid: midpoint(checkpointRange),
    };
    if ([point.oursMid, point.checkpointMid].some(Number.isFinite)) {
      points.push(point);
    }
  }
  return points;
}

async function lastValidCrossBorderRows() {
  const history = await readCsv(historyPath);
  const latestByLabel = new Map();
  for (const row of history) {
    const low = Number(row.oursLow);
    const high = Number(row.oursHigh);
    if (Number.isFinite(low) && low > 0 && Number.isFinite(high) && high > 0) latestByLabel.set(row.label, row);
  }
  return latestByLabel;
}

async function sendTelegram(method, body) {
  if (telegramDisabled) {
    console.log(`Telegram ${method} skipped (${telegramSender} disabled)`);
    return;
  }
  if (!token || !chatId) throw new Error("Telegram credentials are not configured");
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body });
      if (!response.ok) throw new Error(`Telegram returned ${response.status}`);
      console.log(`Telegram ${method} sent via ${telegramSender}`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function sendPhoto(buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", chatId ?? "");
  if (caption) form.append("caption", caption);
  form.append("photo", new Blob([buffer], { type: "image/png" }), filename);
  await sendTelegram("sendPhoto", form);
}

async function sendMessage(text) {
  const body = new URLSearchParams({ chat_id: chatId ?? "", text });
  await sendTelegram("sendMessage", body);
}

function formatSheetTimestamp(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(",", "").replace(/:(\d{2})$/, (_, minute) => (
    `:${String(Math.floor(Number(minute) / 15) * 15).padStart(2, "0")}`
  ));
}

async function appendCheckpointSheetRow(sheetRows, source, log, stampIso) {
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    console.log("Checkpoint.sg sheet append skipped: INGEST_SECRET is not set");
    return;
  }
  const jb = sheetRows.find((row) => row.directionKey === "towardsJb");
  const sg = sheetRows.find((row) => row.directionKey === "towardsSg");
  if (!Number.isFinite(jb?.checkpointMid) || !Number.isFinite(sg?.checkpointMid)) {
    console.log("Checkpoint.sg sheet append skipped: no complete Woodlands reading");
    return;
  }
  const row = [
    formatSheetTimestamp(stampIso),
    jb?.checkpointLow ?? "", jb?.checkpointHigh ?? "", jb?.checkpointMid ?? "",
    sg?.checkpointLow ?? "", sg?.checkpointHigh ?? "", sg?.checkpointMid ?? "",
    source,
    log,
  ];
  const url = process.env.CHECKPOINT_SHEET_WEBAPP_URL
    || "https://script.google.com/macros/s/AKfycbzamRGlMzJ8TLjfHPygtw01RU-NaK2TCyzq4iFRVjZRKL9JUef-SR3NSu8-skeGMJoA/exec";
  let lastBody = "";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, type: "checkpoint", row }),
      redirect: "follow",
    });
    lastBody = await response.text();
    if (lastBody.trim().startsWith("{")) {
      const payload = JSON.parse(lastBody);
      if (!payload.ok) throw new Error(payload.error || "Checkpoint.sg sheet rejected the row");
      console.log(`Checkpoint.sg sheet ${payload.result || "updated"}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  throw new Error(`Checkpoint.sg sheet web app did not return JSON: ${lastBody.slice(0, 160)}`);
}

function displaySmoothValues(values) {
  if (values.length < 3) return values;
  const kernel = [1, 2, 3, 4, 3, 2, 1];
  const radius = 3;
  return values.map((_, index) => {
    let weighted = 0;
    let weight = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sample = values[Math.min(values.length - 1, Math.max(0, index + offset))];
      const sampleWeight = kernel[offset + radius];
      weighted += sample * sampleWeight;
      weight += sampleWeight;
    }
    return weighted / weight;
  });
}

function displaySmoothKey(rows, key) {
  const values = rows.map((row) => row[key]);
  const out = values.slice();
  let start = 0;
  while (start < values.length) {
    while (start < values.length && !Number.isFinite(values[start])) start += 1;
    let end = start;
    while (end < values.length && Number.isFinite(values[end])) end += 1;
    if (end - start >= 3) {
      const smoothed = displaySmoothValues(values.slice(start, end));
      for (let index = 0; index < smoothed.length; index += 1) out[start + index] = smoothed[index];
    }
    start = Math.max(end, start + 1);
  }
  return rows.map((row, index) => ({ ...row, [key]: out[index] }));
}

function chartSvg(route, rows) {
  const width = 1120;
  const height = 620;
  const margin = { top: 94, right: 60, bottom: 70, left: 76 };
  const values = rows.flatMap((row) => [
    row.oursMid, row.checkpointMid,
  ]).filter(Number.isFinite);
  const plotted = displaySmoothKey(displaySmoothKey(rows, "oursMid"), "checkpointMid");
  const low = Math.max(0, Math.floor((Math.min(...values, 20) - 10) / 10) * 10);
  const high = Math.ceil((Math.max(...values, 90) + 10) / 10) * 10;
  const dayStart = new Date(rows.at(-1)?.capturedAt ?? Date.now());
  const singaporeDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(dayStart);
  const minutesIntoSingaporeDay = (timestamp) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  };
  const plotWidth = width - margin.left - margin.right;
  const x = (row) => margin.left + minutesIntoSingaporeDay(row.capturedAt) / (24 * 60) * plotWidth;
  const y = (value) => height - margin.bottom - (value - low) * (height - margin.top - margin.bottom) / Math.max(high - low, 1);
  const monotonePath = (points) => {
    if (points.length === 0) return "";
    if (points.length === 1) return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    if (points.length === 2) {
      return `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
    }
    const n = points.length;
    const delta = [];
    for (let index = 0; index < n - 1; index += 1) {
      const dx = points[index + 1].x - points[index].x;
      delta.push(Math.abs(dx) < 1e-6 ? 0 : (points[index + 1].y - points[index].y) / dx);
    }
    const slope = new Array(n).fill(0);
    slope[0] = delta[0];
    slope[n - 1] = delta[n - 2];
    for (let index = 1; index < n - 1; index += 1) {
      slope[index] = delta[index - 1] * delta[index] <= 0 ? 0 : (delta[index - 1] + delta[index]) / 2;
    }
    for (let index = 0; index < n - 1; index += 1) {
      if (Math.abs(delta[index]) < 1e-6) {
        slope[index] = 0;
        slope[index + 1] = 0;
        continue;
      }
      const alpha = slope[index] / delta[index];
      const beta = slope[index + 1] / delta[index];
      const sum = alpha * alpha + beta * beta;
      if (sum > 9) {
        const tau = 3 / Math.sqrt(sum);
        slope[index] = tau * alpha * delta[index];
        slope[index + 1] = tau * beta * delta[index];
      }
    }
    let path = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
    for (let index = 0; index < n - 1; index += 1) {
      const dx = (points[index + 1].x - points[index].x) / 3;
      path += ` C${(points[index].x + dx).toFixed(1)},${(points[index].y + slope[index] * dx).toFixed(1)} ${(points[index + 1].x - dx).toFixed(1)},${(points[index + 1].y - slope[index + 1] * dx).toFixed(1)} ${points[index + 1].x.toFixed(1)},${points[index + 1].y.toFixed(1)}`;
    }
    return path;
  };
  const line = (key, include = () => true) => {
    const runs = [];
    let run = [];
    let lastMs = null;
    for (const row of plotted) {
      if (!Number.isFinite(row[key]) || !include(row)) {
        if (run.length) runs.push(run);
        run = [];
        lastMs = null;
        continue;
      }
      const ms = new Date(row.capturedAt).getTime();
      if (lastMs !== null && ms - lastMs > 60 * 60 * 1000) {
        if (run.length) runs.push(run);
        run = [];
      }
      run.push({ x: x(row), y: y(row[key]) });
      lastMs = ms;
    }
    if (run.length) runs.push(run);
    return runs.map(monotonePath).join(" ");
  };
  const grids = Array.from({ length: (high - low) / 15 + 1 }, (_, index) => low + index * 15)
    .filter((value) => value <= high)
    .map((value) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" stroke="#d7dde2"/><text x="${margin.left - 14}" y="${y(value) + 5}" text-anchor="end" fill="#56616d" font-size="20">${value}m</text>`)
    .join("");
  const hourTicks = Array.from({ length: 7 }, (_, index) => index * 4).map((hour) => {
    const tickX = margin.left + hour / 24 * plotWidth;
    const label = hour === 0 || hour === 24 ? "12am" : hour === 12 ? "12pm" : `${hour % 12} ${hour < 12 ? "am" : "pm"}`;
    return `<line x1="${tickX}" x2="${tickX}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#e4e8ec"/><text x="${tickX}" y="${height - 24}" text-anchor="middle" fill="#56616d" font-size="18">${label}</text>`;
  }).join("");
  const pointMarker = (key, color, radius) => {
    const latest = plotted.slice().reverse().find((row) => Number.isFinite(row[key]));
    if (!latest) return "";
    const markerY = y(latest[key]);
    if (markerY < margin.top || markerY > height - margin.bottom) return "";
    return `<circle cx="${x(latest)}" cy="${markerY}" r="${radius}" fill="#ffffff" stroke="${color}" stroke-width="4"/>`;
  };
  const dots = [
    pointMarker("oursMid", "#d0008f", 6),
    pointMarker("checkpointMid", "#64748b", 4),
  ].join("");
  const legendX = margin.left + 18;
  const legendY = margin.top + 18;
  const legendItem = (x, y, label, color, dash = "") => `
    <line x1="${x}" x2="${x + 22}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="5" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>
    <text x="${x + 32}" y="${y + 6}" fill="#23303b" font-size="18">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="${margin.left}" y="42" fill="#111827" font-size="34" font-family="Arial, sans-serif" font-weight="700">${route.label}</text>
    <text x="${margin.left}" y="72" fill="#52606d" font-size="20" font-family="Arial, sans-serif">Crossborder vs Checkpoint.sg · ${singaporeDate}</text>
    ${grids}
    ${hourTicks}
    <path d="${line("oursMid")}" fill="none" stroke="#d0008f" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${line("checkpointMid")}" fill="none" stroke="#64748b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="12 10"/>
    ${dots}
    <rect x="${legendX - 12}" y="${legendY - 18}" width="320" height="58" rx="10" fill="#ffffff" fill-opacity="0.9"/>
    ${legendItem(legendX, legendY, "Crossborder", "#d0008f")}
    ${legendItem(legendX + 160, legendY, "Checkpoint.sg", "#64748b", "8 6")}
  </svg>`;
}

await mkdir(captureRoot, { recursive: true });
const mi6Status = await readJson(mi6StatusPath);
const mi6StatusIsCurrent = mi6Status?.checkedAt
  && Date.now() - new Date(mi6Status.checkedAt).getTime() <= 30 * 60 * 1000;
const mi6Log = mi6StatusIsCurrent
  ? mi6Status.mi6Log
  : "Mi6 status was not recorded during this hourly run.";
const chartDryRun = process.env.CHART_DRY_RUN === "1";
let records = [];
try {
  records = await loadWorkerCheckpointCaptures();
  console.log(`Loaded ${records.length} Checkpoint.sg capture(s) from the Worker feed.`);
} catch (error) {
  records = await readJson(join(captureRoot, "latest-summary.json")) ?? [];
  console.warn(`Mi6 Worker capture refresh failed; using local capture cache: ${error.message}`);
}
try {
  const sheetRecords = await loadCheckpointSheetRecords();
  records = mergeCheckpointRecords(records, sheetRecords);
  console.log(`Merged Checkpoint.sg sheet; ${records.length} unique 15-minute slot(s).`);
} catch (error) {
  console.warn(`Checkpoint.sg sheet merge skipped: ${error.message}`);
}
const checkpoint = records.slice().reverse().find((record) => (
  record.app === "Checkpoint.sg"
  && record.captureStatus !== "failed"
  && Number.isFinite(new Date(record.capturedAt).getTime())
  && Date.now() - new Date(record.capturedAt).getTime() <= checkpointMaxAgeMs
  && plausibleRange(record.normalizedReadings?.woodlands?.towardsJb)
  && plausibleRange(record.normalizedReadings?.woodlands?.towardsSg)
)) ?? null;
const capturedAt = new Date().toISOString();
const checkpointSource = checkpoint?.source
  ?? (mi6StatusIsCurrent && mi6Status.fallbackRequired ? "android-emulator"
    : mi6StatusIsCurrent && mi6Status.ok ? "mi6-macrodroid"
      : "unavailable");
const sources = {};
for (const source of timingSources) {
  try {
    sources[source.id] = await loadTimingSource(source);
    if (source.id === "ours") await writeFile(sharedTimingsSnapshotPath, `${JSON.stringify(sources.ours, null, 2)}\n`);
  } catch (error) {
    sources[source.id] = source.id === "ours" ? await readJson(sharedTimingsSnapshotPath) : null;
    if (source.id === "ours" && !sources.ours) throw error;
    console.warn(`${source.label} refresh failed${sources[source.id] ? "; using cached reading" : "; omitting this comparison"}: ${error.message}`);
  }
}
const lastValidRows = await lastValidCrossBorderRows();
const rows = [];
for (const route of routeSets) {
  const lastValid = lastValidRows.get(route.label);
  const oursRange = sourceRange(route, sources.ours) ?? (
    Number(lastValid?.oursLow) > 0 && Number(lastValid?.oursHigh) > 0
      ? [Number(lastValid.oursLow), Number(lastValid.oursHigh)]
      : null
  );
  if (!oursRange) throw new Error(`Crossborder sheet is missing a complete positive ${route.label} reading`);
  const checkpointRange = plausibleRange(checkpoint?.normalizedReadings?.woodlands?.[route.directionKey]);
  rows.push({
    capturedAt,
    label: route.label,
    directionKey: route.directionKey,
    routeCount: route.routes.length,
    routeDataCapturedAt: sourceRange(route, sources.ours) ? sources.ours.capturedAt : lastValid.capturedAt,
    oursLow: oursRange[0],
    oursHigh: oursRange[1],
    oursMid: midpoint(oursRange),
    checkpointLow: checkpointRange?.[0] ?? null,
    checkpointHigh: checkpointRange?.[1] ?? null,
    checkpointMid: midpoint(checkpointRange),
    tomtomLow: null,
    tomtomHigh: null,
    tomtomMid: null,
    mapboxLow: null,
    mapboxHigh: null,
    mapboxMid: null,
  });
}
const history = await readCsv(historyPath);
const historyLines = rows.map((row) => [
  row.capturedAt, row.label, row.oursLow, row.oursHigh, row.oursMid,
  row.checkpointLow ?? "", row.checkpointHigh ?? "", row.checkpointMid ?? "",
  row.tomtomLow ?? "", row.tomtomHigh ?? "", row.tomtomMid ?? "",
  row.mapboxLow ?? "", row.mapboxHigh ?? "", row.mapboxMid ?? "",
].join(","));
if (!chartDryRun) {
  try { await access(historyPath); } catch { await writeFile(historyPath, "capturedAt,label,oursLow,oursHigh,oursMid,checkpointLow,checkpointHigh,checkpointMid,tomtomLow,tomtomHigh,tomtomMid,mapboxLow,mapboxHigh,mapboxMid\n"); }
  await appendFile(historyPath, `${historyLines.join("\n")}\n`);
}
await writeFile(join(captureRoot, "latest-v3-checkpoint-variance.json"), `${JSON.stringify({
  capturedAt,
  checkpointSource,
  mi6Log,
  rows,
}, null, 2)}\n`);
if (!chartDryRun) {
  try {
    await appendCheckpointSheetRow(rows, checkpointSource, mi6Log, checkpoint?.capturedAt ?? capturedAt);
  } catch (error) {
    console.warn(`Checkpoint.sg sheet append failed: ${error instanceof Error ? error.message : error}`);
  }
} else {
  console.log("Chart dry run: skipped history and Checkpoint.sg sheet append.");
}
const routeReports = [];
for (const route of rows) {
  const routeDefinition = routeSets.find((item) => item.label === route.label);
  if (!routeDefinition) throw new Error(`Missing route definition for ${route.label}`);
  const reportDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(route.capturedAt));
  const points = buildQuarterDayPoints(routeDefinition, sources, records, reportDate);
  const oursHistory = points.filter((point) => Number.isFinite(point.oursMid));
  const previousOursMid = oursHistory.length >= 2 ? oursHistory.at(-2).oursMid : null;
  const png = await sharp(Buffer.from(chartSvg(route, points))).png().toBuffer();
  await writeFile(join(captureRoot, `latest-${route.directionKey}-hourly-chart.png`), png);
  routeReports.push({
    label: route.label,
    filename: `${route.label.toLowerCase().replaceAll(" ", "-")}.png`,
    png,
    oursMid: route.oursMid,
    checkpointMid: route.checkpointMid,
    previousOursMid,
  });
}

if (chartDryRun) {
  console.log("Chart dry run: skipped Telegram send.");
} else {
  for (const report of routeReports) {
    await sendPhoto(report.png, report.filename, shortDirection(report.label));
  }
  await sendMessage(buildHourlyInsight(routeReports, checkpointSource));
}
