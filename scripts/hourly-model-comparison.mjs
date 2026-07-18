const API_BASE = process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const directions = [
  ["sg-my", "SG -> JB"],
  ["my-sg", "JB -> SG"],
];

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

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function competitorStatus() {
  return [
    "Checkpoint.sg: no documented public realtime API; app states Google Maps + proprietary tracking.",
    "Beat the Jam: no documented public realtime API; FAQ states Google Maps + anonymised user data.",
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

for (const [direction, label] of directions) {
  const payload = await fetchJson(`${API_BASE}/api/traffic?direction=${direction}`);
  lines.push(label);
  lines.push(formatCheckpoint("Woodlands", payload));
  lines.push(formatCheckpoint("Tuas", payload));
  lines.push("");
}

lines.push("External app comparison");
lines.push(...await competitorStatus());
lines.push("");
lines.push("Action: add permitted Google Maps / app-export adapters before treating this as parity scoring.");

await sendTelegram(lines.join("\n"));
