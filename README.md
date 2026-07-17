# CrossBorder.sg MVP

A mobile-first decision dashboard for Singapore–Johor drivers: when to leave,
which checkpoint to use, the recommended official camera, and an AI-style
wait-time forecast in one screen.

Live mockup: https://ncheewee.github.io/crossborder-sg/

## Status

Live beta. Camera images and freshness timestamps come from LTA's official
Traffic Images dataset via data.gov.sg. Crossing estimates and recommendations
currently use an early time-of-week baseline model; they are not official wait
times. The service stores observations so rolling forecast-error reporting can
replace the initial “collecting samples” state.

## Development

```bash
npm install
npm run dev
```

Build the private runtime version with `npm run build`, or create the static
GitHub Pages bundle in `docs/` with `npm run build:pages`.
