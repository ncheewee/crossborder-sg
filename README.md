# CrossBorder.sg MVP

A mobile-first decision dashboard for Singapore–Johor drivers: when to leave,
which checkpoint to use, the recommended official camera, and an AI-style
wait-time forecast in one screen.

Live mockup: https://ncheewee.github.io/crossborder-sg/

## Status

Live beta 0.5. Camera images and freshness timestamps come from LTA's official
Traffic Images dataset via data.gov.sg. Crossing estimates and recommendations
currently use an early time-of-week baseline model; they are not official wait
times. The service stores observations so rolling forecast-error reporting can
replace the initial “collecting samples” state. Drivers can also submit actual
crossing times through the “I’ve crossed” feedback control; those reports are
stored separately for later calibration.

## Target production stack

The intended zero-dollar MVP stack is:

```text
GitHub Pages frontend
  -> Cloudflare Worker API
      -> Neon Postgres
      -> data.gov.sg / LTA traffic images
```

The old `chatgpt.site` backend was useful for the first live beta, but should be
treated as temporary scaffolding. The Cloudflare Worker backend lives in
`worker-api/index.ts`; its Postgres schema is in `neon/schema.sql`.

Live Cloudflare Worker API:

https://crossborder-sg-api.ncheewee.workers.dev

## Development

```bash
npm install
npm run dev
```

Build the private runtime version with `npm run build`, or create the static
GitHub Pages bundle in `docs/` with `npm run build:pages`.

## Cloudflare Worker + Neon setup

1. Create a Neon project on the Free plan.
2. Run the SQL in `neon/schema.sql` against the Neon database.
3. Set the Worker secret:

```bash
npx wrangler secret put DATABASE_URL --config wrangler.api.toml
```

4. Deploy the Worker:

```bash
npm run api:deploy
```

5. Set `NEXT_PUBLIC_API_BASE` to the deployed Worker URL if you are changing
   API hosts, rebuild with `npm run build:pages`, commit `docs/`, and push to
   GitHub Pages. The current default is
   `https://crossborder-sg-api.ncheewee.workers.dev`.
6. Set the GitHub Actions repository variable `TRAFFIC_API_BASE` to the same
   Worker URL so the five-minute collector warms the Neon-backed API instead of
   the temporary backend.

Google sign-in is optional but recommended before wider sharing. Follow
`guides/google-sso.md` to create the OAuth Web client, configure the Worker, and
rebuild the Pages bundle with the public client id.

The Worker exposes the same public contract as the temporary backend:

- `GET /api/traffic?direction=sg-my`
- `GET /api/traffic?direction=my-sg`
- `POST /api/reports`

## Accuracy monitoring loop

There are two recurring monitors:

- GitHub Actions runs `scripts/hourly-model-comparison.mjs` hourly against the
  public API. Google Routes API checks are opt-in via `USE_GOOGLE_ROUTES_API=true`.
- The local macOS launchd job runs the Android emulator, captures Google Maps,
  Checkpoint.sg, and Beat the Jam, then runs `scripts/report-competitor-comparison.mjs`.

The local loop is the closed-loop tuner. It appends source snapshots to
`benchmark-history.csv`, scores matured 60-minute and 180-minute horizons in
`accuracy-history.csv`, and writes `latest-accuracy.json` for Telegram/reporting.
Until enough traveller reports exist, the later CrossBorder.sg observed estimate
is used as proxy ground truth for tuning bias and route reliability.
