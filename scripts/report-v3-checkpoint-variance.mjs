import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const captureRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const googleKey = process.env.GOOGLE_ROUTES_API_KEY;
const routesUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
const historyPath = join(captureRoot, "v3-checkpoint-history.csv");

const routeSets = [
  {
    label: "Singapore to JB (Woodlands)",
    directionKey: "towardsJb",
    clearance: { latitude: 1.466582, longitude: 103.768091 },
    routes: [
      { id: "A", origin: { latitude: 1.439328, longitude: 103.768422 } },
      { id: "B", origin: { latitude: 1.439356, longitude: 103.768285 } },
      { id: "C", origin: { latitude: 1.440516, longitude: 103.768108 } },
    ],
  },
  {
    label: "JB to Singapore (Woodlands)",
    directionKey: "towardsSg",
    clearance: { latitude: 1.4430746, longitude: 103.7683229 },
    routes: [
      { id: "A", origin: { latitude: 1.472085, longitude: 103.7651 } },
      { id: "B", origin: { latitude: 1.482406, longitude: 103.7832 } },
      { id: "C", origin: { latitude: 1.46734, longitude: 103.7658 } },
      { id: "D", origin: { latitude: 1.465356, longitude: 103.7702 } },
    ],
  },
];

function minutes(duration) {
  const seconds = typeof duration === "string" ? Number(duration.replace(/s$/, "")) : Number.NaN;
  return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
}

function midpoint(range) {
  return Array.isArray(range) ? Math.round((Number(range[0]) + Number(range[1])) / 2) : null;
}

function formatRange(range) {
  return range ? `${range[0]}-${range[1]}m` : "unavailable";
}

async function routeDuration(origin, destination) {
  const response = await fetch(routesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleKey,
      "X-Goog-FieldMask": "routes.duration",
    },
    body: JSON.stringify({
      origin: { location: { latLng: origin } },
      destination: { location: { latLng: destination } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL",
    }),
  });
  if (!response.ok) throw new Error(`Google Routes returned ${response.status}`);
  return minutes((await response.json()).routes?.[0]?.duration);
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

async function sendPhoto(buffer, filename, caption) {
  if (!token || !chatId) throw new Error("Telegram credentials are not configured");
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption);
      form.append("photo", new Blob([buffer], { type: "image/png" }), filename);
      const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
      if (!response.ok) throw new Error(`Telegram returned ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

function chartSvg(route, rows) {
  const width = 1120;
  const height = 620;
  const margin = { top: 94, right: 60, bottom: 70, left: 76 };
  const palette = route.directionKey === "towardsJb"
    ? { main: "#15803d", fill: "#15803d", label: "Singapore to JB" }
    : { main: "#2563eb", fill: "#2563eb", label: "JB to Singapore" };
  const values = rows.flatMap((row) => [row.oursLow, row.oursHigh, row.checkpointLow, row.checkpointHigh]).filter(Number.isFinite);
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
  const line = (key) => rows.length < 2 ? "" : rows.map((row, index) => `${index ? "L" : "M"}${x(row).toFixed(1)},${y(row[key]).toFixed(1)}`).join(" ");
  const area = rows.length < 2 ? "" : `${line("oursLow")} ${rows.slice().reverse().map((row) => `L${x(row).toFixed(1)},${y(row.oursHigh).toFixed(1)}`).join(" ")} Z`;
  const grids = Array.from({ length: (high - low) / 15 + 1 }, (_, index) => low + index * 15)
    .filter((value) => value <= high)
    .map((value) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" stroke="#d7dde2"/><text x="${margin.left - 14}" y="${y(value) + 5}" text-anchor="end" fill="#56616d" font-size="20">${value}m</text>`)
    .join("");
  const hourTicks = Array.from({ length: 7 }, (_, index) => index * 4).map((hour) => {
    const tickX = margin.left + hour / 24 * plotWidth;
    const label = hour === 0 ? "12am" : hour === 12 ? "12pm" : `${hour % 12} ${hour < 12 ? "am" : "pm"}`;
    return `<line x1="${tickX}" x2="${tickX}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#e4e8ec"/><text x="${tickX}" y="${height - 24}" text-anchor="middle" fill="#56616d" font-size="18">${label}</text>`;
  }).join("");
  const dots = rows.map((row) => `
    <circle cx="${x(row)}" cy="${y(row.oursMid)}" r="7" fill="#ffffff" stroke="${palette.main}" stroke-width="5"/>
    <circle cx="${x(row)}" cy="${y(row.checkpointMid)}" r="6" fill="#ffffff" stroke="${palette.main}" stroke-width="4" stroke-dasharray="3 2"/>
  `).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="${margin.left}" y="42" fill="#111827" font-size="34" font-family="Arial, sans-serif" font-weight="700">${route.label}</text>
    <text x="${margin.left}" y="72" fill="#52606d" font-size="20" font-family="Arial, sans-serif">Hourly route-time range vs Checkpoint.sg · ${singaporeDate}</text>
    ${grids}
    ${hourTicks}
    <path d="${area}" fill="${palette.fill}" fill-opacity="0.14"/>
    <path d="${line("oursMid")}" fill="none" stroke="${palette.main}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${line("checkpointMid")}" fill="none" stroke="${palette.main}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="12 10"/>
    ${dots}
    <rect x="${width - 390}" y="24" width="16" height="16" rx="4" fill="${palette.main}"/><text x="${width - 366}" y="39" fill="#23303b" font-size="18">CrossBorder V3 range</text>
    <line x1="${width - 175}" x2="${width - 159}" y1="32" y2="32" stroke="${palette.main}" stroke-width="5" stroke-dasharray="8 6"/><text x="${width - 151}" y="39" fill="#23303b" font-size="18">Checkpoint.sg</text>
  </svg>`;
}

if (!googleKey) throw new Error("GOOGLE_ROUTES_API_KEY is required for V3 variance reporting");
await mkdir(captureRoot, { recursive: true });
const records = JSON.parse(await readFile(join(captureRoot, "latest-summary.json"), "utf8"));
const checkpoint = records.find((record) => record.app === "Checkpoint.sg" && record.captureStatus !== "failed");
if (!checkpoint) throw new Error("No fresh Checkpoint.sg capture is available");
const capturedAt = new Date().toISOString();
const rows = [];
for (const route of routeSets) {
  const durations = await Promise.all(route.routes.map((item) => routeDuration(item.origin, route.clearance)));
  if (durations.some((value) => value == null)) throw new Error(`${route.label}: incomplete Google Routes response`);
  const oursRange = [Math.min(...durations), Math.max(...durations)];
  const checkpointRange = checkpoint.normalizedReadings?.woodlands?.[route.directionKey] ?? null;
  rows.push({
    capturedAt,
    label: route.label,
    directionKey: route.directionKey,
    routeCount: route.routes.length,
    oursLow: oursRange[0],
    oursHigh: oursRange[1],
    oursMid: midpoint(oursRange),
    checkpointLow: checkpointRange?.[0] ?? null,
    checkpointHigh: checkpointRange?.[1] ?? null,
    checkpointMid: midpoint(checkpointRange),
  });
}
const history = await readCsv(historyPath);
const historyLines = rows.map((row) => [row.capturedAt, row.label, row.oursLow, row.oursHigh, row.oursMid, row.checkpointLow ?? "", row.checkpointHigh ?? "", row.checkpointMid ?? ""].join(","));
try { await access(historyPath); } catch { await writeFile(historyPath, "capturedAt,label,oursLow,oursHigh,oursMid,checkpointLow,checkpointHigh,checkpointMid\n"); }
await appendFile(historyPath, `${historyLines.join("\n")}\n`);
await writeFile(join(captureRoot, "latest-v3-checkpoint-variance.json"), `${JSON.stringify({ capturedAt, rows }, null, 2)}\n`);
for (const route of rows) {
  const reportDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(route.capturedAt));
  const points = [...history, ...rows].filter((row) => row.label === route.label && new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(row.capturedAt)) === reportDate).map((row) => ({
    ...row,
    oursLow: Number(row.oursLow), oursHigh: Number(row.oursHigh), oursMid: Number(row.oursMid),
    checkpointLow: Number(row.checkpointLow), checkpointHigh: Number(row.checkpointHigh), checkpointMid: Number(row.checkpointMid),
  })).filter((row) => Number.isFinite(row.oursMid) && Number.isFinite(row.checkpointMid));
  const delta = route.oursMid - route.checkpointMid;
  const percent = route.checkpointMid ? Math.round(Math.abs(delta) / route.checkpointMid * 100) : null;
  const status = percent == null ? "No Checkpoint reading" : percent <= 10 ? "GREEN" : percent <= 30 ? "AMBER" : "RED";
  const png = await sharp(Buffer.from(chartSvg(route, points))).png().toBuffer();
  await sendPhoto(png, `${route.label.toLowerCase().replaceAll(" ", "-")}.png`, `${route.label}\nCrossBorder V3 A-${String.fromCharCode(64 + route.routeCount)}: ${formatRange([route.oursLow, route.oursHigh])}\nCheckpoint.sg: ${formatRange(route.checkpointLow == null ? null : [route.checkpointLow, route.checkpointHigh])}\nVariance: ${delta >= 0 ? "+" : ""}${delta}m (${percent ?? "n/a"}%) ${status}`);
}
