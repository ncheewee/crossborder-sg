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
const SHEET_TOMTOM      = 'TomTom API';
const SHEET_MAPBOX      = 'Mapbox API';
const SHEET_CHECKPOINT  = 'Checkpoint.sg';
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
  { col: 'B', name: 'SG-JB A | BKE Flyover',        from: '1.439328,103.768422',  to: '1.466582,103.768091'   },
  { col: 'C', name: 'SG-JB B | BKE Junction',       from: '1.439356,103.768285',  to: '1.466582,103.768091'   },
  { col: 'D', name: 'SG-JB C | Woodlands Rd',       from: '1.440516,103.768108',  to: '1.466582,103.768091'   },
  { col: 'E', name: 'JB-SG A | Lingkaran Dalam S',  from: '1.472085,103.7651',    to: '1.4430746,103.7683229' },
  { col: 'F', name: 'JB-SG B | AH2',                from: '1.482406,103.7832',    to: '1.4430746,103.7683229' },
  { col: 'G', name: 'JB-SG C | Bukit Chagar',       from: '1.467340,103.7658',    to: '1.4430746,103.7683229' },
  { col: 'H', name: 'JB-SG D | Lingkaran Dalam N',  from: '1.465356,103.7702',    to: '1.4430746,103.7683229' }
];

const COL_TIMESTAMP = 1;   // A
const COL_ROUTE_1   = 2;   // B
const COL_FREEFLOW_1= 9;   // I on the TomTom/Mapbox tabs
const COL_CAM_1     = 9;   // I on the cams tab

// L–R on the GMaps tab: one provenance marker per route, so a mixed-source
// column can be filtered or split later. Two collection methods now feed B–H
// and they are NOT the same measurement — the scrape is what a user sees in
// the Maps app, the API is Google's routing engine. Without this the series
// silently blends two definitions.
const COL_SOURCE_1  = 12;  // L
const SRC_SCRAPE    = 'scrape';
const SRC_ROUTES    = 'routes-api';

// ─── Main hourly job ───────────────────────────────────────────────────────

function logHour() {
  const now = new Date();

  // Checkpoint.sg is independent of the :45/:55 gates. Mi6 posts on the hour;
  // pull it on every 5-minute poll so the tab does not wait on this Mac.
  Logger.log('Checkpoint.sg — ' + logCheckpoint());

  const minute  = Number(Utilities.formatDate(now, TZ, 'm'));
  const slot    = roundToHour(now);
  const slotStr = Utilities.formatDate(slot, TZ, 'yyyy-MM-dd HH:00');

  // Late window: the scraper has had its chance. Backfill Google if it failed,
  // then run the staleness watchdog. No provider or camera work here.
  if (FALLBACK_MINUTE && minute >= FALLBACK_MINUTE && !logHour.force) {
    Logger.log('Fallback window — ' + backfillGoogle(slotStr));
    watchdog();
    return;
  }

  if (minute < TARGET_MINUTE && !logHour.force) {
    Logger.log('Skipped — minute ' + minute + ' is before target ' + TARGET_MINUTE);
    return;
  }

  // Each leg is independent and swallows its own errors, so one provider
  // being down never costs us the others or the camera images.
  const tomtom = logTomTom(slotStr);
  const mapbox = logMapbox(slotStr);
  const cams   = CAMS_ENABLED ? logCameras(slot, slotStr) : 'paused';

  Logger.log('Slot ' + slotStr + ' | TomTom: ' + tomtom
             + ' | Mapbox: ' + mapbox + ' | cams: ' + cams);
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
      return jsonOut({ ok: true, result: logCheckpoint() });
    }
    if (body.type === 'checkpoint') {
      if (!Array.isArray(body.row) || body.row.length !== 9) {
        return jsonOut({ ok: false, error: 'row must be 9 cells' });
      }
      const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
      if (!sh) return jsonOut({ ok: false, error: 'tab "' + SHEET_CHECKPOINT + '" not found' });
      return jsonOut({ ok: true, result: appendCheckpointRow(sh, body.row) });
    }
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(body.slot || ''))) {
      return jsonOut({ ok: false, error: 'slot must be "YYYY-MM-DD HH:MM"' });
    }
    if (!Array.isArray(body.values) || body.values.length !== ROUTES.length) {
      return jsonOut({ ok: false, error: 'values must be an array of ' + ROUTES.length });
    }

    // Coerce to integers, preserving ERR and treating anything unparseable as
    // missing rather than as zero.
    const row = body.values.map(function (v) {
      if (v === 'ERR' || v === null || v === '') return 'ERR';
      const n = Number(v);
      return isFinite(n) ? Math.round(n) : 'ERR';
    });

    const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_GMAPS);
    if (!sh) return jsonOut({ ok: false, error: 'tab "' + SHEET_GMAPS + '" not found' });

    const r = findOrCreateRow(sh, body.slot);
    sh.getRange(r, COL_ROUTE_1, 1, row.length).setValues([row]);

    // Mark provenance only where a real value landed. A failed route stays
    // unmarked so the Routes fallback can claim it a few minutes later.
    const marks = row.map(function (v) { return v === 'ERR' ? '' : SRC_SCRAPE; });
    sh.getRange(r, COL_SOURCE_1, 1, marks.length).setValues([marks]);

    Logger.log('Ingest ' + body.slot + ' → row ' + r + ' : ' + row.join('/'));
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
 * past slots — Routes API reports conditions *now*, so backfilling an old hour
 * with current traffic would silently fabricate history.
 */
function backfillGoogle(slotStr) {
  const key = PropertiesService.getScriptProperties().getProperty('GOOGLE_ROUTES_KEY');
  if (!key) return 'no GOOGLE_ROUTES_KEY — fallback disabled';

  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_GMAPS);
  if (!sh) return 'GMaps tab missing';

  const row      = findOrCreateRow(sh, slotStr);
  const rng      = sh.getRange(row, COL_ROUTE_1, 1, ROUTES.length);
  const existing = rng.getValues()[0];

  const missing = [];
  existing.forEach(function (v, i) {
    if (v === '' || v === null || v === 'ERR') missing.push(i);
  });
  if (!missing.length) return 'scraper covered all 7 — nothing to backfill';

  const srcRng = sh.getRange(row, COL_SOURCE_1, 1, ROUTES.length);
  const marks  = srcRng.getValues()[0];

  const out = existing.slice();
  var ok = 0;
  missing.forEach(function (i) {
    const mins = fetchGoogleRoute(ROUTES[i], key);
    if (mins !== 'ERR') {
      out[i]   = mins;
      marks[i] = SRC_ROUTES;
      ok++;
    } else if (existing[i] === '') {
      out[i] = 'ERR';
    }
  });

  rng.setValues([out]);
  srcRng.setValues([marks]);
  return 'backfilled ' + ok + '/' + missing.length + ' missing route(s) → row ' + row;
}

/** One Routes API call. Returns integer minutes, or 'ERR'. Never throws. */
function fetchGoogleRoute(route, key) {
  const from = route.from.split(',').map(Number);
  const to   = route.to.split(',').map(Number);

  const payload = {
    origin:      { location: { latLng: { latitude: from[0], longitude: from[1] } } },
    destination: { location: { latLng: { latitude: to[0],   longitude: to[1]   } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE'
  };

  try {
    const resp = UrlFetchApp.fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'X-Goog-Api-Key': key,
        // Field mask is mandatory; requesting everything is billed at a higher tier.
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      Logger.log('Routes ' + route.name + ': HTTP ' + resp.getResponseCode()
                 + ' — ' + resp.getContentText().slice(0, 200));
      return 'ERR';
    }
    const body = JSON.parse(resp.getContentText());
    if (!body.routes || !body.routes.length) return 'ERR';

    // duration comes back as a string like "710s".
    return Math.round(parseFloat(String(body.routes[0].duration).replace('s', '')) / 60);
  } catch (e) {
    Logger.log('Routes ' + route.name + ' failed: ' + e);
    return 'ERR';
  }
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
 * Two calls per route (driving-traffic + driving) = 14 calls/hour ≈ 10,100 a
 * month, about 10% of Mapbox's 100,000/month free tier.
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
 * Reads the latest complete Woodlands capture from the Worker and appends one
 * A:I row. Idempotent on column A. No Mac file involved.
 */
function logCheckpoint() {
  const key = PropertiesService.getScriptProperties().getProperty('MONITOR_API_KEY');
  if (!key) return 'no MONITOR_API_KEY — skipping';

  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_CHECKPOINT);
  if (!sh) return 'tab "' + SHEET_CHECKPOINT + '" missing';

  try {
    const resp = UrlFetchApp.fetch(CHECKPOINT_API, {
      headers: {
        'X-Monitor-Key': key,
        'Authorization': 'Bearer ' + key,
      },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    if (resp.getResponseCode() !== 200) {
      return 'Worker HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 160);
    }
    const captures = JSON.parse(resp.getContentText()).captures || [];
    const latest = latestCompleteWoodlands(captures);
    if (!latest) {
      return appendCheckpointRow(sh, [
        Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
        '', '', '', '', '', '',
        'unavailable',
        'No complete Woodlands Checkpoint.sg capture in the last 4 hours.',
      ]);
    }
    const woodlands = latest.readings.woodlands;
    const source = latest.source || 'mi6-macrodroid';
    const capturedAt = new Date(latest.captured_at || latest.capturedAt);
    return appendCheckpointRow(sh, [
      Utilities.formatDate(capturedAt, TZ, 'yyyy-MM-dd HH:mm'),
      woodlands.towardsJb[0], woodlands.towardsJb[1], midpoint(woodlands.towardsJb),
      woodlands.towardsSg[0], woodlands.towardsSg[1], midpoint(woodlands.towardsSg),
      source,
      source === 'android-emulator'
        ? 'Worker source: android-emulator'
        : 'OK: complete Mi6 capture from Worker.',
    ]);
  } catch (e) {
    return 'failed: ' + e;
  }
}

function latestCompleteWoodlands(captures) {
  const now = Date.now();
  for (var i = captures.length - 1; i >= 0; i--) {
    const capture = captures[i];
    const capturedAt = new Date(capture.captured_at || capture.capturedAt);
    if (isNaN(capturedAt.getTime())) continue;
    if (now - capturedAt.getTime() > CHECKPOINT_MAX_AGE_MINUTES * 60000) continue;
    const woodlands = capture.readings && capture.readings.woodlands;
    if (validCheckpointRange(woodlands && woodlands.towardsJb)
        && validCheckpointRange(woodlands && woodlands.towardsSg)) {
      return capture;
    }
  }
  return null;
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

function appendCheckpointRow(sh, row) {
  const lastRow = Math.max(1, sh.getLastRow());
  const stamps = sh.getRange(1, COL_TIMESTAMP, lastRow, 1).getDisplayValues();
  for (var i = 0; i < stamps.length; i++) {
    if (String(stamps[i][0]).trim() === String(row[0])) return 'exists:' + row[0];
  }
  sh.getRange(lastRow + 1, 1, 1, 9).setValues([row]);
  return 'appended:' + row[0];
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
  // A–H durations, I–K cameras, L–R per-route provenance.
  const gHeaders = ['Timestamp (SGT)']
    .concat(ROUTES.map(function (r) { return r.name; }))
    .concat(['Cam 2701 Causeway', 'Cam 2702 Checkpoint', 'Cam 2704 BKE'])
    .concat(ROUTES.map(function (r) { return 'src ' + r.col + ' (' + r.name.split('|')[0].trim() + ')'; }));
  g.getRange(1, 1, 1, gHeaders.length).setValues([gHeaders]).setFontWeight('bold');
  g.setFrozenRows(1);

  // Backfill provenance for rows collected before markers existed. Every one
  // of those came from the scraper — the Routes fallback did not exist yet —
  // so this is a statement of fact, not an assumption.
  const lastRow = g.getLastRow();
  if (lastRow >= 2) {
    const vals = g.getRange(2, COL_ROUTE_1,  lastRow - 1, ROUTES.length).getValues();
    const srcR = g.getRange(2, COL_SOURCE_1, lastRow - 1, ROUTES.length);
    const srcV = srcR.getValues();
    var filled = 0;
    for (var i = 0; i < vals.length; i++) {
      for (var j = 0; j < ROUTES.length; j++) {
        const v = vals[i][j];
        if (srcV[i][j] === '' && v !== '' && v !== null && v !== 'ERR') {
          srcV[i][j] = SRC_SCRAPE; filled++;
        }
      }
    }
    srcR.setValues(srcV);
    Logger.log('Provenance backfilled for ' + filled + ' historical cell(s).');
  }

  // Provider tabs — created if missing, headers refreshed, data untouched.
  ensureProviderTab(ss, SHEET_TOMTOM, 'free-flow');
  ensureProviderTab(ss, SHEET_MAPBOX, 'baseline');

  Logger.log('Sheets ready: "' + SHEET_GMAPS + '", "' + SHEET_TOMTOM
             + '", "' + SHEET_MAPBOX + '"');
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
  Logger.log('Polling trigger installed: providers after :' + TARGET_MINUTE
             + ', Google fallback + watchdog after :' + FALLBACK_MINUTE + '.');

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
  [SHEET_GMAPS, SHEET_TOMTOM, SHEET_MAPBOX].forEach(function (name) {
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