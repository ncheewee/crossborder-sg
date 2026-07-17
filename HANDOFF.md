# CrossBorder.sg live-beta handoff

## What exists now

- Public frontend: https://ncheewee.github.io/crossborder-sg/
- Public source repository: https://github.com/ncheewee/crossborder-sg
- Temporary public traffic API: https://crossborder-sg-mvp.ncheewee.chatgpt.site/api/traffic?direction=sg-my
- Alternate direction: replace `sg-my` with `my-sg`.
- UI build marker: `Codex build · Live beta 0.5`.

The first mobile viewport contains the recommendation, recommended official
camera, and forecast graph. The graph uses teal “good to depart” and amber
“less ideal” regions. A compact “I’ve crossed” feedback control now posts
actual traveler crossing times to the backend.

The target backend is now Cloudflare Worker + Neon Postgres. The Worker API has
been scaffolded in `worker-api/index.ts`, with schema in `neon/schema.sql` and
Wrangler config in `wrangler.api.toml`. The `chatgpt.site` backend should be
treated as temporary until the Worker URL is deployed and wired into the
frontend build. After deployment, set GitHub repository variable
`TRAFFIC_API_BASE` to the Worker URL so the scheduled collector stops warming
the temporary backend.

## Repository state at handoff

- `origin/main` is at `2b1d310` and contains the public Pages frontend, live
  traffic API implementation, D1 schema/migration, and updated README.
- The local branch also contains commits after `2b1d310`: a five-minute GitHub
  Actions collector, this handoff guide, and the beta 0.5 traveler feedback
  work. These commits have **not** reached GitHub because the current GitHub
  CLI authorization does not have the `workflow` scope.
- GitHub CLI authentication is currently invalid after the interrupted scope
  refresh. Re-authenticate before pushing the local scheduler commit.
- The deployed Sites backend source is at `927c319`. The beta 0.5 report
  endpoint and `traveler_reports` migration have been built locally, but are
  not deployed until a new Sites version is saved/deployed.
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
        |
        +--> D1 traveler_reports feedback
```

Target replacement:

```text
GitHub Pages frontend
        |
        | CORS GET/POST
        v
Cloudflare Worker API
        |
        +--> LTA Traffic Images via data.gov.sg
        |
        +--> recommendation + forecast engine
        |
        +--> Neon Postgres traffic_observations + traveler_reports
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
- Traveler report route: `app/api/reports/route.ts`.
- Model: `lib/traffic-engine.ts`.
- Storage schema: `db/schema.ts`.
- Migrations: `drizzle/0000_colossal_phantom_reporter.sql` and
  `drizzle/0001_grey_mentallo.sql`.
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
  stored history, rolling accuracy state, and 24-hour traveler report summary
  for Woodlands and Tuas.
- `forecasts`: timestamped predicted waits and good/amber zones for each
  checkpoint.

`POST /api/reports` accepts `direction`, `checkpoint`, `actualWaitMinutes`,
and optional `estimatedWaitMinutes` / `sourceUpdatedAt`. It stores driver
feedback in `traveler_reports` without collecting user identity.

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
- `app/api/reports/route.ts`
- `db/index.ts`
- `db/schema.ts`
- `drizzle/`
- `public/` image assets

For a standalone GitHub Pages frontend, also port:

- `static-entry/`
- `vite.pages.config.ts`
- the `build:pages` package script

For the target Cloudflare + Neon backend, also port:

- `worker-api/index.ts`
- `wrangler.api.toml`
- `neon/schema.sql`
- the `api:dev` and `api:deploy` package scripts

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
3. Use `traveler_reports` to train/calibrate the route estimates once enough
   real submissions accumulate.
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
