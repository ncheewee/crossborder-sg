"use client";

import { type TouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Direction = "sg-my" | "my-sg";
type Checkpoint = "Tuas" | "Woodlands";
type ForecastWindow = "current" | "next";
type EstimateMode = "border" | "approach";
type ApproachSource = "fixed" | "gps" | "address";
type LocationStatus = "idle" | "detecting" | "ready" | "denied" | "estimated" | "not-found";
type Coordinate = { latitude: number; longitude: number };

type LiveCamera = {
  cameraId: string;
  imageUrl: string;
  updatedAt: string;
  label?: string;
};

type ChartSeries = {
  times: string[];
  actual: Array<number | null>;
  prediction: Array<number | null>;
  uncertainty: Array<number | null>;
  windows: Array<"good" | "amber">;
  nowIndex: number | null;
  windowLabel: string;
  insight: string;
  errorLabel?: string;
};

type LiveCheckpoint = {
  imageUrl: string;
  cameraUpdatedAt: string;
  cameras?: LiveCamera[];
  crossingRange: [number, number];
  waitMinutes: number;
  driveMinutes: number;
  condition: string;
  trend: { label: string; tone: string };
  accuracy: {
    sampleSize: number;
    meanAbsoluteErrorMinutes: number | null;
    label: string;
  };
  uncertainty?: {
    minutes: number;
    sampleSize: number;
    label: string;
    isSevenDayReady: boolean;
  };
  travelerReports: {
    count24h: number;
    averageActualWaitMinutes: number | null;
    meanAbsoluteErrorMinutes: number | null;
    label: string;
  };
  history: Array<{ timestamp: string; observed: number }>;
};

type LiveTraffic = {
  generatedAt: string;
  source: {
    name: string;
    status: string;
    officialUpdatedAt: string;
    updateFrequency: string;
  };
  model: { name: string; status: string; description: string };
  recommendation: {
    action: "go" | "wait";
    depart: string;
    departAt?: string;
    route: Checkpoint;
    totalMinutes?: number;
    totalRange: [number, number];
    clearAt?: string;
    clearTime?: string;
    clearDestination?: string;
    savingMinutes: number;
    reason: string;
    confidenceLabel: string;
  };
  checkpoints: Record<Checkpoint, LiveCheckpoint>;
  forecasts: Record<Checkpoint, Array<{
    time: string;
    timestamp: string;
    predicted: number;
    observed: number | null;
    zone: "good" | "amber";
    uncertaintyMinutes?: number;
  }>>;
};

type FeedbackStatus = "idle" | "saving" | "saved" | "error";
type TrafficByDirection = Partial<Record<Direction, LiveTraffic>>;
type SparkTone = "good" | "amber" | "bad";
type SparkPoint = { timestamp: string; predicted: number; zone?: SparkTone };

const chartSeries: Record<Direction, Record<Checkpoint, ChartSeries>> = {
  "sg-my": {
    Tuas: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [64, 56, 49, 41, null, null, null, null, null],
      prediction: [67, 58, 47, 39, 34, 41, 56, 73, 86],
      uncertainty: [12, 12, 12, 12, 12, 12, 12, 12, 12],
      windows: ["amber", "amber", "good", "good", "good", "amber", "amber", "amber"],
      nowIndex: 3,
      windowLabel: "Today 00:00–23:59",
      errorLabel: "Mock ±12 min band",
      insight: "Depart between 12:00–1:30 pm for the shortest predicted wait.",
    },
    Woodlands: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [49, 57, 66, 74, null, null, null, null, null],
      prediction: [51, 59, 68, 76, 82, 85, 77, 66, 55],
      uncertainty: [12, 12, 12, 12, 12, 12, 12, 12, 12],
      windows: ["amber", "amber", "amber", "amber", "amber", "amber", "amber", "amber"],
      nowIndex: 3,
      windowLabel: "Today 00:00–23:59",
      errorLabel: "Mock ±12 min band",
      insight: "Woodlands remains elevated; Tuas is the better departure choice now.",
    },
  },
  "my-sg": {
    Tuas: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [43, 48, 54, 58, null, null, null, null, null],
      prediction: [45, 49, 55, 59, 64, 68, 61, 53, 47],
      uncertainty: [12, 12, 12, 12, 12, 12, 12, 12, 12],
      windows: ["amber", "amber", "amber", "amber", "amber", "amber", "amber", "amber"],
      nowIndex: 3,
      windowLabel: "Today 00:00–23:59",
      errorLabel: "Mock ±12 min band",
      insight: "Tuas is expected to stay moderate through the afternoon.",
    },
    Woodlands: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [48, 43, 39, 36, null, null, null, null, null],
      prediction: [50, 45, 40, 36, 33, 38, 49, 61, 70],
      uncertainty: [12, 12, 12, 12, 12, 12, 12, 12, 12],
      windows: ["amber", "good", "good", "good", "good", "good", "amber", "amber"],
      nowIndex: 3,
      windowLabel: "Today 00:00–23:59",
      errorLabel: "Mock ±12 min band",
      insight: "Depart between 11:30 am–2:00 pm while the predicted queue is lower.",
    },
  },
};

const tripData = {
  "sg-my": {
    route: "Tuas",
    depart: "Leave now",
    clearTime: "1:15 pm",
    clearDestination: "Johor",
    saving: 24,
    total: "54–69",
    border: "32–42",
    drive: 22,
    leaveWindow: "Best window: now–1:10 pm",
    reason:
      "Tuas is moving steadily while the Woodlands queue is still building.",
    tuas: {
      crossing: "32–42",
      drive: 22,
      trend: "Moving steadily",
      trendTone: "good",
      condition: "Moderate",
    },
    woodlands: {
      crossing: "62–82",
      drive: 16,
      trend: "Queue building",
      trendTone: "warn",
      condition: "Heavy",
    },
  },
  "my-sg": {
    route: "Woodlands",
    depart: "Leave now",
    clearTime: "1:15 pm",
    clearDestination: "Singapore",
    saving: 18,
    total: "48–63",
    border: "34–46",
    drive: 17,
    leaveWindow: "Best window: now–1:25 pm",
    reason:
      "Woodlands is clearing faster and gives you the shorter drive into Singapore.",
    tuas: {
      crossing: "51–66",
      drive: 28,
      trend: "Holding steady",
      trendTone: "neutral",
      condition: "Moderate",
    },
    woodlands: {
      crossing: "34–46",
      drive: 17,
      trend: "Queue easing",
      trendTone: "good",
      condition: "Moderate",
    },
  },
};

function formatTimeLabel(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-SG", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDayWindow(value?: string) {
  if (!value) return "00:00–23:59";
  const date = new Date(value);
  const day = new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
  return `${day} · 00:00–23:59`;
}

function formatHourTick(value?: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    hour: "numeric",
    hour12: true,
  }).format(new Date(value)).replace(" ", "").toLowerCase();
}

function roundUpToQuarter(date: Date) {
  const next = new Date(date);
  const remainder = next.getMinutes() % 15;
  if (remainder) next.setMinutes(next.getMinutes() + (15 - remainder));
  next.setSeconds(0, 0);
  return next;
}

function crossingMidpoint(value: string) {
  const [low, high] = value.split("–").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(low)) return 0;
  return Math.round((low + (Number.isFinite(high) ? high : low)) / 2);
}

function parseMinuteRange(value: string): [number, number] {
  const [low, high] = value.split("–").map((part) => Number.parseInt(part, 10));
  const safeLow = Number.isFinite(low) ? low : 0;
  const safeHigh = Number.isFinite(high) ? high : safeLow;
  return [safeLow, safeHigh];
}

function rangeText(low: number, high: number) {
  return `${Math.max(5, Math.round(low))}–${Math.max(5, Math.round(high))}`;
}

function distanceKm(from: Coordinate, to: Coordinate) {
  const radius = 6371;
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const dLat = (to.latitude - from.latitude) * Math.PI / 180;
  const dLon = (to.longitude - from.longitude) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const checkpointCoordinates: Record<Checkpoint, { latitude: number; longitude: number }> = {
  Woodlands: { latitude: 1.4456, longitude: 103.7683 },
  Tuas: { latitude: 1.3478, longitude: 103.6376 },
};

const postalSectorCoordinates: Array<{ test: (value: string) => boolean; label: string; coordinate: Coordinate }> = [
  { test: (value) => /^0[1-8]/.test(value), label: "CBD / Marina Bay", coordinate: { latitude: 1.2868, longitude: 103.8545 } },
  { test: (value) => /^(09|10)/.test(value), label: "HarbourFront / Sentosa", coordinate: { latitude: 1.2654, longitude: 103.8200 } },
  { test: (value) => /^(11|12|13|14)/.test(value), label: "Queenstown / Bukit Merah", coordinate: { latitude: 1.2890, longitude: 103.8040 } },
  { test: (value) => /^(15|16)/.test(value), label: "East Coast", coordinate: { latitude: 1.3035, longitude: 103.9110 } },
  { test: (value) => /^(17|18|19|20|21|22)/.test(value), label: "City / Orchard / Bugis", coordinate: { latitude: 1.3048, longitude: 103.8380 } },
  { test: (value) => /^(23|24|25|26|27)/.test(value), label: "Bukit Timah / Holland", coordinate: { latitude: 1.3255, longitude: 103.7950 } },
  { test: (value) => /^(28|29|30|31|32|33)/.test(value), label: "Novena / Toa Payoh", coordinate: { latitude: 1.3340, longitude: 103.8460 } },
  { test: (value) => /^(34|35|36|37|38|39|40|41)/.test(value), label: "Geylang / Kallang", coordinate: { latitude: 1.3180, longitude: 103.8840 } },
  { test: (value) => /^(42|43|44|45|46|47|48|49|50)/.test(value), label: "Katong / Bedok / Changi", coordinate: { latitude: 1.3270, longitude: 103.9380 } },
  { test: (value) => /^(51|52)/.test(value), label: "Tampines / Pasir Ris", coordinate: { latitude: 1.3555, longitude: 103.9440 } },
  { test: (value) => /^(53|54|55)/.test(value), label: "Serangoon / Hougang", coordinate: { latitude: 1.3650, longitude: 103.8860 } },
  { test: (value) => /^(56|57)/.test(value), label: "Bishan / Ang Mo Kio", coordinate: { latitude: 1.3695, longitude: 103.8465 } },
  { test: (value) => /^(58|59)/.test(value), label: "Clementi / West Coast", coordinate: { latitude: 1.3150, longitude: 103.7650 } },
  { test: (value) => /^(60|61|62|63|64)/.test(value), label: "Jurong", coordinate: { latitude: 1.3330, longitude: 103.7100 } },
  { test: (value) => /^(65|66|67|68)/.test(value), label: "Bukit Batok / Choa Chu Kang", coordinate: { latitude: 1.3780, longitude: 103.7440 } },
  { test: (value) => /^(69|70|71|72|73)/.test(value), label: "Choa Chu Kang / Woodlands", coordinate: { latitude: 1.4200, longitude: 103.7570 } },
  { test: (value) => /^(75|76)/.test(value), label: "Yishun / Sembawang", coordinate: { latitude: 1.4350, longitude: 103.8200 } },
  { test: (value) => /^(77|78|79|80|81|82|83)/.test(value), label: "Seletar / Punggol / Sengkang", coordinate: { latitude: 1.4030, longitude: 103.9020 } },
];

const namedAreaCoordinates: Array<{ keywords: string[]; label: string; coordinate: Coordinate }> = [
  { keywords: ["orchard", "somerset", "dhoby"], label: "Orchard", coordinate: { latitude: 1.3048, longitude: 103.8318 } },
  { keywords: ["jurong", "jcube", "jem"], label: "Jurong", coordinate: { latitude: 1.3330, longitude: 103.7430 } },
  { keywords: ["woodlands"], label: "Woodlands", coordinate: { latitude: 1.4360, longitude: 103.7860 } },
  { keywords: ["tuas"], label: "Tuas", coordinate: { latitude: 1.3290, longitude: 103.6480 } },
  { keywords: ["tampines"], label: "Tampines", coordinate: { latitude: 1.3547, longitude: 103.9437 } },
  { keywords: ["punggol"], label: "Punggol", coordinate: { latitude: 1.4051, longitude: 103.9023 } },
  { keywords: ["yishun"], label: "Yishun", coordinate: { latitude: 1.4294, longitude: 103.8354 } },
  { keywords: ["clementi"], label: "Clementi", coordinate: { latitude: 1.3151, longitude: 103.7651 } },
];

function estimateApproachMinutes(position: Coordinate | null, checkpoint: Checkpoint, fallback: number) {
  if (!position) return fallback;
  const km = distanceKm(position, checkpointCoordinates[checkpoint]);
  return Math.max(8, Math.round((km / 48) * 60 + 8));
}

function estimateLocationFromInput(value: string): { label: string; coordinate: Coordinate; precision: string } | null {
  const cleaned = value.trim().toLowerCase();
  const postal = cleaned.match(/\b\d{6}\b/)?.[0];
  if (postal) {
    const match = postalSectorCoordinates.find((entry) => entry.test(postal));
    if (match) return { label: `${postal} · ${match.label}`, coordinate: match.coordinate, precision: "postal-sector" };
  }
  const named = namedAreaCoordinates.find((entry) => entry.keywords.some((keyword) => cleaned.includes(keyword)));
  if (named) return { label: named.label, coordinate: named.coordinate, precision: "area" };
  return null;
}

function camerasForCheckpoint(live: LiveTraffic | null, checkpoint: Checkpoint, fallbackImage: string): LiveCamera[] {
  const current = live?.checkpoints[checkpoint];
  return current?.cameras?.length
    ? current.cameras
    : [{
        cameraId: checkpoint,
        imageUrl: current?.imageUrl ?? fallbackImage,
        updatedAt: current?.cameraUpdatedAt ?? "",
        label: `${checkpoint} checkpoint`,
      }];
}

function CameraCarousel({
  cameras,
  title,
  fallbackImage,
  compact = false,
  auto = false,
}: {
  cameras: LiveCamera[];
  title: string;
  fallbackImage: string;
  compact?: boolean;
  auto?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [interacted, setInteracted] = useState(false);
  const swipeStartX = useRef<number | null>(null);
  const safeCameras = cameras.length ? cameras : [];
  const current = safeCameras[Math.min(index, Math.max(0, safeCameras.length - 1))];

  useEffect(() => {
    setIndex(0);
    setInteracted(false);
  }, [cameras]);

  useEffect(() => {
    if (!auto || interacted || safeCameras.length <= 1) return;
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % safeCameras.length);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [auto, interacted, safeCameras.length]);

  const move = (direction: -1 | 1) => {
    if (safeCameras.length <= 1) return;
    setInteracted(true);
    setIndex((value) => (value + direction + safeCameras.length) % safeCameras.length);
  };

  const handleCameraTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setInteracted(true);
    swipeStartX.current = event.touches[0]?.clientX ?? null;
  };

  const handleCameraTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (swipeStartX.current == null) return;
    const endX = event.changedTouches[0]?.clientX ?? swipeStartX.current;
    const delta = endX - swipeStartX.current;
    if (Math.abs(delta) > 38) {
      move(delta < 0 ? 1 : -1);
    }
    swipeStartX.current = null;
  };

  if (!current) return null;

  return (
    <div
      className={`camera-carousel ${compact ? "compact" : ""}`}
      onPointerDown={() => setInteracted(true)}
      onTouchStart={handleCameraTouchStart}
      onTouchEnd={handleCameraTouchEnd}
    >
      <div className="camera-frame">
        <img
          src={current.imageUrl || fallbackImage}
          alt={`${title}: ${current.label ?? current.cameraId}`}
          onError={(event) => {
            if (event.currentTarget.src.endsWith(fallbackImage)) return;
            event.currentTarget.src = fallbackImage;
          }}
        />
        <div className="camera-shade" />
        <div className="camera-meta">
          <span><i aria-hidden="true" /> {current.label ?? title}</span>
          <span>{formatTimeLabel(current.updatedAt)}</span>
        </div>
      </div>
      {safeCameras.length > 1 && (
        <div className="camera-dots" aria-label={`${title} camera position`}>
          {safeCameras.map((camera, dotIndex) => (
            <button
              key={camera.cameraId}
              className={dotIndex === index ? "active" : ""}
              onClick={() => {
                setInteracted(true);
                setIndex(dotIndex);
              }}
              aria-label={`Show camera ${dotIndex + 1}`}
              aria-pressed={dotIndex === index}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function normalizeTrend(label: string) {
  const lower = label.toLowerCase();
  if (lower.includes("eas") || lower.includes("fast") || lower.includes("clear")) return "Easing";
  if (lower.includes("build") || lower.includes("slow") || lower.includes("rising")) return "Slowing";
  if (lower.includes("steady") || lower.includes("hold")) return "Steady";
  return label.replace(/^Queue\s+/i, "");
}

function trafficSignalTone(minutes: number, trend: string) {
  void trend;
  if (minutes < 45) return "good";
  if (minutes <= 90) return "warn";
  return "bad";
}

function trendTone(trend: string) {
  if (trend === "Easing") return "good";
  if (trend === "Slowing") return "bad";
  return "warn";
}

function waitTone(minutes: number): SparkTone {
  if (minutes < 45) return "good";
  if (minutes <= 90) return "amber";
  return "bad";
}

function projectedTrend(points: SparkPoint[], current: number, fallbackTrend: string, nowMs: number | null) {
  if (nowMs === null) {
    return {
      trend: fallbackTrend,
      trendTone: trendTone(fallbackTrend),
    };
  }

  const safePoints = points
    .filter((point) => Number.isFinite(point.predicted) && Number.isFinite(new Date(point.timestamp).getTime()))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  if (safePoints.length < 2) {
    return {
      trend: fallbackTrend,
      trendTone: trendTone(fallbackTrend),
    };
  }

  const startMs = new Date(safePoints[0].timestamp).getTime();
  const endMs = new Date(safePoints[safePoints.length - 1].timestamp).getTime();
  const clampedNow = Math.min(endMs, Math.max(startMs, nowMs));
  const lookAhead = Math.min(endMs, clampedNow + 3 * 60 * 60 * 1000);
  const interpolate = (targetMs: number) => {
    const foundIndex = safePoints.findIndex((point) => new Date(point.timestamp).getTime() >= targetMs);
    const rightIndex = foundIndex === -1 ? safePoints.length - 1 : Math.max(1, foundIndex);
    const right = safePoints[rightIndex];
    const left = safePoints[Math.max(0, rightIndex - 1)];
    const leftMs = new Date(left.timestamp).getTime();
    const rightMs = new Date(right.timestamp).getTime();
    const ratio = rightMs === leftMs ? 0 : Math.min(1, Math.max(0, (targetMs - leftMs) / (rightMs - leftMs)));
    return left.predicted + (right.predicted - left.predicted) * ratio;
  };

  const nowValue = interpolate(clampedNow);
  const futureValue = interpolate(lookAhead);
  const delta = futureValue - nowValue;
  const trend = delta >= 6 ? "Slowing" : delta <= -6 ? "Easing" : "Steady";
  return {
    trend,
    trendTone: trendTone(trend),
  };
}

function compactCheckpointData(
  traffic: LiveTraffic | undefined,
  direction: Direction,
  checkpoint: Checkpoint,
) {
  const fallback = checkpoint === "Tuas"
    ? tripData[direction].tuas
    : tripData[direction].woodlands;
  const live = traffic?.checkpoints[checkpoint];
  const trendLabel = live?.trend.label ?? fallback.trend;
  const crossing = live ? `${live.crossingRange[0]}–${live.crossingRange[1]}` : fallback.crossing;
  const waitMinutes = live?.waitMinutes ?? crossingMidpoint(fallback.crossing);
  const trend = normalizeTrend(trendLabel);
  return {
    crossing,
    waitMinutes,
    trend,
    trendTone: trafficSignalTone(waitMinutes, trend),
  };
}

function sparklinePoints(
  trafficByDirection: TrafficByDirection,
  direction: Direction,
  checkpoint: Checkpoint,
): SparkPoint[] {
  const livePoints = trafficByDirection[direction]?.forecasts[checkpoint];
  if (livePoints?.length) {
    return livePoints.slice(0, 49).map((point) => ({
      timestamp: point.timestamp,
      predicted: point.predicted,
      zone: waitTone(point.predicted),
    }));
  }

  const fallback = chartSeries[direction][checkpoint];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return fallback.prediction.map((predicted, index) => ({
    timestamp: new Date(start.getTime() + index * 3 * 60 * 60 * 1000).toISOString(),
    predicted: predicted ?? 50,
    zone: fallback.windows[Math.min(index, fallback.windows.length - 1)] ?? "amber",
  }));
}

function Sparkline24h({
  points,
  current,
  label,
}: {
  points: SparkPoint[];
  current: number;
  label: string;
}) {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const chart = useMemo(() => {
    const safePoints = points
      .filter((point) => Number.isFinite(point.predicted) && Number.isFinite(new Date(point.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const width = 240;
    const height = 68;
    const padding = { top: 8, right: 8, bottom: 8, left: 28 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    if (safePoints.length < 2) return null;

    const startMs = new Date(safePoints[0].timestamp).getTime();
    const lastMs = new Date(safePoints[safePoints.length - 1].timestamp).getTime();
    const endMs = Math.max(lastMs, startMs + 24 * 60 * 60 * 1000);
    const spanMs = Math.max(1, endMs - startMs);
    const waits = safePoints.map((point) => point.predicted);
    const smoothedWaits = waits.map((value, index) => {
      const previous2 = waits[Math.max(0, index - 2)];
      const previous1 = waits[Math.max(0, index - 1)];
      const next1 = waits[Math.min(waits.length - 1, index + 1)];
      const next2 = waits[Math.min(waits.length - 1, index + 2)];
      return (previous2 + previous1 * 2 + value * 4 + next1 * 2 + next2) / 10;
    });
    const minWait = 0;
    const maxWait = 120;
    const x = (timestamp: string) => padding.left + ((new Date(timestamp).getTime() - startMs) / spanMs) * plotWidth;
    const y = (value: number) => padding.top + plotHeight - ((value - minWait) / (maxWait - minWait)) * plotHeight;
    const plotted = safePoints.map((point, index) => ({
      x: x(point.timestamp),
      y: y(smoothedWaits[index]),
      zone: point.zone ?? waitTone(point.predicted),
      timestamp: point.timestamp,
      predicted: smoothedWaits[index],
    }));

    const curvePath = (pathPoints: Array<{ x: number; y: number }>) => {
      if (!pathPoints.length) return "";
      if (pathPoints.length === 1) return `M ${pathPoints[0].x.toFixed(1)} ${pathPoints[0].y.toFixed(1)}`;
      const parts = [`M ${pathPoints[0].x.toFixed(1)} ${pathPoints[0].y.toFixed(1)}`];
      for (let index = 0; index < pathPoints.length - 1; index += 1) {
        const p0 = pathPoints[Math.max(0, index - 1)];
        const p1 = pathPoints[index];
        const p2 = pathPoints[index + 1];
        const p3 = pathPoints[Math.min(pathPoints.length - 1, index + 2)];
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        parts.push(`C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
      }
      return parts.join(" ");
    };

    const now = nowMs === null ? null : Math.min(endMs, Math.max(startMs, nowMs));
    const nextIndex = now === null ? -1 : plotted.findIndex((point) => new Date(point.timestamp).getTime() >= now);
    const rightIndex = nextIndex === -1
      ? plotted.length - 1
      : Math.max(1, nextIndex);
    const leftIndex = Math.max(0, rightIndex - 1);
    const right = plotted[rightIndex];
    const left = plotted[leftIndex];
    const leftMs = new Date(left.timestamp).getTime();
    const rightMs = new Date(right.timestamp).getTime();
    const localRatio = now === null || rightMs === leftMs ? 0 : Math.min(1, Math.max(0, (now - leftMs) / (rightMs - leftMs)));
    const nowX = now === null ? null : padding.left + ((now - startMs) / spanMs) * plotWidth;
    const nowY = now === null ? null : left.y + (right.y - left.y) * localRatio;
    const nowPoint = nowX === null || nowY === null ? null : { x: nowX, y: nowY };
    const historyPoints = nowPoint
      ? [...plotted.filter((point) => new Date(point.timestamp).getTime() <= now), nowPoint]
      : plotted;
    const predictionPoints = nowPoint
      ? [nowPoint, ...plotted.filter((point) => new Date(point.timestamp).getTime() > now)]
      : [];

    return {
      width,
      height,
      historyPath: curvePath(historyPoints),
      predictionPath: curvePath(predictionPoints),
      nowX,
      nowY,
      nowLeft: nowX === null ? null : `${((nowX / width) * 100).toFixed(2)}%`,
      nowTop: nowY === null ? null : `${((nowY / height) * 100).toFixed(2)}%`,
      axisLeft: `${((padding.left / width) * 100).toFixed(2)}%`,
      axisWidth: `${((plotWidth / width) * 100).toFixed(2)}%`,
      padding,
      plotHeight,
      yTicks: [0, 60, 120].map((value) => ({ value, y: y(value) })),
      zones: plotted.slice(0, -1).map((point, index) => {
        const next = plotted[index + 1];
        return {
          x: point.x,
          w: Math.max(1, next.x - point.x),
          tone: waitTone((point.predicted + next.predicted) / 2),
        };
      }),
      grid: [padding.top, padding.top + plotHeight / 2, padding.top + plotHeight],
    };
  }, [current, nowMs, points]);

  return (
    <div className="sparkline-card">
      {chart && (
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={label} preserveAspectRatio="none">
          {chart.zones.map((zone, index) => (
            <rect
              key={`${zone.x}-${index}`}
              className={`spark-zone spark-zone-${zone.tone}`}
              x={zone.x}
              y={chart.padding.top}
              width={zone.w}
              height={chart.plotHeight}
            />
          ))}
          {chart.yTicks.map((tick) => (
            <text key={tick.value} className="spark-y-label" x={chart.padding.left - 5} y={tick.y}>
              {tick.value}m
            </text>
          ))}
          {chart.grid.map((y) => (
            <line key={y} className="spark-grid" x1={chart.padding.left} x2={chart.width - chart.padding.right} y1={y} y2={y} />
          ))}
          <path className="spark-line-underlay" d={chart.historyPath} />
          <path className="spark-line-underlay spark-line-forecast-underlay" d={chart.predictionPath} />
          <path className="spark-line" d={chart.historyPath} />
          <path className="spark-line spark-line-forecast" d={chart.predictionPath} />
        </svg>
      )}
      {chart?.nowLeft && chart.nowTop && (
        <span className="spark-now-marker" style={{ left: chart.nowLeft, top: chart.nowTop }} aria-hidden="true">
          <i />
        </span>
      )}
    </div>
  );
}

function SparklineAxis({ points }: { points: SparkPoint[] }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(true);
  }, []);

  const ticks = useMemo(() => {
    void points;
    if (!ready) return [];
    return [0, 4, 8, 12, 16, 20].map((hourOffset) => {
      const time = new Date(Date.UTC(2026, 0, 1, hourOffset - 8, 0, 0));
      return {
        left: `${(hourOffset / 24) * 100}%`,
        edge: hourOffset === 0,
        label: new Intl.DateTimeFormat("en-SG", {
          hour: "numeric",
          hour12: true,
          timeZone: "Asia/Singapore",
        }).format(time).replace(" ", "").toLowerCase(),
      };
    });
  }, [ready]);

  return (
    <div className="spark-axis" aria-hidden="true">
      {ticks.map((tick) => (
        <span key={`${tick.left}-${tick.label}`} className={tick.edge ? "edge" : ""} style={{ left: tick.left }}>
          <i aria-hidden="true" />
          <b>{tick.label}</b>
        </span>
      ))}
    </div>
  );
}

function LandingCheckpointCard({
  checkpoint,
  trafficByDirection,
}: {
  checkpoint: Checkpoint;
  trafficByDirection: TrafficByDirection;
}) {
  const sgMy = compactCheckpointData(trafficByDirection["sg-my"], "sg-my", checkpoint);
  const mySg = compactCheckpointData(trafficByDirection["my-sg"], "my-sg", checkpoint);
  const cameraTraffic = trafficByDirection["sg-my"] ?? trafficByDirection["my-sg"] ?? null;
  const fallbackImage = checkpoint === "Tuas" ? "tuas.jpg" : "woodlands.jpg";
  const cameras = camerasForCheckpoint(cameraTraffic, checkpoint, fallbackImage);
  const sgMyPoints = sparklinePoints(trafficByDirection, "sg-my", checkpoint);
  const mySgPoints = sparklinePoints(trafficByDirection, "my-sg", checkpoint);
  const [trendNowMs, setTrendNowMs] = useState<number | null>(null);

  useEffect(() => {
    setTrendNowMs(Date.now());
    const timer = window.setInterval(() => setTrendNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const sgMyProjection = projectedTrend(sgMyPoints, sgMy.waitMinutes, sgMy.trend, trendNowMs);
  const mySgProjection = projectedTrend(mySgPoints, mySg.waitMinutes, mySg.trend, trendNowMs);
  const sgMyDurationTone = trafficSignalTone(sgMy.waitMinutes, sgMyProjection.trend);
  const mySgDurationTone = trafficSignalTone(mySg.waitMinutes, mySgProjection.trend);

  return (
    <article className="landing-checkpoint-card">
      <div className="landing-camera-header">
        <CameraCarousel
          cameras={cameras}
          title={`${checkpoint} official cameras`}
          fallbackImage={fallbackImage}
          compact
          auto
        />
        <h1><span>{checkpoint}</span></h1>
      </div>

      <div className="landing-card-body">
        <div className="direction-signal-row">
          <div className="duration-row">
            <span>Towards JB</span>
            <strong className={`duration-time duration-time-${sgMyDurationTone}`}>{sgMy.crossing} <em>min</em></strong>
            <small className={`trend-chip trend-chip-${sgMyProjection.trendTone}`}>{sgMyProjection.trend}</small>
          </div>
          <Sparkline24h
            points={sgMyPoints}
            current={sgMy.waitMinutes}
            label={`${checkpoint} 24-hour forecast towards Johor with current time marker`}
          />
        </div>
        <div className="spark-axis-row">
          <div aria-hidden="true" />
          <SparklineAxis points={sgMyPoints.length >= mySgPoints.length ? sgMyPoints : mySgPoints} />
        </div>
        <div className="direction-signal-row">
          <div className="duration-row">
            <span>Towards SG</span>
            <strong className={`duration-time duration-time-${mySgDurationTone}`}>{mySg.crossing} <em>min</em></strong>
            <small className={`trend-chip trend-chip-${mySgProjection.trendTone}`}>{mySgProjection.trend}</small>
          </div>
          <Sparkline24h
            points={mySgPoints}
            current={mySg.waitMinutes}
            label={`${checkpoint} 24-hour forecast towards Singapore with current time marker`}
          />
        </div>
      </div>
    </article>
  );
}

function CheckpointCard({
  name,
  recommended,
  crossing,
  drive,
  trend,
  trendTone,
  condition,
  cameras,
  fallbackImage,
}: {
  name: Checkpoint;
  recommended: boolean;
  crossing: string;
  drive: number;
  trend: string;
  trendTone: string;
  condition: string;
  cameras: LiveCamera[];
  fallbackImage: string;
}) {
  return (
    <article className={`checkpoint-card ${recommended ? "recommended" : ""}`}>
      <div className="card-heading">
        <div>
          <div className="eyebrow-row">
            <span className="eyebrow">{name} checkpoint</span>
            {recommended && <span className="recommended-pill">Recommended</span>}
          </div>
          <div className="crossing-time">
            {crossing} <span>min</span>
          </div>
          <p className="metric-label">Estimated border crossing</p>
        </div>
        <div className={`trend trend-${trendTone}`}>
          <span className="trend-dot" aria-hidden="true" />
          {trend}
        </div>
      </div>

      <div className="metric-strip">
        <div>
          <span>Drive there</span>
          <strong>{drive} min</strong>
        </div>
        <div>
          <span>Camera view</span>
          <strong>{condition}</strong>
        </div>
        <div>
          <span>Forecast</span>
          <strong>{recommended ? "Favourable" : "Slower"}</strong>
        </div>
      </div>

      <CameraCarousel cameras={cameras} title={`${name} official cameras`} fallbackImage={fallbackImage} compact />
    </article>
  );
}

function ForecastMiniChart({
  checkpoint,
  selected,
}: {
  checkpoint: Checkpoint;
  selected: ChartSeries;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const draw = () => {
      const width = Math.max(280, container.clientWidth);
      const height = 196;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);

      const styles = getComputedStyle(document.documentElement);
      const predictionColor = styles.getPropertyValue("--teal").trim();
      const gridColor = styles.getPropertyValue("--chart-grid").trim();
      const labelColor = styles.getPropertyValue("--muted").trim();
      const goodFill = styles.getPropertyValue("--good-zone").trim();
      const amberFill = styles.getPropertyValue("--amber-zone").trim();
      const nowColor = styles.getPropertyValue("--teal-bright").trim();
      const bandFill = styles.getPropertyValue("--error-band").trim();

      const padding = { top: 14, right: 8, bottom: 32, left: 34 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const maxWait = Math.max(100, Math.ceil(Math.max(...selected.prediction.map((value, index) => (
        value == null ? 80 : value + (selected.uncertainty[index] ?? 0)
      ))) / 25) * 25);
      const x = (index: number) => padding.left + (index / (selected.times.length - 1)) * plotWidth;
      const y = (value: number) => padding.top + plotHeight - (value / maxWait) * plotHeight;

      context.clearRect(0, 0, width, height);

      selected.windows.forEach((windowType, index) => {
        const left = x(index);
        const right = x(index + 1);
        context.fillStyle = windowType === "good" ? goodFill : amberFill;
        context.fillRect(left, padding.top, right - left, plotHeight);
      });

      selected.prediction.forEach((_, index) => {
        if (index % 2 !== 0) return;
        const tickX = x(index);
        context.beginPath();
        context.strokeStyle = index % 8 === 0 || index === selected.prediction.length - 1
          ? "rgba(48, 83, 78, 0.18)"
          : "rgba(48, 83, 78, 0.07)";
        context.lineWidth = index % 8 === 0 || index === selected.prediction.length - 1 ? 1 : 0.6;
        context.moveTo(tickX, padding.top);
        context.lineTo(tickX, padding.top + plotHeight);
        context.stroke();
      });

      context.lineWidth = 1;
      context.strokeStyle = gridColor;
      context.fillStyle = labelColor;
      context.font = "10px Arial, sans-serif";
      context.textAlign = "right";
      context.textBaseline = "middle";
      Array.from({ length: Math.floor(maxWait / 25) + 1 }, (_, index) => index * 25).forEach((value) => {
        const lineY = y(value);
        context.beginPath();
        context.moveTo(padding.left, lineY);
        context.lineTo(width - padding.right, lineY);
        context.stroke();
        context.fillText(`${value}`, padding.left - 8, lineY);
      });

      context.textAlign = "center";
      context.textBaseline = "top";
      context.font = "10px Arial, sans-serif";
      selected.times.forEach((label, index) => {
        if (!label) return;
        context.fillText(label, x(index), padding.top + plotHeight + 12);
      });

      const curvePath = (values: Array<number | null>) => {
        context.beginPath();
        const points = values
          .map((value, index) => value === null ? null : { x: x(index), y: y(value) })
          .filter((value): value is { x: number; y: number } => value !== null);
        if (!points.length) return points;
        context.moveTo(points[0].x, points[0].y);
        for (let index = 0; index < points.length - 1; index += 1) {
          const current = points[index];
          const next = points[index + 1];
          const control = (next.x - current.x) / 2;
          context.bezierCurveTo(current.x + control, current.y, next.x - control, next.y, next.x, next.y);
        }
        return points;
      };

      const drawBand = () => {
        const upper = selected.prediction.map((value, index) => (
          value == null ? null : Math.max(0, value - (selected.uncertainty[index] ?? 0))
        ));
        const lower = selected.prediction.map((value, index) => (
          value == null ? null : value + (selected.uncertainty[index] ?? 0)
        ));
        const upperPoints = upper
          .map((value, index) => value === null ? null : { x: x(index), y: y(value) })
          .filter((value): value is { x: number; y: number } => value !== null);
        const lowerPoints = lower
          .map((value, index) => value === null ? null : { x: x(index), y: y(value) })
          .filter((value): value is { x: number; y: number } => value !== null);
        if (!upperPoints.length || !lowerPoints.length) return;
        context.beginPath();
        context.moveTo(upperPoints[0].x, upperPoints[0].y);
        for (let index = 0; index < upperPoints.length - 1; index += 1) {
          const current = upperPoints[index];
          const next = upperPoints[index + 1];
          const control = (next.x - current.x) / 2;
          context.bezierCurveTo(current.x + control, current.y, next.x - control, next.y, next.x, next.y);
        }
        for (let index = lowerPoints.length - 1; index > 0; index -= 1) {
          const current = lowerPoints[index];
          const next = lowerPoints[index - 1];
          const control = (current.x - next.x) / 2;
          context.bezierCurveTo(current.x - control, current.y, next.x + control, next.y, next.x, next.y);
        }
        context.closePath();
        context.fillStyle = bandFill;
        context.fill();
      };

      const drawLine = (values: Array<number | null>, color: string) => {
        context.lineWidth = 3.4;
        context.strokeStyle = color;
        context.setLineDash([]);
        const points = curvePath(values);
        context.stroke();
      };

      drawBand();
      drawLine(selected.prediction, predictionColor);

      if (selected.nowIndex !== null) {
        const nowX = x(selected.nowIndex);
        context.beginPath();
        context.strokeStyle = nowColor;
        context.lineWidth = 2;
        context.setLineDash([]);
        context.moveTo(nowX, padding.top - 4);
        context.lineTo(nowX, padding.top + plotHeight);
        context.stroke();
        context.fillStyle = nowColor;
        context.font = "10px Arial, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.fillText("NOW", nowX, padding.top - 7);
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selected]);

  return (
    <article className="forecast-card">
      <div className="graph-title-row">
        <h3>{checkpoint}</h3>
        <span>{selected.windowLabel}</span>
      </div>
      <div className="chart-wrap">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${checkpoint} smooth wait-time forecast from midnight to 11:59 pm.`}
        />
      </div>
    </article>
  );
}

function WaitTimeChart({
  series,
}: {
  series: Record<Checkpoint, Record<ForecastWindow, ChartSeries>>;
}) {
  return (
    <section className="forecast-section" aria-labelledby="forecast-title">
      <div className="section-heading forecast-heading">
        <div>
          <p className="section-kicker">Forecast</p>
          <h2 id="forecast-title">Today’s wait pattern</h2>
        </div>
      </div>
      <ForecastMiniChart checkpoint="Woodlands" selected={series.Woodlands.current} />
      <ForecastMiniChart checkpoint="Tuas" selected={series.Tuas.current} />
    </section>
  );
}

function apiBase() {
  if (typeof window === "undefined") return "";
  const configuredBase = typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_API_BASE
    : undefined;
  if (configuredBase) return configuredBase.replace(/\/$/, "");
  return window.location.hostname.endsWith("github.io")
    ? "https://crossborder-sg-api.ncheewee.workers.dev"
    : "";
}

function initialDirection(): Direction {
  if (typeof window === "undefined") return "sg-my";
  return new URLSearchParams(window.location.search).get("direction") === "my-sg"
    ? "my-sg"
    : "sg-my";
}

export default function Home() {
  const [direction, setDirection] = useState<Direction>(() => initialDirection());
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState("12:29 pm");
  const [liveTraffic, setLiveTraffic] = useState<LiveTraffic | null>(null);
  const [trafficByDirection, setTrafficByDirection] = useState<TrafficByDirection>({});
  const [feedState, setFeedState] = useState<"loading" | "live" | "fallback">("loading");
  const [feedbackCheckpoint, setFeedbackCheckpoint] = useState<Checkpoint>("Tuas");
  const [actualWaitMinutes, setActualWaitMinutes] = useState(45);
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus>("idle");
  const [showSignals, setShowSignals] = useState(false);
  const [estimateMode, setEstimateMode] = useState<EstimateMode>("border");
  const [approachSource, setApproachSource] = useState<ApproachSource>("fixed");
  const [routeChoice, setRouteChoice] = useState<Checkpoint | null>(null);
  const [selectedDeparture, setSelectedDeparture] = useState<"now" | "later">("now");
  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [addressLocation, setAddressLocation] = useState<{ label: string; coordinate: Coordinate; precision: string } | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [locationInput, setLocationInput] = useState("");
  const pullStartY = useRef<number | null>(null);

  const loadTraffic = useCallback(async () => {
    setRefreshing(true);
    try {
      const directions: Direction[] = ["sg-my", "my-sg"];
      const responses = await Promise.all(directions.map(async (travelDirection) => {
        const response = await fetch(`${apiBase()}/api/traffic?direction=${travelDirection}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Traffic API returned ${response.status}`);
        return [travelDirection, await response.json() as LiveTraffic] as const;
      }));
      const nextTraffic = Object.fromEntries(responses) as TrafficByDirection;
      const primary = nextTraffic[direction] ?? nextTraffic["sg-my"] ?? nextTraffic["my-sg"] ?? null;
      setTrafficByDirection(nextTraffic);
      setLiveTraffic(primary);
      setFeedState("live");
      setLastChecked(new Intl.DateTimeFormat("en-SG", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(primary?.generatedAt ?? Date.now())));
    } catch {
      setLiveTraffic(null);
      setTrafficByDirection({});
      setFeedState("fallback");
      setLastChecked(new Intl.DateTimeFormat("en-SG", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date()));
    } finally {
      setRefreshing(false);
    }
  }, [direction]);

  useEffect(() => {
    void loadTraffic();
  }, [loadTraffic]);

  useEffect(() => {
    const root = document.documentElement;
    const fitCameras = () => {
      window.requestAnimationFrame(() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const cards = Array.from(document.querySelectorAll<HTMLElement>(".landing-checkpoint-card"));
        const cameras = Array.from(document.querySelectorAll<HTMLElement>(".landing-checkpoint-card .camera-frame"));
        if (!cards.length || !cameras.length) return;

        const contentBottom = Math.max(...cards.map((card) => card.getBoundingClientRect().bottom));
        const cameraHeight = cameras.reduce((total, camera) => total + camera.getBoundingClientRect().height, 0);
        const nonCameraHeight = contentBottom - cameraHeight;
        const targetHeight = Math.max(132, Math.min(280, (viewportHeight - nonCameraHeight - 4) / cameras.length));
        root.style.setProperty("--landing-camera-height", `${targetHeight.toFixed(1)}px`);
      });
    };

    fitCameras();
    window.setTimeout(fitCameras, 250);
    window.addEventListener("resize", fitCameras);
    window.visualViewport?.addEventListener("resize", fitCameras);
    return () => {
      window.removeEventListener("resize", fitCameras);
      window.visualViewport?.removeEventListener("resize", fitCameras);
    };
  }, [trafficByDirection]);

  const data = useMemo(() => {
    if (!liveTraffic) return tripData[direction];
    const checkpointData = (checkpoint: Checkpoint) => {
      const live = liveTraffic.checkpoints[checkpoint];
      return {
        crossing: `${live.crossingRange[0]}–${live.crossingRange[1]}`,
        drive: live.driveMinutes,
        trend: live.trend.label,
        trendTone: live.trend.tone,
        condition: live.condition,
      };
    };
    return {
      route: liveTraffic.recommendation.route,
      depart: liveTraffic.recommendation.depart,
      departAt: liveTraffic.recommendation.departAt,
      clearTime: liveTraffic.recommendation.clearTime,
      clearDestination: liveTraffic.recommendation.clearDestination,
      totalMinutes: liveTraffic.recommendation.totalMinutes,
      saving: liveTraffic.recommendation.savingMinutes,
      total: `${liveTraffic.recommendation.totalRange[0]}–${liveTraffic.recommendation.totalRange[1]}`,
      border: `${liveTraffic.checkpoints[liveTraffic.recommendation.route].crossingRange[0]}–${liveTraffic.checkpoints[liveTraffic.recommendation.route].crossingRange[1]}`,
      drive: liveTraffic.checkpoints[liveTraffic.recommendation.route].driveMinutes,
      leaveWindow: liveTraffic.recommendation.depart,
      reason: liveTraffic.recommendation.reason,
      tuas: checkpointData("Tuas"),
      woodlands: checkpointData("Woodlands"),
    };
  }, [direction, liveTraffic]);

  const selectedRoute = routeChoice ?? data.route as Checkpoint;
  const selectedCheckpointData = selectedRoute === "Tuas" ? data.tuas : data.woodlands;
  const activeStartCoordinate = approachSource === "gps"
    ? userLocation
    : approachSource === "address"
      ? addressLocation?.coordinate ?? null
    : null;
  const approachMinutes = estimateApproachMinutes(
    activeStartCoordinate,
    selectedRoute,
    selectedCheckpointData.drive,
  );
  const selectedBorderRange = selectedCheckpointData.crossing;
  const borderMid = crossingMidpoint(selectedBorderRange);
  const displayedMinutes = estimateMode === "border"
    ? borderMid
    : borderMid + approachMinutes;
  const displayedRange = estimateMode === "border"
    ? selectedBorderRange
    : `${Math.max(15, displayedMinutes - 7)}–${displayedMinutes + 9}`;
  const departureAt = data.departAt ? new Date(data.departAt) : new Date();
  const [displayedLow, displayedHigh] = parseMinuteRange(displayedRange);
  const clearRangeStart = roundUpToQuarter(new Date(departureAt.getTime() + displayedLow * 60000));
  const clearRangeEnd = roundUpToQuarter(new Date(departureAt.getTime() + displayedHigh * 60000));
  const displayedClearRange = `${formatTimeLabel(clearRangeStart.toISOString())}–${formatTimeLabel(clearRangeEnd.toISOString())}`;
  const nowDurationRange = displayedRange;
  const selectedForecast = liveTraffic?.forecasts[selectedRoute] ?? [];
  const futureBest = selectedForecast
    .filter((point) => new Date(point.timestamp).getTime() > Date.now() + 30 * 60000)
    .sort((a, b) => a.predicted - b.predicted)[0];
  const laterDepartAt = futureBest ? new Date(futureBest.timestamp) : new Date(Date.now() + 60 * 60000);
  const laterBaseMinutes = futureBest?.predicted ?? borderMid;
  const laterTotalMid = estimateMode === "border" ? laterBaseMinutes : laterBaseMinutes + approachMinutes;
  const laterDurationRange = rangeText(laterTotalMid - 7, laterTotalMid + 9);
  const laterClearStart = roundUpToQuarter(new Date(laterDepartAt.getTime() + (laterTotalMid - 7) * 60000));
  const laterClearEnd = roundUpToQuarter(new Date(laterDepartAt.getTime() + (laterTotalMid + 9) * 60000));
  const laterClearRange = `${formatTimeLabel(laterClearStart.toISOString())}–${formatTimeLabel(laterClearEnd.toISOString())}`;
  const recommendedDeparture = laterTotalMid <= displayedMinutes - 15 ? "later" : "now";
  const activeLocationLabel = approachSource === "gps" && userLocation
    ? "Current location"
    : approachSource === "address" && addressLocation
      ? addressLocation.label
      : "Fixed Singapore approach";
  const selectedEtaRange = selectedDeparture === "now" ? displayedClearRange : laterClearRange;
  const approachBasis = estimateMode === "border"
    ? "Border crossing only"
    : approachSource === "gps" && userLocation
      ? "Location-adjusted approach"
      : approachSource === "address" && addressLocation
        ? `${addressLocation.precision === "postal-sector" ? "Postal-sector" : "Area"} approach estimate`
      : "Fixed approach estimate";

  const liveSeries = useMemo<Record<Checkpoint, Record<ForecastWindow, ChartSeries>>>(() => {
    const fallback = Object.fromEntries((["Tuas", "Woodlands"] as Checkpoint[]).map((checkpoint) => [
      checkpoint,
      {
        current: chartSeries[direction][checkpoint],
        next: chartSeries[direction][checkpoint],
      },
    ])) as Record<Checkpoint, Record<ForecastWindow, ChartSeries>>;
    if (!liveTraffic) return fallback;

    const makeSeries = (checkpoint: Checkpoint, forecastWindow: ForecastWindow): ChartSeries => {
      const offset = forecastWindow === "current" ? 0 : 48;
      const future = liveTraffic.forecasts[checkpoint].slice(offset, offset + 49);
      const current = liveTraffic.checkpoints[checkpoint].waitMinutes;
      const savedHistory = forecastWindow === "current"
        ? liveTraffic.checkpoints[checkpoint].history.slice(-1)
        : [];
      const nowTime = new Date(liveTraffic.generatedAt).getTime();
      const nowIndex = forecastWindow === "current"
        ? future.reduce((nearest, point, index) => {
          const difference = Math.abs(new Date(point.timestamp).getTime() - nowTime);
          return difference < nearest.difference ? { index, difference } : nearest;
        }, { index: 0, difference: Number.POSITIVE_INFINITY }).index
        : null;
      const times = future.map((point, index) => {
        if (index === future.length - 1) return "11.59pm";
        if (index % 8 !== 0) return "";
        return formatHourTick(point.timestamp);
      });
      const actual = future.map((_, index) => index === nowIndex && forecastWindow === "current"
        ? savedHistory[0]?.observed ?? current
        : null);
      const prediction = future.map((point, index) => index === nowIndex && forecastWindow === "current"
        ? current
        : point.predicted);
      const uncertainty = future.map((point) => (
        liveTraffic.checkpoints[checkpoint].uncertainty?.isSevenDayReady
          ? point.uncertaintyMinutes ?? liveTraffic.checkpoints[checkpoint].uncertainty?.minutes ?? 12
          : 12
      ));
      const low = Math.min(...future.map((point) => point.predicted));
      const windows = future.slice(0, -1).map((point) => (
        point.predicted <= low + 4 ? "good" as const : "amber" as const
      ));
      const best = future.reduce((lowest, point) => point.predicted < lowest.predicted ? point : lowest, future[0]);
      const label = forecastWindow === "current" ? "next 24 hours" : "following 24 hours";
      return {
        times,
        actual,
        prediction,
        uncertainty,
        windows,
        nowIndex,
        windowLabel: formatDayWindow(future[0]?.timestamp),
        errorLabel: liveTraffic.checkpoints[checkpoint].uncertainty?.isSevenDayReady
          ? liveTraffic.checkpoints[checkpoint].uncertainty?.label
          : "Mock ±12 min error zone",
        insight: best
          ? `The lowest ${checkpoint} estimate in the ${label} is ${best.predicted} minutes around ${best.time}.`
          : `The current ${checkpoint} estimate is ${current} minutes.`,
      };
    };

    return Object.fromEntries((["Tuas", "Woodlands"] as Checkpoint[]).map((checkpoint) => {
      return [checkpoint, {
        current: makeSeries(checkpoint, "current"),
        next: makeSeries(checkpoint, "next"),
      }];
    })) as Record<Checkpoint, Record<ForecastWindow, ChartSeries>>;
  }, [direction, liveTraffic]);

  const recommendedCameras = camerasForCheckpoint(
    liveTraffic,
    selectedRoute,
    selectedRoute === "Tuas" ? "tuas.jpg" : "woodlands.jpg",
  );

  const cards = useMemo(
    () => [
      {
        name: "Tuas" as Checkpoint,
        ...data.tuas,
        cameras: camerasForCheckpoint(liveTraffic, "Tuas", "tuas.jpg"),
        fallbackImage: "tuas.jpg",
      },
      {
        name: "Woodlands" as Checkpoint,
        ...data.woodlands,
        cameras: camerasForCheckpoint(liveTraffic, "Woodlands", "woodlands.jpg"),
        fallbackImage: "woodlands.jpg",
      },
    ],
    [data, liveTraffic],
  );

  useEffect(() => {
    setFeedbackCheckpoint(data.route as Checkpoint);
    setFeedbackStatus("idle");
  }, [data.route, direction]);

  useEffect(() => {
    setSelectedDeparture(recommendedDeparture);
  }, [recommendedDeparture, selectedRoute]);

  function refresh() {
    void loadTraffic();
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if (window.scrollY <= 0) {
      pullStartY.current = event.touches[0]?.clientY ?? null;
    }
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (pullStartY.current == null || refreshing) {
      pullStartY.current = null;
      return;
    }
    const endY = event.changedTouches[0]?.clientY ?? pullStartY.current;
    if (endY - pullStartY.current > 86) {
      refresh();
    }
    pullStartY.current = null;
  }

  function detectLocation() {
    if (!("geolocation" in navigator)) {
      setLocationStatus("denied");
      return;
    }
    setEstimateMode("approach");
    setApproachSource("gps");
    setLocationStatus("detecting");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setAddressLocation(null);
        setLocationStatus("ready");
      },
      () => {
        setUserLocation(null);
        setLocationStatus("denied");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
  }

  function estimateAddressLocation() {
    setEstimateMode("approach");
    setApproachSource("address");
    const estimate = estimateLocationFromInput(locationInput);
    setAddressLocation(estimate);
    setUserLocation(null);
    setLocationStatus(estimate ? "estimated" : "not-found");
  }

  async function submitFeedback() {
    setFeedbackStatus("saving");
    try {
      const checkpoint = liveTraffic?.checkpoints[feedbackCheckpoint];
      const response = await fetch(`${apiBase()}/api/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direction,
          checkpoint: feedbackCheckpoint,
          actualWaitMinutes,
          estimatedWaitMinutes: checkpoint?.waitMinutes,
          sourceUpdatedAt: checkpoint?.cameraUpdatedAt,
        }),
      });
      if (!response.ok) throw new Error(`Report API returned ${response.status}`);
      setFeedbackStatus("saved");
      void loadTraffic();
    } catch {
      setFeedbackStatus("error");
    }
  }

  return (
    <main className="app-shell landing-shell" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <header className="topbar">
        <div className="updated-line">
          <span>{refreshing ? "Updating…" : `Last updated ${lastChecked}`}</span>
        </div>
        <a className="brand compact" href="#top" aria-label="CrossBorder.sg home">
          <span>CrossBorder<span>.sg</span></span>
        </a>
      </header>

      <section className="landing-card-stack double-card" id="top" aria-label="Checkpoint summaries">
        <LandingCheckpointCard checkpoint="Woodlands" trafficByDirection={trafficByDirection} />
        <LandingCheckpointCard checkpoint="Tuas" trafficByDirection={trafficByDirection} />
      </section>

    </main>
  );
}
