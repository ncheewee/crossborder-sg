# CrossBorder.sg handoff

Date: 2026-07-18, Asia/Singapore

## Current objective

CrossBorder.sg is a mobile-first Singapore-Johor land-checkpoint companion.
The product should answer the driver's immediate question:

> Should I cross now, which checkpoint should I use, and roughly how long will
> the crossing take?

The near-term design direction is deliberately narrow: get one checkpoint card
right first, starting with Woodlands, then duplicate the pattern for Tuas only
after the Woodlands card feels excellent.

## Live state

- Public frontend: https://ncheewee.github.io/crossborder-sg/
- Source repository: https://github.com/ncheewee/crossborder-sg
- Public API base: https://crossborder-sg-api.ncheewee.workers.dev
- Example traffic endpoint:
  https://crossborder-sg-api.ncheewee.workers.dev/api/traffic?direction=sg-my
- Latest deployed commit at handoff: `5dbd8ce Refine Woodlands landing card`
- UI build marker currently rendered in footer: `Codex build · Live beta 0.7`

## User preferences and product direction

- Keep the app simple and decisive.
- Prioritize the first mobile viewport.
- Use a light theme with teal-green brand accents.
- Avoid legacy traffic-site clutter, ad-heavy grids, and long scroll-heavy
  dashboards.
- Do not imply recommendations are untrustworthy when official data is stale.
  Instead, always provide a recommendation and separately show source/update
  freshness where relevant.
- The user prefers visible, tested iterations and frequent deployment to
  GitHub Pages.
- The chosen MVP hosting direction is GitHub Pages for the frontend, plus
  Cloudflare Worker and Neon for backend/persistence. Do not reintroduce the
  earlier ChatGPT/Sites-hosting backend direction unless explicitly asked.

## Current frontend UX

The app currently focuses on a single Woodlands landing card.

The current card should show:

- Big `Woodlands` label in teal.
- Two direction rows:
  - `Towards JB`
  - `Towards SG`
- Each row shows:
  - expected crossing duration range, e.g. `32-42 min`
  - trend chip: `Easing`, `Steady`, `Slowing`, etc.
  - a dedicated sparkline for that direction
- Trend-chip colour logic:
  - green = good, e.g. fast and steady/easing
  - amber = warning, e.g. fast but slowing, or moderate/slowing
  - red = bad, e.g. slow and slowing
- Sparkline intent:
  - smooth, data-rich-looking 24-hour forecast
  - timing block takes about 30 percent of row width
  - sparkline gets the remaining space
  - glowing spot indicates NOW
  - one sparkline for Towards JB and one for Towards SG
- Camera feed:
  - appears directly under the timing/sparkline rows
  - swipeable carousel with dots
  - auto-advances every 3 seconds until the user interacts
  - should keep natural camera proportions; avoid making it too short/wide

The current page intentionally removed:

- `Pull down to refresh` helper text
- `Compare checkpoints` / intro header copy
- `Official feed live` badge
- `Woodlands Causeway` small subtitle
- `Live estimate` chip
- Separate `drive there`, `camera view`, and `forecast` sections
- The Tuas card, until the Woodlands card is right

## Important next UX work

1. Visually inspect the live app on a mobile-width viewport, ideally around
   390px wide.
2. Tune the Woodlands card spacing, typography, sparklines, and camera height
   until it feels like the right landing experience.
3. Only then restore/duplicate the same pattern for Tuas, with Woodlands first
   and Tuas second.
4. After both cards work, reintroduce a concise recommendation layer:
   `leave now` or `leave at HH:MM`, via Woodlands/Tuas, expected clear-time
   range to 15-minute precision.
5. Keep camera/source freshness visible somewhere, but do not let it dominate
   the first glance.

## Architecture

```text
GitHub Pages frontend
  docs/index.html + versioned assets
        |
        | CORS GET/POST
        v
Cloudflare Worker API
        |
        +--> data.gov.sg LTA traffic images
        |
        +--> recommendation + forecast engine
        |
        +--> Neon Postgres traffic_observations + traveler_reports
```

## Key files

Frontend:

- `app/page.tsx` - main React client UI and chart/camera components
- `app/globals.css` - light teal theme and mobile layout
- `app/layout.tsx` - app metadata
- `static-entry/` - static Pages entrypoint
- `vite.pages.config.ts` - GitHub Pages static build config
- `public/` - PWA icons, manifest, service worker, camera fallbacks
- `docs/` - generated GitHub Pages bundle; commit this for Pages deploys

Backend:

- `worker-api/index.ts` - Cloudflare Worker API
- `wrangler.api.toml` - Worker deploy config
- `neon/schema.sql` - Neon database schema
- `app/api/traffic/route.ts` and `app/api/reports/route.ts` - app API routes
  kept for the Vinext/Sites-compatible build path
- `lib/traffic-engine.ts` - estimation/model helpers
- `db/` and `drizzle/` - database schema/migration support

Project/deployment:

- `.env.example` - documents `NEXT_PUBLIC_API_BASE` and `DATABASE_URL`
- `package.json` - scripts for frontend, static Pages bundle, and Worker API
- `.github/workflows/collect-traffic.yml` - scheduled observation collection

## Build and deploy commands

Requires Node.js 22.13 or newer.

Install dependencies:

```bash
npm ci
```

Validate app build:

```bash
npm run build
```

Build GitHub Pages bundle:

```bash
NEXT_PUBLIC_API_BASE=https://crossborder-sg-api.ncheewee.workers.dev npm run build:pages
```

Deploy frontend:

```bash
git add app/page.tsx app/globals.css docs
git commit -m "Describe the UI change"
git push origin main
```

GitHub Pages is configured to serve `main` branch `/docs`.

Deploy backend if Worker code changes:

```bash
npm run api:deploy
```

Useful API checks:

```bash
curl --fail "https://crossborder-sg-api.ncheewee.workers.dev/api/traffic?direction=sg-my"
curl --fail "https://crossborder-sg-api.ncheewee.workers.dev/api/traffic?direction=my-sg"
```

## API behaviour

Traffic endpoints:

- `GET /api/traffic?direction=sg-my`
- `GET /api/traffic?direction=my-sg`

Report endpoint:

- `POST /api/reports`

`POST /api/reports` accepts:

- `direction`
- `checkpoint`
- `actualWaitMinutes`
- optional `estimatedWaitMinutes`
- optional `sourceUpdatedAt`

The backend stores traveller feedback without collecting user identity.

## Official data and model boundaries

Official camera images and timestamps come from:

`https://api.data.gov.sg/v1/transport/traffic-images`

Current camera mapping includes:

- Woodlands: camera `2701`
- Tuas: camera `4703`

Important: the current estimates are not official wait times. The MVP combines
time-of-week priors, official camera freshness, stored observations, and
traveller reports. Full computer vision/vehicle detection is not implemented
yet.

## PWA state

The app has PWA assets and install metadata:

- `public/manifest.webmanifest`
- `public/sw.js`
- `public/icon.svg`
- `public/icon-192.png`
- `public/icon-512.png`
- `public/maskable-icon.svg`
- `public/maskable-icon-512.png`
- `public/apple-touch-icon.png`

The generated `docs/` folder includes the corresponding deployed assets.

## What not to do accidentally

- Do not pivot back to the older scroll-heavy dashboard as the default
  homepage.
- Do not bring back the separate forecast section until the one-card pattern is
  working.
- Do not bring back helper/header clutter on the first screen.
- Do not replace GitHub Pages + Cloudflare Worker + Neon with ChatGPT/Sites
  hosting unless the user explicitly changes direction.
- Do not treat generated `docs/assets/*` filenames as stable; they change after
  each Pages build.
- Do not commit secrets. Configure `DATABASE_URL` as a Cloudflare Worker secret.

## Suggested next prompt for a new Codex task

```text
Read HANDOFF.md first and treat it as the current source of truth.

Continue CrossBorder.sg from the latest deployed state. Focus only on getting
the Woodlands landing card right before restoring Tuas.

Please visually inspect the mobile layout around 390px wide, then refine:
- spacing and hierarchy of the big Woodlands label
- the two direction rows: Towards JB and Towards SG
- trend chip colour logic and wording
- sparklines so they look smooth, useful, and not compressed
- glowing NOW point positioning
- camera carousel height/proportions

Do not reintroduce the old dashboard sections, intro headers, official-feed
badge, pull-down helper text, or ChatGPT/Sites-hosting backend direction.

When done, run the build, build the GitHub Pages bundle, commit, push to main,
and verify the Pages deployment.
```
