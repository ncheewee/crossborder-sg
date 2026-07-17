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

5. Set `NEXT_PUBLIC_API_BASE` to the deployed Worker URL, rebuild with
   `npm run build:pages`, commit `docs/`, and push to GitHub Pages.
6. Set the GitHub Actions repository variable `TRAFFIC_API_BASE` to the same
   Worker URL so the five-minute collector warms the Neon-backed API instead of
   the temporary backend.

The Worker exposes the same public contract as the temporary backend:

- `GET /api/traffic?direction=sg-my`
- `GET /api/traffic?direction=my-sg`
- `POST /api/reports`
