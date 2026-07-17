import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../../db";
import { trafficObservations, travelerReports } from "../../../db/schema";
import {
  buildForecast,
  cameraFor,
  createRecommendation,
  driveTime,
  estimateWait,
  type Checkpoint,
  type Direction,
} from "../../../lib/traffic-engine";

export const dynamic = "force-dynamic";

const SOURCE_URL = "https://api.data.gov.sg/v1/transport/traffic-images";
const checkpoints: Checkpoint[] = ["Woodlands", "Tuas"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders,
      "Cache-Control": "public, max-age=60, s-maxage=90",
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

async function loadHistory(direction: Direction, checkpoint: Checkpoint, since: string) {
  try {
    return await getDb()
      .select()
      .from(trafficObservations)
      .where(and(
        eq(trafficObservations.direction, direction),
        eq(trafficObservations.checkpoint, checkpoint),
        gte(trafficObservations.observedAt, since),
      ))
      .orderBy(desc(trafficObservations.observedAt))
      .limit(160);
  } catch {
    return [];
  }
}

async function saveObservation(values: typeof trafficObservations.$inferInsert) {
  try {
    const db = getDb();
    const latest = await db
      .select({ sourceUpdatedAt: trafficObservations.sourceUpdatedAt })
      .from(trafficObservations)
      .where(and(
        eq(trafficObservations.direction, values.direction),
        eq(trafficObservations.checkpoint, values.checkpoint),
      ))
      .orderBy(desc(trafficObservations.observedAt))
      .limit(1);
    if (latest[0]?.sourceUpdatedAt !== values.sourceUpdatedAt) {
      await db.insert(trafficObservations).values(values);
    }
  } catch {
    // The live response remains useful if storage is temporarily unavailable.
  }
}

async function loadTravelerReports(direction: Direction, checkpoint: Checkpoint, since: string) {
  try {
    return await getDb()
      .select()
      .from(travelerReports)
      .where(and(
        eq(travelerReports.direction, direction),
        eq(travelerReports.checkpoint, checkpoint),
        gte(travelerReports.reportedAt, since),
      ))
      .orderBy(desc(travelerReports.reportedAt))
      .limit(80);
  } catch {
    return [];
  }
}

function accuracy(rows: Awaited<ReturnType<typeof loadHistory>>) {
  const ordered = [...rows].reverse();
  const errors: number[] = [];
  for (const row of ordered) {
    if (row.forecast30Minutes == null) continue;
    const target = new Date(row.observedAt).getTime() + 30 * 60000;
    const later = ordered.find((candidate) => {
      const difference = Math.abs(new Date(candidate.observedAt).getTime() - target);
      return difference <= 18 * 60000;
    });
    if (later) errors.push(Math.abs(row.forecast30Minutes - later.estimatedWaitMinutes));
  }
  return {
    sampleSize: errors.length,
    meanAbsoluteErrorMinutes: errors.length
      ? Math.round(errors.reduce((sum, value) => sum + value, 0) / errors.length)
      : null,
    label: errors.length >= 12 ? "Rolling 30-minute backtest" : "Collecting baseline samples",
  };
}

function travelerSummary(rows: Awaited<ReturnType<typeof loadTravelerReports>>) {
  const withEstimate = rows.filter((row) => row.estimatedWaitMinutes != null);
  const averageActualWaitMinutes = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + row.actualWaitMinutes, 0) / rows.length)
    : null;
  const meanAbsoluteErrorMinutes = withEstimate.length
    ? Math.round(withEstimate.reduce((sum, row) => (
        sum + Math.abs(row.actualWaitMinutes - (row.estimatedWaitMinutes ?? row.actualWaitMinutes))
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

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const direction: Direction = url.searchParams.get("direction") === "my-sg" ? "my-sg" : "sg-my";
  const now = new Date();

  try {
    const sourceResponse = await fetch(SOURCE_URL, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 90, cacheEverything: true },
    });
    if (!sourceResponse.ok) throw new Error(`Official feed returned ${sourceResponse.status}`);
    const sourcePayload = await sourceResponse.json() as {
      items?: Array<{
        timestamp: string;
        cameras: Array<{ camera_id: string; image: string; timestamp: string }>;
      }>;
      api_info?: { status?: string };
    };
    const item = sourcePayload.items?.[0];
    if (!item?.cameras?.length) throw new Error("Official feed returned no cameras");

    const cameras = {
      Woodlands: cameraFor("Woodlands", item.cameras),
      Tuas: cameraFor("Tuas", item.cameras),
    };
    const recommendation = createRecommendation(direction, now, cameras);
    const since = new Date(now.getTime() - 6 * 60 * 60000).toISOString();
    const reportSince = new Date(now.getTime() - 24 * 60 * 60000).toISOString();
    const historyEntries = await Promise.all(
      checkpoints.map(async (checkpoint) => {
        const forecast = buildForecast(checkpoint, direction, now, cameras[checkpoint]);
        const wait = estimateWait(checkpoint, direction, now, cameras[checkpoint]);
        await saveObservation({
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
        const rows = await loadHistory(direction, checkpoint, since);
        const reports = await loadTravelerReports(direction, checkpoint, reportSince);
        return [checkpoint, { rows, reports, forecast, wait }] as const;
      }),
    );
    const history = Object.fromEntries(historyEntries) as Record<
      Checkpoint,
      {
        rows: Awaited<ReturnType<typeof loadHistory>>;
        reports: Awaited<ReturnType<typeof loadTravelerReports>>;
        forecast: ReturnType<typeof buildForecast>;
        wait: number;
      }
    >;

    const checkpointPayload = Object.fromEntries(
      checkpoints.map((checkpoint) => {
        const details = history[checkpoint];
        const next = details.forecast[1]?.predicted ?? details.wait;
        return [checkpoint, {
          cameraId: cameras[checkpoint].cameraId,
          imageUrl: cameras[checkpoint].imageUrl,
          cameraUpdatedAt: cameras[checkpoint].updatedAt,
          crossingRange: [Math.max(15, details.wait - 7), details.wait + 9],
          waitMinutes: details.wait,
          driveMinutes: driveTime(direction, checkpoint),
          condition: condition(details.wait),
          trend: trend(details.wait, next),
          accuracy: accuracy(details.rows),
          travelerReports: travelerSummary(details.reports),
          history: details.rows
            .slice(0, 8)
            .reverse()
            .map((row) => ({
              timestamp: row.observedAt,
              observed: row.estimatedWaitMinutes,
            })),
        }];
      }),
    );

    return json({
      generatedAt: now.toISOString(),
      direction,
      source: {
        name: "LTA Traffic Images via data.gov.sg",
        status: sourcePayload.api_info?.status === "healthy" ? "live" : "available",
        officialUpdatedAt: item.timestamp,
        updateFrequency: "1–5 minutes",
      },
      model: {
        name: "Historical baseline v1",
        status: "early",
        description: "Live official camera freshness combined with time-of-week checkpoint patterns.",
      },
      recommendation: {
        action: recommendation.action,
        depart: recommendation.depart,
        route: recommendation.route,
        totalRange: recommendation.totalRange,
        savingMinutes: recommendation.savingMinutes,
        reason: recommendation.reason,
        confidenceLabel: recommendation.confidenceLabel,
      },
      checkpoints: checkpointPayload,
      forecasts: recommendation.forecasts,
    });
  } catch (error) {
    return json({
      error: "official_feed_unavailable",
      message: error instanceof Error ? error.message : "Unable to read official traffic feed",
      generatedAt: now.toISOString(),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
