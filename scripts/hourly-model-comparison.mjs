const API_BASE = process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GOOGLE_ROUTES_API_KEY = process.env.GOOGLE_ROUTES_API_KEY;
const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

const directions = [
  ["sg-my", "SG -> JB", "Towards JB"],
  ["my-sg", "JB -> SG", "Towards SG"],
];

const routeEndpoints = {
  Woodlands: {
    sg: { latitude: 1.4456, longitude: 103.7683 },
    my: { latitude: 1.4599, longitude: 103.7649 },
  },
  Tuas: {
    sg: { latitude: 1.3478, longitude: 103.6376 },
    my: { latitude: 1.3618, longitude: 103.6194 },
  },
};

function midpoint(range) {
  if (!Array.isArray(range) || range.length < 2) return null;
  return Math.round((Number(range[0]) + Number(range[1])) / 2);
}

function formatCheckpoint(checkpoint, payload) {
  const current = payload.checkpoints?.[checkpoint];
  if (!current) return `${checkpoint}: unavailable`;
  const forecast = payload.forecasts?.[checkpoint] || [];
  const now = current.waitMinutes ?? midpoint(current.crossingRange);
  const plus3h = forecast.find((point) => (
    new Date(point.timestamp).getTime() >= Date.now() + 3 * 60 * 60 * 1000
  ))?.predicted;
  const delta = Number.isFinite(now) && Number.isFinite(plus3h)
    ? `${plus3h >= now ? "+" : ""}${Math.round(plus3h - now)}m`
    : "n/a";
  return `${checkpoint}: ${current.crossingRange?.[0]}-${current.crossingRange?.[1]}m now, ${plus3h ?? "n/a"}m in ~3h (${delta})`;
}

function currentRange(checkpoint, payload) {
  const current = payload.checkpoints?.[checkpoint];
  if (!current) return null;
  const range = current.crossingRange;
  const now = current.waitMinutes ?? midpoint(range);
  if (!Array.isArray(range) || range.length < 2 || !Number.isFinite(now)) return null;
  return {
    lower: Number(range[0]),
    upper: Number(range[1]),
    midpoint: Math.round(now),
  };
}

function parseDurationMinutes(duration) {
  const match = typeof duration === "string" ? duration.match(/^([\d.]+)s$/) : null;
  return match ? Math.round(Number(match[1]) / 60) : null;
}

function formatDelta(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value >= 0 ? "+" : ""}${Math.round(value)}m`;
}

function routeBody(checkpoint, direction) {
  const endpoints = routeEndpoints[checkpoint];
  const origin = direction === "sg-my" ? endpoints.sg : endpoints.my;
  const destination = direction === "sg-my" ? endpoints.my : endpoints.sg;
  return {
    origin: { location: { latLng: origin } },
    destination: { location: { latLng: destination } },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
  };
}

async function googleRouteMinutes(checkpoint, direction) {
  if (!GOOGLE_ROUTES_API_KEY) return null;
  const response = await fetch(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_ROUTES_API_KEY,
      "X-Goog-FieldMask": "routes.duration,routes.staticDuration",
    },
    body: JSON.stringify(routeBody(checkpoint, direction)),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Routes ${checkpoint} ${direction} failed: ${response.status} ${body}`);
  }
  const payload = await response.json();
  const route = payload.routes?.[0];
  return {
    traffic: parseDurationMinutes(route?.duration),
    static: parseDurationMinutes(route?.staticDuration),
  };
}

async function googleComparisonLines(direction, label, payload) {
  if (!GOOGLE_ROUTES_API_KEY) {
    return ["Google Routes proxy: not configured (GOOGLE_ROUTES_API_KEY missing)."];
  }

  const checkpoints = ["Woodlands", "Tuas"];
  const results = await Promise.all(checkpoints.map(async (checkpoint) => {
    const ours = currentRange(checkpoint, payload);
    const google = await googleRouteMinutes(checkpoint, direction);
    if (!ours || !Number.isFinite(google?.traffic)) {
      return `${checkpoint}: unavailable`;
    }
    const delta = ours.midpoint - google.traffic;
    const trafficLift = Number.isFinite(google.static) ? `, traffic ${formatDelta(google.traffic - google.static)}` : "";
    const gapFlag = Math.abs(delta) >= 20 ? " CHECK" : "";
    return `${checkpoint}: ours ${ours.lower}-${ours.upper}m vs Google ${google.traffic}m (${formatDelta(delta)}${trafficLift})${gapFlag}`;
  }));

  return [
    `${label} Google Routes proxy`,
    ...results,
  ];
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function competitorStatus() {
  return [
    "Checkpoint.sg / Beat the Jam: no documented realtime API found.",
    "Using Google Routes traffic-aware durations as the recurring market proxy.",
  ];
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

const lines = [
  "CrossBorder.sg hourly model comparison",
  new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date()),
  "",
];

for (const [direction, label, displayLabel] of directions) {
  const payload = await fetchJson(`${API_BASE}/api/traffic?direction=${direction}`);
  lines.push(label);
  lines.push(formatCheckpoint("Woodlands", payload));
  lines.push(formatCheckpoint("Tuas", payload));
  lines.push(...await googleComparisonLines(direction, displayLabel, payload));
  lines.push("");
}

lines.push("External benchmark");
lines.push(...await competitorStatus());
lines.push("");
lines.push("Gaps marked CHECK mean our midpoint differs from Google by at least 20m.");

await sendTelegram(lines.join("\n"));
