import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const captureRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const sharedTimingsUrl = process.env.SHARED_TIMINGS_SHEET_URL
  || "https://docs.google.com/spreadsheets/d/1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo/export?format=csv";
const historyPath = join(captureRoot, "v3-crossborder-sheet-history.csv");
const sharedTimingsSnapshotPath = join(captureRoot, "v3-shared-timings-cache.json");
const checkpointMaxAgeMs = 90 * 60 * 1000;

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

function formatRange(range) {
  return range ? `${range[0]}-${range[1]}m` : "unavailable";
}

function signedMinutes(value) {
  return `${value >= 0 ? "+" : ""}${value}m`;
}

function assessVariance(route, points, sourceKey, sourceLabel) {
  const current = points.at(-1);
  if (!current) return `No comparable ${sourceLabel} reading was captured.`;

  const recent = points.slice(-4);
  const deltas = recent.map((point) => point.oursMid - point[sourceKey]);
  const average = Math.round(deltas.reduce((sum, value) => sum + value, 0) / deltas.length);
  const sameDirection = deltas.length >= 3 && deltas.every((value) => value <= -10) ? "lower"
    : deltas.length >= 3 && deltas.every((value) => value >= 10) ? "higher"
      : null;
  const currentGap = current.oursMid - current[sourceKey];
  const separated = current.oursHigh < current[`${sourceKey}Low`]
    ? `Our full route range sits below ${sourceLabel}'s band`
    : current.oursLow > current[`${sourceKey}High`]
      ? `Our full route range sits above ${sourceLabel}'s band`
      : "The two published ranges overlap";

  if (recent.length === 1) {
    return `${separated} by ${Math.abs(currentGap)}m at this check. This is the first same-day observation, so it is a discrepancy to investigate, not a calibration signal yet.`;
  }

  const previous = recent.at(-2);
  const oursMovement = current.oursMid - previous.oursMid;
  const sourceMovement = current[sourceKey] - previous[sourceKey];
  const movement = Math.abs(oursMovement) <= 5 && Math.abs(sourceMovement) <= 5
    ? "Both sources are broadly steady hour-on-hour"
    : Math.sign(oursMovement) === Math.sign(sourceMovement)
      ? `Both sources moved in the same direction (${signedMinutes(oursMovement)} ours, ${signedMinutes(sourceMovement)} ${sourceLabel})`
      : `The sources moved differently (${signedMinutes(oursMovement)} ours, ${signedMinutes(sourceMovement)} ${sourceLabel})`;

  if (sameDirection === "lower") {
    return `${separated}; CrossBorder has stayed ${Math.abs(average)}m below ${sourceLabel} on average across ${recent.length} hourly checks. ${movement}. Treat this as a likely measurement-boundary or model bias: validate against completed trips before lifting estimates wholesale.`;
  }
  if (sameDirection === "higher") {
    return `${separated}; CrossBorder has stayed ${average}m above ${sourceLabel} on average across ${recent.length} hourly checks. ${movement}. Check whether our chosen route starts earlier than ${sourceLabel}'s queue boundary before tuning down.`;
  }
  return `${separated}. The gap is not yet directionally stable over ${recent.length} checks (average ${signedMinutes(average)}). ${movement}. Keep collecting: the right lesson may be time-of-day sensitivity rather than a single offset.`;
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

async function loadSharedTimings() {
  const response = await fetch(sharedTimingsUrl, { headers: { Accept: "text/csv" } });
  if (!response.ok) throw new Error(`Shared timings sheet returned ${response.status}`);
  const [header = [], ...data] = parseCsv(await response.text());
  const timestampIndex = header.indexOf("Timestamp (SGT)");
  if (timestampIndex === -1 || data.length === 0) throw new Error("Shared timings sheet has no timestamped readings");
  const latest = data.at(-1);
  const capturedAt = parseSingaporeTimestamp(latest[timestampIndex]);
  if (!capturedAt) throw new Error("Shared timings sheet timestamp is invalid");
  const readings = Object.fromEntries(header.map((key, index) => [key, Number(latest[index])]));
  return { capturedAt, readings };
}

function sharedRange(route, sharedTimings) {
  if (!sharedTimings) return null;
  const values = route.routes.map((item) => sharedTimings.readings[item.sourceColumn]).filter((value) => Number.isFinite(value) && value > 0);
  return values.length === route.routes.length ? [Math.min(...values), Math.max(...values)] : null;
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
  const line = (key) => {
    let previousWasPoint = false;
    return rows.map((row) => {
      if (!Number.isFinite(row[key])) {
        previousWasPoint = false;
        return "";
      }
      const command = previousWasPoint ? "L" : "M";
      previousWasPoint = true;
      return `${command}${x(row).toFixed(1)},${y(row[key]).toFixed(1)}`;
    }).filter(Boolean).join(" ");
  };
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
    ${Number.isFinite(row.checkpointMid) ? `<circle cx="${x(row)}" cy="${y(row.checkpointMid)}" r="6" fill="#ffffff" stroke="${palette.main}" stroke-width="4" stroke-dasharray="3 2"/>` : ""}
  `).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="${margin.left}" y="42" fill="#111827" font-size="34" font-family="Arial, sans-serif" font-weight="700">${route.label}</text>
    <text x="${margin.left}" y="72" fill="#52606d" font-size="20" font-family="Arial, sans-serif">Hourly CrossBorder route-time range vs Checkpoint.sg · ${singaporeDate}</text>
    ${grids}
    ${hourTicks}
    <path d="${area}" fill="${palette.fill}" fill-opacity="0.14"/>
    <path d="${line("oursMid")}" fill="none" stroke="${palette.main}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${line("checkpointMid")}" fill="none" stroke="${palette.main}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="12 10"/>
    ${dots}
    <rect x="${width - 390}" y="24" width="16" height="16" rx="4" fill="${palette.main}"/><text x="${width - 366}" y="39" fill="#23303b" font-size="18">CrossBorder range</text>
    <line x1="${width - 175}" x2="${width - 159}" y1="32" y2="32" stroke="${palette.main}" stroke-width="5" stroke-dasharray="8 6"/><text x="${width - 151}" y="39" fill="#23303b" font-size="18">Checkpoint.sg</text>
  </svg>`;
}

await mkdir(captureRoot, { recursive: true });
const records = await readJson(join(captureRoot, "latest-summary.json")) ?? [];
const checkpoint = records.find((record) => (
  record.app === "Checkpoint.sg"
  && record.captureStatus !== "failed"
  && Number.isFinite(new Date(record.capturedAt).getTime())
  && Date.now() - new Date(record.capturedAt).getTime() <= checkpointMaxAgeMs
)) ?? null;
let sharedTimings = null;
try {
  sharedTimings = await loadSharedTimings();
  await writeFile(sharedTimingsSnapshotPath, `${JSON.stringify(sharedTimings, null, 2)}\n`);
} catch (error) {
  sharedTimings = await readJson(sharedTimingsSnapshotPath);
  if (!sharedTimings) throw error;
  console.warn(`Shared timings refresh failed; using cached reading: ${error.message}`);
}
const capturedAt = new Date().toISOString();
const lastValidRows = await lastValidCrossBorderRows();
const rows = [];
for (const route of routeSets) {
  const lastValid = lastValidRows.get(route.label);
  const oursRange = sharedRange(route, sharedTimings) ?? (
    Number(lastValid?.oursLow) > 0 && Number(lastValid?.oursHigh) > 0
      ? [Number(lastValid.oursLow), Number(lastValid.oursHigh)]
      : null
  );
  if (!oursRange) throw new Error(`CrossBorder timing sheet is missing a complete positive ${route.label} reading`);
  const checkpointRange = checkpoint?.normalizedReadings?.woodlands?.[route.directionKey] ?? null;
  rows.push({
    capturedAt,
    label: route.label,
    directionKey: route.directionKey,
    routeCount: route.routes.length,
    routeDataCapturedAt: sharedRange(route, sharedTimings) ? sharedTimings.capturedAt : lastValid.capturedAt,
    oursLow: oursRange[0],
    oursHigh: oursRange[1],
    oursMid: midpoint(oursRange),
    checkpointLow: checkpointRange?.[0] ?? null,
    checkpointHigh: checkpointRange?.[1] ?? null,
    checkpointMid: midpoint(checkpointRange),
  });
}
const history = await readCsv(historyPath);
const historyLines = rows.map((row) => [
  row.capturedAt, row.label, row.oursLow, row.oursHigh, row.oursMid,
  row.checkpointLow ?? "", row.checkpointHigh ?? "", row.checkpointMid ?? "",
].join(","));
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
  })).filter((row) => Number.isFinite(row.oursMid));
  const checkpointPoints = points.filter((point) => Number.isFinite(point.checkpointMid));
  const checkpointDelta = route.checkpointMid == null ? null : route.oursMid - route.checkpointMid;
  const checkpointPercent = route.checkpointMid ? Math.round(Math.abs(checkpointDelta) / route.checkpointMid * 100) : null;
  const status = checkpointPercent == null ? "No Checkpoint reading" : checkpointPercent <= 10 ? "GREEN" : checkpointPercent <= 30 ? "AMBER" : "RED";
  const assessment = checkpointPoints.length
    ? assessVariance(route, checkpointPoints, "checkpointMid", "Checkpoint.sg")
    : "Checkpoint.sg was unavailable for this hourly capture.";
  const png = await sharp(Buffer.from(chartSvg(route, points))).png().toBuffer();
  const sourceAgeMinutes = Math.max(0, Math.round((Date.now() - new Date(route.routeDataCapturedAt).getTime()) / 60_000));
  const sourceNote = sourceAgeMinutes < 60 ? "CrossBorder timing sheet live now" : `CrossBorder timing sheet ${Math.round(sourceAgeMinutes / 60)}h old`;
  await sendPhoto(png, `${route.label.toLowerCase().replaceAll(" ", "-")}.png`, `${route.label}\nCrossBorder A-${String.fromCharCode(64 + route.routeCount)}: ${formatRange([route.oursLow, route.oursHigh])}\nCheckpoint.sg: ${formatRange(route.checkpointLow == null ? null : [route.checkpointLow, route.checkpointHigh])}${checkpointDelta == null ? "" : ` · ${signedMinutes(checkpointDelta)} (${checkpointPercent}%)`}\nVariance: ${checkpointDelta == null ? "unavailable" : `${signedMinutes(checkpointDelta)} (${checkpointPercent}%) ${status}`}\n${sourceNote}\n\n${assessment}`);
}
