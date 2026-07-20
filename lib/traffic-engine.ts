export type Direction = "sg-my" | "my-sg";
export type Checkpoint = "Tuas" | "Woodlands";

export type OfficialCamera = {
  cameraId: string;
  imageUrl: string;
  updatedAt: string;
  label?: string;
};

export type ForecastPoint = {
  time: string;
  timestamp: string;
  predicted: number;
  observed: number | null;
  zone: "good" | "amber";
  uncertaintyMinutes?: number;
};

const cameraIds: Record<Checkpoint, string> = {
  Woodlands: "2701",
  Tuas: "4703",
};

const cameraPrefixes: Record<Checkpoint, string> = {
  Woodlands: "27",
  Tuas: "47",
};

const driveMinutes: Record<Direction, Record<Checkpoint, number>> = {
  "sg-my": { Woodlands: 16, Tuas: 22 },
  "my-sg": { Woodlands: 17, Tuas: 28 },
};

function singaporeParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  return {
    weekday: value("weekday"),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
}

function historicalPrior(
  checkpoint: Checkpoint,
  direction: Direction,
  date: Date,
) {
  const { weekday, hour } = singaporeParts(date);
  const weekend = weekday === "Sat" || weekday === "Sun";

  let woodlands: number;
  if (direction === "sg-my") {
    if (weekend) {
      woodlands = hour < 6 ? 34 : hour < 11 ? 72 : hour < 16 ? 54 : hour < 21 ? 48 : 34;
    } else {
      woodlands = hour < 6 ? 28 : hour < 10 ? 52 : hour < 16 ? 42 : hour < 21 ? 68 : 38;
    }
  } else if (weekend) {
    woodlands = hour < 10 ? 38 : hour < 15 ? 52 : hour < 19 ? 58 : hour < 22 ? 50 : 36;
  } else {
    woodlands = hour < 7 ? 31 : hour < 11 ? 47 : hour < 16 ? 40 : hour < 22 ? 65 : 36;
  }

  const tuasAdjustment = direction === "sg-my" ? -11 : -7;
  const peakRelief = hour >= 16 && hour < 21 ? -5 : 0;
  let wait = woodlands + (checkpoint === "Tuas" ? tuasAdjustment + peakRelief : 0);

  // Calibrated from repeated 07:00-08:59 SGT app and Google captures on 2026-07-20.
  if (!weekend && checkpoint === "Woodlands" && hour >= 7 && hour < 9) {
    wait += direction === "sg-my" ? -14 : 13;
  }

  return Math.max(18, wait);
}

function cameraFreshnessAdjustment(camera: OfficialCamera, now: Date) {
  const ageMinutes = Math.max(0, (now.getTime() - new Date(camera.updatedAt).getTime()) / 60000);
  if (ageMinutes <= 7) return 0;
  if (ageMinutes <= 15) return 3;
  return 7;
}

function formatSingaporeTime(date: Date) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function singaporeMidnight(date: Date, offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "01";
  const midnight = new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00+08:00`);
  midnight.setDate(midnight.getDate() + offsetDays);
  return midnight;
}

function roundUpToQuarterHour(date: Date) {
  const rounded = new Date(date);
  const minutes = rounded.getMinutes();
  const remainder = minutes % 15;
  if (remainder) rounded.setMinutes(minutes + (15 - remainder));
  rounded.setSeconds(0, 0);
  return rounded;
}

export function estimateWait(
  checkpoint: Checkpoint,
  direction: Direction,
  at: Date,
  camera: OfficialCamera,
) {
  return Math.round(historicalPrior(checkpoint, direction, at) + cameraFreshnessAdjustment(camera, at));
}

export function buildForecast(
  checkpoint: Checkpoint,
  direction: Direction,
  now: Date,
  camera: OfficialCamera,
) {
  const start = singaporeMidnight(now);
  const raw = Array.from({ length: 97 }, (_, index) => {
    const at = new Date(start.getTime() + index * 30 * 60000);
    return { at, predicted: estimateWait(checkpoint, direction, at, camera) };
  });
  const lowest = Math.min(...raw.map((point) => point.predicted));
  return raw.map(({ at, predicted }) => ({
    time: formatSingaporeTime(at),
    timestamp: at.toISOString(),
    predicted,
    observed: null,
    zone: predicted <= lowest + 4 ? "good" as const : "amber" as const,
  }));
}

export function createRecommendation(
  direction: Direction,
  now: Date,
  cameras: Record<Checkpoint, OfficialCamera>,
) {
  const checkpoints: Checkpoint[] = ["Woodlands", "Tuas"];
  const forecasts = Object.fromEntries(
    checkpoints.map((checkpoint) => [
      checkpoint,
      buildForecast(checkpoint, direction, now, cameras[checkpoint]),
    ]),
  ) as Record<Checkpoint, ForecastPoint[]>;

  const candidates = checkpoints.flatMap((checkpoint) =>
    forecasts[checkpoint].map((point) => ({
      checkpoint,
      point,
      total: point.predicted + driveMinutes[direction][checkpoint],
      timestamp: new Date(point.timestamp).getTime(),
    })),
  ).filter((candidate) => {
    const next24h = now.getTime() + 24 * 60 * 60000;
    return candidate.timestamp >= now.getTime() - 30 * 60000 && candidate.timestamp <= next24h;
  });
  const nowCandidates = candidates.filter((candidate) => (
    Math.abs(candidate.timestamp - now.getTime()) <= 30 * 60000
  ));
  const nowBest = nowCandidates.sort((a, b) => a.total - b.total)[0];
  const futureBest = candidates
    .filter((candidate) => candidate.timestamp > now.getTime() + 30 * 60000)
    .sort((a, b) => a.total - b.total)[0];
  const fallbackBest = candidates.sort((a, b) => a.total - b.total)[0];
  const shouldWait = Boolean(futureBest && nowBest && futureBest.total <= nowBest.total - 15);
  const best = shouldWait && futureBest ? futureBest : nowBest ?? fallbackBest;
  const sameTimeAlternative = candidates.find(
    (candidate) => candidate.timestamp === best.timestamp && candidate.checkpoint !== best.checkpoint,
  );
  const saving = Math.max(0, (sameTimeAlternative?.total ?? best.total) - best.total);
  const departureAt = shouldWait ? new Date(best.point.timestamp) : now;
  const clearAt = roundUpToQuarterHour(new Date(departureAt.getTime() + best.total * 60000));
  const depart = shouldWait ? `Leave at ${best.point.time}` : "Leave now";

  return {
    action: shouldWait ? "wait" as const : "go" as const,
    depart,
    departAt: departureAt.toISOString(),
    route: best.checkpoint,
    totalMinutes: best.total,
    totalRange: [Math.max(20, best.total - 7), best.total + 9] as [number, number],
    clearAt: clearAt.toISOString(),
    clearTime: formatSingaporeTime(clearAt),
    clearDestination: direction === "sg-my" ? "Johor" : "Singapore",
    savingMinutes: saving,
    reason: shouldWait
      ? `Wait for the ${best.point.time} window, when ${best.checkpoint} is forecast to ease.`
      : `${best.checkpoint} has the lowest combined approach and border estimate right now.`,
    confidenceLabel: "Early model · live official camera",
    forecasts,
  };
}

export function cameraFor(
  checkpoint: Checkpoint,
  cameras: Array<{
    camera_id: string;
    image: string;
    timestamp: string;
  }>,
): OfficialCamera {
  const primaryId = cameraIds[checkpoint];
  const prefix = cameraPrefixes[checkpoint];
  const match = cameras.find((camera) => camera.camera_id === primaryId)
    ?? cameras
      .filter((camera) => camera.camera_id.startsWith(prefix))
      .sort((a, b) => a.camera_id.localeCompare(b.camera_id))[0];
  if (!match) throw new Error(`Official ${checkpoint} cameras are unavailable`);
  return {
    cameraId: match.camera_id,
    imageUrl: match.image,
    updatedAt: match.timestamp,
    label: match.camera_id === primaryId
      ? `${checkpoint} camera ${match.camera_id}`
      : `${checkpoint} fallback camera ${match.camera_id}`,
  };
}

export function relatedCamerasFor(
  checkpoint: Checkpoint,
  cameras: Array<{
    camera_id: string;
    image: string;
    timestamp: string;
  }>,
): OfficialCamera[] {
  const primaryId = cameraIds[checkpoint];
  const prefix = cameraPrefixes[checkpoint];
  const related = cameras
    .filter((camera) => camera.camera_id === primaryId || camera.camera_id.startsWith(prefix))
    .map((camera) => ({
      cameraId: camera.camera_id,
      imageUrl: camera.image,
      updatedAt: camera.timestamp,
      label: camera.camera_id === primaryId
        ? `${checkpoint} checkpoint`
        : `${checkpoint} approach ${camera.camera_id}`,
    }));
  return related.sort((a, b) => {
    if (a.cameraId === primaryId) return -1;
    if (b.cameraId === primaryId) return 1;
    return a.cameraId.localeCompare(b.cameraId);
  });
}

export function driveTime(direction: Direction, checkpoint: Checkpoint) {
  return driveMinutes[direction][checkpoint];
}
