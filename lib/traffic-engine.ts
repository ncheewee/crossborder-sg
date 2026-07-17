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
      woodlands = hour < 6 ? 34 : hour < 11 ? 72 : hour < 16 ? 54 : hour < 21 ? 82 : 48;
    } else {
      woodlands = hour < 6 ? 28 : hour < 10 ? 52 : hour < 16 ? 42 : hour < 21 ? 68 : 38;
    }
  } else if (weekend) {
    woodlands = hour < 10 ? 38 : hour < 15 ? 52 : hour < 22 ? 78 : 46;
  } else {
    woodlands = hour < 7 ? 31 : hour < 11 ? 47 : hour < 16 ? 40 : hour < 22 ? 65 : 36;
  }

  const tuasAdjustment = direction === "sg-my" ? -11 : -7;
  const peakRelief = hour >= 16 && hour < 21 ? -5 : 0;
  return Math.max(18, woodlands + (checkpoint === "Tuas" ? tuasAdjustment + peakRelief : 0));
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
  const start = new Date(now);
  start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0);
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
    forecasts[checkpoint].slice(0, 49).map((point, index) => ({
      checkpoint,
      point,
      index,
      total: point.predicted + driveMinutes[direction][checkpoint],
    })),
  );
  const nowCandidates = candidates.filter((candidate) => candidate.index === 0);
  const nowBest = nowCandidates.sort((a, b) => a.total - b.total)[0];
  const futureBest = candidates
    .filter((candidate) => candidate.index > 0)
    .sort((a, b) => a.total - b.total)[0];
  const shouldWait = futureBest.total <= nowBest.total - 15;
  const best = shouldWait ? futureBest : nowBest;
  const sameTimeAlternative = candidates.find(
    (candidate) => candidate.index === best.index && candidate.checkpoint !== best.checkpoint,
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
  const match = cameras.find((camera) => camera.camera_id === cameraIds[checkpoint]);
  if (!match) throw new Error(`Official ${checkpoint} camera is unavailable`);
  return {
    cameraId: match.camera_id,
    imageUrl: match.image,
    updatedAt: match.timestamp,
    label: `${checkpoint} camera ${match.camera_id}`,
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
