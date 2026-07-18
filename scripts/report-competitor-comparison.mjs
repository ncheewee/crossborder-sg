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

const competitorRecords = JSON.parse(await readFile(join(outRoot, "latest-summary.json"), "utf8"));
const capturedAt = new Date().toISOString();
const liveByDirection = Object.fromEntries(await Promise.all(
  Object.values(directionMap).map(async ({ apiDirection }) => [
    apiDirection,
    await fetchJson(`${API_BASE}/api/traffic?direction=${apiDirection}`),
  ]),
));

const benchmark = [];

for (const [directionKey, { apiDirection, label }] of Object.entries(directionMap)) {
  const live = liveByDirection[apiDirection];
  for (const checkpoint of Object.keys(routeEndpoints)) {
    const displayCheckpoint = routeEndpoints[checkpoint].display;
    const oursRange = live.checkpoints?.[displayCheckpoint]?.crossingRange ?? null;
    const oursMid = live.checkpoints?.[displayCheckpoint]?.waitMinutes ?? midpoint(oursRange);

    const sources = [
      {
        source: "CrossBorder.sg",
        range: oursRange,
        midpoint: oursMid,
        deltaVsOurs: 0,
      },
    ];

    const googleMinutes = await googleRouteMinutes(checkpoint, apiDirection);
    if (Number.isFinite(googleMinutes)) {
      sources.push({
        source: "Google Routes",
        range: [googleMinutes, googleMinutes],
        midpoint: googleMinutes,
        deltaVsOurs: googleMinutes - oursMid,
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
await appendBenchmarkHistory(historyRows);
await writeFile(join(outRoot, "latest-benchmark.json"), `${JSON.stringify({ capturedAt, benchmark }, null, 2)}\n`);

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
}

await sendTelegram(lines.join("\n"));
