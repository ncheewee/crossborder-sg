import { createSign } from "node:crypto";

const sheetId = "1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo";
const sheetName = "Checkpoint.sg";
const apiBase = (process.env.CROSSBORDER_API_BASE || "https://crossborder-sg-api.ncheewee.workers.dev").replace(/\/$/, "");
const monitorKey = process.env.MONITOR_API_KEY;
const maxAgeMinutes = Number(process.env.CHECKPOINT_MAX_AGE_MINUTES || 90);

function validRange(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every((item) => Number.isFinite(Number(item)) && Number(item) > 0)
    && Number(value[1]) >= Number(value[0])
    && Number(value[1]) <= 240;
}

function midpoint(range) {
  return Math.round((Number(range[0]) + Number(range[1])) / 2);
}

function formatSgt(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(",", "");
}

function latestCompleteWoodlands(captures) {
  const now = Date.now();
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const capture = captures[index];
    const capturedAt = capture?.captured_at ?? capture?.capturedAt;
    if (!capturedAt || Number.isNaN(new Date(capturedAt).getTime())) continue;
    if (now - new Date(capturedAt).getTime() > maxAgeMinutes * 60_000) continue;
    const woodlands = capture.readings?.woodlands;
    if (validRange(woodlands?.towardsJb) && validRange(woodlands?.towardsSg)) return capture;
  }
  return null;
}

function buildRow(capture) {
  if (!capture) {
    return [
      formatSgt(new Date().toISOString()),
      "", "", "",
      "", "", "",
      "unavailable",
      "No complete Woodlands Checkpoint.sg capture in the last 4 hours.",
    ];
  }
  const woodlands = capture.readings.woodlands;
  const source = capture.source || "mi6-macrodroid";
  return [
    formatSgt(capture.captured_at ?? capture.capturedAt),
    woodlands.towardsJb[0], woodlands.towardsJb[1], midpoint(woodlands.towardsJb),
    woodlands.towardsSg[0], woodlands.towardsSg[1], midpoint(woodlands.towardsSg),
    source,
    source === "android-emulator" ? "Worker source: android-emulator" : "OK: complete Mi6 capture from Worker.",
  ];
}

async function loadCaptures() {
  if (!monitorKey) throw new Error("MONITOR_API_KEY is not configured");
  const response = await fetch(`${apiBase}/api/monitor/checkpoint?hours=4`, {
    headers: { "X-Monitor-Key": monitorKey },
  });
  if (!response.ok) throw new Error(`Checkpoint capture API returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.captures)) throw new Error("Checkpoint capture API returned an invalid payload");
  return payload.captures;
}

function decodeServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  return JSON.parse(raw);
}

async function googleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claim = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const unsigned = `${header}.${claim}`;
  const sign = createSign("RSA-SHA256");
  sign.update(unsigned);
  const jwt = `${unsigned}.${sign.sign(serviceAccount.private_key, "base64url")}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json();
  if (!payload.access_token) throw new Error("Google service-account token exchange failed");
  return payload.access_token;
}

async function sheetsAppend(accessToken, row) {
  const range = encodeURIComponent(`${sheetName}!A:I`);
  const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${sheetName}!A:A`)}`;
  const readResponse = await fetch(readUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!readResponse.ok) throw new Error(`Sheets read returned ${readResponse.status}`);
  const existing = await readResponse.json();
  const timestamps = (existing.values ?? []).flat().map(String);
  if (timestamps.includes(String(row[0]))) {
    console.log(`Sheet already has ${row[0]}`);
    return;
  }
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const appendResponse = await fetch(appendUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [row] }),
  });
  if (!appendResponse.ok) throw new Error(`Sheets append returned ${appendResponse.status}`);
  console.log(`Appended Checkpoint.sg row ${row[0]}`);
}

async function webappAppend(url, row) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ row }),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Sheet web app returned ${response.status}`);
  console.log(await response.text());
}

const captures = await loadCaptures();
const row = buildRow(latestCompleteWoodlands(captures));
const serviceAccount = decodeServiceAccount();
if (serviceAccount) {
  await sheetsAppend(await googleAccessToken(serviceAccount), row);
} else if (process.env.CHECKPOINT_SHEET_WEBAPP_URL) {
  await webappAppend(process.env.CHECKPOINT_SHEET_WEBAPP_URL, row);
} else {
  console.log("Sheet append skipped: set GOOGLE_SERVICE_ACCOUNT_JSON or CHECKPOINT_SHEET_WEBAPP_URL");
  console.log(row.join(","));
}
