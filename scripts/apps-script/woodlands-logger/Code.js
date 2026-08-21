/**
 * Woodlands Checkpoint Logger — Apps Script
 * =========================================
 * Runs on Google's servers as ncheewee.backend@gmail.com. Independent of your
 * Mac being awake or Claude being open, and costs no Claude tokens.
 *
 * THREE PROVIDERS, THREE TABS — kept side by side so you can see whether they
 * agree on the SHAPE of the day before trusting any single one:
 *
 *   Tab "GMaps Scraped"  A: slot key | B–H: durations, POSTed to the doPost()
 *                        web app by the Claude Chrome scraping task
 *                        I–K: LTA camera image links — CURRENTLY PAUSED, see
 *                        CAMS_ENABLED. Existing images and links are retained.
 *
 *   Tab "Shadow Fit"     A: slot key | B–H: intercept + slope × GMaps plus the
 *                        Checkpoint.sg-learned bias. Same pink line as the
 *                        Telegram charts and the app listing. Rebuilt from
 *                        GMaps Scraped + Checkpoint.sg on each logHour.
 *
 *   Tab "TomTom API"     A: slot key | B–H: live traffic-aware minutes
 *                        I–O: free-flow minutes (true no-traffic baseline)
 *
 *   Tab "Mapbox API"     A: slot key | B–H: live minutes (driving-traffic)
 *                        I–O: baseline minutes (driving profile)
 *
 * Rows in all three tabs share the same slot key, so they join on column A.
 *
 * Note the baselines are NOT equivalent: TomTom's noTrafficTravelTime is true
 * free-flow, while Mapbox's `driving` profile uses typical/historical speeds.
 * Mapbox baselines will read slower. Don't compare the two baselines directly.
 *
 * SETUP
 *   1. Open the sheet → Extensions → Apps Script, replace Code.gs with this
 *   2. Project Settings → Script Properties → add:
 *        TOMTOM_API_KEY     <key from developer.tomtom.com>
 *        MAPBOX_TOKEN       <public pk. token from console.mapbox.com>
 *        INGEST_SECRET      <long random string, matches the scheduled task>
 *        GOOGLE_ROUTES_KEY  <optional — enables the Google fallback>
 *      Kept out of the code so no key sits in a file or in git.
 *      The Mapbox token must have NO URL restrictions — UrlFetchApp sends no
 *      Referer header, so any restriction returns 403.
 *
 *   GOOGLE SOURCE: the Chrome scraper is PRIMARY (free, matches what users see
 *   in the Maps app). GOOGLE_ROUTES_KEY only enables a fallback that fills
 *   routes the scraper missed for the current hour. Leave it unset and nothing
 *   changes except that missed hours stay blank.
 *   3. Run  setupSheets()   — renames Sheet1, creates provider tabs, headers
 *   4. Run  testProviders() — prints all routes from both APIs side by side so
 *                             you can sanity check cross-border routing
 *   5. Run  testRun()       — one full logging cycle, bypasses the time gate
 *   6. Run  setupTrigger()  — installs the 15-minute polling trigger
 *
 * Already ran setup for TomTom only? Just re-run setupSheets() — it is
 * idempotent and will add the Mapbox tab without touching existing data.
 */

// ─── Config ────────────────────────────────────────────────────────────────

const SHEET_ID      = '1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo';
const SHEET_GMAPS       = 'GMaps Scraped';
const SHEET_SHADOW      = 'Crossborder';
const SHEET_SHADOW_LEGACY = 'Shadow Fit';
const SHEET_SHADOW_LEGACY_2 = 'GMaps Adjusted';
const SHEET_PARAMETERS  = 'Parameters';
const SHEET_TOMTOM      = 'TomTom API';
const SHEET_MAPBOX      = 'Mapbox API';
const SHEET_CHECKPOINT  = 'Checkpoint.sg';

// Keep in sync with config/crossing-calibration.json and lib/shadow-fit.js.
const SHADOW_CALIBRATION = {
  displayOffsetMinutes: -5,
  minimumMinutes: 5,
  maximumMinutes: 180,
  biasHoldHours: 3,
  biasHalfLifeHours: 3,
  directions: {
    'sg-my': { intercept: 10, slope: 1.9, alpha: 0.25 },
    'my-sg': { intercept: 5, slope: 1.7, alpha: 0.65 },
  },
};
const CHECKPOINT_API    = 'https://crossborder-sg-api.ncheewee.workers.dev/api/monitor/checkpoint?hours=4';
const CHECKPOINT_MAX_AGE_MINUTES = 90;

// Which tab receives the camera links. They belong to neither provider — they
// are independent observations — so when the scraper is retired, change this
// one line to SHEET_TOMTOM and the images follow.
const SHEET_CAMS    = SHEET_GMAPS;

const ROOT_FOLDER   = 'Woodlands Checkpoint Cams';
const TZ            = 'Asia/Singapore';
const FEED_URL      = 'https://api.data.gov.sg/v1/transport/traffic-images';

// Camera capture is PAUSED. Set back to true to resume — nothing else needs
// changing, existing images and the I/J/K columns are left untouched.
const CAMS_ENABLED = false;

// Days to keep images before moving them to Drive trash. 0 = keep forever.
// At ~0.5 MB/hour this archive grows ~4.4 GB/year, so consider 180 or 365.
const RETENTION_DAYS = 0;

// The trigger polls every 15 min but real work happens once an hour, in the
// run-up to the hour mark, so each row is complete before that hour arrives.
// Apps Script gives no control over where in the hour a trigger lands, so
// polling and gating is the only way to hit a window. Keep this >= 45 so
// exactly one firing per hour qualifies.
const TARGET_MINUTE = 45;

// Google Routes API runs as a FALLBACK ONLY. The Chrome scraper is primary and
// writes B–H via doPost around :52. This gate fires later in the hour, checks
// whether the scraper actually landed, and fills the row only if it did not.
// Set to 0 to disable the fallback entirely.
const FALLBACK_MINUTE = 55;

// Watchdog: alert if any source has written nothing for this many hours.
const STALE_HOURS   = 3;
const ALERT_EMAIL   = 'ncheewee@gmail.com';
// Minimum gap between alert emails, so a long outage sends one message a day
// rather than one an hour.
const ALERT_COOLDOWN_HOURS = 12;

const CAMS = [
  { id: '2701', label: 'causeway'   },  // → col I
  { id: '2702', label: 'checkpoint' },  // → col J
  { id: '2704', label: 'bke'        }   // → col K
];

// Column order here defines B–H on both tabs. Do not reorder without also
// updating the Chrome scraping task, which writes B–H positionally.
const ROUTES = [
  { col: 'B', name: 'SG-JB A | BKE Flyover',        from: '1.421730,103.771179',  to: '1.466582,103.768091'   },
  { col: 'C', name: 'SG-JB B | BKE Junction',       from: '1.421730,103.771179',  to: '1.466582,103.768091'   },
  { col: 'D', name: 'SG-JB C | Woodlands Rd',       from: '1.426905,103.763665',  to: '1.466582,103.768091'   },
  { col: 'E', name: 'JB-SG A | Lingkaran Dalam S',  from: '1.472085,103.7651',    to: '1.4430746,103.7683229' },
  { col: 'F', name: 'JB-SG B | AH2',                from: '1.482406,103.7832',    to: '1.4430746,103.7683229' },
  { col: 'G', name: 'JB-SG C | Bukit Chagar',       from: '1.467340,103.7658',    to: '1.4430746,103.7683229' },
  { col: 'H', name: 'JB-SG D | Lingkaran Dalam N',  from: '1.465356,103.7702',    to: '1.4430746,103.7683229' }
];

const COL_TIMESTAMP = 1;   // A
const COL_ROUTE_1   = 2;   // B
const COL_FREEFLOW_1= 9;   // I on the TomTom/Mapbox tabs
const COL_CAM_1     = 9;   // I on the cams tab

// Crossborder extra columns after the seven route durations.
const COL_JAM_SGJB_KM  = 9;  // I
const COL_JAM_SGJB_MIN = 10; // J
const COL_JAM_C_KM     = 11; // K
const COL_JAM_C_MIN    = 12; // L
const COL_JAM_JBSG_KM  = 13; // M
const COL_JAM_JBSG_MIN = 14; // N
const JAM_COL_COUNT    = 6;

// Plaza reference for jam length: 0 km when the tail is at the checkpoint.
const JAM_REF = { lat: 1.443307, lng: 103.767903 };
const JAM_PROBES = [
  { key: 'sg_jb', from: '1.421730,103.771179', to: '1.466582,103.768091', kmCol: COL_JAM_SGJB_KM, minCol: COL_JAM_SGJB_MIN },
  { key: 'sg_jb_c', from: '1.426905,103.763665', to: '1.466582,103.768091', kmCol: COL_JAM_C_KM, minCol: COL_JAM_C_MIN },
  { key: 'jb_sg', from: '1.482406,103.7832', to: '1.4430746,103.7683229', kmCol: COL_JAM_JBSG_KM, minCol: COL_JAM_JBSG_MIN },
];

// L on the GMaps tab: one Source label for the whole row — Mi6, Mac, or API.
const COL_GMAPS_SOURCE = 12; // L
const SRC_MI6       = 'Mi6';
const SRC_MAC       = 'Mac';
const SRC_API       = 'API';

// ─── Main hourly job ───────────────────────────────────────────────────────

function logHour() {
  const now = new Date();

  // Checkpoint.sg is independent of the Google hourly gates. Pull every poll
  // and upsert into the capture's 15-minute slot.
  Logger.log('GMaps source columns — ' + collapseGmapsSourceColumns());
  paintExistingGmapsSources();
  paintExistingCheckpointSources();
  const checkpointSheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
  if (checkpointSheet && checkpointNeedsCleanup(checkpointSheet)) {
    Logger.log('Checkpoint.sg cleanup — ' + cleanupCheckpointSheet());
  }
  Logger.log('Checkpoint.sg — ' + logCheckpoint());

  const minute     = Number(Utilities.formatDate(now, TZ, 'm'));
  const hourSlot   = Utilities.formatDate(roundToHour(now), TZ, 'yyyy-MM-dd HH:00');
  const quarter    = floorToQuarter(now);
  const quarterStr = Utilities.formatDate(quarter, TZ, 'yyyy-MM-dd HH:mm');

  // TomTom/Mapbox/GMaps: one API pass per 15-minute slot. Skip if that slot
  // is full so the 5-minute poll does not burn quota 3×. GMaps prefers a
  // Maps reading (Mi6, or Claude scrape when the Mac is on). Routes only
  // fills empty cells.
  if (logHour.force
      || !providerSlotFilled(SHEET_TOMTOM, quarterStr)
      || !providerSlotFilled(SHEET_MAPBOX, quarterStr)) {
    const tomtom = logTomTom(quarterStr);
    const mapbox = logMapbox(quarterStr);
    const cams   = (CAMS_ENABLED && (minute >= TARGET_MINUTE || logHour.force))
      ? logCameras(roundToHour(now), hourSlot)
      : 'paused';
    Logger.log('Slot ' + quarterStr + ' | TomTom: ' + tomtom
               + ' | Mapbox: ' + mapbox + ' | cams: ' + cams);
  } else {
    Logger.log('Slot ' + quarterStr + ' | TomTom/Mapbox already filled');
  }

  // Give Mi6 ~8 minutes to land Maps times before spending Routes quota.
  const minuteOfQuarter = minute % 15;
  if ((logHour.force || minuteOfQuarter >= 8) && !providerSlotFilled(SHEET_GMAPS, quarterStr)) {
    Logger.log('GMaps ' + quarterStr + ' — ' + backfillGoogle(quarterStr));
  }

  // Late window: give the hourly Chrome scrape one last chance on the :00 row.
  if (FALLBACK_MINUTE && minute >= FALLBACK_MINUTE && !logHour.force) {
    Logger.log('Fallback window — ' + backfillGoogle(hourSlot));
    watchdog();
  }

  Logger.log('Jam lengths — ' + logJamLengths(quarterStr));
  Logger.log('Crossborder — ' + rebuildShadowFit());
}

// ─── Ingest endpoint for the Google Maps scraper ───────────────────────────

/**
 * Web app POST endpoint. Lets the Chrome scraping task hand over its seven
 * durations in a single HTTP call instead of driving the spreadsheet UI.
 *
 * That UI driving was the source of three separate bugs: a hardcoded Name Box
 * coordinate that broke when the window resized, timestamps silently coerced
 * from text to datetime, and fragile last-row detection. All of it disappears
 * here — row placement and type handling happen in one place, server-side.
 *
 * DEPLOY: Extensions → Deploy → New deployment → type "Web app"
 *   Execute as:      Me (ncheewee.backend@gmail.com)
 *   Who has access:  Anyone
 * Copy the /exec URL. "Anyone" is required because the caller is an unauth'd
 * curl; the shared secret below is what actually gates writes.
 *
 * SECRET: Script Properties → INGEST_SECRET → a long random string.
 * Requests without a matching secret are rejected and logged.
 *
 * Expected body (JSON):
 *   { "secret": "...", "slot": "2026-07-30 17:00", "values": [28,24,21,40,41,40,38] }
 *
 * Values may be integers or the string "ERR". Exactly 7 are required.
 */
function doPost(e) {
  try {
    const expected = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
    if (!expected) return jsonOut({ ok: false, error: 'INGEST_SECRET not configured' });

    const body = JSON.parse(e.postData.contents);

    if (body.secret !== expected) {
      Logger.log('Rejected ingest: bad secret');
      return jsonOut({ ok: false, error: 'unauthorized' });
    }
    if (body.type === 'setup-monitor-key') {
      if (!body.key) return jsonOut({ ok: false, error: 'key required' });
      PropertiesService.getScriptProperties().setProperty('MONITOR_API_KEY', String(body.key));
      return jsonOut({ ok: true, setup: 'MONITOR_API_KEY' });
    }
    if (body.type === 'checkpoint-sync') {
      const result = logCheckpoint();
      rebuildShadowFit();
      return jsonOut({ ok: true, result: result });
    }
    if (body.type === 'checkpoint-cleanup') {
      return jsonOut({ ok: true, result: cleanupCheckpointSheet() });
    }
    if (body.type === 'shadow-rebuild') {
      return jsonOut({ ok: true, result: rebuildShadowFit() });
    }
    if (body.type === 'parameters-sync') {
      return jsonOut({ ok: true, result: writeParametersSheet() });
    }
    if (body.type === 'jam-log') {
      const slot = body.slot || Utilities.formatDate(floorToQuarter(new Date()), TZ, 'yyyy-MM-dd HH:mm');
      const jam = logJamLengths(slot);
      const rebuilt = rebuildShadowFit();
      return jsonOut({ ok: true, result: jam + '; ' + rebuilt });
    }
    if (body.type === 'checkpoint') {
      if (!Array.isArray(body.row) || body.row.length !== 9) {
        return jsonOut({ ok: false, error: 'row must be 9 cells' });
      }
      const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
      if (!sh) return jsonOut({ ok: false, error: 'tab "' + SHEET_CHECKPOINT + '" not found' });
      const result = appendCheckpointRow(sh, body.row);
      rebuildShadowFit();
      return jsonOut({ ok: true, result: result });
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(body.slot || ''))) {
      return jsonOut({ ok: false, error: 'slot must be "YYYY-MM-DD HH:MM"' });
    }
    body.slot = quarterSlot(body.slot);
    if (!Array.isArray(body.values) || body.values.length !== ROUTES.length) {
      return jsonOut({ ok: false, error: 'values must be an array of ' + ROUTES.length });
    }

    // Coerce to integers, preserving ERR and treating anything unparseable as
    // missing rather than as zero.
    let row = body.values.map(function (v) {
      if (v === 'ERR' || v === null || v === '') return 'ERR';
      const n = Number(v);
      return isFinite(n) ? Math.round(n) : 'ERR';
    });

    const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_GMAPS);
    if (!sh) return jsonOut({ ok: false, error: 'tab "' + SHEET_GMAPS + '" not found' });

    if (body.source === 'mi6-maps') {
      row = row.map(function (v) { return typeof v === 'number' && v < 5 ? 'ERR' : v; });
      const good = row.filter(function (v) { return v !== 'ERR'; }).length;
      if (good < 5) {
        return jsonOut({ ok: false, error: 'mi6-maps row looks implausible; not overwriting' });
      }
    }

    const r = findOrCreateRow(sh, body.slot);
    sh.getRange(r, COL_ROUTE_1, 1, row.length).setValues([row]);

    const landed = row.some(function (v) { return v !== 'ERR'; });
    writeGmapsSource(sh, r, landed ? (body.source === 'mi6-maps' ? SRC_MI6 : SRC_MAC) : '');

    Logger.log('Ingest ' + body.slot + ' → row ' + r + ' : ' + row.join('/'));
    logJamLengths(body.slot);
    rebuildShadowFit();
    return jsonOut({ ok: true, slot: body.slot, row: r, values: row });

  } catch (err) {
    Logger.log('Ingest failed: ' + err);
    return jsonOut({ ok: false, error: String(err) });
  }
}

/** Health check — open the /exec URL in a browser to confirm the deployment. */
function doGet() {
  return jsonOut({ ok: true, service: 'woodlands-logger', tab: SHEET_GMAPS });
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

// ─── TomTom routing ────────────────────────────────────────────────────────

/**
 * Fetches live and free-flow travel times for all 7 routes and writes them to
 * the TomTom tab. Returns a short status string for the log.
 */
function logTomTom(slotStr) {
  const key = PropertiesService.getScriptProperties().getProperty('TOMTOM_API_KEY');
  if (!key) {
    Logger.log('TOMTOM_API_KEY script property not set — skipping TomTom leg.');
    return 'no key';
  }

  const live = [];
  const free = [];
  var ok = 0;

  ROUTES.forEach(function (r) {
    const res = fetchTomTomRoute(r, key);
    live.push(res.live);
    free.push(res.free);
    if (res.live !== 'ERR') ok++;
  });

  return writeProviderRow(SHEET_TOMTOM, slotStr, live, free, ok);
}

/**
 * One TomTom calculateRoute call.
 *
 * traffic=true makes travelTimeInSeconds live-traffic-aware.
 * computeTravelTimeFor=all additionally returns noTrafficTravelTimeInSeconds,
 * which is the free-flow baseline — subtract to get pure congestion.
 *
 * Returns minutes as integers, or 'ERR' on any failure. Never throws: one bad
 * route must not cost us the other six or the camera images.
 */
function fetchTomTomRoute(route, key) {
  const url = 'https://api.tomtom.com/routing/1/calculateRoute/'
            + encodeURIComponent(route.from) + ':' + encodeURIComponent(route.to)
            + '/json'
            + '?key=' + encodeURIComponent(key)
            + '&traffic=true'
            + '&routeType=fastest'
            + '&travelMode=car'
            + '&computeTravelTimeFor=all';

  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log(route.name + ': HTTP ' + resp.getResponseCode() + ' — '
                 + resp.getContentText().slice(0, 200));
      return { live: 'ERR', free: 'ERR' };
    }

    const s = JSON.parse(resp.getContentText()).routes[0].summary;
    return {
      live: Math.round(s.travelTimeInSeconds / 60),
      free: s.noTrafficTravelTimeInSeconds
              ? Math.round(s.noTrafficTravelTimeInSeconds / 60)
              : ''
    };
  } catch (e) {
    Logger.log(route.name + ' failed: ' + e);
    return { live: 'ERR', free: 'ERR' };
  }
}

// ─── Google Routes API — FALLBACK ONLY ─────────────────────────────────────

/**
 * Fills columns B–H on the GMaps tab from the Google Routes API, but ONLY for
 * routes the Chrome scraper left empty for this slot.
 *
 * Scraping stays primary: it is free, and it returns exactly what a user sees
 * in the Maps app. This exists because the scraper depends on a Mac being awake
 * and a browser extension being connected, and has historically lost ~35% of
 * hours to those two things.
 *
 * Deliberately does NOT overwrite scraped values, and does NOT touch rows for
 * past slots — Routes API reports conditions *now*, so backfilling an old
 * slot with current traffic would silently fabricate history. Off-hour
 * 15-minute rows have no scrape, so they are Routes-only by design.
 */
function displayGmapsSource(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  if (lower === 'mi6' || lower.includes('mi6')) return SRC_MI6;
  if (lower === 'mac' || lower.includes('scrape')) return SRC_MAC;
  if (lower === 'api' || lower.includes('routes')) return SRC_API;
  return text;
}

function summarizeGmapsSources(marks) {
  const unique = [];
  (marks || []).forEach(function (mark) {
    const value = displayGmapsSource(mark);
    if (value && unique.indexOf(value) === -1) unique.push(value);
  });
  return unique.join(' + ');
}

const COLOR_SYNTHETIC = '#FDE68A'; // amber — API / emulator
const COLOR_REAL = '#FFFFFF';

function isSyntheticGmapsLabel(label) {
  return String(label || '').toLowerCase().indexOf('api') !== -1;
}

function paintGmapsRow(sh, row, label) {
  const fill = isSyntheticGmapsLabel(label) ? COLOR_SYNTHETIC : COLOR_REAL;
  sh.getRange(row, COL_ROUTE_1, 1, ROUTES.length).setBackground(fill);
  sh.getRange(row, COL_GMAPS_SOURCE).setBackground(fill);
}

function writeGmapsSource(sh, row, label) {
  if (String(sh.getRange(1, COL_GMAPS_SOURCE).getDisplayValue()).trim() !== 'Source') {
    sh.getRange(1, COL_GMAPS_SOURCE).setValue('Source').setFontWeight('bold');
  }
  sh.getRange(row, COL_GMAPS_SOURCE).setValue(label || '');
  paintGmapsRow(sh, row, label);
}

function collapseGmapsSourceColumns() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_GMAPS);
  if (!sh) return 'GMaps tab missing';
  const lastCol = sh.getLastColumn();
  const headerL = String(sh.getRange(1, COL_GMAPS_SOURCE).getDisplayValue()).trim();
  if (headerL === 'Source' && lastCol <= COL_GMAPS_SOURCE) return 'already collapsed';

  const lastRow = sh.getLastRow();
  const width = Math.max(1, lastCol - COL_GMAPS_SOURCE + 1);
  if (lastRow >= 2) {
    const block = sh.getRange(2, COL_GMAPS_SOURCE, lastRow - 1, width).getDisplayValues();
    const summaries = block.map(function (row) { return [summarizeGmapsSources(row)]; });
    sh.getRange(2, COL_GMAPS_SOURCE, lastRow - 1, width).clearContent();
    sh.getRange(2, COL_GMAPS_SOURCE, summaries.length, 1).setValues(summaries);
    for (var i = 0; i < summaries.length; i++) {
      paintGmapsRow(sh, i + 2, summaries[i][0]);
    }
  }
  if (width > 1) {
    sh.getRange(1, COL_GMAPS_SOURCE, 1, width).clearContent();
  }
  sh.getRange(1, COL_GMAPS_SOURCE).setValue('Source').setFontWeight('bold');
  return 'collapsed ' + Math.max(0, lastRow - 1) + ' rows';
}

function backfillGoogle(slotStr) {
  const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_ROUTES_KEY');
  if (!key) return 'no GOOGLE_ROUTES_KEY — fallback disabled';

  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('GMAPS_API_SLOT') === slotStr && !logHour.force) {
    return 'already attempted ' + slotStr;
  }

  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_GMAPS);
  if (!sh) return 'GMaps tab missing';

  const lastRowBefore = sh.getLastRow();
  const row      = findOrCreateRow(sh, slotStr);
  const created  = row > lastRowBefore;
  const rng      = sh.getRange(row, COL_ROUTE_1, 1, ROUTES.length);
  const existing = rng.getValues()[0];

  const missing = [];
  existing.forEach(function (v, i) {
    if (v === '' || v === null || v === 'ERR') missing.push(i);
  });
  if (!missing.length) return 'scraper covered all 7 — nothing to backfill';

  const priorSource = displayGmapsSource(sh.getRange(row, COL_GMAPS_SOURCE).getDisplayValue());
  const hadExisting = existing.some(function (v) { return v !== '' && v !== null && v !== 'ERR'; });
  const out = existing.slice();
  var ok = 0;
  var hit429 = false;
  missing.forEach(function (i) {
    if (hit429) return;
    const result = fetchGoogleRoute(ROUTES[i], key);
    if (result.mins !== 'ERR') {
      out[i] = result.mins;
      ok++;
    }
    if (result.status === 429) hit429 = true;
    Utilities.sleep(1200);
  });
  props.setProperty('GMAPS_API_SLOT', slotStr);

  const stillEmpty = out.every(function (v) { return v === '' || v === null || v === 'ERR'; });
  if (stillEmpty && created) {
    sh.deleteRow(row);
    return hit429 ? '429 quota — no row written' : 'API empty — no row written';
  }

  rng.setValues([out]);
  var label = SRC_API;
  if (hadExisting && priorSource && priorSource !== SRC_API) {
    label = priorSource + ' + ' + SRC_API;
  } else if (hadExisting && priorSource) {
    label = priorSource;
  }
  writeGmapsSource(sh, row, ok >= 5 ? label : (hadExisting ? priorSource : ''));
  return (hit429 ? '429 after ' : 'backfilled ') + ok + '/' + missing.length + ' missing route(s) → row ' + row;
}

/** One Routes API call with 429 retries. Returns { mins, status }. Never throws. */
function fetchGoogleRoute(route, key) {
  const from = route.from.split(',').map(Number);
  const to   = route.to.split(',').map(Number);

  const payload = {
    origin:      { location: { latLng: { latitude: from[0], longitude: from[1] } } },
    destination: { location: { latLng: { latitude: to[0],   longitude: to[1]   } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE'
  };

  var lastStatus = 0;
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = UrlFetchApp.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      lastStatus = resp.getResponseCode();
      if (lastStatus === 200) {
        const body = JSON.parse(resp.getContentText());
        if (!body.routes || !body.routes.length) return { mins: 'ERR', status: 200 };
        return {
          mins: Math.round(parseFloat(String(body.routes[0].duration).replace('s', '')) / 60),
          status: 200,
        };
      }
      Logger.log('Routes ' + route.name + ': HTTP ' + lastStatus
                 + ' — ' + resp.getContentText().slice(0, 200));
      if (lastStatus === 429 || lastStatus === 503) {
        Utilities.sleep(2500 * attempt);
        continue;
      }
      return { mins: 'ERR', status: lastStatus };
    } catch (e) {
      Logger.log('Routes ' + route.name + ' failed: ' + e);
      lastStatus = 0;
      Utilities.sleep(1500 * attempt);
    }
  }
  return { mins: 'ERR', status: lastStatus || 429 };
}

// ─── Watchdog ──────────────────────────────────────────────────────────────

/**
 * Emails if any source has gone quiet. Exists because a shadowed doPost once
 * silently killed Google collection for a fortnight before anyone noticed —
 * the whole point is that a dead source announces itself rather than being
 * discovered later in the data.
 *
 * Throttled via a Script Property so a long outage sends one mail a day.
 */
function watchdog() {
  const ss  = SpreadsheetApp.openById(SHEET_ID);
  const now = Date.now();
  const problems = [];

  [[SHEET_GMAPS, 'Google (scraped)'], [SHEET_TOMTOM, 'TomTom'], [SHEET_MAPBOX, 'Mapbox'], [SHEET_CHECKPOINT, 'Checkpoint.sg']]
    .forEach(function (pair) {
      const sh = ss.getSheetByName(pair[0]);
      if (!sh) { problems.push(pair[1] + ': tab "' + pair[0] + '" is missing'); return; }

      const last = sh.getLastRow();
      if (last < 2) { problems.push(pair[1] + ': no data rows at all'); return; }

      // Walk upward to the most recent row that actually has values in B–H.
      const scan = Math.min(48, last - 1);
      const vals = sh.getRange(last - scan + 1, COL_TIMESTAMP, scan, 1 + ROUTES.length).getValues();
      var newest = null;
      for (var i = vals.length - 1; i >= 0; i--) {
        const hasData = vals[i].slice(1).some(function (v) {
          return v !== '' && v !== null && v !== 'ERR';
        });
        if (hasData) { newest = String(vals[i][0]); break; }
      }
      if (!newest) { problems.push(pair[1] + ': no populated row in the last ' + scan + ' rows'); return; }

      const m = newest.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
      if (!m) { problems.push(pair[1] + ': unparseable timestamp "' + newest + '"'); return; }

      const ts  = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const age = (now - ts.getTime()) / 3600000;
      if (age > STALE_HOURS) {
        problems.push(pair[1] + ': last data ' + newest + ' (' + age.toFixed(1) + 'h ago)');
      }
    });

  if (!problems.length) return 'all sources fresh';

  const props = PropertiesService.getScriptProperties();
  const lastAlert = Number(props.getProperty('LAST_ALERT_MS') || 0);
  if (now - lastAlert < ALERT_COOLDOWN_HOURS * 3600000) {
    return 'stale but within cooldown: ' + problems.join('; ');
  }

  try {
    MailApp.sendEmail(ALERT_EMAIL,
      'Woodlands logger: ' + problems.length + ' source(s) stale',
      'The Woodlands checkpoint logger has sources that have stopped writing.\n\n'
      + problems.map(function (p) { return '  • ' + p; }).join('\n')
      + '\n\nThreshold: ' + STALE_HOURS + ' hours.\n'
      + 'Sheet: https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit\n\n'
      + 'Google is scraped by a Claude scheduled task and needs both the Mac awake\n'
      + 'and the Chrome extension connected. TomTom and Mapbox run server-side and\n'
      + 'should never be stale unless an API key has expired or a quota is exhausted.\n');
    props.setProperty('LAST_ALERT_MS', String(now));
    return 'ALERTED: ' + problems.join('; ');
  } catch (e) {
    return 'alert failed: ' + e + ' | ' + problems.join('; ');
  }
}

/** Run by hand to see watchdog status without waiting for the trigger. */
function testWatchdog() { Logger.log(watchdog()); }

// ─── Mapbox routing ────────────────────────────────────────────────────────

/**
 * Fetches live and baseline travel times for all 7 routes and writes them to
 * the Mapbox tab. Returns a short status string for the log.
 *
 * Two calls per route (driving-traffic + driving) = 14 calls per 15-min slot
 * ≈ 40,400 a month, about 40% of Mapbox's 100,000/month free tier.
 */
function logMapbox(slotStr) {
  const token = PropertiesService.getScriptProperties().getProperty('MAPBOX_TOKEN');
  if (!token) {
    Logger.log('MAPBOX_TOKEN script property not set — skipping Mapbox leg.');
    return 'no token';
  }

  const live = [];
  const base = [];
  var ok = 0;

  ROUTES.forEach(function (r) {
    const l = fetchMapboxRoute(r, token, 'driving-traffic');
    const b = fetchMapboxRoute(r, token, 'driving');
    live.push(l);
    base.push(b);
    if (l !== 'ERR') ok++;
  });

  return writeProviderRow(SHEET_MAPBOX, slotStr, live, base, ok);
}

/**
 * Writes one provider's live + baseline values to its tab.
 *
 * Returns a status string rather than throwing on a missing tab. This matters:
 * logHour() calls the providers before the cameras, so an exception here would
 * silently kill the camera archive for that hour. A missing tab is a setup
 * omission, not a reason to lose data.
 */
function writeProviderRow(tabName, slotStr, live, baseline, ok) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(tabName);
  if (!sh) {
    Logger.log('Tab "' + tabName + '" not found — run setupSheets(). Skipping.');
    return 'tab missing';
  }
  const row = findOrCreateRow(sh, slotStr);
  sh.getRange(row, COL_ROUTE_1,    1, live.length).setValues([live]);
  sh.getRange(row, COL_FREEFLOW_1, 1, baseline.length).setValues([baseline]);
  return ok + '/' + ROUTES.length + ' routes → row ' + row;
}

/**
 * One Mapbox Directions call. Returns minutes as an integer, or 'ERR'.
 *
 * profile: 'driving-traffic' for live conditions, 'driving' for the baseline.
 *
 * WATCH THE COORDINATE ORDER. Mapbox takes lon,lat — the reverse of TomTom and
 * of how ROUTES stores them. Getting this backwards does not error; it silently
 * routes somewhere in the Indian Ocean and returns a plausible-looking number.
 */
function fetchMapboxRoute(route, token, profile) {
  const url = 'https://api.mapbox.com/directions/v5/mapbox/' + profile + '/'
            + toLonLat(route.from) + ';' + toLonLat(route.to)
            + '?access_token=' + encodeURIComponent(token)
            + '&overview=false&alternatives=false&geometries=geojson';

  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('Mapbox ' + profile + ' ' + route.name + ': HTTP '
                 + resp.getResponseCode() + ' — ' + resp.getContentText().slice(0, 200));
      return 'ERR';
    }
    const body = JSON.parse(resp.getContentText());
    if (!body.routes || !body.routes.length) {
      Logger.log('Mapbox ' + profile + ' ' + route.name + ': no route returned');
      return 'ERR';
    }
    return Math.round(body.routes[0].duration / 60);
  } catch (e) {
    Logger.log('Mapbox ' + profile + ' ' + route.name + ' failed: ' + e);
    return 'ERR';
  }
}

/** "1.439328,103.768422" (lat,lng) → "103.768422,1.439328" (lon,lat). */
function toLonLat(latLng) {
  const p = latLng.split(',');
  return p[1].trim() + ',' + p[0].trim();
}

// ─── LTA cameras → Drive ───────────────────────────────────────────────────

function logCameras(slot, slotStr) {
  const fnDate  = Utilities.formatDate(slot, TZ, 'yyyy-MM-dd');
  const fnTime  = Utilities.formatDate(slot, TZ, 'HHmm');
  const fnMonth = Utilities.formatDate(slot, TZ, 'yyyy-MM');

  const folder = getOrCreateFolder(
    getOrCreateFolder(DriveApp.getRootFolder(), ROOT_FOLDER), fnMonth);

  let feed = {};
  try {
    const resp = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
    JSON.parse(resp.getContentText()).items[0].cameras.forEach(function (c) {
      feed[c.camera_id] = c;
    });
  } catch (e) {
    Logger.log('Camera feed fetch failed: ' + e);
  }

  const links = CAMS.map(function (cam) {
    const c = feed[cam.id];
    if (!c) return 'ERR';
    try {
      // WDL_2026-07-28_2300_cam2702_checkpoint.jpg
      // The date+time segment is the SLOT KEY, byte-identical to column A, so
      // images join to timings on a plain string match. True capture time goes
      // in the file description — it drifts a few minutes from the slot.
      const name = ['WDL', fnDate, fnTime, 'cam' + cam.id, cam.label].join('_') + '.jpg';

      // Overwrite rather than duplicate: Drive happily allows two files with
      // the same name, which would make the archive ambiguous if a run repeats.
      const dupes = folder.getFilesByName(name);
      while (dupes.hasNext()) dupes.next().setTrashed(true);

      const file = folder.createFile(UrlFetchApp.fetch(c.image).getBlob().setName(name));
      file.setDescription([
        'slot='      + slotStr,
        'camera_ts=' + c.timestamp,
        'camera_id=' + cam.id,
        'location='  + cam.label,
        'lat='       + c.location.latitude,
        'lng='       + c.location.longitude,
        'source='    + c.image
      ].join(' | '));
      return file.getUrl();
    } catch (e) {
      Logger.log('Camera ' + cam.id + ' save failed: ' + e);
      return 'ERR';
    }
  });

  const sh  = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CAMS);
  const row = findOrCreateRow(sh, slotStr);
  sh.getRange(row, COL_CAM_1, 1, links.length).setValues([links]);

  return links.filter(function (l) { return l !== 'ERR'; }).length + '/3 → row ' + row;
}

// ─── Checkpoint.sg from the Worker ─────────────────────────────────────────

/**
 * Reads complete Woodlands captures from the Worker and upserts one A:I row
 * per SGT 15-minute slot. Idempotent on the slot. No Mac file involved.
 */
function logCheckpoint() {
  const key = PropertiesService.getScriptProperties().getProperty('MONITOR_API_KEY');
  if (!key) return 'no MONITOR_API_KEY — skipping';

  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
  if (!sh) return 'tab "' + SHEET_CHECKPOINT + '" missing';

  try {
    var resp = null;
    var lastStatus = '';
    for (var attempt = 1; attempt <= 4; attempt++) {
      resp = UrlFetchApp.fetch(CHECKPOINT_API, {
        headers: {
          'X-Monitor-Key': key,
          'Authorization': 'Bearer ' + key,
        },
        muteHttpExceptions: true,
        followRedirects: true,
      });
      if (resp.getResponseCode() === 200) break;
      lastStatus = 'Worker HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 160);
      Utilities.sleep(1500 * attempt);
    }
    if (!resp || resp.getResponseCode() !== 200) return lastStatus;
    const captures = JSON.parse(resp.getContentText()).captures || [];
    const complete = completeWoodlandsInWindow(captures);
    if (!complete.length) return 'no fresh complete capture';
    return complete.map(function (capture) {
      const woodlands = capture.readings.woodlands;
      const source = capture.source || 'mi6-macrodroid';
      const capturedAt = new Date(capture.captured_at || capture.capturedAt);
      return appendCheckpointRow(sh, [
        Utilities.formatDate(floorToQuarter(capturedAt), TZ, 'yyyy-MM-dd HH:mm'),
        woodlands.towardsJb[0], woodlands.towardsJb[1], midpoint(woodlands.towardsJb),
        woodlands.towardsSg[0], woodlands.towardsSg[1], midpoint(woodlands.towardsSg),
        source,
        source === 'android-emulator'
          ? 'Worker source: android-emulator'
          : 'OK: complete Mi6 capture from Worker.',
      ]);
    }).join('; ');
  } catch (e) {
    return 'failed: ' + e;
  }
}

function completeWoodlandsInWindow(captures) {
  const now = Date.now();
  const out = [];
  for (var i = 0; i < captures.length; i++) {
    const capture = captures[i];
    const capturedAt = new Date(capture.captured_at || capture.capturedAt);
    if (isNaN(capturedAt.getTime())) continue;
    if (now - capturedAt.getTime() > CHECKPOINT_MAX_AGE_MINUTES * 60000) continue;
    const woodlands = capture.readings && capture.readings.woodlands;
    if (validCheckpointRange(woodlands && woodlands.towardsJb)
        && validCheckpointRange(woodlands && woodlands.towardsSg)) {
      out.push(capture);
    }
  }
  return out;
}

function latestCompleteWoodlands(captures) {
  const complete = completeWoodlandsInWindow(captures);
  return complete.length ? complete[complete.length - 1] : null;
}

function validCheckpointRange(value) {
  return Object.prototype.toString.call(value) === '[object Array]'
    && value.length === 2
    && typeof value[0] === 'number' && value[0] > 0
    && typeof value[1] === 'number' && value[1] >= value[0] && value[1] <= 240;
}

function midpoint(range) {
  return Math.round((Number(range[0]) + Number(range[1])) / 2);
}

function quarterSlot(stamp) {
  const match = String(stamp || '').trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/);
  if (!match) return String(stamp || '').trim();
  const minute = Math.floor(Number(match[3]) / 15) * 15;
  return match[1] + ' ' + match[2] + ':' + ('0' + minute).slice(-2);
}

function checkpointSourceRank(source) {
  const value = String(source || '').trim();
  if (value === 'mi6-macrodroid') return 2;
  if (value && value !== 'unavailable') return 1;
  return 0;
}

function paintExistingGmapsSources() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_GMAPS);
  if (!sh) return;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const labels = sh.getRange(2, COL_GMAPS_SOURCE, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < labels.length; i++) paintGmapsRow(sh, i + 2, labels[i][0]);
}

function paintExistingCheckpointSources() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
  if (!sh) return;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const sources = sh.getRange(2, 8, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < sources.length; i++) paintCheckpointRow(sh, i + 2, sources[i][0]);
}

function paintCheckpointRow(sh, row, source) {
  const fill = String(source || '').indexOf('emulator') !== -1 ? COLOR_SYNTHETIC : COLOR_REAL;
  sh.getRange(row, 1, 1, 9).setBackground(fill);
}

function appendCheckpointRow(sh, row) {
  if (!row || row.length !== 9) return 'bad row';
  const source = String(row[7] || '').trim();
  const hasNums = String(row[1] || '').trim() !== '' && String(row[4] || '').trim() !== '';
  if (!hasNums || source === 'unavailable') return 'skipped empty';

  row = row.slice();
  row[0] = quarterSlot(row[0]);

  const lastRow = Math.max(1, sh.getLastRow());
  const stamps = sh.getRange(1, COL_TIMESTAMP, lastRow, 1).getDisplayValues();
  for (var i = 0; i < stamps.length; i++) {
    if (quarterSlot(stamps[i][0]) !== row[0]) continue;
    const existing = sh.getRange(i + 1, 1, 1, 9).getDisplayValues()[0];
    if (checkpointSourceRank(source) > checkpointSourceRank(existing[7])) {
      sh.getRange(i + 1, 1, 1, 9).setValues([row]);
      paintCheckpointRow(sh, i + 1, source);
      return 'upgraded:' + row[0];
    }
    return 'exists:' + row[0];
  }
  const dest = lastRow + 1;
  sh.getRange(dest, COL_TIMESTAMP).setNumberFormat('@').setValue(row[0]);
  sh.getRange(dest, 2, 1, 8).setValues([row.slice(1)]);
  paintCheckpointRow(sh, dest, source);
  return 'appended:' + row[0];
}

function checkpointNeedsCleanup(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  const start = Math.max(2, lastRow - 80);
  const rows = sh.getRange(start, 1, lastRow - start + 1, 8).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    const stamp = String(rows[i][0] || '').trim();
    const source = String(rows[i][7] || '').trim();
    if (source === 'unavailable') return true;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp)
        && Number(stamp.slice(-2)) % 15 !== 0) return true;
  }
  return false;
}

/** Drop empty rows, snap stamps to :00/:15/:30/:45, keep one row per slot (Mi6 wins). */
function cleanupCheckpointSheet() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
  if (!sh) return 'tab "' + SHEET_CHECKPOINT + '" missing';
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 'empty';

  const values = sh.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
  const best = {};
  for (var i = 0; i < values.length; i++) {
    const row = values[i].slice();
    const source = String(row[7] || '').trim();
    const hasNums = String(row[1] || '').trim() !== '' && String(row[4] || '').trim() !== '';
    if (!hasNums || source === 'unavailable') continue;
    const slot = quarterSlot(row[0]);
    if (!slot) continue;
    row[0] = slot;
    if (!best[slot] || checkpointSourceRank(source) > checkpointSourceRank(best[slot][7])) {
      best[slot] = row;
    }
  }

  const slots = Object.keys(best).sort();
  const cleaned = slots.map(function (slot) { return best[slot]; });
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 9).clearContent();
  if (cleaned.length) {
    sh.getRange(2, 1, cleaned.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, cleaned.length, 9).setValues(cleaned);
    for (var c = 0; c < cleaned.length; c++) {
      paintCheckpointRow(sh, c + 2, cleaned[c][7]);
    }
  }
  return 'kept ' + cleaned.length + ' quarter-hour rows, dropped ' + (values.length - cleaned.length);
}

function testCheckpoint() { Logger.log(logCheckpoint()); }

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Rounds to the nearest hour.
 *
 * Safe because TARGET_MINUTE pins execution to :45–:59, leaving 8+ minutes of
 * margin from the flip point — and semantically right: a reading taken at
 * 22:52 describes conditions at the 23:00 mark, not the 22:00 one. The Chrome
 * scraping task rounds identically and runs at ~:52.
 */
function roundToHour(d) {
  return new Date(Math.round(d.getTime() / 3600000) * 3600000);
}

function floorToQuarter(d) {
  return new Date(Math.floor(d.getTime() / 900000) * 900000);
}

function providerSlotFilled(tabName, slotStr) {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(tabName);
  if (!sh) return false;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  const stamps = sh.getRange(2, COL_TIMESTAMP, lastRow - 1, 1).getDisplayValues();
  for (var i = stamps.length - 1; i >= 0; i--) {
    if (String(stamps[i][0]).trim() !== slotStr) continue;
    const live = sh.getRange(i + 2, COL_ROUTE_1, 1, ROUTES.length).getValues()[0];
    return live.every(function (v) { return v !== '' && v !== null && v !== 'ERR'; });
  }
  return false;
}

/**
 * Returns the row holding this slot on the given sheet, creating it if absent.
 * Idempotent — re-running an hour updates in place rather than duplicating.
 */
function findOrCreateRow(sh, slotStr) {
  const lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    const stamps = sh.getRange(2, COL_TIMESTAMP, lastRow - 1, 1).getDisplayValues();
    for (var i = stamps.length - 1; i >= 0; i--) {      // recent rows first
      if (String(stamps[i][0]).trim() === slotStr) return i + 2;
    }
  }
  const row = lastRow + 1;
  sh.getRange(row, COL_TIMESTAMP)
    .setNumberFormat('@')          // plain text, so the join key never reformats
    .setValue(slotStr);
  return row;
}

function getOrCreateFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ─── Shadow Fit tab ────────────────────────────────────────────────────────
// Same walk as lib/shadow-fit.js and the Telegram pink line. Sequential EMA
// cannot be an ARRAYFORMULA, so this tab is rewritten as values.

function createShadowBiasState() {
  return { learnedBias: 0, lastCheckpointMs: null };
}

function shadowEffectiveBias(state, atMs, config) {
  if (state.lastCheckpointMs == null) return 0;
  const hoursSinceCheckpoint = (atMs - state.lastCheckpointMs) / 3600000;
  const decay = hoursSinceCheckpoint <= config.biasHoldHours
    ? 1
    : Math.pow(0.5, (hoursSinceCheckpoint - config.biasHoldHours) / config.biasHalfLifeHours);
  return state.learnedBias * decay;
}

function shadowMinutesForSource(gmapsMinutes, direction, effectiveBias, config) {
  const settings = config.directions[direction];
  const value = settings.intercept
    + settings.slope * gmapsMinutes
    + effectiveBias
    + config.displayOffsetMinutes;
  return Math.round(Math.max(config.minimumMinutes, Math.min(config.maximumMinutes, value)));
}

function learnShadowBias(state, gmapsMean, checkpointMid, direction, atMs, effectiveBias, config) {
  if (!isFinite(checkpointMid) || !isFinite(gmapsMean) || gmapsMean <= 0) return state;
  const settings = config.directions[direction];
  const base = settings.intercept + settings.slope * gmapsMean;
  return {
    learnedBias: settings.alpha * (checkpointMid - base) + (1 - settings.alpha) * effectiveBias,
    lastCheckpointMs: atMs,
  };
}

function sgtStampToMs(stamp) {
  const match = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = ('0' + match[4]).slice(-2);
  const parsed = Utilities.parseDate(
    match[1] + '-' + match[2] + '-' + match[3] + ' ' + hour + ':' + match[5] + ':00',
    TZ,
    'yyyy-MM-dd HH:mm:ss'
  );
  return parsed ? parsed.getTime() : null;
}

function shadowMeanPositive(values) {
  const finite = values.filter(function (value) { return typeof value === 'number' && isFinite(value) && value > 0; });
  if (!finite.length) return NaN;
  return finite.reduce(function (sum, value) { return sum + value; }, 0) / finite.length;
}

function parseGmapsMinutes(value) {
  if (value === '' || value === 'ERR' || value == null) return null;
  const number = Number(value);
  return isFinite(number) && number > 0 ? number : null;
}

function ensureShadowFitTab(ss) {
  let sh = ss.getSheetByName(SHEET_SHADOW);
  if (!sh) {
    const legacy = ss.getSheetByName(SHEET_SHADOW_LEGACY) || ss.getSheetByName(SHEET_SHADOW_LEGACY_2);
    if (legacy) {
      legacy.setName(SHEET_SHADOW);
      sh = legacy;
      Logger.log('Renamed to "' + SHEET_SHADOW + '"');
    }
  }
  if (!sh) {
    sh = ss.insertSheet(SHEET_SHADOW);
    Logger.log('Created tab "' + SHEET_SHADOW + '"');
  }
  const headers = ['Timestamp (SGT)']
    .concat(ROUTES.map(function (route) { return route.name; }))
    .concat(['SG-JB jam km', 'SG-JB jam-start min', 'SG-JB C jam km', 'SG-JB C jam-start min', 'JB-SG jam km', 'JB-SG jam-start min']);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote(
    'Crossborder — jam-start duration through intercept + slope. '
    + 'Jam km is along-route length from the first slow/jam to the plaza at 1.443307, 103.767903 (0 if none).'
  );
  return sh;
}

/** Rebuilds the Shadow Fit tab from GMaps Scraped + Checkpoint.sg. Safe to re-run. */
function rebuildShadowFit() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gmaps = ss.getSheetByName(SHEET_GMAPS);
  const checkpoint = ss.getSheetByName(SHEET_CHECKPOINT);
  if (!gmaps) return 'GMaps tab missing';
  if (!checkpoint) return 'Checkpoint.sg tab missing';
  const shadow = ensureShadowFitTab(ss);

  const gLast = gmaps.getLastRow();
  if (gLast < 2) return 'no GMaps rows';
  const gValues = gmaps.getRange(2, COL_TIMESTAMP, gLast - 1, 8).getDisplayValues();
  const jamByStamp = readJamByStamp(shadow);
  const cpLast = checkpoint.getLastRow();
  const checkpointByMs = {};
  if (cpLast >= 2) {
    const cpValues = checkpoint.getRange(2, COL_TIMESTAMP, cpLast - 1, 7).getDisplayValues();
    cpValues.forEach(function (row) {
      const at = sgtStampToMs(row[0]);
      if (at == null) return;
      const jb = Number(row[3]);
      const sg = Number(row[6]);
      checkpointByMs[at] = {
        towardsJb: isFinite(jb) && jb > 0 ? jb : null,
        towardsSg: isFinite(sg) && sg > 0 ? sg : null,
      };
    });
  }

  let sgState = createShadowBiasState();
  let myState = createShadowBiasState();
  const out = [];
  for (var i = 0; i < gValues.length; i++) {
    const row = gValues[i];
    const stamp = row[0];
    const at = sgtStampToMs(stamp);
    const minutes = row.slice(1, 8).map(parseGmapsMinutes);
    const jam = jamByStamp[stamp] || ['', '', '', '', '', ''];
    if (at == null) {
      out.push([stamp, '', '', '', '', '', '', ''].concat(jam));
      continue;
    }
    const sgAb = Number(jam[1]);
    const sgC = Number(jam[3]);
    const jbSg = Number(jam[5]);
    if (isFinite(sgAb) && sgAb > 0) {
      minutes[0] = sgAb;
      minutes[1] = sgAb;
    }
    if (isFinite(sgC) && sgC > 0) minutes[2] = sgC;
    if (isFinite(jbSg) && jbSg > 0) {
      minutes[3] = jbSg;
      minutes[4] = jbSg;
      minutes[5] = jbSg;
      minutes[6] = jbSg;
    }
    const sgBias = shadowEffectiveBias(sgState, at, SHADOW_CALIBRATION);
    const myBias = shadowEffectiveBias(myState, at, SHADOW_CALIBRATION);
    const fitted = minutes.map(function (value, index) {
      if (value == null) return '';
      const direction = index < 3 ? 'sg-my' : 'my-sg';
      return shadowMinutesForSource(value, direction, direction === 'sg-my' ? sgBias : myBias, SHADOW_CALIBRATION);
    });
    const cp = checkpointByMs[at] || {};
    sgState = learnShadowBias(sgState, shadowMeanPositive(minutes.slice(0, 3)), cp.towardsJb, 'sg-my', at, sgBias, SHADOW_CALIBRATION);
    myState = learnShadowBias(myState, shadowMeanPositive(minutes.slice(3, 7)), cp.towardsSg, 'my-sg', at, myBias, SHADOW_CALIBRATION);
    out.push([stamp].concat(fitted).concat(jam));
  }

  shadow.getRange(2, 1, out.length, 8 + JAM_COL_COUNT).setValues(out);
  const leftover = shadow.getLastRow() - (out.length + 1);
  if (leftover > 0) {
    shadow.getRange(out.length + 2, 1, leftover, 8 + JAM_COL_COUNT).clearContent();
  }
  return 'rewrote ' + out.length + ' rows';
}

function readJamByStamp(shadow) {
  const map = {};
  const last = shadow.getLastRow();
  if (last < 2) return map;
  const block = shadow.getRange(2, COL_TIMESTAMP, last - 1, 8 + JAM_COL_COUNT).getDisplayValues();
  block.forEach(function (row) {
    if (!row[0]) return;
    map[row[0]] = row.slice(8, 8 + JAM_COL_COUNT);
  });
  return map;
}

function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function decodePolyline(encoded) {
  const coords = [];
  var index = 0;
  var lat = 0;
  var lng = 0;
  while (index < encoded.length) {
    for (var part = 0; part < 2; part++) {
      var shift = 0;
      var result = 0;
      var byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 31) << shift;
        shift += 5;
      } while (byte >= 32);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (part === 0) lat += delta;
      else lng += delta;
    }
    coords.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return coords;
}

function alongKm(points, fromIdx, toIdx) {
  if (fromIdx >= toIdx || fromIdx < 0 || toIdx >= points.length) return 0;
  var sum = 0;
  for (var i = fromIdx; i < toIdx; i++) sum += haversineKm(points[i], points[i + 1]);
  return sum;
}

function nearestIndex(points, ref) {
  var best = 0;
  var bestD = 1e9;
  for (var i = 0; i < points.length; i++) {
    const d = haversineKm(points[i], ref);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function analyzeJam(routeBody) {
  const route = routeBody && routeBody.routes && routeBody.routes[0];
  if (!route) return null;
  const live = Math.round(parseFloat(String(route.duration || '0').replace('s', '')) / 60);
  const stat = route.staticDuration
    ? Math.round(parseFloat(String(route.staticDuration).replace('s', '')) / 60)
    : live;
  const encoded = route.polyline && route.polyline.encodedPolyline;
  if (!encoded) return { jamKm: 0, jamStartMin: live, live: live };
  const points = decodePolyline(encoded);
  if (points.length < 2) return { jamKm: 0, jamStartMin: live, live: live };
  const intervals = (route.travelAdvisory && route.travelAdvisory.speedReadingIntervals) || [];
  var jamIdx = -1;
  for (var i = 0; i < intervals.length; i++) {
    const speed = String(intervals[i].speed || '');
    if (speed === 'SLOW' || speed === 'TRAFFIC_JAM') {
      jamIdx = Number(intervals[i].startPolylinePointIndex || 0);
      break;
    }
  }
  const cpIdx = nearestIndex(points, JAM_REF);
  const totalKm = alongKm(points, 0, points.length - 1);
  if (jamIdx < 0 || jamIdx >= cpIdx) {
    const remainKm = alongKm(points, cpIdx, points.length - 1);
    const remainMin = totalKm > 0 ? Math.round(stat * remainKm / totalKm) : SHADOW_CALIBRATION.minimumMinutes;
    return { jamKm: 0, jamStartMin: Math.max(SHADOW_CALIBRATION.minimumMinutes, remainMin), live: live };
  }
  const prefixKm = alongKm(points, 0, jamIdx);
  const jamKm = alongKm(points, jamIdx, cpIdx);
  const prefixStatic = totalKm > 0 ? stat * prefixKm / totalKm : 0;
  const jamStartMin = Math.max(SHADOW_CALIBRATION.minimumMinutes, Math.round(live - prefixStatic));
  return { jamKm: Math.round(jamKm * 100) / 100, jamStartMin: jamStartMin, live: live };
}

function fetchTrafficOnPolyline(fromStr, toStr, key) {
  const from = fromStr.split(',').map(Number);
  const to = toStr.split(',').map(Number);
  const payload = {
    origin: { location: { latLng: { latitude: from[0], longitude: from[1] } } },
    destination: { location: { latLng: { latitude: to[0], longitude: to[1] } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    polylineQuality: 'HIGH_QUALITY',
    extraComputations: ['TRAFFIC_ON_POLYLINE'],
  };
  var lastStatus = 0;
  for (var attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = UrlFetchApp.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.speedReadingIntervals',
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      lastStatus = resp.getResponseCode();
      if (lastStatus === 200) return { status: 200, body: JSON.parse(resp.getContentText()) };
      Logger.log('Jam polyline HTTP ' + lastStatus + ' — ' + resp.getContentText().slice(0, 200));
      if (lastStatus === 429 || lastStatus === 503) {
        Utilities.sleep(2500 * attempt);
        continue;
      }
      return { status: lastStatus, body: null };
    } catch (e) {
      Logger.log('Jam polyline failed: ' + e);
      Utilities.sleep(1500 * attempt);
    }
  }
  return { status: lastStatus || 429, body: null };
}

function logJamLengths(slotStr) {
  const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_ROUTES_KEY');
  if (!key) return 'no GOOGLE_ROUTES_KEY';
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const gmaps = ss.getSheetByName(SHEET_GMAPS);
  if (gmaps && gmaps.getLastRow() >= 2) {
    const stamps = gmaps.getRange(2, COL_TIMESTAMP, gmaps.getLastRow() - 1, 1).getDisplayValues();
    var found = false;
    for (var i = 0; i < stamps.length; i++) {
      if (String(stamps[i][0]).trim() === slotStr) found = true;
    }
    if (!found) slotStr = String(stamps[stamps.length - 1][0]).trim();
  }
  const sh = ensureShadowFitTab(ss);
  const row = findOrCreateRow(sh, slotStr);
  const existingKm = sh.getRange(row, COL_JAM_SGJB_KM).getDisplayValue();
  if (existingKm !== '' && !logJamLengths.force) return 'already filled ' + slotStr;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('JAM_API_SLOT') === slotStr && !logJamLengths.force && !logHour.force) {
    return 'already attempted ' + slotStr;
  }
  var hit429 = false;
  JAM_PROBES.forEach(function (probe) {
    if (hit429) return;
    const fetched = fetchTrafficOnPolyline(probe.from, probe.to, key);
    if (fetched.status === 429) hit429 = true;
    const analyzed = analyzeJam(fetched.body);
    if (analyzed) {
      sh.getRange(row, probe.kmCol).setValue(analyzed.jamKm);
      sh.getRange(row, probe.minCol).setValue(analyzed.jamStartMin);
    }
    Utilities.sleep(1200);
  });
  props.setProperty('JAM_API_SLOT', slotStr);
  sh.getRange(row, COL_TIMESTAMP).setValue(slotStr);
  return (hit429 ? '429 after filling ' : 'logged jam for ') + slotStr;
}

/** Canonical pins and shadow-fit model. Safe to re-run; replaces the tab contents. */
function writeParametersSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(SHEET_PARAMETERS);
  if (!sh) sh = ss.insertSheet(SHEET_PARAMETERS);
  const cal = SHADOW_CALIBRATION;
  const sg = cal.directions['sg-my'];
  const my = cal.directions['my-sg'];
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const rows = [
    ['Key', 'Value', 'Notes'],
    ['updated_sgt', stamp, 'Rewritten when pins or model change'],
    ['', '', ''],
    ['sg_jb_clearance', '1.466582, 103.768091', 'Past Malaysian CIQ'],
    ['sg_jb_a_origin', '1.421730, 103.771179', 'Far start on Bukit Timah Expy (PUB WH2). Shared with B.'],
    ['sg_jb_b_origin', '1.421730, 103.771179', 'Same far start as A. Mi6 copies A duration into B.'],
    ['sg_jb_c_origin', '1.426905, 103.763665', 'Far start on Woodlands Ave 3 into Woodlands Road'],
    ['jam_ref', '1.443307, 103.767903', 'Plaza point. Jam km is along-route from first slow/jam to here; 0 if none.'],
    ['crossborder_tab', 'Crossborder', 'Was Shadow Fit / GMaps Adjusted. Crossing minutes plus jam km.'],
    ['', '', ''],
    ['jb_sg_clearance', '1.4430746, 103.7683229', 'Past Singapore CIQ'],
    ['jb_sg_a_origin', '1.472085, 103.7651', 'Lingkaran Dalam S'],
    ['jb_sg_b_origin', '1.482406, 103.7832', 'AH2'],
    ['jb_sg_c_origin', '1.467340, 103.7658', 'Bukit Chagar'],
    ['jb_sg_d_origin', '1.465356, 103.7702', 'Lingkaran Dalam N'],
    ['', '', ''],
    ['sg_jb_intercept_min', String(sg.intercept), 'Booth / CIQ floor, empty road'],
    ['sg_jb_slope', String(sg.slope), 'Hidden plaza vs Maps road time'],
    ['sg_jb_alpha', String(sg.alpha), 'Currently in code; agreed not to chase Checkpoint with bias'],
    ['jb_sg_intercept_min', String(my.intercept), 'Booth / CIQ floor, empty road'],
    ['jb_sg_slope', String(my.slope), 'Hidden plaza vs Maps road time'],
    ['jb_sg_alpha', String(my.alpha), 'Currently in code; agreed not to chase Checkpoint with bias'],
    ['display_offset_min', String(cal.displayOffsetMinutes), 'Currently in code; agreed to drop the static minus-five'],
    ['bias_hold_hours', String(cal.biasHoldHours), 'How long a learned bias is held before it fades'],
    ['bias_half_life_hours', String(cal.biasHalfLifeHours), 'Fade after the hold'],
    ['minimum_minutes', String(cal.minimumMinutes), 'Clamp'],
    ['maximum_minutes', String(cal.maximumMinutes), 'Clamp'],
    ['', '', ''],
    ['method', 'far-start then jam-start', 'Ask Google for speed along the line from the far pin. First slow/jam is the queue tail. Time from there, then intercept + slope. Checkpoint.sg is the grey guide, not the teacher.'],
  ];
  sh.clear();
  sh.getRange(1, 1, rows.length, 3).setValues(rows);
  sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 280);
  sh.setColumnWidth(3, 520);
  return 'wrote ' + rows.length + ' rows';
}

// ─── One-time setup ────────────────────────────────────────────────────────

/** Renames the original tab, creates the TomTom tab, writes headers. Safe to re-run. */
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Rename the legacy tab if it's still called Sheet1.
  const legacy = ss.getSheetByName('Sheet1');
  if (legacy && !ss.getSheetByName(SHEET_GMAPS)) {
    legacy.setName(SHEET_GMAPS);
    Logger.log('Renamed "Sheet1" → "' + SHEET_GMAPS + '"');
  }

  const g = ss.getSheetByName(SHEET_GMAPS);
  if (!g) throw new Error('Cannot find tab "' + SHEET_GMAPS + '" or "Sheet1".');

  // GMaps tab headers — rewritten in place, existing data untouched.
  // A–H durations, I–K cameras, L Source (Mi6 / Mac / API).
  const gHeaders = ['Timestamp (SGT)']
    .concat(ROUTES.map(function (r) { return r.name; }))
    .concat(['Cam 2701 Causeway', 'Cam 2702 Checkpoint', 'Cam 2704 BKE'])
    .concat(['Source']);
  g.getRange(1, 1, 1, gHeaders.length).setValues([gHeaders]).setFontWeight('bold');
  g.setFrozenRows(1);
  Logger.log('GMaps source columns — ' + collapseGmapsSourceColumns());

  // Provider tabs — created if missing, headers refreshed, data untouched.
  ensureProviderTab(ss, SHEET_TOMTOM, 'free-flow');
  ensureProviderTab(ss, SHEET_MAPBOX, 'baseline');

  ensureShadowFitTab(ss);
  Logger.log('Shadow Fit — ' + rebuildShadowFit());
  Logger.log('Parameters — ' + writeParametersSheet());

  Logger.log('Sheets ready: "' + SHEET_GMAPS + '", "' + SHEET_TOMTOM
             + '", "' + SHEET_MAPBOX + '", "' + SHEET_SHADOW + '", "' + SHEET_PARAMETERS + '"');
}

/** Creates a provider tab if absent and writes its headers. Idempotent. */
function ensureProviderTab(ss, name, baselineLabel) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    Logger.log('Created tab "' + name + '"');
  }
  const headers = ['Timestamp (SGT)']
    .concat(ROUTES.map(function (r) { return r.name + ' (live)'; }))
    .concat(ROUTES.map(function (r) { return r.name + ' (' + baselineLabel + ')'; }));
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const f = t.getHandlerFunction();
    if (f === 'logHour' || f === 'purgeOld') ScriptApp.deleteTrigger(t);
  });

  // Apps Script cannot schedule "at :50 every hour" — everyHours() lands on an
  // arbitrary offset and nearMinute() is not honoured for it. So poll and let
  // the gates in logHour() decide what runs.
  //
  // 5-minute polling (not 15) because we now need TWO windows per hour: the
  // main provider run at :45–:54 and the Google fallback + watchdog at :55+.
  // A 15-minute poll can only land once in that span. The extra firings are
  // sub-millisecond no-ops.
  ScriptApp.newTrigger('logHour').timeBased().everyMinutes(5).create();
  Logger.log('Polling trigger installed: TomTom/Mapbox every 15 min, Google fallback + watchdog after :'
             + FALLBACK_MINUTE + '.');

  if (RETENTION_DAYS > 0) {
    ScriptApp.newTrigger('purgeOld').timeBased().everyDays(1).atHour(4).create();
    Logger.log('Daily purge trigger installed (retention ' + RETENTION_DAYS + ' days).');
  }
}

// ─── Diagnostics ───────────────────────────────────────────────────────────

/**
 * Queries both APIs for every route and logs them side by side, plus the raw
 * TomTom summary and Mapbox distance for route 1.
 *
 * Run this BEFORE trusting any of the numbers. Two specific things to check:
 *
 *  1. DISTANCE SANITY. Every one of these routes is 3–6 km. If a provider
 *     reports 20 km+, it has routed via the Second Link instead of the
 *     causeway, and that column is measuring the wrong road entirely.
 *  2. MAPBOX TRAFFIC COVERAGE. The driving-traffic profile silently falls back
 *     to plain driving where Mapbox has no traffic data. If a route's live and
 *     baseline figures are identical across several runs, that's the tell —
 *     most likely on the Johor side.
 */
function testProviders() {
  const props  = PropertiesService.getScriptProperties();
  const ttKey  = props.getProperty('TOMTOM_API_KEY');
  const mbTok  = props.getProperty('MAPBOX_TOKEN');

  if (!ttKey) Logger.log('WARNING: TOMTOM_API_KEY not set.');
  if (!mbTok) Logger.log('WARNING: MAPBOX_TOKEN not set.');

  Logger.log('route                          TT live  TT free   MB live  MB base');
  ROUTES.forEach(function (r) {
    const tt = ttKey ? fetchTomTomRoute(r, ttKey) : { live: '-', free: '-' };
    const ml = mbTok ? fetchMapboxRoute(r, mbTok, 'driving-traffic') : '-';
    const mb = mbTok ? fetchMapboxRoute(r, mbTok, 'driving')         : '-';
    Logger.log(pad(r.name, 30) + pad(tt.live, 9) + pad(tt.free, 9)
               + pad(ml, 10) + mb);
  });

  // Raw payloads for route 1, for distance checking.
  const r0 = ROUTES[0];
  if (ttKey) {
    const url = 'https://api.tomtom.com/routing/1/calculateRoute/'
              + encodeURIComponent(r0.from) + ':' + encodeURIComponent(r0.to)
              + '/json?key=' + encodeURIComponent(ttKey)
              + '&traffic=true&routeType=fastest&travelMode=car&computeTravelTimeFor=all';
    const s = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true })
                .getContentText()).routes[0].summary;
    Logger.log('TomTom route 1 summary: ' + JSON.stringify(s));
    Logger.log('  → distance ' + (s.lengthInMeters / 1000).toFixed(1) + ' km (expect ~3.6)');
  }
  if (mbTok) {
    const url = 'https://api.mapbox.com/directions/v5/mapbox/driving-traffic/'
              + toLonLat(r0.from) + ';' + toLonLat(r0.to)
              + '?access_token=' + encodeURIComponent(mbTok)
              + '&overview=false&alternatives=false';
    const b = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
    if (b.routes && b.routes.length) {
      Logger.log('Mapbox route 1: ' + (b.routes[0].distance / 1000).toFixed(1)
                 + ' km, ' + Math.round(b.routes[0].duration / 60)
                 + ' min (expect ~3.6 km)');
    } else {
      Logger.log('Mapbox route 1 returned no route: ' + JSON.stringify(b).slice(0, 300));
    }
  }
}

function pad(v, n) {
  var s = String(v);
  while (s.length < n) s += ' ';
  return s;
}

/**
 * One full logging cycle across all providers, bypassing the TARGET_MINUTE gate.
 * Writes real rows and real images. Duplicate image names are overwritten
 * rather than duplicated, so running this mid-hour is safe.
 */
function testRun() {
  logHour.force = true;
  try {
    logHour();
    SpreadsheetApp.flush();
  } finally {
    logHour.force = false;
  }
  Logger.log('Test complete — check both tabs and the Drive folder.');
}

/**
 * Repairs the join key column on every tab.
 *
 * The Chrome scraping task creates rows by TYPING the slot key into a cell,
 * and Sheets silently coerces "2026-07-30 11:00" into a datetime value. This
 * script writes the same key as plain text. Mixed types in column A are a
 * latent bug: they still render identically, so findOrCreateRow's display-value
 * match keeps working, but CSV export and any downstream parser will see two
 * different things and the tabs will fail to join.
 *
 * Run this once now, and any time you notice date-formatted cells in column A.
 * Idempotent and safe — it only rewrites column A, never the data columns.
 */
function normaliseSlotKeys() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  [SHEET_GMAPS, SHEET_TOMTOM, SHEET_MAPBOX, SHEET_SHADOW].forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) { Logger.log('Tab "' + name + '" not found — skipped.'); return; }

    const lastRow = sh.getLastRow();
    if (lastRow < 2) { Logger.log(name + ': no data rows.'); return; }

    const rng     = sh.getRange(2, COL_TIMESTAMP, lastRow - 1, 1);
    const display = rng.getDisplayValues();
    const values  = rng.getValues();
    var fixed = 0;

    const out = display.map(function (d, i) {
      const raw = values[i][0];
      if (raw instanceof Date) {
        fixed++;
        // Rebuild from the underlying Date so a mis-rendered cell can't
        // propagate a wrong string.
        //
        // Use HH:mm, NOT HH:00. An earlier version hardcoded :00 here, which
        // was a no-op for genuine hourly rows but silently rewrote the two
        // legacy 22:06 / 22:10 rows into duplicate 22:00 keys. Never let a
        // normalisation routine invent data — preserve what's there and let
        // the caller decide whether an off-hour row belongs in the series.
        return [Utilities.formatDate(raw, TZ, 'yyyy-MM-dd HH:mm')];
      }
      return [String(d[0]).trim()];
    });

    rng.setNumberFormat('@').setValues(out);
    Logger.log(name + ': ' + fixed + ' date cell(s) converted to text, '
               + out.length + ' row(s) normalised.');
  });
}

/** Moves images older than RETENTION_DAYS to Drive trash (recoverable). */
function purgeOld() {
  if (RETENTION_DAYS <= 0) return;

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
  const months = getOrCreateFolder(DriveApp.getRootFolder(), ROOT_FOLDER).getFolders();
  var n = 0;

  while (months.hasNext()) {
    const files = months.next().getFiles();
    while (files.hasNext()) {
      const f = files.next();
      if (f.getDateCreated() < cutoff) { f.setTrashed(true); n++; }
    }
  }
  Logger.log('Trashed ' + n + ' file(s) older than ' + RETENTION_DAYS + ' days.');
}