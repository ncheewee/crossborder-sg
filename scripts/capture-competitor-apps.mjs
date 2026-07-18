import { execFile, spawn } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adb = process.env.ADB || "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const outRoot = process.env.COMPETITOR_CAPTURE_DIR || join(repoRoot, ".competitor-captures");

const apps = [
  {
    id: "checkpoint-sg",
    name: "Checkpoint.sg",
    packageName: "com.tplusinteractive.checkpointsg",
    launchActivity: "com.tplusinteractive.checkpointsg/.view.SplashActivity",
    playUrl: "market://details?id=com.tplusinteractive.checkpointsg",
  },
  {
    id: "beat-the-jam",
    name: "Beat the Jam",
    packageName: "com.phonegap.btj",
    launchActivity: "com.phonegap.btj/.MainActivity",
    playUrl: "market://details?id=com.phonegap.btj",
  },
];

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
  return run(adb, ["shell", ...args]);
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
    await run(adb, [
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      app.playUrl,
    ]);
    console.log(`Opened ${app.name} Play Store listing.`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function launchApp(app) {
  await run(adb, ["shell", "am", "start", "-n", app.launchActivity]);
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.APP_SETTLE_MS || 6000)));
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

function normalizeCheckpointSg(text) {
  const flat = text.replace(/\s+/g, " ");
  return {
    woodlands: {
      towardsJb: firstRange(flat, /(\d{1,3})\s*-\s*(\d{1,3})\s*mins?\s*to\s*J?B/i),
      towardsSg: firstRange(flat, /(\d{1,3})\s*-\s*(\d{1,3})\s*mins?\s*to\s*S?G/i),
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
  await launchApp(app);

  const screenshotPath = join(appDir, "screen.png");
  const xmlPath = join(appDir, "window.xml");
  const screenshot = await capture(adb, ["exec-out", "screencap", "-p"]);
  await writeFile(screenshotPath, screenshot);

  await adbShell("uiautomator", "dump", "/sdcard/window.xml");
  const { stdout: xml } = await run(adb, ["exec-out", "cat", "/sdcard/window.xml"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  await writeFile(xmlPath, xml);

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

  const record = {
    capturedAt: new Date().toISOString(),
    app: app.name,
    packageName: app.packageName,
    screenshotPath,
    xmlPath,
    uiText,
    ocrText,
    parsedDurations,
    normalizedReadings,
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

  await run(adb, ["wait-for-device"]);
  const installed = Object.fromEntries(await Promise.all(
    apps.map(async (app) => [app.id, await isInstalled(app.packageName)]),
  ));

  if (command === "status") {
    console.log(JSON.stringify({ adb, outRoot, installed }, null, 2));
    return;
  }

  const missing = apps.filter((app) => !installed[app.id]);
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
  for (const app of apps) records.push(await captureApp(app, timestamp));
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
