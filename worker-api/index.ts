import { neon } from "@neondatabase/serverless";
import {
  buildForecast,
  cameraFor,
  createRecommendation,
  driveTime,
  estimateWait,
  relatedCamerasFor,
  type Checkpoint,
  type Direction,
  type ForecastPoint,
} from "../lib/traffic-engine";

type Env = {
  DATABASE_URL: string;
  ALLOWED_ORIGIN?: string;
};

type CameraPayload = {
  camera_id: string;
  image: string;
  timestamp: string;
};

type TrafficObservationRow = {
  observed_at: string;
  estimated_wait_minutes: number;
  forecast_30_minutes: number | null;
};

type TravelerReportRow = {
  actual_wait_minutes: number;
  estimated_wait_minutes: number | null;
};

const SOURCE_URL = "https://api.data.gov.sg/v1/transport/traffic-images";
const checkpoints: Checkpoint[] = ["Woodlands", "Tuas"];

function corsHeaders(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(env: Env, body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders(env),
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

function condition(wait: number) {
  if (wait <= 35) return "Light";
  if (wait <= 60) return "Moderate";
  return "Heavy";
}

function trend(current: number, next: number) {
  if (next <= current - 5) return { label: "Queue easing", tone: "good" };
  if (next >= current + 5) return { label: "Queue building", tone: "warn" };
  return { label: "Holding steady", tone: "neutral" };
}

function parseDirection(value: string | null): Direction {
  return value === "my-sg" ? "my-sg" : "sg-my";
}

function parseReportDirection(value: unknown): Direction | null {
  return value === "sg-my" || value === "my-sg" ? value : null;
}

function parseCheckpoint(value: unknown): Checkpoint | null {
  return value === "Woodlands" || value === "Tuas" ? value : null;
}

function parseMinutes(value: unknown) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  if (rounded < 5 || rounded > 240) return null;
  return rounded;
}

function accuracy(rows: TrafficObservationRow[]) {
  const ordered = [...rows].reverse();
  const errors: number[] = [];
  for (const row of ordered) {
    if (row.forecast_30_minutes == null) continue;
    const target = new Date(row.observed_at).getTime() + 30 * 60000;
    const later = ordered.find((candidate) => {
      const difference = Math.abs(new Date(candidate.observed_at).getTime() - target);
      return difference <= 18 * 60000;
    });
    if (later) errors.push(Math.abs(row.forecast_30_minutes - later.estimated_wait_minutes));
  }
  return {
    sampleSize: errors.length,
    meanAbsoluteErrorMinutes: errors.length
      ? Math.round(errors.reduce((sum, value) => sum + value, 0) / errors.length)
      : null,
    label: errors.length >= 12 ? "Rolling 30-minute backtest" : "Collecting baseline samples",
  };
}

function travelerSummary(rows: TravelerReportRow[]) {
  const withEstimate = rows.filter((row) => row.estimated_wait_minutes != null);
  const averageActualWaitMinutes = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.actual_wait_minutes, 0) / rows.length)
    : null;
  const meanAbsoluteErrorMinutes = withEstimate.length
    ? Math.round(withEstimate.reduce((sum, row) => (
        sum + Math.abs(row.actual_wait_minutes - (row.estimated_wait_minutes ?? row.actual_wait_minutes))
      ), 0) / withEstimate.length)
    : null;

  return {
    count24h: rows.length,
    averageActualWaitMinutes,
    meanAbsoluteErrorMinutes,
    label: rows.length
      ? "Traveler reports in the last 24 hours"
      : "Awaiting traveler reports",
  };
}

function uncertaintyBand(rows: TrafficObservationRow[], reports: TravelerReportRow[]) {
  const backtest = accuracy(rows);
  const traveler = travelerSummary(reports);
  const sampleSize = backtest.sampleSize + traveler.count24h;
  const candidateErrors = [
    backtest.meanAbsoluteErrorMinutes,
    traveler.meanAbsoluteErrorMinutes,
  ].filter((value): value is number => value != null);
  const minutes = candidateErrors.length
    ? Math.max(6, Math.round(candidateErrors.reduce((sum, value) => sum + value, 0) / candidateErrors.length))
    : 12;

  return {
    minutes,
    sampleSize,
    label: sampleSize >= 24
      ? `±${minutes} min band from recent backtests and traveler reports`
      : `±${minutes} min provisional band · collecting 7-day data`,
    isSevenDayReady: sampleSize >= 24,
  };
}

async function loadHistory(
  sql: ReturnType<typeof neon>,
  direction: Direction,
  checkpoint: Checkpoint,
  since: string,
) {
  try {
    return await sql`
      select observed_at, estimated_wait_minutes, forecast_30_minutes
      from traffic_observations
      where direction = ${direction}
        and checkpoint = ${checkpoint}
        and observed_at >= ${since}
      order by observed_at desc
      limit 160
    ` as TrafficObservationRow[];
  } catch {
    return [];
  }
}

async function loadTravelerReports(
  sql: ReturnType<typeof neon>,
  direction: Direction,
  checkpoint: Checkpoint,
  since: string,
) {
  try {
    return await sql`
      select actual_wait_minutes, estimated_wait_minutes
      from traveler_reports
      where direction = ${direction}
        and checkpoint = ${checkpoint}
        and reported_at >= ${since}
      order by reported_at desc
      limit 80
    ` as TravelerReportRow[];
  } catch {
    return [];
  }
}

async function saveObservation(
  sql: ReturnType<typeof neon>,
  values: {
    observedAt: string;
    direction: Direction;
    checkpoint: Checkpoint;
    sourceUpdatedAt: string;
    cameraId: string;
    imageUrl: string;
    estimatedWaitMinutes: number;
    forecast30Minutes: number | null;
    method: string;
  },
) {
  try {
    await sql`
      insert into traffic_observations (
        observed_at,
        direction,
        checkpoint,
        source_updated_at,
        camera_id,
        image_url,
        estimated_wait_minutes,
        forecast_30_minutes,
        method
      )
      values (
        ${values.observedAt},
        ${values.direction},
        ${values.checkpoint},
        ${values.sourceUpdatedAt},
        ${values.cameraId},
        ${values.imageUrl},
        ${values.estimatedWaitMinutes},
        ${values.forecast30Minutes},
        ${values.method}
      )
      on conflict (direction, checkpoint, source_updated_at) do nothing
    `;
  } catch {
    // The live response remains useful if storage is temporarily unavailable.
  }
}

async function handleTraffic(request: Request, env: Env) {
  const url = new URL(request.url);
  const direction = parseDirection(url.searchParams.get("direction"));
  const now = new Date();
  const sql = neon(env.DATABASE_URL);

  try {
    const sourceResponse = await fetch(SOURCE_URL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 90, cacheEverything: true },
    });
    if (!sourceResponse.ok) throw new Error(`Official feed returned ${sourceResponse.status}`);
    const sourcePayload = await sourceResponse.json() as {
      items?: Array<{
        timestamp: string;
        cameras: CameraPayload[];
      }>;
      api_info?: { status?: string };
    };
    const item = sourcePayload.items?.[0];
    if (!item?.cameras?.length) throw new Error("Official feed returned no cameras");

    const cameras = {
      Woodlands: cameraFor("Woodlands", item.cameras),
      Tuas: cameraFor("Tuas", item.cameras),
    };
    const relatedCameras = {
      Woodlands: relatedCamerasFor("Woodlands", item.cameras),
      Tuas: relatedCamerasFor("Tuas", item.cameras),
    };
    const recommendation = createRecommendation(direction, now, cameras);
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60000).toISOString();
    const reportSince = new Date(now.getTime() - 24 * 60 * 60000).toISOString();

    const historyEntries = await Promise.all(
      checkpoints.map(async (checkpoint) => {
        const forecast = buildForecast(checkpoint, direction, now, cameras[checkpoint]);
        const wait = estimateWait(checkpoint, direction, now, cameras[checkpoint]);
        await saveObservation(sql, {
          observedAt: now.toISOString(),
          direction,
          checkpoint,
          sourceUpdatedAt: cameras[checkpoint].updatedAt,
          cameraId: cameras[checkpoint].cameraId,
          imageUrl: cameras[checkpoint].imageUrl,
          estimatedWaitMinutes: wait,
          forecast30Minutes: forecast[1]?.predicted ?? null,
          method: "historical-baseline-v1+official-camera-freshness",
        });
        const rows = await loadHistory(sql, direction, checkpoint, since);
        const reports = await loadTravelerReports(sql, direction, checkpoint, reportSince);
        return [checkpoint, { rows, reports, forecast, wait }] as const;
      }),
    );
    const history = Object.fromEntries(historyEntries) as Record<
      Checkpoint,
      {
        rows: TrafficObservationRow[];
        reports: TravelerReportRow[];
        forecast: ForecastPoint[];
        wait: number;
      }
    >;

    const checkpointPayload = Object.fromEntries(
      checkpoints.map((checkpoint) => {
        const details = history[checkpoint];
        const next = details.forecast[1]?.predicted ?? details.wait;
        const band = uncertaintyBand(details.rows, details.reports);
        return [checkpoint, {
          cameraId: cameras[checkpoint].cameraId,
          imageUrl: cameras[checkpoint].imageUrl,
          cameraUpdatedAt: cameras[checkpoint].updatedAt,
          cameras: relatedCameras[checkpoint],
          crossingRange: [Math.max(15, details.wait - 7), details.wait + 9],
          waitMinutes: details.wait,
          driveMinutes: driveTime(direction, checkpoint),
          condition: condition(details.wait),
          trend: trend(details.wait, next),
          accuracy: accuracy(details.rows),
          uncertainty: band,
          travelerReports: travelerSummary(details.reports),
          history: details.rows
            .slice(0, 8)
            .reverse()
            .map((row) => ({
              timestamp: row.observed_at,
              observed: row.estimated_wait_minutes,
            })),
        }];
      }),
    );

    return json(env, {
      generatedAt: now.toISOString(),
      direction,
      source: {
        name: "LTA Traffic Images via data.gov.sg",
        status: sourcePayload.api_info?.status === "healthy" ? "live" : "available",
        officialUpdatedAt: item.timestamp,
        updateFrequency: "1-5 minutes",
      },
      model: {
        name: "Historical baseline v1",
        status: "early",
        description: "Live official camera freshness combined with time-of-week checkpoint patterns.",
      },
      recommendation: {
        action: recommendation.action,
        depart: recommendation.depart,
        departAt: recommendation.departAt,
        route: recommendation.route,
        totalMinutes: recommendation.totalMinutes,
        totalRange: recommendation.totalRange,
        clearAt: recommendation.clearAt,
        clearTime: recommendation.clearTime,
        clearDestination: recommendation.clearDestination,
        savingMinutes: recommendation.savingMinutes,
        reason: recommendation.reason,
        confidenceLabel: recommendation.confidenceLabel,
      },
      checkpoints: checkpointPayload,
      forecasts: Object.fromEntries(
        checkpoints.map((checkpoint) => {
          const band = uncertaintyBand(history[checkpoint].rows, history[checkpoint].reports);
          return [checkpoint, recommendation.forecasts[checkpoint].map((point) => ({
            ...point,
            uncertaintyMinutes: band.minutes,
          }))];
        }),
      ),
    }, {
      headers: { "Cache-Control": "public, max-age=60, s-maxage=90" },
    });
  } catch (error) {
    return json(env, {
      error: "official_feed_unavailable",
      message: error instanceof Error ? error.message : "Unable to read official traffic feed",
      generatedAt: now.toISOString(),
    }, { status: 503 });
  }
}

async function handleReport(request: Request, env: Env) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const direction = parseReportDirection(body.direction);
    const checkpoint = parseCheckpoint(body.checkpoint);
    const actualWaitMinutes = parseMinutes(body.actualWaitMinutes);
    const estimatedWaitMinutes = body.estimatedWaitMinutes == null
      ? null
      : parseMinutes(body.estimatedWaitMinutes);
    const sourceUpdatedAt = typeof body.sourceUpdatedAt === "string"
      ? body.sourceUpdatedAt
      : null;

    if (!direction || !checkpoint || actualWaitMinutes == null) {
      return json(env, {
        error: "invalid_report",
        message: "Choose a checkpoint and an actual crossing time between 5 and 240 minutes.",
      }, { status: 400 });
    }

    const sql = neon(env.DATABASE_URL);
    await sql`
      insert into traveler_reports (
        reported_at,
        direction,
        checkpoint,
        actual_wait_minutes,
        estimated_wait_minutes,
        source_updated_at
      )
      values (
        ${new Date().toISOString()},
        ${direction},
        ${checkpoint},
        ${actualWaitMinutes},
        ${estimatedWaitMinutes},
        ${sourceUpdatedAt}
      )
    `;

    return json(env, {
      ok: true,
      message: "Thanks. This crossing will be used to calibrate future estimates.",
    });
  } catch {
    return json(env, {
      error: "report_unavailable",
      message: "Unable to save the crossing report right now.",
    }, { status: 503 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (!env.DATABASE_URL) {
      return json(env, {
        error: "database_not_configured",
        message: "DATABASE_URL is not configured for this Worker.",
      }, { status: 503 });
    }

    if (request.method === "GET" && url.pathname === "/api/traffic") {
      return handleTraffic(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/reports") {
      return handleReport(request, env);
    }

    return json(env, { error: "not_found" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const origin = "https://worker.internal";
    ctx.waitUntil(Promise.all([
      handleTraffic(new Request(`${origin}/api/traffic?direction=sg-my`), env),
      handleTraffic(new Request(`${origin}/api/traffic?direction=my-sg`), env),
    ]).then(() => undefined));
  },
};
