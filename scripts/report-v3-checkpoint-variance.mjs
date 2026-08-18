import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const calibrationConfig = JSON.parse(await readFile(join(repoRoot, "config", "crossing-calibration.json"), "utf8"));
const captureRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const telegramDisabled = process.env.TELEGRAM_DISABLED === "1" || process.env.TELEGRAM_DISABLED === "true";
const telegramSender = process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local-launchd";
const sheetId = "1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo";
const timingSources = [
  {
    id: "ours",
    label: "CrossBorder (Google Maps)",
    url: process.env.SHARED_TIMINGS_SHEET_URL || `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=0`,
    suffix: "",
  },
  {
    id: "tomtom",
    label: "TomTom",
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=281973384`,
    suffix: " (live)",
  },
  {
    id: "mapbox",
    label: "Mapbox",
    url: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=14569418`,
    suffix: " (live)",
  },
];
const historyPath = join(captureRoot, "v3-four-source-history.csv");
const legacyHistoryPath = join(captureRoot, "v3-crossborder-sheet-history.csv");
const sharedTimingsSnapshotPath = join(captureRoot, "v3-gmaps-timings-cache.json");
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
      { id: "A", sourceColumn: "SG-JB A | BKE Flyover", origin: { latitude: 1.439328, longitude: 103.768422 } },
      { id: "B", sourceColumn: "SG-JB B | BKE Junction", origin: { latitude: 1.439356, longitude: 103.768285 } },
      { id: "C", sourceColumn: "SG-JB C | Woodlands Rd", origin: { latitude: 1.440516, longitude: 103.768108 } },
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
    if (!Number.isFinite(report.checkpointMid)) return `${name}  ${ours}  ·  no Checkpoint`;
    const gap = gapVsCheckpoint(report.oursMid, report.checkpointMid);
    const match = Math.abs(gap) <= 8 ? "match" : `${signedMinutes(gap)} vs CP`;
    return `${name}  ${ours}  ·  CP ${formatMinutes(report.checkpointMid)}  ·  ${match}`;
  });

  const takeaways = [];
  if (checkpointSource === "android-emulator") {
    takeaways.push("Grey line is emulator — treat it as a stand-in.");
  } else if (checkpointSource !== "mi6-macrodroid") {
    takeaways.push("No fresh Checkpoint this hour.");
  }

  for (const report of routeReports) {
    const name = shortDirection(report.label);
    const gap = gapVsCheckpoint(report.oursMid, report.checkpointMid);
    if (gap !== null && gap <= -12) {
      takeaways.push(`${name} we are ${Math.abs(gap)}m under Checkpoint — we may be starting before their queue line.`);
    } else if (gap !== null && gap >= 12) {
      takeaways.push(`${name} we are ${gap}m over Checkpoint — check whether we are too conservative.`);
    }
    const move = describeMovement(report.oursMid, report.previousOursMid);
    if (move) takeaways.push(`${name} ${move} since the last chart.`);
  }

  if (!takeaways.length) {
    takeaways.push("Both sides sit with Checkpoint. Nothing to change.");
  }

  return [`${stamp}  ·  ${sourceNote}`, "", ...lines, "", takeaways[0]].join("\n");
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
    return { capturedAt, readings };
  }).filter((record) => record.capturedAt && requiredColumns.every((column) => (
    Number.isFinite(record.readings[column]) && record.readings[column] > 0
  )));
  const latest = records.at(-1);
  if (!latest) throw new Error(`${source.label} sheet has no complete positive route reading`);
  return { ...source, ...latest, records };
}

function sourceRange(route, source) {
  if (!source) return null;
  const values = route.routes
    .map((item) => source.readings[`${item.sourceColumn}${source.suffix}`])
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length === route.routes.length ? [Math.min(...values), Math.max(...values)] : null;
}

function sourcePoint(route, source, record) {
  if (!record?.readings || !record.capturedAt) return null;
  const range = sourceRange(route, { ...source, ...record });
  if (!range) return null;
  const point = { capturedAt: record.capturedAt, label: route.label };
  if (source.id === "ours") {
    point.oursLow = range[0];
    point.oursHigh = range[1];
    point.oursMid = midpoint(range);
  } else {
    point[`${source.id}Low`] = range[0];
    point[`${source.id}High`] = range[1];
    point[`${source.id}Mid`] = midpoint(range);
  }
  return point;
}

function sourceAverage(route, source, record) {
  if (!record?.readings) return null;
  const values = route.routes
    .map((item) => record.readings[`${item.sourceColumn}${source.suffix}`])
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length === route.routes.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function quarterBucket(timestamp) {
  const time = new Date(timestamp).getTime();
  return Number.isFinite(time) ? Math.floor(time / 900_000) * 900_000 : null;
}

function roundToFive(value) {
  return Math.max(calibrationConfig.minimumMinutes, Math.round(value / 5) * 5);
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildShadowPoints(route, googleSource, checkpointRecords) {
  if (!googleSource?.records?.length) return [];
  const googleByQuarter = new Map();
  const checkpointByQuarter = new Map();

  const keepClosestToQuarter = (map, bucket, candidate) => {
    const existing = map.get(bucket);
    const distance = Math.abs(new Date(candidate.capturedAt).getTime() - bucket);
    const existingDistance = existing
      ? Math.abs(new Date(existing.capturedAt).getTime() - bucket)
      : Number.POSITIVE_INFINITY;
    if (distance < existingDistance) map.set(bucket, candidate);
  };

  for (const record of googleSource.records) {
    const bucket = quarterBucket(record.capturedAt);
    const googleMid = sourceAverage(route, googleSource, record);
    if (bucket === null || !Number.isFinite(googleMid)) continue;
    keepClosestToQuarter(googleByQuarter, bucket, { capturedAt: record.capturedAt, googleMid });
  }
  for (const record of checkpointRecords) {
    const bucket = quarterBucket(record.capturedAt);
    const range = plausibleRange(record.normalizedReadings?.woodlands?.[route.directionKey]);
    if (bucket === null || !range) continue;
    keepClosestToQuarter(checkpointByQuarter, bucket, {
      capturedAt: record.capturedAt,
      checkpointMid: midpoint(range),
    });
  }

  const direction = route.directionKey === "towardsJb" ? "sg-my" : "my-sg";
  const settings = calibrationConfig.directions[direction];
  let learnedBias = 0;
  let lastCheckpointHour = null;

  return [...googleByQuarter.entries()].sort(([left], [right]) => left - right).map(([bucket, google]) => {
    const checkpoint = checkpointByQuarter.get(bucket);
    const hoursSinceCheckpoint = lastCheckpointHour === null
      ? Number.POSITIVE_INFINITY
      : (bucket - lastCheckpointHour) / 3_600_000;
    const decay = hoursSinceCheckpoint <= calibrationConfig.biasHoldHours
      ? 1
      : 0.5 ** (
        (hoursSinceCheckpoint - calibrationConfig.biasHoldHours) / calibrationConfig.biasHalfLifeHours
      );
    const effectiveBias = lastCheckpointHour === null ? 0 : learnedBias * decay;
    const base = settings.intercept + settings.slope * google.googleMid;
    const shadowMid = Math.round(Math.max(
      calibrationConfig.minimumMinutes,
      Math.min(calibrationConfig.maximumMinutes, base + effectiveBias + calibrationConfig.displayOffsetMinutes),
    ));

    // Update after emitting this hour so the shadow line never learns from its target point.
    if (checkpoint) {
      const residual = checkpoint.checkpointMid - base;
      learnedBias = settings.alpha * residual + (1 - settings.alpha) * effectiveBias;
      lastCheckpointHour = bucket;
    }

    return {
      capturedAt: google.capturedAt,
      label: route.label,
      shadowLow: roundToFive(shadowMid * calibrationConfig.rangeLowFactor),
      shadowHigh: roundToFive(shadowMid * calibrationConfig.rangeHighFactor),
      shadowMid,
    };
  });
}

function inSingaporeDate(timestamp, date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(timestamp)) === date;
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

function chartSvg(route, rows) {
  const width = 1120;
  const height = 620;
  const margin = { top: 94, right: 60, bottom: 70, left: 76 };
  const palette = route.directionKey === "towardsJb"
    ? { main: "#15803d", fill: "#15803d", label: "Singapore to JB" }
    : { main: "#2563eb", fill: "#2563eb", label: "JB to Singapore" };
  const comparisonSeries = [
    { key: "checkpoint", label: "Checkpoint.sg", color: "#64748b", dash: "12 10" },
    { key: "tomtom", label: "TomTom", color: "#d97706", dash: "10 7" },
    { key: "mapbox", label: "Mapbox", color: "#9333ea", dash: "3 9" },
  ];
  const values = rows.flatMap((row) => [
    row.oursLow, row.oursHigh, row.shadowMid,
    ...comparisonSeries.flatMap((series) => [row[`${series.key}Low`], row[`${series.key}High`]]),
  ]).filter(Number.isFinite);
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
  const line = (key) => {
    let previousWasPoint = false;
    return rows.map((row) => {
      if (!Number.isFinite(row[key])) {
        return "";
      }
      const command = previousWasPoint ? "L" : "M";
      previousWasPoint = true;
      return `${command}${x(row).toFixed(1)},${y(row[key]).toFixed(1)}`;
    }).filter(Boolean).join(" ");
  };
  const oursPoints = rows.filter((row) => Number.isFinite(row.oursLow) && Number.isFinite(row.oursHigh));
  const area = oursPoints.length < 2 ? "" : `${line("oursLow")} ${oursPoints.slice().reverse().map((row) => `L${x(row).toFixed(1)},${y(row.oursHigh).toFixed(1)}`).join(" ")} Z`;
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
    const latest = rows.slice().reverse().find((row) => Number.isFinite(row[key]));
    if (!latest) return "";
    const markerY = y(latest[key]);
    if (markerY < margin.top || markerY > height - margin.bottom) return "";
    return `<circle cx="${x(latest)}" cy="${markerY}" r="${radius}" fill="#ffffff" stroke="${color}" stroke-width="4"/>`;
  };
  const dots = [
    pointMarker("oursMid", palette.main, 6),
    pointMarker("shadowMid", "#d0008f", 6),
    ...comparisonSeries.map((series) => pointMarker(`${series.key}Mid`, series.color, 4)),
  ].join("");
  const legendX = margin.left + 18;
  const legendY = margin.top + 18;
  const legendItem = (x, y, label, color, dash = "") => `
    <line x1="${x}" x2="${x + 22}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="5" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""}/>
    <text x="${x + 32}" y="${y + 6}" fill="#23303b" font-size="18">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="${margin.left}" y="42" fill="#111827" font-size="34" font-family="Arial, sans-serif" font-weight="700">${route.label}</text>
    <text x="${margin.left}" y="72" fill="#52606d" font-size="20" font-family="Arial, sans-serif">15-minute route-time range, shadow calibration and comparisons · ${singaporeDate}</text>
    ${grids}
    ${hourTicks}
    <path d="${area}" fill="${palette.fill}" fill-opacity="0.14"/>
    <path d="${line("oursMid")}" fill="none" stroke="${palette.main}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    ${comparisonSeries.map((series) => `<path d="${line(`${series.key}Mid`)}" fill="none" stroke="${series.color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${series.dash}"/>`).join("")}
    <path d="${line("shadowMid")}" fill="none" stroke="#d0008f" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <rect x="${legendX - 12}" y="${legendY - 18}" width="446" height="88" rx="10" fill="#ffffff" fill-opacity="0.9"/>
    ${legendItem(legendX, legendY, "CrossBorder", palette.main)}
    ${legendItem(legendX + 202, legendY, "Shadow fit", "#d0008f")}
    ${legendItem(legendX, legendY + 28, "Checkpoint", "#64748b", "8 6")}
    ${legendItem(legendX + 202, legendY + 28, "TomTom", "#d97706", "8 6")}
    ${legendItem(legendX, legendY + 56, "Mapbox", "#9333ea", "3 8")}
  </svg>`;
}

await mkdir(captureRoot, { recursive: true });
const mi6Status = await readJson(mi6StatusPath);
const mi6StatusIsCurrent = mi6Status?.checkedAt
  && Date.now() - new Date(mi6Status.checkedAt).getTime() <= 30 * 60 * 1000;
const mi6Log = mi6StatusIsCurrent
  ? mi6Status.mi6Log
  : "Mi6 status was not recorded during this hourly run.";
let records = [];
try {
  records = await loadWorkerCheckpointCaptures();
  console.log(`Loaded ${records.length} Checkpoint.sg capture(s) from the Worker feed.`);
} catch (error) {
  records = await readJson(join(captureRoot, "latest-summary.json")) ?? [];
  console.warn(`Mi6 Worker capture refresh failed; using local capture cache: ${error.message}`);
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
  if (!oursRange) throw new Error(`CrossBorder timing sheet is missing a complete positive ${route.label} reading`);
  const checkpointRange = plausibleRange(checkpoint?.normalizedReadings?.woodlands?.[route.directionKey]);
  const tomtomRange = sourceRange(route, sources.tomtom);
  const mapboxRange = sourceRange(route, sources.mapbox);
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
    tomtomLow: tomtomRange?.[0] ?? null,
    tomtomHigh: tomtomRange?.[1] ?? null,
    tomtomMid: midpoint(tomtomRange),
    mapboxLow: mapboxRange?.[0] ?? null,
    mapboxHigh: mapboxRange?.[1] ?? null,
    mapboxMid: midpoint(mapboxRange),
  });
}
const history = await readCsv(historyPath);
const legacyHistory = await readCsv(legacyHistoryPath);
const historyLines = rows.map((row) => [
  row.capturedAt, row.label, row.oursLow, row.oursHigh, row.oursMid,
  row.checkpointLow ?? "", row.checkpointHigh ?? "", row.checkpointMid ?? "",
  row.tomtomLow ?? "", row.tomtomHigh ?? "", row.tomtomMid ?? "",
  row.mapboxLow ?? "", row.mapboxHigh ?? "", row.mapboxMid ?? "",
].join(","));
try { await access(historyPath); } catch { await writeFile(historyPath, "capturedAt,label,oursLow,oursHigh,oursMid,checkpointLow,checkpointHigh,checkpointMid,tomtomLow,tomtomHigh,tomtomMid,mapboxLow,mapboxHigh,mapboxMid\n"); }
await appendFile(historyPath, `${historyLines.join("\n")}\n`);
await writeFile(join(captureRoot, "latest-v3-checkpoint-variance.json"), `${JSON.stringify({
  capturedAt,
  checkpointSource,
  mi6Log,
  rows,
}, null, 2)}\n`);
try {
  await appendCheckpointSheetRow(rows, checkpointSource, mi6Log, checkpoint?.capturedAt ?? capturedAt);
} catch (error) {
  console.warn(`Checkpoint.sg sheet append failed: ${error instanceof Error ? error.message : error}`);
}
const routeReports = [];
for (const route of rows) {
  const routeDefinition = routeSets.find((item) => item.label === route.label);
  if (!routeDefinition) throw new Error(`Missing route definition for ${route.label}`);
  const reportDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(route.capturedAt));
  const sheetPoints = timingSources.flatMap((source) => (sources[source.id]?.records ?? [])
    .filter((record) => inSingaporeDate(record.capturedAt, reportDate))
    .map((record) => sourcePoint(routeDefinition, source, record))
    .filter(Boolean));
  const shadowPoints = buildShadowPoints(routeDefinition, sources.ours, records)
    .filter((point) => inSingaporeDate(point.capturedAt, reportDate));
  const checkpointHistoryPoints = legacyHistory.filter((row) => (
    row.label === route.label && inSingaporeDate(row.capturedAt, reportDate)
  )).map((row) => ({
    capturedAt: row.capturedAt,
    label: row.label,
    checkpointLow: row.checkpointLow,
    checkpointHigh: row.checkpointHigh,
  }));
  const mi6CheckpointPoints = records.map((record) => {
    const range = plausibleRange(record.normalizedReadings?.woodlands?.[routeDefinition.directionKey]);
    if (!range || !inSingaporeDate(record.capturedAt, reportDate)) return null;
    return {
      capturedAt: record.capturedAt,
      label: route.label,
      checkpointLow: range[0],
      checkpointHigh: range[1],
    };
  }).filter(Boolean);
  const points = [...sheetPoints, ...shadowPoints, ...checkpointHistoryPoints, ...mi6CheckpointPoints, ...history, ...rows]
    .filter((row) => row.label === route.label && inSingaporeDate(row.capturedAt, reportDate)).map((row) => {
    const checkpointRange = plausibleRange([row.checkpointLow, row.checkpointHigh]);
    const tomtomRange = plausibleRange([row.tomtomLow, row.tomtomHigh]);
    const mapboxRange = plausibleRange([row.mapboxLow, row.mapboxHigh]);
    return {
      ...row,
      oursLow: Number(row.oursLow), oursHigh: Number(row.oursHigh), oursMid: Number(row.oursMid),
      shadowLow: optionalNumber(row.shadowLow),
      shadowHigh: optionalNumber(row.shadowHigh),
      shadowMid: optionalNumber(row.shadowMid),
      checkpointLow: checkpointRange?.[0] ?? null,
      checkpointHigh: checkpointRange?.[1] ?? null,
      checkpointMid: midpoint(checkpointRange),
      tomtomLow: tomtomRange?.[0] ?? null,
      tomtomHigh: tomtomRange?.[1] ?? null,
      tomtomMid: midpoint(tomtomRange),
      mapboxLow: mapboxRange?.[0] ?? null,
      mapboxHigh: mapboxRange?.[1] ?? null,
      mapboxMid: midpoint(mapboxRange),
    };
  }).filter((row) => (
    Number.isFinite(row.oursMid)
    || Number.isFinite(row.shadowMid)
    || Number.isFinite(row.checkpointMid)
    || Number.isFinite(row.tomtomMid)
    || Number.isFinite(row.mapboxMid)
  )).sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
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

for (const report of routeReports) {
  await sendPhoto(report.png, report.filename, shortDirection(report.label));
}
await sendMessage(buildHourlyInsight(routeReports, checkpointSource));
