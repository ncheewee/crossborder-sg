import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const API_BASE = process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_ROUTES_API_KEY = process.env.GOOGLE_ROUTES_API_KEY;
const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const outRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const accuracyHorizons = (process.env.ACCURACY_HORIZONS_MINUTES || "60,180")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const accuracyToleranceMinutes = Number(process.env.ACCURACY_TARGET_TOLERANCE_MINUTES || 45);

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

const directionMap = {
  towardsJb: { apiDirection: "sg-my", label: "Towards JB" },
  towardsSg: { apiDirection: "my-sg", label: "Towards SG" },
};

function midpoint(range) {
  return Array.isArray(range) ? Math.round((Number(range[0]) + Number(range[1])) / 2) : null;
}

function formatRange(range) {
  return Array.isArray(range) ? `${range[0]}-${range[1]}m` : "n/a";
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

function bar(delta) {
  if (!Number.isFinite(delta)) return "";
  const blocks = Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 8)));
  const direction = delta >= 0 ? "high" : "low";
  return `${direction} ${"#".repeat(blocks)}`;
}

function parseDurationMinutes(duration) {
  const match = typeof duration === "string" ? duration.match(/^([\d.]+)s$/) : null;
  return match ? Math.round(Number(match[1]) / 60) : null;
}

function routeBody(checkpoint, apiDirection) {
  const endpoints = routeEndpoints[checkpoint];
  const origin = apiDirection === "sg-my" ? endpoints.sg : endpoints.my;
  const destination = apiDirection === "sg-my" ? endpoints.my : endpoints.sg;
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
      const response = await fetch(url, { headers: { Accept: "application/json" } });
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
  if (!GOOGLE_ROUTES_API_KEY) return null;
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

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(text);
    console.log("\nTelegram not sent: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing.");
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${body}`);
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

const competitorRecords = JSON.parse(await readFile(join(outRoot, "latest-summary.json"), "utf8"));
const capturedAt = new Date().toISOString();
const liveByDirection = Object.fromEntries(await Promise.all(
  Object.values(directionMap).map(async ({ apiDirection }) => [
    apiDirection,
    await fetchLiveTraffic(apiDirection),
  ]),
));

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

    for (const record of competitorRecords) {
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

const lines = [
  "CrossBorder.sg hourly variance",
  new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(capturedAt)),
  "",
  "Delta = source midpoint minus ours",
  "",
];

if (fetchWarnings.length) {
  lines.push("Data warnings");
  for (const warning of fetchWarnings) lines.push(warning);
  lines.push("");
}

for (const entry of benchmark) {
  lines.push(`${entry.displayCheckpoint} ${entry.label}`);
  for (const source of entry.sources) {
    if (source.source === "CrossBorder.sg") {
      lines.push(`Ours          ${formatRange(source.range)} baseline`);
      continue;
    }
    lines.push(`${source.source.padEnd(13).slice(0, 13)} ${formatRange(source.range).padEnd(8)} ${deltaText(source.deltaVsOurs).padStart(5)} [${source.severity}] ${bar(source.deltaVsOurs)}`);
  }
  lines.push("");
}

const gapRows = historyRows
  .filter((row) => row.severity === "GAP")
  .sort((a, b) => Math.abs(Number(b.deltaVsOurs)) - Math.abs(Number(a.deltaVsOurs)))
  .slice(0, 3);

if (gapRows.length) {
  lines.push("Largest gaps");
  for (const row of gapRows) {
    lines.push(`${row.checkpoint} ${row.direction}: ${row.source} ${deltaText(Number(row.deltaVsOurs))}`);
  }
  lines.push("");
}

lines.push("Accuracy loop");
if (!accuracyRows.length) {
  lines.push(`Waiting for ${accuracyHorizons.join("/")}m horizons to mature.`);
} else {
  lines.push(`${scoredAccuracyRows.length} new scored samples; ${accuracyRows.length} total local proxy scores.`);
  const winners = accuracySummary.winners.slice(0, 4);
  if (winners.length) {
    lines.push("Best recent source by route");
    for (const winner of winners) {
      lines.push(`${winner.checkpoint} ${winner.direction}: ${winner.source} MAE ${winner.mae}m, bias ${deltaText(winner.bias)}, ${winner.within15Pct}% <=15m (${winner.sampleSize})`);
    }
  }
  if (accuracySummary.tuning.length) {
    lines.push("Tuning candidates");
    for (const item of accuracySummary.tuning.slice(0, 4)) lines.push(item);
  } else {
    lines.push("Tuning candidates: need >=3 samples and >=8m bias per route.");
  }
}

await sendTelegram(lines.join("\n"));
