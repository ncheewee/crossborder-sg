# CrossBorder.sg live-beta handoff

## What exists now

- Public frontend: https://ncheewee.github.io/crossborder-sg/
- Public source repository: https://github.com/ncheewee/crossborder-sg
- Public traffic API: https://crossborder-sg-mvp.ncheewee.chatgpt.site/api/traffic?direction=sg-my
- Alternate direction: replace `sg-my` with `my-sg`.
- UI build marker: `Codex build · Live beta 0.4`.

The first mobile viewport contains the recommendation, recommended official
camera, and forecast graph. The graph uses teal “good to depart” and amber
“less ideal” regions.

## Repository state at handoff

- `origin/main` is at `2b1d310` and contains the public Pages frontend, live
  traffic API implementation, D1 schema/migration, and updated README.
- The local branch also contains commit `1b52796`, which adds a five-minute
  GitHub Actions collector. That commit has **not** reached GitHub because the
  current GitHub CLI authorization does not have the `workflow` scope.
- GitHub CLI authentication is currently invalid after the interrupted scope
  refresh. Re-authenticate before pushing the local scheduler commit.
- The deployed Sites backend source is at `927c319`. Later commits only change
  documentation and add the unpushed collector; the deployed application code
  is current.
- Working tree should be clean after this handoff file is committed locally.

Do not assume scheduled collection is active until `.github/workflows/collect-traffic.yml`
is visible on GitHub and a workflow run succeeds.

## Architecture

```text
GitHub Pages frontend
  docs/index.html + versioned assets
        |
        | CORS GET
        v
Public Sites API /api/traffic
        |
        +--> LTA Traffic Images via data.gov.sg
        |
        +--> recommendation + forecast engine
        |
        +--> D1 traffic_observations history
```

### Public frontend

- Source entry: `static-entry/index.html` and `static-entry/main.tsx`.
- React UI: `app/page.tsx`.
- Styling: `app/globals.css`.
- Static build configuration: `vite.pages.config.ts`.
- `npm run build:pages` writes the deployable bundle to `docs/`.
- GitHub Pages is configured to serve `main` branch `/docs`.
- On `github.io`, `app/page.tsx` calls the public Sites API URL directly.
  Change that hard-coded API base when moving the backend.

### Backend

- Route: `app/api/traffic/route.ts`.
- Model: `lib/traffic-engine.ts`.
- Storage schema: `db/schema.ts`.
- Initial migration: `drizzle/0000_colossal_phantom_reporter.sql`.
- Logical D1 binding: `DB` in `.openai/hosting.json`.
- The API permits public cross-origin `GET` and `OPTIONS` requests.
- Responses are cached for 60 seconds in browsers and 90 seconds at the edge.
- A successful API request records at most one observation per official camera
  timestamp, so repeated refreshes do not create duplicate samples.

## Official data and model boundaries

Official camera images and timestamps come from:

`https://api.data.gov.sg/v1/transport/traffic-images`

Current camera mapping:

- Woodlands: camera `2701`.
- Tuas: camera `4703`.

The official feed typically updates every 1–5 minutes. The current endpoint can
be tested without an API key; obtain and configure a data.gov.sg production key
if higher limits or production support become necessary.

Important: estimated crossing times are **not official wait times**. Model v1
combines time-of-week checkpoint priors with official camera freshness. It does
not yet decode images or detect vehicles. The recommendation is always present,
while the official source timestamp is shown separately.

## API response contract

The response contains:

- `source`: official source name, health, timestamp, and update frequency.
- `model`: current estimation method and maturity.
- `recommendation`: `go` or `wait`, departure time, checkpoint, total range,
  saving versus the other checkpoint, reason, and confidence label.
- `checkpoints`: camera URL/time, crossing range, drive time, condition, trend,
  stored history, and rolling accuracy state for Woodlands and Tuas.
- `forecasts`: timestamped predicted waits and good/amber zones for each
  checkpoint.

## Automatic collection

`.github/workflows/collect-traffic.yml` calls both directions every five
minutes. To activate it:

1. Re-authenticate GitHub CLI with repository and workflow permission.
2. Push the current local `main` branch to `origin`.
3. Confirm the `Collect checkpoint observations` workflow exists on GitHub.
4. Trigger it manually once and confirm both API calls succeed.
5. Confirm later API responses contain growing `history` arrays.

The API also records observations whenever a user loads or refreshes the app,
so history collection works on demand even without the scheduler.

## Build and validation

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run build:pages
npm run build
```

Useful live checks:

```bash
curl --fail "https://crossborder-sg-mvp.ncheewee.chatgpt.site/api/traffic?direction=sg-my"
curl --fail "https://crossborder-sg-mvp.ncheewee.chatgpt.site/api/traffic?direction=my-sg"
```

If the D1 schema changes, run `npm run db:generate`, inspect the generated SQL,
and deploy the migration with the backend.

## Files to port into another project

Minimum product surface:

- `app/page.tsx`
- `app/globals.css`
- `lib/traffic-engine.ts`
- `app/api/traffic/route.ts`
- `db/index.ts`
- `db/schema.ts`
- `drizzle/`
- `public/` image assets

For a standalone GitHub Pages frontend, also port:

- `static-entry/`
- `vite.pages.config.ts`
- the `build:pages` package script

For the same Sites/Cloudflare backend, also preserve:

- `.openai/hosting.json`
- `vite.config.ts`
- `worker/index.ts`
- `build/sites-vite-plugin.ts`

Do not copy platform project IDs blindly when creating a genuinely new backend.
Create the new project/bindings, then update the frontend API base.

## Known limitations and next engineering work

1. Replace the time-of-week prior with calibrated camera-derived or reported
   crossing observations.
2. Add real vehicle/queue analysis; current v1 does not perform computer vision.
3. Add a functional “I’ve crossed” ground-truth submission flow. The current
   button is visual only.
4. The rolling error compares a prior estimate with a later estimate. It is not
   genuine traveller-confirmed accuracy yet.
5. Add API rate limiting or a dedicated ingestion endpoint before significant
   public traffic; the read endpoint currently performs deduplicated writes.
6. Add monitoring for official-feed failures and stale camera timestamps.
7. Verify responsive UI and browser errors after any port that changes fonts,
   CSS loading, asset base paths, or the API hostname.

## No secrets in this repository

No LTA/data.gov.sg key or private token is committed. Short-lived Sites and
GitHub credentials were used only during deployment. New hosting credentials
must be configured through the destination platform rather than added to source.
