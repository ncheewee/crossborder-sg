import { execFile, spawn } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adb = process.env.ADB || "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const adbSerial = process.env.ADB_SERIAL?.trim();
const outRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");
const googleMapsPackageName = "com.google.android.apps.maps";

const apps = [
  {
    id: "checkpoint-sg",
    name: "Checkpoint.sg",
    packageName: "com.tplusinteractive.checkpointsg",
    launchActivity: "com.tplusinteractive.checkpointsg/.view.SplashActivity",
    playUrl: "market://details?id=com.tplusinteractive.checkpointsg",
    settleMs: 15000,
  },
  {
    id: "beat-the-jam",
    name: "Beat the Jam",
    packageName: "com.phonegap.btj",
    launchActivity: "com.phonegap.btj/.MainActivity",
    playUrl: "market://details?id=com.phonegap.btj",
    settleMs: 8000,
  },
];
const selectedAppIds = new Set((process.env.CAPTURE_APPS || apps.map((app) => app.id).join(","))
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean));
const selectedApps = apps.filter((app) => selectedAppIds.has(app.id));

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
  towardsJb: "sg-my",
  towardsSg: "my-sg",
};

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      encoding: options.encoding ?? "utf8",
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (options.input) child.stdin?.end(options.input);
  });
}

function adbArgs(args) {
  return adbSerial ? ["-s", adbSerial, ...args] : args;
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code) {
        reject(new Error(Buffer.concat(errors).toString() || `${command} exited ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

async function adbShell(...args) {
  return run(adb, adbArgs(["shell", ...args]));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function adbShellOk(...args) {
  try {
    await adbShell(...args);
    return true;
  } catch {
    return false;
  }
}

async function prepareDevice() {
  await run(adb, adbArgs(["wait-for-device"]));
  await adbShellOk("settings", "put", "global", "airplane_mode_on", "0");
  await adbShellOk("am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", "false");
  await adbShellOk("svc", "wifi", "enable");
  await adbShellOk("svc", "data", "enable");
  await adbShellOk("settings", "put", "global", "captive_portal_mode", "0");
  await adbShellOk("settings", "put", "global", "private_dns_mode", "off");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const ok = await adbShellOk("ping", "-c", "1", "-W", "3", "google.com");
    if (ok) return true;
    await sleep(attempt * 1500);
  }
  return false;
}

async function isInstalled(packageName) {
  try {
    await adbShell("pm", "path", packageName);
    return true;
  } catch {
    return false;
  }
}

async function openPlayListings() {
  for (const app of apps) {
    await run(adb, adbArgs([
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      app.playUrl,
    ]));
    console.log(`Opened ${app.name} Play Store listing.`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function launchApp(app) {
  // MIUI can leave the recents overview above a newly started activity.
  await adbShellOk("am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS");
  await adbShellOk("am", "force-stop", app.packageName);
  await run(adb, adbArgs([
    "shell", "am", "start", "-W", "-f", "0x14000000", "-n", app.launchActivity,
  ]));
  await sleep(Number(process.env.APP_SETTLE_MS || app.settleMs || 6000));
}

function extractUiText(xml) {
  const values = [];
  for (const attr of ["text", "content-desc"]) {
    const pattern = new RegExp(`${attr}="([^"]+)"`, "g");
    for (const match of xml.matchAll(pattern)) {
      const value = match[1]
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", "\"")
        .trim();
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function parseDurations(text) {
  const compact = text.replace(/\s+/g, " ").trim();
  const matches = [];
  const patterns = [
    /(?:woodlands|causeway|tuas|2nd link|second link|jb|sg|singapore|malaysia)[^.\n]{0,80}?(\d{1,3})\s*(?:-|to|~)\s*(\d{1,3})\s*(?:min|mins|minutes|m)\b/gi,
    /(?:woodlands|causeway|tuas|2nd link|second link|jb|sg|singapore|malaysia)[^.\n]{0,80}?(\d{1,3})\s*(?:min|mins|minutes|m)\b/gi,
    /\b(\d{1,3})\s*(?:-|to|~)\s*(\d{1,3})\s*(?:min|mins|minutes|m)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of compact.matchAll(pattern)) {
      matches.push({
        text: match[0],
        minutes: match[2]
          ? [Number(match[1]), Number(match[2])]
          : [Number(match[1]), Number(match[1])],
      });
    }
  }
  return matches;
}

function range(lower, upper) {
  const low = Number(lower);
  const high = Number(upper);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
  return [low, high];
}

function firstRange(text, pattern) {
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
    const value = range(match[1], match[2]);
    if (value) return value;
  }
  return null;
}

function firstSingleMinute(text, pattern) {
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
    const minutes = Number(match[1]);
    if (Number.isFinite(minutes)) return [minutes, minutes];
  }
  return null;
}

function normalizeCheckpointSg(text) {
  const flat = text.replace(/\s+/g, " ");
  return {
    woodlands: {
      towardsJb: firstRange(flat, /(\d{1,3})\s*-\s*(\d{1,3})\s*mins?\s*to\s*J?B/i)
        ?? firstSingleMinute(flat, /(\d{1,3})\s*mins?\s*to\s*J?B/i),
      towardsSg: firstRange(flat, /(\d{1,3})\s*-\s*(\d{1,3})\s*mins?\s*to\s*S?G/i)
        ?? firstSingleMinute(flat, /(\d{1,3})\s*mins?\s*to\s*S?G/i),
    },
    tuas: {
      towardsJb: firstRange(flat, /\((\d{1,3})\s*-\s*(\d{1,3})\s*mins?\s*via\s*Tuas\)/i),
      towardsSg: (() => {
        const viaTuas = [...flat.matchAll(/\((\d{1,3})\s*-\s*(\d{1,3})\s*mins?\s*via\s*Tuas\)/gi)];
        const valid = viaTuas
          .map((match) => range(match[1], match[2]))
          .filter(Boolean);
        return valid[1] ?? null;
      })(),
    },
  };
}

function normalizeBeatTheJam(text) {
  const flat = text.replace(/&#10;/g, "\n").replace(/\r/g, "");
  const toJohor = flat.match(/TO JOHOR([\s\S]*?)TO SINGAPORE/i)?.[1] ?? "";
  const toSingapore = flat.match(/TO SINGAPORE([\s\S]*)/i)?.[1] ?? "";
  return {
    woodlands: {
      towardsJb: firstRange(toJohor, /Causeway\s+(\d{1,3})\s*-\s*(\d{1,3})\s*mins?/i),
      towardsSg: firstRange(toSingapore, /Causeway\s+(\d{1,3})\s*-\s*(\d{1,3})\s*mins?/i),
    },
    tuas: {
      towardsJb: firstRange(toJohor, /2nd\s+Link\s+(\d{1,3})\s*-\s*(\d{1,3})\s*mins?/i),
      towardsSg: firstRange(toSingapore, /2nd\s+Link\s+(\d{1,3})\s*-\s*(\d{1,3})\s*mins?/i),
    },
  };
}

function normalizeAppReadings(app, uiText, ocrText) {
  const text = [...uiText, ocrText].join("\n");
  if (app.id === "checkpoint-sg") return normalizeCheckpointSg(text);
  if (app.id === "beat-the-jam") return normalizeBeatTheJam(text);
  return null;
}

function googleMapsUrl(checkpoint, apiDirection) {
  const endpoints = routeEndpoints[checkpoint];
  const origin = apiDirection === "sg-my" ? endpoints.sg : endpoints.my;
  const destination = apiDirection === "sg-my" ? endpoints.my : endpoints.sg;
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.latitude},${origin.longitude}`,
    destination: `${destination.latitude},${destination.longitude}`,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function parseGoogleMapsMinutes(text) {
  const flat = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const patterns = [
    /Driving mode:\s*(?:(\d{1,2})\s*(?:hr|hour|hours)\s*)?(?:(\d{1,3})\s*(?:min|minute|minutes))?/i,
    /\bDrive\s+(?:(\d{1,2})\s*(?:hr|hour|hours)\s*)?(?:(\d{1,3})\s*(?:min|minute|minutes))?/i,
    /\b(?:(\d{1,2})\s*(?:hr|hour|hours)\s*)?(\d{1,3})\s*(?:min|minute|minutes)\b/i,
  ];
  for (const pattern of patterns) {
    const match = flat.match(pattern);
    if (!match) continue;
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2] ?? 0);
    const total = hours * 60 + minutes;
    if (Number.isFinite(total) && total > 0 && total < 360) return total;
  }
  return null;
}

function flattenReadings(record) {
  const rows = [];
  for (const [checkpoint, directions] of Object.entries(record.normalizedReadings || {})) {
    for (const [direction, minutes] of Object.entries(directions)) {
      if (!Array.isArray(minutes)) continue;
      rows.push({
        capturedAt: record.capturedAt,
        app: record.app,
        checkpoint,
        direction,
        lower: minutes[0],
        upper: minutes[1],
        midpoint: Math.round((minutes[0] + minutes[1]) / 2),
      });
    }
  }
  return rows;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

async function appendHistory(records) {
  const rows = records.flatMap(flattenReadings);
  if (!rows.length) return;
  const csvPath = join(outRoot, "history.csv");
  await mkdir(outRoot, { recursive: true });
  let exists = true;
  try {
    await access(csvPath);
  } catch {
    exists = false;
  }
  const lines = rows.map((row) => [
    row.capturedAt,
    row.app,
    row.checkpoint,
    row.direction,
    row.lower,
    row.upper,
    row.midpoint,
  ].map(csvEscape).join(","));
  if (!exists) {
    await writeFile(csvPath, `capturedAt,app,checkpoint,direction,lower,upper,midpoint\n${lines.join("\n")}\n`);
  } else {
    await appendFile(csvPath, `${lines.join("\n")}\n`);
  }
}

async function runOcr(imagePath) {
  try {
    const { stdout } = await run("tesseract", [imagePath, "stdout", "--psm", "6"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    return `OCR failed: ${error.message}`;
  }
}

async function dumpWindowXml(xmlPath) {
  let dumpError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await adbShell("uiautomator", "dump", "/sdcard/window.xml");
    } catch (error) {
      dumpError = error;
      // uiautomator occasionally exits 137 after successfully writing the XML.
    }

    try {
      const { stdout: xml } = await run(adb, adbArgs(["exec-out", "cat", "/sdcard/window.xml"]), {
        maxBuffer: 10 * 1024 * 1024,
      });
      if (xml.includes("<hierarchy")) {
        await writeFile(xmlPath, xml);
        return xml;
      }
    } catch (error) {
      dumpError = error;
    }

    await sleep(attempt * 1000);
  }
  throw dumpError ?? new Error("Unable to dump Android window XML");
}

function emptyReadings() {
  return {
    woodlands: { towardsJb: null, towardsSg: null },
    tuas: { towardsJb: null, towardsSg: null },
  };
}

function hasAnyReading(readings) {
  return Object.values(readings || {}).some((directions) => (
    Object.values(directions || {}).some((value) => Array.isArray(value))
  ));
}

function appErrorReason(app, uiText, ocrText) {
  const text = [...uiText, ocrText].join("\n").toLowerCase();
  if (text.includes("internet connection appears to be offline")) return "Android app reports offline";
  if (text.includes("unable to download images")) return "Checkpoint.sg image download failed";
  if (text.includes("problem reaching our server")) return "Beat the Jam server screen";
  if (text.includes("oops.") && app.id === "beat-the-jam") return "Beat the Jam error screen";
  return null;
}

async function recoverApp(app, reason) {
  await prepareDevice();
  if (app.id === "checkpoint-sg") {
    await adbShellOk("input", "tap", "895", "1390");
  } else if (app.id === "beat-the-jam") {
    await adbShellOk("input", "tap", "540", "1450");
  }
  await sleep(2000);
  await adbShellOk("am", "force-stop", app.packageName);
  await sleep(1000);
  if (reason) console.warn(`${app.name}: retrying after ${reason}.`);
}

async function runCheckpointRegionOcr(imagePath, appDir) {
  const cropSpecPath = join(appDir, "checkpoint-ocr-crops.json");
  const python = String.raw`
import json
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
img = Image.open(src).convert("L")
w, h = img.size

def box(left, top, width, height):
    return (
        round(left * w / 1080),
        round(top * h / 2400),
        round((left + width) * w / 1080),
        round((top + height) * h / 2400),
    )

# The Mi6 renders Checkpoint's image panel at 1920px high, while the former
# emulator capture is 2400px. Keep both timing labels inside their OCR crops.
if h <= 2100:
    crops = {
        "top": box(0, 700, 800, 250),
        "bottom": box(430, 1340, 650, 260),
    }
else:
    crops = {
        "top": box(0, 740, 760, 220),
        "bottom": box(480, 1350, 600, 300),
    }
written = {}
for name, crop_box in crops.items():
    crop = img.crop(crop_box)
    # White overlay text on camera footage becomes black text on a white page.
    thresholded = crop.point(lambda p: 0 if p > 180 else 255, "1")
    thresholded = thresholded.resize((thresholded.width * 3, thresholded.height * 3))
    path = out_dir / f"checkpoint-{name}-threshold.png"
    thresholded.save(path)
    written[name] = str(path)

print(json.dumps(written))
`;
  try {
    const { stdout } = await run("python3", ["-c", python, imagePath, appDir], {
      maxBuffer: 10 * 1024 * 1024,
    });
    await writeFile(cropSpecPath, stdout);
    const cropPaths = JSON.parse(stdout);
    const texts = [];
    for (const [name, cropPath] of Object.entries(cropPaths)) {
      const text = await run("tesseract", [
        cropPath,
        "stdout",
        "--psm",
        "6",
        "-c",
        "tessedit_char_whitelist=0123456789- minstoJBTuasvia()SG",
      ], { maxBuffer: 10 * 1024 * 1024 }).then(({ stdout: value }) => value.trim()).catch((error) => (
        `Checkpoint ${name} crop OCR failed: ${error.message}`
      ));
      if (text) texts.push(text);
    }
    return texts.join("\n");
  } catch (error) {
    return `Checkpoint crop OCR failed: ${error.message}`;
  }
}

async function captureApp(app, timestamp) {
  const appDir = join(outRoot, timestamp, app.id);
  await mkdir(appDir, { recursive: true });

  let record = null;
  const requestedAttempts = Number(process.env.APP_CAPTURE_ATTEMPTS || 3);
  const attempts = Number.isFinite(requestedAttempts) && requestedAttempts > 0
    ? Math.floor(requestedAttempts)
    : 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const suffix = attempt === 1 ? "" : `-attempt-${attempt}`;
    const screenshotPath = join(appDir, `screen${suffix}.png`);
    const xmlPath = join(appDir, `window${suffix}.xml`);
    try {
      await launchApp(app);
      const screenshot = await capture(adb, adbArgs(["exec-out", "screencap", "-p"]));
      await writeFile(screenshotPath, screenshot);

      const xml = await dumpWindowXml(xmlPath);
      const uiText = extractUiText(xml);
      const wholeScreenOcr = await runOcr(screenshotPath);
      const regionOcr = app.id === "checkpoint-sg"
        ? await runCheckpointRegionOcr(screenshotPath, appDir)
        : "";
      const ocrText = app.id === "checkpoint-sg"
        ? [regionOcr, wholeScreenOcr].filter(Boolean).join("\n")
        : wholeScreenOcr;
      const combinedText = [...uiText, ocrText].join("\n");
      const parsedDurations = parseDurations(combinedText);
      const normalizedReadings = normalizeAppReadings(app, uiText, ocrText);
      const errorReason = appErrorReason(app, uiText, ocrText);

      record = {
        capturedAt: new Date().toISOString(),
        app: app.name,
        packageName: app.packageName,
        screenshotPath,
        xmlPath,
        uiText,
        ocrText,
        parsedDurations,
        normalizedReadings: normalizedReadings ?? emptyReadings(),
        captureStatus: hasAnyReading(normalizedReadings) ? "ok" : "failed",
        captureError: errorReason,
        captureAttempt: attempt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        capturedAt: new Date().toISOString(),
        app: app.name,
        packageName: app.packageName,
        screenshotPath,
        xmlPath,
        uiText: [],
        ocrText: "",
        parsedDurations: [],
        normalizedReadings: emptyReadings(),
        captureStatus: "failed",
        captureError: `Capture error: ${message}`,
        captureAttempt: attempt,
      };
    }

    if (record.captureStatus === "ok" || attempt === attempts) break;
    await writeFile(join(appDir, `record-attempt-${attempt}.json`), `${JSON.stringify(record, null, 2)}\n`);
    try {
      await recoverApp(app, record.captureError || "no parseable readings");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${app.name}: recovery failed (${message}); retrying capture anyway.`);
    }
    await sleep(attempt * 2500);
  }

  await writeFile(join(appDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function captureGoogleMaps(timestamp) {
  const appDir = join(outRoot, timestamp, "google-maps");
  await mkdir(appDir, { recursive: true });
  const normalizedReadings = {
    woodlands: { towardsJb: null, towardsSg: null },
    tuas: { towardsJb: null, towardsSg: null },
  };
  const routes = [];

  for (const [checkpoint, endpoint] of Object.entries(routeEndpoints)) {
    for (const [directionKey, apiDirection] of Object.entries(directionMap)) {
      const routeId = `${checkpoint}-${directionKey}`;
      const url = googleMapsUrl(checkpoint, apiDirection);
      const routeDir = join(appDir, routeId);
      await mkdir(routeDir, { recursive: true });
      await run(adb, adbArgs([
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        url.replaceAll("&", "\\&"),
        "-p",
        googleMapsPackageName,
      ]));
      await sleep(Number(process.env.GOOGLE_MAPS_SETTLE_MS || 7000));

      const screenshotPath = join(routeDir, "screen.png");
      const xmlPath = join(routeDir, "window.xml");
      const screenshot = await capture(adb, adbArgs(["exec-out", "screencap", "-p"]));
      await writeFile(screenshotPath, screenshot);

      const xml = await dumpWindowXml(xmlPath);

      const uiText = extractUiText(xml);
      const minutes = parseGoogleMapsMinutes(uiText.join("\n"));
      if (minutes != null) normalizedReadings[checkpoint][directionKey] = [minutes, minutes];
      routes.push({
        checkpoint: endpoint.display,
        direction: apiDirection,
        directionKey,
        url,
        minutes,
        screenshotPath,
        xmlPath,
        uiText,
      });
    }
  }

  const record = {
    capturedAt: new Date().toISOString(),
    app: "Google Maps",
    packageName: googleMapsPackageName,
    routes,
    normalizedReadings,
    captureStatus: hasAnyReading(normalizedReadings) ? "ok" : "failed",
    captureError: hasAnyReading(normalizedReadings) ? null : "No parseable Google Maps readings",
  };
  await writeFile(join(appDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

async function main() {
  const command = process.argv[2] || "capture";
  if (command === "open-play") {
    await openPlayListings();
    return;
  }

  const networkReady = await prepareDevice();
  if (!networkReady) console.warn("Android network preflight failed; capture will still proceed.");
  const installed = Object.fromEntries(await Promise.all(
    apps.map(async (app) => [app.id, await isInstalled(app.packageName)]),
  ));
  installed["google-maps"] = await isInstalled(googleMapsPackageName);

  if (command === "status") {
    console.log(JSON.stringify({ adb, outRoot, installed }, null, 2));
    return;
  }

  const missing = selectedApps.filter((app) => !installed[app.id]);
  if (missing.length) {
    console.error("Missing competitor apps:");
    for (const app of missing) {
      console.error(`- ${app.name}: ${app.packageName}`);
    }
    console.error("Run: node scripts/capture-competitor-apps.mjs open-play");
    process.exitCode = 1;
    return;
  }

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const records = [];
  for (const app of selectedApps) records.push(await captureApp(app, timestamp));
  if (installed["google-maps"] && process.env.CAPTURE_GOOGLE_MAPS !== "false") {
    records.push(await captureGoogleMaps(timestamp));
  }
  await mkdir(join(outRoot, timestamp), { recursive: true });
  await writeFile(join(outRoot, timestamp, "summary.json"), `${JSON.stringify(records, null, 2)}\n`);
  await writeFile(join(outRoot, "latest-summary.json"), `${JSON.stringify(records, null, 2)}\n`);
  await appendHistory(records);
  console.log(JSON.stringify(records.map((record) => ({
    app: record.app,
    screenshotPath: record.screenshotPath,
    normalizedReadings: record.normalizedReadings,
  })), null, 2));
}

await main();
