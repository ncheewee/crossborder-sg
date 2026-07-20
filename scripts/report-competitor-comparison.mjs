import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const API_BASE = process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_ROUTES_API_KEY = process.env.GOOGLE_ROUTES_API_KEY;
const MONITOR_API_KEY = process.env.MONITOR_API_KEY;
const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const useGoogleRoutesApi = process.env.USE_GOOGLE_ROUTES_API === "true";
const outRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const graphRoot = join(outRoot, "report-graphs");
const accuracyHorizons = (process.env.ACCURACY_HORIZONS_MINUTES || "60,180")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const accuracyToleranceMinutes = Number(process.env.ACCURACY_TARGET_TOLERANCE_MINUTES || 45);
const competitorMaxAgeMinutes = Number(process.env.COMPETITOR_MAX_AGE_MINUTES || 90);

const routeEndpoints = {
  woodlands: {
    display: "Woodlands",
    sg: { latitude: 1.4456, longitude: 103.7683 },
    my: { latitude: 1.4599, longitude: 103.7649 },
  },
  tuas: {
    display: "Tuas",
    sg: { latitude: 1.3478, longitude: 103.6376 },
    my: { latitude: 1.3618, longitude: 103.6194 },
  },
};

const approachRoutes = [
  {
    id: "wl-sg-bke",
    checkpoint: "woodlands",
    displayCheckpoint: "Woodlands",
    directionKey: "towardsJb",
    apiDirection: "sg-my",
    label: "BKE / Woodlands Crossing",
    origin: { latitude: 1.4377, longitude: 103.7750 },
    destination: { latitude: 1.4599, longitude: 103.7649 },
    cameraCheckpoint: "Woodlands",
  },
  {
    id: "wl-sg-ave3",
    checkpoint: "woodlands",
    displayCheckpoint: "Woodlands",
    directionKey: "towardsJb",
    apiDirection: "sg-my",
    label: "Woodlands Ave 3",
    origin: { latitude: 1.4365, longitude: 103.7858 },
    destination: { latitude: 1.4599, longitude: 103.7649 },
    cameraCheckpoint: "Woodlands",
  },
  {
    id: "wl-sg-woodlands-rd",
    checkpoint: "woodlands",
    displayCheckpoint: "Woodlands",
    directionKey: "towardsJb",
    apiDirection: "sg-my",
    label: "Woodlands Road / Kranji",
    origin: { latitude: 1.4260, longitude: 103.7595 },
    destination: { latitude: 1.4599, longitude: 103.7649 },
    cameraCheckpoint: "Woodlands",
  },
  {
    id: "wl-my-inner-ring",
    checkpoint: "woodlands",
    displayCheckpoint: "Woodlands",
    directionKey: "towardsSg",
    apiDirection: "my-sg",
    label: "JB Inner Ring / Route 188",
    origin: { latitude: 1.4657, longitude: 103.7616 },
    destination: { latitude: 1.4456, longitude: 103.7683 },
    cameraCheckpoint: "Woodlands",
  },
  {
    id: "wl-my-wong-ah-fook",
    checkpoint: "woodlands",
    displayCheckpoint: "Woodlands",
    directionKey: "towardsSg",
    apiDirection: "my-sg",
    label: "Jalan Wong Ah Fook",
    origin: { latitude: 1.4589, longitude: 103.7645 },
    destination: { latitude: 1.4456, longitude: 103.7683 },
    cameraCheckpoint: "Woodlands",
  },
  {
    id: "wl-my-tun-abdul-razak",
    checkpoint: "woodlands",
    displayCheckpoint: "Woodlands",
    directionKey: "towardsSg",
    apiDirection: "my-sg",
    label: "Jalan Tun Abdul Razak",
    origin: { latitude: 1.4691, longitude: 103.7594 },
    destination: { latitude: 1.4456, longitude: 103.7683 },
    cameraCheckpoint: "Woodlands",
  },
];

const directionMap = {
  towardsJb: { apiDirection: "sg-my", label: "Towards JB" },
  towardsSg: { apiDirection: "my-sg", label: "Towards SG" },
};

function midpoint(range) {
  return Array.isArray(range) ? Math.round((Number(range[0]) + Number(range[1])) / 2) : null;
}

function formatMinutes(value) {
  return Number.isFinite(value) ? `${Math.round(value)}m` : "n/a";
}

function deltaText(delta) {
  if (!Number.isFinite(delta)) return "n/a";
  return `${delta >= 0 ? "+" : ""}${Math.round(delta)}m`;
}

function severity(delta) {
  if (!Number.isFinite(delta)) return "NA";
  const value = Math.abs(delta);
  if (value <= 10) return "OK";
  if (value <= 25) return "WATCH";
  return "GAP";
}

function parseDurationMinutes(duration) {
  const match = typeof duration === "string" ? duration.match(/^([\d.]+)s$/) : null;
  return match ? Math.round(Number(match[1]) / 60) : null;
}

function routeBody(checkpoint, apiDirection, route = null) {
  const endpoints = routeEndpoints[checkpoint];
  const origin = route?.origin ?? (apiDirection === "sg-my" ? endpoints.sg : endpoints.my);
  const destination = route?.destination ?? (apiDirection === "sg-my" ? endpoints.my : endpoints.sg);
  return {
    origin: { location: { latLng: origin } },
    destination: { location: { latLng: destination } },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
  };
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const headers = { Accept: "application/json" };
      if (MONITOR_API_KEY) headers["X-Monitor-Key"] = MONITOR_API_KEY;
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2500));
    }
  }
  throw lastError;
}

const fetchWarnings = [];

async function fetchLiveTraffic(apiDirection) {
  try {
    return await fetchJson(`${API_BASE}/api/traffic?direction=${apiDirection}`);
  } catch (error) {
    fetchWarnings.push(`${apiDirection}: ${error instanceof Error ? error.message : "traffic API unavailable"}`);
    return null;
  }
}

async function googleRouteMinutes(checkpoint, apiDirection) {
  if (!useGoogleRoutesApi || !GOOGLE_ROUTES_API_KEY) return null;
  const response = await fetch(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_ROUTES_API_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.staticDuration",
    },
    body: JSON.stringify(routeBody(checkpoint, apiDirection)),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Routes ${checkpoint} ${apiDirection} failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  return parseDurationMinutes(payload.routes?.[0]?.duration);
}

async function googleApproachRoute(route) {
  if (!useGoogleRoutesApi || !GOOGLE_ROUTES_API_KEY) return null;
  const response = await fetch(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_ROUTES_API_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.description",
    },
    body: JSON.stringify(routeBody(route.checkpoint, route.apiDirection, route)),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google approach ${route.id} failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  const best = payload.routes?.[0];
  return {
    trafficMinutes: parseDurationMinutes(best?.duration),
    staticMinutes: parseDurationMinutes(best?.staticDuration),
    distanceMeters: Number.isFinite(best?.distanceMeters) ? best.distanceMeters : null,
    description: typeof best?.description === "string" ? best.description : "",
  };
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(text);
    console.log("\nTelegram not sent: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing.");
    return;
  }

  const maxLength = 3600;
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  for (const [index, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `(${index + 1}/${chunks.length}) ` : "";
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `${prefix}${chunk}`,
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram send failed: ${response.status} ${body}`);
    }
  }
}

async function sendTelegramPhoto(buffer, filename, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`\nTelegram photo not sent: ${filename}`);
    console.log(caption);
    return;
  }

  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption.slice(0, 1000));
  form.append("photo", new Blob([new Uint8Array(buffer)], { type: "image/png" }), filename);

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram photo send failed: ${response.status} ${body}`);
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\"" && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

async function readCsvRows(fileName) {
  try {
    return parseCsv(await readFile(join(outRoot, fileName), "utf8"));
  } catch {
    return [];
  }
}

function toNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function appendBenchmarkHistory(rows) {
  const csvPath = join(outRoot, "benchmark-history.csv");
  let exists = true;
  try {
    await access(csvPath);
  } catch {
    exists = false;
  }
  const header = "capturedAt,checkpoint,direction,source,lower,upper,midpoint,deltaVsOurs,severity\n";
  const lines = rows.map((row) => [
    row.capturedAt,
    row.checkpoint,
    row.direction,
    row.source,
    row.lower,
    row.upper,
    row.midpoint,
    row.deltaVsOurs,
    row.severity,
  ].map(csvEscape).join(","));
  if (exists) {
    await appendFile(csvPath, `${lines.join("\n")}\n`);
  } else {
    await writeFile(csvPath, `${header}${lines.join("\n")}\n`);
  }
}

async function appendApproachHistory(rows) {
  if (!rows.length) return;
  const csvPath = join(outRoot, "approach-history.csv");
  let exists = true;
  try {
    await access(csvPath);
  } catch {
    exists = false;
  }
  const header = [
    "capturedAt",
    "checkpoint",
    "direction",
    "source",
    "approachId",
    "approachLabel",
    "trafficMinutes",
    "staticMinutes",
    "trafficLiftMinutes",
    "distanceMeters",
    "cameraAgeMinutes",
    "cameraConfidence",
    "confidence",
    "rank",
    "deltaVsBest",
    "description",
  ].join(",");
  const lines = rows.map((row) => [
    row.capturedAt,
    row.checkpoint,
    row.direction,
    row.source,
    row.approachId,
    row.approachLabel,
    row.trafficMinutes,
    row.staticMinutes,
    row.trafficLiftMinutes,
    row.distanceMeters,
    row.cameraAgeMinutes,
    row.cameraConfidence,
    row.confidence,
    row.rank,
    row.deltaVsBest,
    row.description,
  ].map(csvEscape).join(","));
  if (exists) {
    await appendFile(csvPath, `${lines.join("\n")}\n`);
  } else {
    await writeFile(csvPath, `${header}\n${lines.join("\n")}\n`);
  }
}

async function appendAccuracyHistory(rows) {
  if (!rows.length) return;
  const csvPath = join(outRoot, "accuracy-history.csv");
  let exists = true;
  try {
    await access(csvPath);
  } catch {
    exists = false;
  }
  const header = [
    "scoredAt",
    "capturedAt",
    "horizonMinutes",
    "actualAt",
    "checkpoint",
    "direction",
    "source",
    "predicted",
    "actual",
    "error",
    "bias",
    "severity",
  ].join(",");
  const lines = rows.map((row) => [
    row.scoredAt,
    row.capturedAt,
    row.horizonMinutes,
    row.actualAt,
    row.checkpoint,
    row.direction,
    row.source,
    row.predicted,
    row.actual,
    row.error,
    row.bias,
    row.severity,
  ].map(csvEscape).join(","));
  if (exists) {
    await appendFile(csvPath, `${lines.join("\n")}\n`);
  } else {
    await writeFile(csvPath, `${header}\n${lines.join("\n")}\n`);
  }
}

function routeKey(row) {
  return `${row.checkpoint}|${row.direction}`;
}

function accuracyKey(row) {
  return `${row.capturedAt}|${row.horizonMinutes}|${row.checkpoint}|${row.direction}|${row.source}`;
}

function findActualRow(baselineRows, sourceRow, horizonMinutes) {
  const capturedMs = new Date(sourceRow.capturedAt).getTime();
  if (!Number.isFinite(capturedMs)) return null;
  const targetMs = capturedMs + horizonMinutes * 60000;
  if (targetMs > Date.now() - 2 * 60000) return null;

  const routeRows = baselineRows.filter((row) => (
    row.checkpoint === sourceRow.checkpoint
    && row.direction === sourceRow.direction
  ));
  let best = null;
  for (const row of routeRows) {
    const rowMs = new Date(row.capturedAt).getTime();
    if (!Number.isFinite(rowMs)) continue;
    const distanceMinutes = Math.abs(rowMs - targetMs) / 60000;
    if (distanceMinutes > accuracyToleranceMinutes) continue;
    if (!best || distanceMinutes < best.distanceMinutes) {
      best = { ...row, distanceMinutes };
    }
  }
  return best;
}

function buildAccuracyRows(benchmarkRows, existingAccuracyRows, scoredAt) {
  const baselineRows = benchmarkRows
    .filter((row) => row.source === "CrossBorder.sg" && toNumber(row.midpoint) != null)
    .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  const existingKeys = new Set(existingAccuracyRows.map(accuracyKey));
  const rows = [];

  for (const sourceRow of benchmarkRows) {
    const predicted = toNumber(sourceRow.midpoint);
    if (predicted == null) continue;
    for (const horizonMinutes of accuracyHorizons) {
      const actualRow = findActualRow(baselineRows, sourceRow, horizonMinutes);
      if (!actualRow) continue;
      const actual = toNumber(actualRow.midpoint);
      if (actual == null) continue;
      const error = Math.abs(predicted - actual);
      const bias = predicted - actual;
      const row = {
        scoredAt,
        capturedAt: sourceRow.capturedAt,
        horizonMinutes,
        actualAt: actualRow.capturedAt,
        checkpoint: sourceRow.checkpoint,
        direction: sourceRow.direction,
        source: sourceRow.source,
        predicted,
        actual,
        error,
        bias,
        severity: severity(error),
      };
      if (!existingKeys.has(accuracyKey(row))) {
        existingKeys.add(accuracyKey(row));
        rows.push(row);
      }
    }
  }

  return rows;
}

function summarizeAccuracy(rows, sinceMs) {
  const recent = rows
    .filter((row) => {
      const scoredMs = new Date(row.scoredAt || row.capturedAt).getTime();
      return Number.isFinite(scoredMs) && scoredMs >= sinceMs;
    })
    .map((row) => ({
      ...row,
      horizonMinutes: toNumber(row.horizonMinutes),
      error: toNumber(row.error),
      bias: toNumber(row.bias),
    }))
    .filter((row) => row.horizonMinutes != null && row.error != null && row.bias != null);

  const groups = new Map();
  for (const row of recent) {
    const key = `${routeKey(row)}|${row.source}`;
    const current = groups.get(key) || {
      checkpoint: row.checkpoint,
      direction: row.direction,
      source: row.source,
      sampleSize: 0,
      errorTotal: 0,
      biasTotal: 0,
      within15: 0,
      horizons: new Set(),
    };
    current.sampleSize += 1;
    current.errorTotal += row.error;
    current.biasTotal += row.bias;
    if (row.error <= 15) current.within15 += 1;
    current.horizons.add(row.horizonMinutes);
    groups.set(key, current);
  }

  const sourceStats = [...groups.values()].map((group) => ({
    checkpoint: group.checkpoint,
    direction: group.direction,
    source: group.source,
    sampleSize: group.sampleSize,
    mae: Math.round(group.errorTotal / group.sampleSize),
    bias: Math.round(group.biasTotal / group.sampleSize),
    within15Pct: Math.round((group.within15 / group.sampleSize) * 100),
    horizons: [...group.horizons].sort((a, b) => a - b),
  })).sort((a, b) => (
    a.checkpoint.localeCompare(b.checkpoint)
    || a.direction.localeCompare(b.direction)
    || a.mae - b.mae
  ));

  const winners = [];
  const byRoute = new Map();
  for (const stat of sourceStats) {
    const key = routeKey(stat);
    const list = byRoute.get(key) || [];
    list.push(stat);
    byRoute.set(key, list);
  }
  for (const [key, stats] of byRoute) {
    const qualified = stats.filter((stat) => stat.sampleSize >= 3);
    const winner = (qualified.length ? qualified : stats)
      .sort((a, b) => a.mae - b.mae || Math.abs(a.bias) - Math.abs(b.bias))[0];
    if (winner) winners.push({ route: key, ...winner });
  }

  const tuning = sourceStats
    .filter((stat) => stat.source === "CrossBorder.sg" && stat.sampleSize >= 3 && Math.abs(stat.bias) >= 8)
    .map((stat) => {
      const action = stat.bias < 0 ? "raise" : "lower";
      return `${stat.checkpoint} ${stat.direction}: ${action} baseline by ~${Math.abs(stat.bias)}m (${stat.sampleSize} samples)`;
    });

  return { sourceStats, winners, tuning };
}

function singaporeParts(date) {
  const parts = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function singaporeHour(date) {
  return Number(singaporeParts(date).hour);
}

function singaporeDayBounds(date) {
  const parts = singaporeParts(date);
  const startMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 8 * 60 * 60000;
  return {
    startMs,
    endMs: startMs + 24 * 60 * 60000,
  };
}

function formatSingaporeStamp(date) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function routeLabel(checkpoint, direction) {
  return `${checkpoint} ${direction}`;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((total, value) => total + value, 0) / clean.length : null;
}

function sourceMidpoint(row) {
  return toNumber(row.midpoint);
}

function cameraAgeMinutes(livePayload, checkpointDisplay, capturedAt) {
  const updatedAt = livePayload?.checkpoints?.[checkpointDisplay]?.cameraUpdatedAt;
  const updatedMs = new Date(updatedAt).getTime();
  const capturedMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(updatedMs) || !Number.isFinite(capturedMs)) return null;
  return Math.max(0, Math.round((capturedMs - updatedMs) / 60000));
}

function cameraConfidence(ageMinutes) {
  if (!Number.isFinite(ageMinutes)) return "unknown";
  if (ageMinutes <= 7) return "fresh";
  if (ageMinutes <= 15) return "aging";
  return "stale";
}

function approachConfidence(cameraStatus, winnerGapMinutes, trafficLiftMinutes) {
  let score = 0;
  if (cameraStatus === "fresh") score += 2;
  if (cameraStatus === "aging") score += 1;
  if (Number.isFinite(winnerGapMinutes) && winnerGapMinutes >= 5) score += 1;
  if (Number.isFinite(trafficLiftMinutes) && trafficLiftMinutes >= 8) score += 1;
  if (cameraStatus === "stale" || cameraStatus === "unknown") score -= 1;
  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

function summarizeApproachGroup(rows, directionLabel) {
  const usable = rows.filter((row) => Number.isFinite(row.trafficMinutes));
  if (!usable.length) return `${directionLabel}: approach routes pending Google traffic data.`;
  const sorted = [...usable].sort((a, b) => a.trafficMinutes - b.trafficMinutes);
  const best = sorted[0];
  const second = sorted[1] ?? null;
  const gap = Number.isFinite(second?.trafficMinutes) ? second.trafficMinutes - best.trafficMinutes : 0;
  const confidence = approachConfidence(best.cameraConfidence, gap, best.trafficLiftMinutes);
  const alternatives = sorted.slice(1, 3).map((row) => `${row.approachLabel} ${formatMinutes(row.trafficMinutes)}`).join(", ");
  return `${directionLabel}: fastest ${best.approachLabel} at ${formatMinutes(best.trafficMinutes)} (${confidence} confidence, +${Math.max(0, Math.round(gap))}m vs next).${alternatives ? ` Next: ${alternatives}.` : ""}`;
}

function googleMapsApproachRows(records, liveByDirection, capturedAt) {
  const googleMaps = records.find((record) => record.app === "Google Maps");
  const rows = [];
  for (const route of googleMaps?.routes ?? []) {
    if (route.checkpoint !== "Woodlands") continue;
    const direction = directionMap[route.directionKey]?.label;
    if (!direction) continue;
    const live = liveByDirection[route.direction];
    const age = cameraAgeMinutes(live, route.checkpoint, capturedAt);
    const routeCameraConfidence = cameraConfidence(age);
    const text = (route.uiText ?? []).join("\n").replace(/\u00a0/g, " ");
    const matches = [...text.matchAll(/\b(Selected|Alternate) route\s+(\d{1,3})\s+minutes?\s+via\s+([^,\n]+)/gi)];
    const alternatives = matches.length
      ? matches
      : route.minutes
        ? [["", "Selected", String(route.minutes), "Google selected route"]]
        : [];
    for (const [index, match] of alternatives.entries()) {
      const routeKind = String(match[1] ?? "Route");
      const minutes = Number(match[2]);
      const via = String(match[3] ?? "Google route").trim();
      if (!Number.isFinite(minutes)) continue;
      rows.push({
        capturedAt,
        checkpoint: route.checkpoint,
        direction,
        source: "Google Maps emulator",
        approachId: `gm-${route.directionKey}-${index + 1}`,
        approachLabel: via || routeKind,
        trafficMinutes: minutes,
        staticMinutes: null,
        trafficLiftMinutes: null,
        distanceMeters: null,
        cameraAgeMinutes: age,
        cameraConfidence: routeCameraConfidence,
        confidence: "pending",
        rank: "",
        deltaVsBest: "",
        description: routeKind,
      });
    }
  }
  return rows;
}

function rankApproachRows(rows) {
  const byDirection = new Map();
  for (const row of rows) {
    const key = `${row.checkpoint}|${row.direction}`;
    const group = byDirection.get(key) || [];
    group.push(row);
    byDirection.set(key, group);
  }

  for (const group of byDirection.values()) {
    const ranked = group
      .filter((row) => Number.isFinite(row.trafficMinutes))
      .sort((a, b) => a.trafficMinutes - b.trafficMinutes);
    const best = ranked[0] ?? null;
    const second = ranked[1] ?? null;
    const winnerGap = Number.isFinite(second?.trafficMinutes) && Number.isFinite(best?.trafficMinutes)
      ? second.trafficMinutes - best.trafficMinutes
      : 0;
    for (const [index, row] of ranked.entries()) {
      row.rank = index + 1;
      row.deltaVsBest = Number.isFinite(best?.trafficMinutes) ? row.trafficMinutes - best.trafficMinutes : "";
      row.confidence = approachConfidence(row.cameraConfidence, index === 0 ? winnerGap : 0, row.trafficLiftMinutes);
    }
  }

  const summaries = [...byDirection.entries()].map(([key, group]) => {
    const [, direction] = key.split("|");
    return summarizeApproachGroup(group, direction);
  });

  return { rows, summaries };
}

async function buildApproachReport(liveByDirection, competitorRecords, capturedAt) {
  const rows = [];

  if (!useGoogleRoutesApi) {
    fetchWarnings.push("Approach routing: USE_GOOGLE_ROUTES_API is off; using Android Google Maps route alternatives.");
  } else if (!GOOGLE_ROUTES_API_KEY) {
    fetchWarnings.push("Approach routing: GOOGLE_ROUTES_API_KEY missing; using Android Google Maps route alternatives.");
  }

  for (const route of approachRoutes) {
    const live = liveByDirection[route.apiDirection];
    const age = cameraAgeMinutes(live, route.displayCheckpoint, capturedAt);
    const routeCameraConfidence = cameraConfidence(age);
    let google = null;
    try {
      google = await googleApproachRoute(route);
    } catch (error) {
      fetchWarnings.push(`Approach ${route.label}: ${error instanceof Error ? error.message : "Google route unavailable"}`);
    }
    const trafficMinutes = google?.trafficMinutes ?? null;
    const staticMinutes = google?.staticMinutes ?? null;
    const trafficLiftMinutes = Number.isFinite(trafficMinutes) && Number.isFinite(staticMinutes)
      ? trafficMinutes - staticMinutes
      : null;
    const row = {
      capturedAt,
      checkpoint: route.displayCheckpoint,
      direction: directionMap[route.directionKey].label,
      source: "Google Routes",
      approachId: route.id,
      approachLabel: route.label,
      trafficMinutes,
      staticMinutes,
      trafficLiftMinutes,
      distanceMeters: google?.distanceMeters ?? null,
      cameraAgeMinutes: age,
      cameraConfidence: routeCameraConfidence,
      confidence: "pending",
      rank: "",
      deltaVsBest: "",
      description: google?.description ?? "",
    };
    rows.push(row);
  }

  const hasRoutesApiData = rows.some((row) => Number.isFinite(row.trafficMinutes));
  if (hasRoutesApiData) return rankApproachRows(rows);

  const fallbackRows = googleMapsApproachRows(competitorRecords, liveByDirection, capturedAt);
  if (fallbackRows.length) {
    return rankApproachRows(fallbackRows);
  }

  return rankApproachRows(rows);
}

function buildRouteSeries(rows, checkpoint, direction, sinceMs) {
  const routeRows = rows
    .filter((row) => (
      row.checkpoint === checkpoint
      && row.direction === direction
      && new Date(row.capturedAt).getTime() >= sinceMs
    ))
    .sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());

  const byTime = new Map();
  for (const row of routeRows) {
    const capturedMs = new Date(row.capturedAt).getTime();
    if (!Number.isFinite(capturedMs)) continue;
    const current = byTime.get(row.capturedAt) || {
      capturedAt: row.capturedAt,
      capturedMs,
      ours: null,
      google: null,
      checkpointSg: null,
      beatTheJam: null,
      competitorValues: [],
    };
    const value = sourceMidpoint(row);
    if (value == null) continue;
    if (row.source === "CrossBorder.sg") current.ours = value;
    if (row.source === "Google Maps" || row.source === "Google Routes") current.google = value;
    if (row.source === "Checkpoint.sg") {
      current.checkpointSg = value;
      current.competitorValues.push(value);
    }
    if (row.source === "Beat the Jam") {
      current.beatTheJam = value;
      current.competitorValues.push(value);
    }
    byTime.set(row.capturedAt, current);
  }

  return [...byTime.values()]
    .map((point) => ({
      ...point,
      competitor: average(point.competitorValues),
    }))
    .filter((point) => point.ours != null || point.google != null || point.competitor != null)
    .sort((a, b) => a.capturedMs - b.capturedMs);
}

function accuracyForRoute(summary, checkpoint, direction, source) {
  return summary.sourceStats.find((stat) => (
    stat.checkpoint === checkpoint
    && stat.direction === direction
    && stat.source === source
  ));
}

function latestWithValue(points, key) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(points[index][key])) return points[index];
  }
  return null;
}

function currentSourceValue(latestOurs, key) {
  if (!latestOurs || !Number.isFinite(latestOurs[key])) return null;
  return latestOurs[key];
}

function routeTrafficStatus(points, capturedAt) {
  const latestOurs = points.find((point) => point.capturedAt === capturedAt && Number.isFinite(point.ours)) ?? null;
  if (!latestOurs) {
    return {
      level: "pending",
      label: "PENDING",
      color: "#64748b",
      fill: "#e2e8f0",
      summary: "PENDING: no CrossBorder.sg reading",
    };
  }

  const comparisons = [
    { label: "Google", value: currentSourceValue(latestOurs, "google") },
    { label: "Checkpoint.sg", value: currentSourceValue(latestOurs, "checkpointSg") },
    { label: "BTJ", value: currentSourceValue(latestOurs, "beatTheJam") },
  ]
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .map((item) => ({
      ...item,
      pct: Math.abs(latestOurs.ours - item.value) / item.value,
    }));

  if (!comparisons.length) {
    return {
      level: "pending",
      label: "PENDING",
      color: "#64748b",
      fill: "#e2e8f0",
      summary: "PENDING: no external source reading",
    };
  }

  const worst = comparisons.sort((a, b) => b.pct - a.pct)[0];
  if (worst.pct <= 0.1) {
    return {
      level: "green",
      label: "GREEN",
      color: "#0f8a4b",
      fill: "#dff8ea",
      summary: `GREEN: max variance ${Math.round(worst.pct * 100)}% vs ${worst.label}`,
    };
  }
  if (worst.pct <= 0.3) {
    return {
      level: "amber",
      label: "AMBER",
      color: "#b45309",
      fill: "#fff3cf",
      summary: `AMBER: max variance ${Math.round(worst.pct * 100)}% vs ${worst.label}`,
    };
  }
  return {
    level: "red",
    label: "RED",
    color: "#dc2626",
    fill: "#ffe4e1",
    summary: `RED: max variance ${Math.round(worst.pct * 100)}% vs ${worst.label}`,
  };
}

function buildRouteInsight(points, checkpoint, direction, accuracySummary, status, capturedAt) {
  const latestOurs = points.find((point) => point.capturedAt === capturedAt && Number.isFinite(point.ours)) ?? null;
  const latestGoogle = currentSourceValue(latestOurs, "google");
  const latestCheckpointSg = currentSourceValue(latestOurs, "checkpointSg");
  const latestBeatTheJam = currentSourceValue(latestOurs, "beatTheJam");
  const stat = accuracyForRoute(accuracySummary, checkpoint, direction, "CrossBorder.sg");

  if (!latestOurs) return "No CrossBorder.sg line available yet; keep collecting hourly samples.";

  const comparisons = [];
  if (Number.isFinite(latestGoogle)) comparisons.push(`vs Google ${deltaText(latestOurs.ours - latestGoogle)}`);
  if (Number.isFinite(latestCheckpointSg)) comparisons.push(`vs Checkpoint.sg ${deltaText(latestOurs.ours - latestCheckpointSg)}`);
  if (Number.isFinite(latestBeatTheJam)) comparisons.push(`vs BTJ ${deltaText(latestOurs.ours - latestBeatTheJam)}`);

  const previousOurs = [...points]
    .reverse()
    .filter((point) => Number.isFinite(point.ours))[1];
  const trend = previousOurs ? latestOurs.ours - previousOurs.ours : null;
  const trendText = Number.isFinite(trend)
    ? `trend ${trend > 3 ? "rising" : trend < -3 ? "easing" : "steady"} (${deltaText(trend)})`
    : "trend needs another sample";
  const accuracyText = stat
    ? `MAE ${stat.mae}m, bias ${deltaText(stat.bias)} over ${stat.sampleSize} scores`
    : "accuracy score pending horizon maturity";

  return `${status.summary}; now ${formatMinutes(latestOurs.ours)}; ${comparisons.join(", ") || "comparison pending"}; ${trendText}. ${accuracyText}.`;
}

function routeRecommendation(points, checkpoint, direction, accuracySummary, capturedAt) {
  const stat = accuracyForRoute(accuracySummary, checkpoint, direction, "CrossBorder.sg");
  if (stat && stat.sampleSize >= 3 && Math.abs(stat.bias) >= 8) {
    return stat.bias < 0
      ? `${routeLabel(checkpoint, direction)}: raise baseline by about ${Math.abs(stat.bias)}m.`
      : `${routeLabel(checkpoint, direction)}: lower baseline by about ${Math.abs(stat.bias)}m.`;
  }

  const latestOurs = points.find((point) => point.capturedAt === capturedAt && Number.isFinite(point.ours)) ?? null;
  const latestGoogle = currentSourceValue(latestOurs, "google");
  const latestCheckpointSg = currentSourceValue(latestOurs, "checkpointSg");
  const latestBeatTheJam = currentSourceValue(latestOurs, "beatTheJam");
  const reference = average([latestGoogle, latestCheckpointSg, latestBeatTheJam]);
  if (latestOurs && Number.isFinite(reference) && Math.abs(latestOurs.ours - reference) >= 20) {
    return `${routeLabel(checkpoint, direction)}: inspect ${latestOurs.ours > reference ? "high" : "low"} live estimate versus market by ${Math.round(Math.abs(latestOurs.ours - reference))}m.`;
  }
  return null;
}

function sanitizeSvgText(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function chartPath(points, key, xForTime, yForValue, minMs, maxMs, width = 4, dashed = false) {
  const commands = points
    .filter((point) => Number.isFinite(point[key]) && point.capturedMs >= minMs && point.capturedMs <= maxMs)
    .map((point) => `${xForTime(point.capturedMs).toFixed(1)},${yForValue(point[key]).toFixed(1)}`);
  if (commands.length < 2) return "";
  return `<polyline points="${commands.join(" ")}" fill="none" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dashed ? " stroke-dasharray=\"10 12\"" : ""} />`;
}

function wrapSvgText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function timeTickLabel(ms) {
  const hour = singaporeHour(new Date(ms));
  if (hour === 0) return "12am";
  if (hour < 12) return `${hour}am`;
  if (hour === 12) return "12pm";
  return `${hour - 12}pm`;
}

function buildSvgChart({ checkpoint, direction, points, insight, status, capturedAt }) {
  const width = 1200;
  const height = 760;
  const margin = { top: 112, right: 68, bottom: 132, left: 132 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const { startMs: minMs, endMs: maxMs } = singaporeDayBounds(new Date(capturedAt));
  const minValue = 30;
  const maxValue = 90;

  const xForTime = (ms) => margin.left + ((Math.max(minMs, Math.min(maxMs, ms)) - minMs) / (maxMs - minMs)) * (chartWidth - 18);
  const yForValue = (value) => margin.top + chartHeight - ((Math.max(minValue, Math.min(maxValue, value)) - minValue) / (maxValue - minValue)) * chartHeight;

  const thresholdBands = [
    { from: minValue, to: 45, fill: "#dff8ea" },
    { from: 45, to: 75, fill: "#fff3cf" },
    { from: 75, to: maxValue, fill: "#ffe4e1" },
  ].map((band) => {
    const y = yForValue(band.to);
    const bandHeight = yForValue(band.from) - y;
    return `<rect x="${margin.left}" y="${y}" width="${chartWidth}" height="${bandHeight}" fill="${band.fill}" />`;
  }).join("");

  const yTicks = [30, 45, 60, 75, 90];
  const yGridLines = yTicks.map((value) => {
    const y = yForValue(value);
    return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#cbd5df" stroke-width="1.5" />`;
  }).join("");
  const yLabels = yTicks.map((value) => {
    const y = yForValue(value);
      return `<text x="${margin.left - 20}" y="${y + 9}" text-anchor="end" font-size="32" font-weight="800" fill="#3f4a54">${value}m</text>`;
  }).join("");

  const tickHours = [0, 4, 8, 12, 16, 20, 24].map((hour) => minMs + hour * 60 * 60000);
  const xTicks = tickHours
    .filter((ms) => ms >= minMs && ms <= maxMs)
    .map((ms) => {
      const x = xForTime(ms);
      return `
        <line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#d6dee7" stroke-width="1.5" />
      `;
    }).join("");
  const xLabels = tickHours
    .filter((ms) => ms >= minMs && ms <= maxMs)
    .map((ms) => {
      const x = xForTime(ms);
      return `<text x="${x}" y="${height - 88}" text-anchor="middle" font-size="28" font-weight="700" fill="#53606b">${timeTickLabel(ms)}</text>`;
    }).join("");

  const series = [
    { key: "ours", label: "CrossBorder.sg", color: "#007c7c", width: 7, dashed: false },
    { key: "google", label: "Google", color: "#2563eb", width: 4, dashed: false },
    { key: "checkpointSg", label: "Checkpoint.sg", color: "#9333ea", width: 4, dashed: true },
    { key: "beatTheJam", label: "BTJ", color: "#ea580c", width: 4, dashed: true },
  ];
  const lines = series.map((item) => `
    <g stroke="${item.color}">
      ${chartPath(points, item.key, xForTime, yForValue, minMs, maxMs, item.width, item.dashed)}
    </g>
  `).join("");
  const latest = latestWithValue(points, "ours");
  const latestDot = latest
    ? `<circle cx="${xForTime(latest.capturedMs)}" cy="${yForValue(latest.ours)}" r="9" fill="#008c8c" stroke="#ffffff" stroke-width="4" />`
    : "";
  const legend = series.map((item, index) => {
    const x = margin.left + index * 238;
    return `
      <g transform="translate(${x}, 76)">
        <line x1="0" y1="0" x2="42" y2="0" stroke="${item.color}" stroke-width="${item.width}" stroke-linecap="round"${item.dashed ? " stroke-dasharray=\"10 10\"" : ""} />
        <text x="54" y="9" font-size="23" font-weight="${item.key === "ours" ? 900 : 760}" fill="#25313b">${sanitizeSvgText(item.label)}</text>
      </g>
    `;
  }).join("");

  const insightLines = wrapSvgText(insight, 86).map((line, index) => (
    `<tspan x="${margin.left}" dy="${index === 0 ? 0 : 30}">${sanitizeSvgText(line)}</tspan>`
  )).join("");

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <style>text{font-family:Inter,Arial,sans-serif}</style>
      <rect width="${width}" height="${height}" rx="30" fill="#f8fbfd" />
      <text x="${margin.left}" y="46" font-size="36" font-weight="800" fill="#0f1720">${sanitizeSvgText(routeLabel(checkpoint, direction))}</text>
      <text x="${width - margin.right}" y="46" text-anchor="end" font-size="24" font-weight="700" fill="#53606b">${sanitizeSvgText(formatSingaporeStamp(new Date(capturedAt)))}</text>
      <rect x="${width - margin.right - 178}" y="62" width="178" height="42" rx="21" fill="${status.fill}" stroke="${status.color}" stroke-width="2" />
      <circle cx="${width - margin.right - 150}" cy="83" r="10" fill="${status.color}" />
      <text x="${width - margin.right - 126}" y="93" font-size="27" font-weight="900" fill="${status.color}">${sanitizeSvgText(status.label)}</text>
      ${legend}
      <clipPath id="plot-${checkpoint}-${direction.replaceAll(" ", "-")}">
        <rect x="${margin.left}" y="${margin.top}" width="${chartWidth}" height="${chartHeight}" />
      </clipPath>
      <g clip-path="url(#plot-${checkpoint}-${direction.replaceAll(" ", "-")})">
        ${thresholdBands}
        ${xTicks}
        ${yGridLines}
        ${lines}
        ${latestDot}
      </g>
      ${yLabels}
      ${xLabels}
      <rect x="${margin.left}" y="${margin.top}" width="${chartWidth}" height="${chartHeight}" fill="none" stroke="#97a6b5" stroke-width="2" />
      <text x="${margin.left}" y="${height - 46}" font-size="23" font-weight="700" fill="#31404d">${insightLines}</text>
    </svg>
  `;
}

async function svgToPng(svg) {
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

async function buildGraphReports(allRows, accuracySummary, capturedAt) {
  await mkdir(graphRoot, { recursive: true });
  const { startMs: sinceMs } = singaporeDayBounds(new Date(capturedAt));
  const routes = [
    { checkpoint: "Woodlands", direction: "Towards JB" },
    { checkpoint: "Tuas", direction: "Towards JB" },
    { checkpoint: "Woodlands", direction: "Towards SG" },
    { checkpoint: "Tuas", direction: "Towards SG" },
  ];

  const reports = [];
  for (const route of routes) {
    const capturedMs = new Date(capturedAt).getTime();
    const points = buildRouteSeries(allRows, route.checkpoint, route.direction, sinceMs)
      .filter((point) => point.capturedMs <= capturedMs);
    const status = routeTrafficStatus(points, capturedAt);
    const insight = buildRouteInsight(points, route.checkpoint, route.direction, accuracySummary, status, capturedAt);
    const svg = buildSvgChart({ ...route, points, insight, status, capturedAt });
    const png = await svgToPng(svg);
    const filename = `${route.checkpoint.toLowerCase()}-${route.direction.toLowerCase().replaceAll(" ", "-")}.png`;
    await writeFile(join(graphRoot, filename), png);
    reports.push({
      ...route,
      points,
      status,
      insight,
      png,
      filename,
    });
  }
  return reports;
}

function buildOverallAssessment(graphReports, accuracySummary, scoredAccuracyRows, approachReport, capturedAt) {
  const oursStats = accuracySummary.sourceStats.filter((stat) => stat.source === "CrossBorder.sg");
  const totalSamples = oursStats.reduce((total, stat) => total + stat.sampleSize, 0);
  const weightedMae = totalSamples
    ? Math.round(oursStats.reduce((total, stat) => total + stat.mae * stat.sampleSize, 0) / totalSamples)
    : null;
  const weightedBias = totalSamples
    ? Math.round(oursStats.reduce((total, stat) => total + stat.bias * stat.sampleSize, 0) / totalSamples)
    : null;
  const recommendations = [
    ...accuracySummary.tuning.slice(0, 4),
    ...graphReports.map((report) => routeRecommendation(
      report.points,
      report.checkpoint,
      report.direction,
      accuracySummary,
      capturedAt,
    )).filter(Boolean),
  ];
  const uniqueRecommendations = [...new Set(recommendations)].slice(0, 5);
  const isTuningHour = singaporeHour(new Date(capturedAt)) === 10;

  const lines = [
    "CrossBorder.sg model scorecard",
    formatSingaporeStamp(new Date(capturedAt)),
    "",
    weightedMae == null
      ? `Accuracy: waiting for ${accuracyHorizons.join("/")}m horizons to mature.`
      : `Accuracy: recent CrossBorder.sg MAE ${weightedMae}m, bias ${deltaText(weightedBias)} across ${totalSamples} scored samples.`,
    `New scored samples this run: ${scoredAccuracyRows.length}.`,
  ];

  if (fetchWarnings.length) {
    lines.push("");
    lines.push("Data warnings:");
    for (const warning of fetchWarnings.slice(0, 4)) lines.push(`- ${warning}`);
  }

  lines.push("");
  lines.push("Approach routing:");
  if (approachReport?.summaries?.length) {
    for (const summary of approachReport.summaries) lines.push(`- ${summary}`);
  } else {
    lines.push("- Waiting for route-level Google traffic samples.");
  }

  lines.push("");
  lines.push(isTuningHour ? "1000hrs tuning check:" : "Next scheduled tuning check: 1000hrs SGT.");
  if (uniqueRecommendations.length) {
    for (const item of uniqueRecommendations) lines.push(`- ${item}`);
  } else {
    lines.push("- Hold model settings; keep collecting hourly samples.");
  }

  lines.push("");
  lines.push("Scientific loop: checkpoint estimate stays separate from approach route timing; Google ranks approaches, cameras moderate confidence, hourly history tunes the anchors.");
  return lines.join("\n");
}

const competitorRecords = JSON.parse(await readFile(join(outRoot, "latest-summary.json"), "utf8"));
const capturedAt = new Date().toISOString();
const capturedMs = new Date(capturedAt).getTime();
const freshCompetitorRecords = competitorRecords.filter((record) => {
  const recordMs = new Date(record.capturedAt).getTime();
  if (!Number.isFinite(recordMs)) {
    fetchWarnings.push(`${record.app ?? "Competitor app"}: missing capture timestamp; excluded from current comparison.`);
    return false;
  }
  const ageMinutes = Math.round((capturedMs - recordMs) / 60000);
  if (ageMinutes > competitorMaxAgeMinutes) {
    fetchWarnings.push(`${record.app ?? "Competitor app"}: capture is ${ageMinutes}m old; excluded from current comparison.`);
    return false;
  }
  return true;
});
const liveByDirection = Object.fromEntries(await Promise.all(
  Object.values(directionMap).map(async ({ apiDirection }) => [
    apiDirection,
    await fetchLiveTraffic(apiDirection),
  ]),
));
const approachReport = await buildApproachReport(liveByDirection, freshCompetitorRecords, capturedAt);

const benchmark = [];

for (const [directionKey, { apiDirection, label }] of Object.entries(directionMap)) {
  const live = liveByDirection[apiDirection];
  for (const checkpoint of Object.keys(routeEndpoints)) {
    const displayCheckpoint = routeEndpoints[checkpoint].display;
    const oursRange = live?.checkpoints?.[displayCheckpoint]?.crossingRange ?? null;
    const oursMid = live?.checkpoints?.[displayCheckpoint]?.waitMinutes ?? midpoint(oursRange);

    const sources = [
      {
        source: "CrossBorder.sg",
        range: oursRange,
        midpoint: oursMid,
        deltaVsOurs: 0,
      },
    ];

    if (useGoogleRoutesApi) {
      let googleMinutes = null;
      try {
        googleMinutes = await googleRouteMinutes(checkpoint, apiDirection);
      } catch (error) {
        fetchWarnings.push(`Google ${displayCheckpoint} ${label}: ${error instanceof Error ? error.message : "unavailable"}`);
      }
      if (Number.isFinite(googleMinutes)) {
        sources.push({
          source: "Google Routes",
          range: [googleMinutes, googleMinutes],
          midpoint: googleMinutes,
          deltaVsOurs: oursMid == null ? null : googleMinutes - oursMid,
        });
      }
    }

    for (const record of freshCompetitorRecords) {
      const range = record.normalizedReadings?.[checkpoint]?.[directionKey] ?? null;
      const sourceMid = midpoint(range);
      sources.push({
        source: record.app,
        range,
        midpoint: sourceMid,
        deltaVsOurs: sourceMid == null || oursMid == null ? null : sourceMid - oursMid,
      });
    }

    benchmark.push({
      checkpoint,
      displayCheckpoint,
      directionKey,
      apiDirection,
      label,
      oursMid,
      sources: sources.map((source) => ({
        ...source,
        severity: source.source === "CrossBorder.sg" ? "BASE" : severity(source.deltaVsOurs),
      })),
    });
  }
}

const historyRows = benchmark.flatMap((entry) => entry.sources.map((source) => ({
  capturedAt,
  checkpoint: entry.displayCheckpoint,
  direction: entry.label,
  source: source.source,
  lower: source.range?.[0] ?? "",
  upper: source.range?.[1] ?? "",
  midpoint: source.midpoint ?? "",
  deltaVsOurs: source.deltaVsOurs ?? "",
  severity: source.severity,
})));
const previousBenchmarkRows = await readCsvRows("benchmark-history.csv");
const existingAccuracyRows = await readCsvRows("accuracy-history.csv");
await appendBenchmarkHistory(historyRows);
await appendApproachHistory(approachReport.rows);

const scoredAccuracyRows = buildAccuracyRows(
  [...previousBenchmarkRows, ...historyRows],
  existingAccuracyRows,
  capturedAt,
);
await appendAccuracyHistory(scoredAccuracyRows);
const accuracyRows = [...existingAccuracyRows, ...scoredAccuracyRows];
const accuracySummary = summarizeAccuracy(
  accuracyRows,
  Date.now() - 7 * 24 * 60 * 60000,
);

await writeFile(join(outRoot, "latest-benchmark.json"), `${JSON.stringify({
  capturedAt,
  benchmark,
  accuracy: {
    horizonsMinutes: accuracyHorizons,
    targetToleranceMinutes: accuracyToleranceMinutes,
    newSamples: scoredAccuracyRows.length,
    ...accuracySummary,
  },
}, null, 2)}\n`);
await writeFile(join(outRoot, "latest-accuracy.json"), `${JSON.stringify({
  capturedAt,
  horizonsMinutes: accuracyHorizons,
  targetToleranceMinutes: accuracyToleranceMinutes,
  newSamples: scoredAccuracyRows.length,
  ...accuracySummary,
}, null, 2)}\n`);
await writeFile(join(outRoot, "latest-approaches.json"), `${JSON.stringify({
  capturedAt,
  method: {
    primary: "Google Routes traffic-aware duration by named approach",
    corroboration: "CrossBorder.sg live camera freshness moderates confidence",
    scope: "Woodlands approach routing, checkpoint crossing model remains separate",
  },
  routes: approachReport.rows,
  summaries: approachReport.summaries,
}, null, 2)}\n`);

const allBenchmarkRows = [...previousBenchmarkRows, ...historyRows];
const graphReports = await buildGraphReports(allBenchmarkRows, accuracySummary, capturedAt);

for (const report of graphReports) {
  await sendTelegramPhoto(
    report.png,
    report.filename,
    `${routeLabel(report.checkpoint, report.direction)}\n${report.insight}`,
  );
}

await sendTelegram(buildOverallAssessment(
  graphReports,
  accuracySummary,
  scoredAccuracyRows,
  approachReport,
  capturedAt,
));
