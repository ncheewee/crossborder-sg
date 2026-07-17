import { getDb } from "../../../db";
import { travelerReports } from "../../../db/schema";
import type { Checkpoint, Direction } from "../../../lib/traffic-engine";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

function parseDirection(value: unknown): Direction | null {
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

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const direction = parseDirection(body.direction);
    const checkpoint = parseCheckpoint(body.checkpoint);
    const actualWaitMinutes = parseMinutes(body.actualWaitMinutes);
    const estimatedWaitMinutes = body.estimatedWaitMinutes == null
      ? null
      : parseMinutes(body.estimatedWaitMinutes);
    const sourceUpdatedAt = typeof body.sourceUpdatedAt === "string"
      ? body.sourceUpdatedAt
      : null;

    if (!direction || !checkpoint || actualWaitMinutes == null) {
      return json({
        error: "invalid_report",
        message: "Choose a checkpoint and an actual crossing time between 5 and 240 minutes.",
      }, { status: 400 });
    }

    await getDb().insert(travelerReports).values({
      reportedAt: new Date().toISOString(),
      direction,
      checkpoint,
      actualWaitMinutes,
      estimatedWaitMinutes,
      sourceUpdatedAt,
    });

    return json({
      ok: true,
      message: "Thanks. This crossing will be used to calibrate future estimates.",
    });
  } catch {
    return json({
      error: "report_unavailable",
      message: "Unable to save the crossing report right now.",
    }, { status: 503 });
  }
}
