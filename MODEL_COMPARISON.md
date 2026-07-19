# CrossBorder.sg model comparison

Date: 2026-07-18

## Current CrossBorder.sg prediction

The current deployed prediction is an early baseline:

- 30-minute forecast points from `lib/traffic-engine.ts`.
- A Singapore time-of-week prior for Woodlands/Tuas and SG->MY/MY->SG.
- A camera freshness adjustment from the official LTA traffic image timestamp.
- Rolling observations and traveler reports are stored, but the public estimate is still mostly the prior plus camera freshness.

This is useful for shaping the product UI, but it is not yet equivalent to mature apps that use live route traffic or user-derived crossing samples.

## Publicly stated competitor methods

Checkpoint.sg:

- Uses LTA Singapore traffic images and LLM Malaysia camera sources.
- States that estimated travel time uses Google Maps data and proprietary tracking technology.
- The web version is discontinued; current detailed readings are in the mobile apps.
- Public 7-day charts are available at `https://www.checkpoint.sg/week`, but exact app readings are not exposed as a documented public API.

Beat the Jam:

- States that time-to-clear uses Google Maps real-time traffic data plus anonymised user-shared data.
- States that 24-hour forecasts use historical data, with forecast tabs up to six days ahead.
- States a peak-hour threshold of 30 minutes in its FAQ.
- App readings are not exposed as a documented public API.

## Benchmark protocol

Until explicit APIs or permitted exports are available, compare through the
local Android-emulator capture loop:

1. Capture hourly, with extra confidence at morning peak, midday, evening peak, late night.
2. Capture all four routes:
   - Woodlands SG->MY
   - Woodlands MY->SG
   - Tuas SG->MY
   - Tuas MY->SG
3. Record:
   - CrossBorder.sg current range and trend.
   - Checkpoint.sg current estimate, if visible.
   - Beat the Jam current estimate, if visible.
   - Camera freshness and any visible incident/advisory.
4. Treat estimates within +/-15 minutes as directionally aligned for MVP.
5. Flag gaps where CrossBorder.sg differs by more than 20 minutes from both apps in the same direction.

## Closed-loop accuracy monitoring

The local hourly competitor report now writes three durable files under
`COMPETITOR_CAPTURE_DIR`:

- `benchmark-history.csv`: every hourly source snapshot.
- `accuracy-history.csv`: lagged proxy scores once 60-minute and 180-minute
  horizons mature.
- `latest-accuracy.json`: machine-readable scorecard for the latest Telegram
  report.

The local emulator captures Google Maps directions directly and treats that as
the normal Google benchmark. The paid Google Routes API path is opt-in via
`USE_GOOGLE_ROUTES_API=true`, so quota exhaustion does not break hourly
monitoring.

The scoring loop treats the later CrossBorder.sg observed estimate as a proxy
ground truth until enough traveller-reported actual clear times exist. For each
checkpoint, direction, source, and horizon it records:

- predicted midpoint at capture time
- later observed midpoint
- absolute error
- bias, where positive means the source predicted too high
- severity band: OK <= 10 minutes, WATCH <= 25 minutes, GAP > 25 minutes

Telegram includes:

- current variance versus Google Routes, Checkpoint.sg, and Beat the Jam
- best recent source by route using MAE and bias
- tuning candidates when CrossBorder.sg has at least three scored samples and
  absolute bias of at least eight minutes on a route

## Model upgrade target

To be competitive, CrossBorder.sg should add at least one live traffic input beyond camera freshness:

- Google Maps route durations for causeway/second-link crossing segments, if we can use an approved API path.
- User/traveler reported actual clear times.
- Computer-vision queue density from LTA/LLM camera images.
- A holiday/school-holiday calendar override, because both competitor app reviews and official advisories indicate normal weekday/weekend priors break during special periods.

## Current conclusion

Use the current model as a product scaffold, not as the final estimator. The UI should present useful ranges and trends, but the next backend milestone is a competitor-aligned live route signal.
