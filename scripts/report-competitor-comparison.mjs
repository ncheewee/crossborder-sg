import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const API_BASE = process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const outRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");

const directionMap = {
  towardsJb: ["sg-my", "Towards JB"],
  towardsSg: ["my-sg", "Towards SG"],
};

function midpoint(range) {
  return Array.isArray(range) ? Math.round((Number(range[0]) + Number(range[1])) / 2) : null;
}

function formatRange(range) {
  return Array.isArray(range) ? `${range[0]}-${range[1]}m` : "n/a";
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
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

const competitorRecords = JSON.parse(await readFile(join(outRoot, "latest-summary.json"), "utf8"));
const liveByDirection = Object.fromEntries(await Promise.all(
  Object.values(directionMap).map(async ([direction]) => [
    direction,
    await fetchJson(`${API_BASE}/api/traffic?direction=${direction}`),
  ]),
));

const lines = [
  "CrossBorder.sg competitor comparison",
  new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date()),
  "",
];

for (const [directionKey, [apiDirection, label]] of Object.entries(directionMap)) {
  lines.push(label);
  const live = liveByDirection[apiDirection];
  for (const checkpoint of ["woodlands", "tuas"]) {
    const displayCheckpoint = checkpoint === "woodlands" ? "Woodlands" : "Tuas";
    const oursRange = live.checkpoints?.[displayCheckpoint]?.crossingRange ?? null;
    const oursMid = live.checkpoints?.[displayCheckpoint]?.waitMinutes ?? midpoint(oursRange);
    const competitorBits = competitorRecords.map((record) => {
      const range = record.normalizedReadings?.[checkpoint]?.[directionKey] ?? null;
      const delta = midpoint(range) == null || oursMid == null ? null : midpoint(range) - oursMid;
      return `${record.app} ${formatRange(range)}${delta == null ? "" : ` (${delta >= 0 ? "+" : ""}${delta}m)`}`;
    });
    lines.push(`${displayCheckpoint}: ours ${formatRange(oursRange)} | ${competitorBits.join(" | ")}`);
  }
  lines.push("");
}

lines.push("Delta is competitor midpoint minus our current estimate.");

await sendTelegram(lines.join("\n"));
