const SPREADSHEET_ID = "1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo";
const SHEET_NAME = "Checkpoint.sg";
const API_BASE = "https://crossborder-sg-api.ncheewee.workers.dev";
const MAX_AGE_MINUTES = 90;

function hourlyAppend() {
  const key = PropertiesService.getScriptProperties().getProperty("MONITOR_API_KEY");
  if (!key) throw new Error("MONITOR_API_KEY script property is not set");

  const response = UrlFetchApp.fetch(API_BASE + "/api/monitor/checkpoint?hours=4", {
    headers: { "X-Monitor-Key": key },
    muteHttpExceptions: true,
    followRedirects: true,
  });
  if (response.getResponseCode() >= 300) {
    throw new Error("Checkpoint capture API returned " + response.getResponseCode());
  }

  const payload = JSON.parse(response.getContentText());
  const captures = Array.isArray(payload.captures) ? payload.captures : [];
  const latest = latestCompleteWoodlands(captures);
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error("Missing tab " + SHEET_NAME);

  if (!latest) {
    return appendIfNew(sheet, [
      formatSgt(new Date()),
      "", "", "",
      "", "", "",
      "unavailable",
      "No complete Woodlands Checkpoint.sg capture in the last 4 hours.",
    ]);
  }

  const woodlands = latest.readings.woodlands;
  const jb = woodlands.towardsJb;
  const sg = woodlands.towardsSg;
  return appendIfNew(sheet, [
    formatSgt(new Date(latest.captured_at || latest.capturedAt)),
    jb[0], jb[1], midpoint(jb),
    sg[0], sg[1], midpoint(sg),
    latest.source || "mi6-macrodroid",
    latest.source === "android-emulator"
      ? "Worker source: android-emulator"
      : "OK: complete Mi6 capture from Worker.",
  ]);
}

function latestCompleteWoodlands(captures) {
  const now = Date.now();
  for (let index = captures.length - 1; index >= 0; index -= 1) {
    const capture = captures[index];
    const capturedAt = new Date(capture.captured_at || capture.capturedAt);
    if (Number.isNaN(capturedAt.getTime())) continue;
    if (now - capturedAt.getTime() > MAX_AGE_MINUTES * 60 * 1000) continue;
    const woodlands = capture.readings && capture.readings.woodlands;
    if (validRange(woodlands && woodlands.towardsJb) && validRange(woodlands && woodlands.towardsSg)) {
      return capture;
    }
  }
  return null;
}

function validRange(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every(function (item) { return typeof item === "number" && item > 0; })
    && value[1] >= value[0]
    && value[1] <= 240;
}

function midpoint(range) {
  return Math.round((Number(range[0]) + Number(range[1])) / 2);
}

function formatSgt(date) {
  return Utilities.formatDate(date, "Asia/Singapore", "yyyy-MM-dd HH:mm");
}

function appendIfNew(sheet, row) {
  const lastRow = Math.max(1, sheet.getLastRow());
  const timestamps = sheet.getRange(1, 1, lastRow, 1).getDisplayValues().flat();
  if (timestamps.indexOf(String(row[0])) !== -1) return "exists:" + row[0];
  sheet.getRange(lastRow + 1, 1, 1, 9).setValues([row]);
  return "appended:" + row[0];
}

function installHourlyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let index = 0; index < triggers.length; index += 1) {
    if (triggers[index].getHandlerFunction() === "hourlyAppend") {
      ScriptApp.deleteTrigger(triggers[index]);
    }
  }
  ScriptApp.newTrigger("hourlyAppend").timeBased().everyHours(1).create();
}

function setMonitorKey(key) {
  PropertiesService.getScriptProperties().setProperty("MONITOR_API_KEY", key);
}

function doGet(e) {
  const setupKey = e && e.parameter && e.parameter.key;
  const expected = PropertiesService.getScriptProperties().getProperty("MONITOR_API_KEY");
  if (setupKey && !expected) {
    PropertiesService.getScriptProperties().setProperty("MONITOR_API_KEY", setupKey);
  }
  const result = hourlyAppend();
  return ContentService.createTextOutput(String(result)).setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  if (e && e.postData && e.postData.contents) {
    const body = JSON.parse(e.postData.contents);
    if (Array.isArray(body.row) && body.row.length === 9) {
      const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
      return ContentService.createTextOutput(appendIfNew(sheet, body.row)).setMimeType(ContentService.MimeType.TEXT);
    }
  }
  return doGet(e);
}
