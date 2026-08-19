"use client";

import { type TouchEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createShadowBiasState,
  learnShadowBias,
  shadowEffectiveBias,
  shadowMinutesForSource,
} from "../lib/crossing-calibration";

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
type SparkSeries = { today: SparkPoint[]; comparison: SparkPoint[] };
type HourlyPattern = { today: number[]; comparison: number[] };
type AuthUser = {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  hostedDomain: string | null;
};
type AuthState =
  | { status: "disabled" }
  | { status: "signed-out" | "loading" | "error"; message?: string }
  | { status: "ready"; sessionToken: string; user: AuthUser };
type GoogleCredentialResponse = { credential?: string; select_by?: string };
type ApproachId =
  | "woodlands-bke-right"
  | "woodlands-bke-left"
  | "woodlands-road-left"
  | "woodlands-jln-lingkaran-dalam"
  | "woodlands-ah2"
  | "woodlands-bukit-chagar"
  | "woodlands-jb-city-square";
type ApproachRouteOption = {
  id: ApproachId;
  preApproachMinutes: number | null;
  crossingMinutes: number;
  totalMinutes: number;
};
type ApproachHistoryPoint = { hour: number; minutes: number };
type ApproachHistorySeries = {
  today: ApproachHistoryPoint[];
  comparison: ApproachHistoryPoint[];
  comparisonLabel: string;
};
type ApproachHistoryScale = { low: number; high: number };
type AdjustedApproachTime = { minutes: number; timestamp: string };
type AdjustedApproachTimes = Partial<Record<ApproachId, AdjustedApproachTime>>;
type AdjustedApproachSheet = {
  history: Partial<Record<ApproachId, ApproachHistorySeries>>;
  latest: AdjustedApproachTimes;
};
type ApproachTripReport = {
  direction: Direction;
  checkpoint: "Woodlands";
  approachId: ApproachId;
  startedAt: string;
  clearedAt: string;
  estimatedMinutes: number;
  actualWaitMinutes: number;
  joinLatitude: number;
  joinLongitude: number;
  clearLatitude: number;
  clearLongitude: number;
  locationAccuracyMeters: number | null;
};
type CapturedLocation = Coordinate & { accuracy: number | null };
type QueueCapture = {
  direction: Direction;
  approachId: ApproachId;
  estimatedMinutes: number;
  startedAt: string;
  location: CapturedLocation;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (options: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
            auto_select?: boolean;
            use_fedcm_for_prompt?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, options: {
            theme?: "outline" | "filled_blue" | "filled_black";
            size?: "large" | "medium" | "small";
            shape?: "rectangular" | "pill" | "circle" | "square";
            text?: "signin_with" | "signup_with" | "continue_with" | "signin";
            width?: number;
          }) => void;
          prompt: () => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

const checkpointSgSaturdayPattern: Record<Direction, Record<Checkpoint, HourlyPattern>> = {
  "sg-my": {
    Woodlands: {
      today: [55, 28, 20, 20, 20, 21, 34, 52, 74, 70, 80, 86, 63, 70, 76, 69, 55, 68, 52, 34, 29, 30, 33, 31],
      comparison: [45, 30, 20, 20, 20, 22, 35, 40, 52, 33, 38, 40, 42, 38, 40, 41, 28, 32, 34, 34, 30, 28, 32, 29],
    },
    Tuas: {
      today: [20, 20, 20, 20, 20, 22, 25, 50, 38, 47, 55, 60, 58, 40, 43, 47, 35, 30, 40, 30, 20, 20, 20, 20],
      comparison: [20, 20, 20, 20, 20, 20, 22, 30, 25, 20, 20, 20, 20, 20, 20, 20, 20, 23, 20, 20, 20, 20, 20, 20],
    },
  },
  "my-sg": {
    Woodlands: {
      today: [25, 20, 20, 20, 20, 20, 20, 24, 40, 36, 31, 30, 38, 42, 34, 32, 45, 47, 44, 38, 36, 48, 43, 68],
      comparison: [28, 20, 20, 22, 23, 20, 20, 22, 22, 24, 24, 28, 30, 34, 33, 32, 50, 52, 38, 28, 30, 32, 50, 58],
    },
    Tuas: {
      today: [20, 20, 20, 20, 20, 20, 20, 20, 22, 22, 22, 20, 25, 30, 24, 28, 38, 30, 35, 30, 34, 36, 52, 44],
      comparison: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21, 25, 22, 22, 22, 25, 24, 28, 25, 24, 22, 20, 28],
    },
  },
};

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
  const singaporeCameras = current?.cameras?.length
    ? current.cameras
    : [{
        cameraId: checkpoint,
        imageUrl: current?.imageUrl ?? fallbackImage,
        updatedAt: current?.cameraUpdatedAt ?? "",
        label: `${checkpoint} checkpoint`,
      }];
  const malaysiaCameras: Record<Checkpoint, LiveCamera[]> = {
    Woodlands: [
      {
        cameraId: "my-woodlands-jb-ciq",
        imageUrl: "https://odis.sgp1.digitaloceanspaces.com/node/L22_C2_Jalan_Jim_Quee___CIQ",
        updatedAt: "",
        label: "Malaysia side · JB CIQ",
      },
      {
        cameraId: "my-woodlands-ismail-sultan",
        imageUrl: "https://odis.sgp1.digitaloceanspaces.com/node/L23_C1_Jalan_Ismail_Sultan___Jalan_Ibrahim_Sultan",
        updatedAt: "",
        label: "Malaysia side · CIQ approach",
      },
    ],
    Tuas: [
      {
        cameraId: "my-tuas-second-link-0.5",
        imageUrl: "https://odis.sgp1.digitaloceanspaces.com/node/second_link_0.5",
        updatedAt: "",
        label: "Malaysia side · Second Link 0.5km",
      },
      {
        cameraId: "my-tuas-second-link-1.3",
        imageUrl: "https://odis.sgp1.digitaloceanspaces.com/node/second_link_1.3",
        updatedAt: "",
        label: "Malaysia side · Second Link 1.3km",
      },
      {
        cameraId: "my-tuas-second-link-4.7",
        imageUrl: "https://odis.sgp1.digitaloceanspaces.com/node/second_link_4.7",
        updatedAt: "",
        label: "Malaysia side · Second Link 4.7km",
      },
    ],
  };
  return [...singaporeCameras, ...malaysiaCameras[checkpoint]];
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

function observedTrend(points: SparkPoint[], current: number, fallbackTrend: string, nowMs: number | null) {
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
  const lookBehind = Math.max(startMs, clampedNow - 2 * 60 * 60 * 1000);
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

  const nowValue = current;
  const previousValue = interpolate(lookBehind);
  const delta = nowValue - previousValue;
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

function lastWeekComparisonPoints(
  trafficByDirection: TrafficByDirection,
  direction: Direction,
  checkpoint: Checkpoint,
): SparkPoint[] {
  void trafficByDirection;
  const values = checkpointSgSaturdayPattern[direction][checkpoint].comparison;
  const todayBase = new Date();
  todayBase.setHours(0, 0, 0, 0);
  return [...values, values[values.length - 1] ?? 50].map((predicted, index) => ({
    timestamp: new Date(todayBase.getTime() + index * 60 * 60 * 1000).toISOString(),
    predicted: predicted ?? 50,
    zone: waitTone(predicted ?? 50),
  }));
}

function todaySparklinePoints(
  trafficByDirection: TrafficByDirection,
  direction: Direction,
  checkpoint: Checkpoint,
): SparkPoint[] {
  const live = trafficByDirection[direction];
  const checkpointData = live?.checkpoints[checkpoint];
  const now = new Date(live?.generatedAt ?? Date.now());
  const todayBase = new Date(now);
  todayBase.setHours(0, 0, 0, 0);
  const current = checkpointData?.waitMinutes ?? compactCheckpointData(live, direction, checkpoint).waitMinutes;
  const values = checkpointSgSaturdayPattern[direction][checkpoint].today;
  const nowHour = now.getHours();
  const points = values.slice(0, Math.min(values.length, nowHour + 1)).map((predicted, index) => ({
    timestamp: new Date(todayBase.getTime() + index * 60 * 60 * 1000).toISOString(),
    predicted,
    zone: waitTone(predicted),
  }));
  points.push({
    timestamp: now.toISOString(),
    predicted: current,
    zone: waitTone(current),
  });
  return points
    .filter((point, index, all) => index === 0 || point.timestamp !== all[index - 1].timestamp)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function sparklineSeries(
  trafficByDirection: TrafficByDirection,
  direction: Direction,
  checkpoint: Checkpoint,
): SparkSeries {
  return {
    today: todaySparklinePoints(trafficByDirection, direction, checkpoint),
    comparison: lastWeekComparisonPoints(trafficByDirection, direction, checkpoint),
  };
}

function Sparkline24h({
  series,
  current,
  label,
}: {
  series: SparkSeries;
  current: number;
  label: string;
}) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const [chartSize, setChartSize] = useState({ width: 240, height: 74 });
  const chartRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.max(160, Math.round(rect.width));
      const height = Math.max(58, Math.round(rect.height));
      setChartSize((currentSize) => (
        currentSize.width === width && currentSize.height === height
          ? currentSize
          : { width, height }
      ));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chart = useMemo(() => {
    if (nowMs === null) return null;
    const safeToday = series.today
      .filter((point) => Number.isFinite(point.predicted) && Number.isFinite(new Date(point.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const safeComparison = series.comparison
      .filter((point) => Number.isFinite(point.predicted) && Number.isFinite(new Date(point.timestamp).getTime()))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const width = chartSize.width;
    const height = chartSize.height;
    const padding = {
      top: Math.max(11, Math.round(height * 0.12)),
      right: 8,
      bottom: Math.max(8, Math.round(height * 0.1)),
      left: 32,
    };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    if (safeToday.length < 2 && safeComparison.length < 2) return null;

    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const endMs = startMs + 24 * 60 * 60 * 1000;
    const spanMs = Math.max(1, endMs - startMs);
    const minWait = 0;
    const maxWait = 120;
    const timeOffsetMs = (timestamp: string) => {
      const date = new Date(timestamp);
      return Math.min(spanMs, Math.max(0, date.getTime() - startMs));
    };
    const x = (timestamp: string) => padding.left + (timeOffsetMs(timestamp) / spanMs) * plotWidth;
    const y = (value: number) => padding.top + plotHeight - ((value - minWait) / (maxWait - minWait)) * plotHeight;
    const plot = (source: SparkPoint[]) => {
      const waits = source.map((point) => point.predicted);
      const smoothedWaits = waits.map((value, index) => {
        const previous2 = waits[Math.max(0, index - 2)];
        const previous1 = waits[Math.max(0, index - 1)];
        const next1 = waits[Math.min(waits.length - 1, index + 1)];
        const next2 = waits[Math.min(waits.length - 1, index + 2)];
        return (previous2 + previous1 * 2 + value * 4 + next1 * 2 + next2) / 10;
      });
      return source.map((point, index) => ({
        x: x(point.timestamp),
        y: y(smoothedWaits[index]),
        zone: point.zone ?? waitTone(point.predicted),
        timestamp: point.timestamp,
        predicted: smoothedWaits[index],
      }));
    };
    const plottedToday = plot(safeToday);
    const plottedComparison = plot(safeComparison);

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
    const nextIndex = now === null ? -1 : plottedToday.findIndex((point) => startMs + timeOffsetMs(point.timestamp) >= now);
    const rightIndex = nextIndex === -1
      ? plottedToday.length - 1
      : Math.max(1, nextIndex);
    const leftIndex = Math.max(0, rightIndex - 1);
    const right = plottedToday[rightIndex];
    const left = plottedToday[leftIndex];
    const leftMs = startMs + timeOffsetMs(left.timestamp);
    const rightMs = startMs + timeOffsetMs(right.timestamp);
    const localRatio = now === null || rightMs === leftMs ? 0 : Math.min(1, Math.max(0, (now - leftMs) / (rightMs - leftMs)));
    const nowX = now === null ? null : padding.left + ((now - startMs) / spanMs) * plotWidth;
    const nowY = now === null ? null : left.y + (right.y - left.y) * localRatio;
    const nowPoint = nowX === null || nowY === null ? null : { x: nowX, y: nowY };
    const todayPoints = nowPoint
      ? [...plottedToday.filter((point) => startMs + timeOffsetMs(point.timestamp) <= now), nowPoint]
      : plottedToday;

    return {
      width,
      height,
      todayPath: curvePath(todayPoints),
      comparisonPath: curvePath(plottedComparison),
      nowX,
      nowY,
      nowLeft: nowX === null ? null : `${((nowX / width) * 100).toFixed(2)}%`,
      nowTop: nowY === null ? null : `${((nowY / height) * 100).toFixed(2)}%`,
      axisLeft: `${((padding.left / width) * 100).toFixed(2)}%`,
      axisWidth: `${((plotWidth / width) * 100).toFixed(2)}%`,
      padding,
      plotHeight,
      yTicks: [0, 60, 120].map((value) => ({ value, y: y(value) })),
      zones: todayPoints.slice(0, -1).map((point, index) => {
        const next = todayPoints[index + 1];
        const isCurrentEdge = index === todayPoints.length - 2;
        return {
          x: point.x,
          w: Math.max(0, next.x - point.x - (isCurrentEdge ? 2 : 0)),
          tone: waitTone((point.predicted + next.predicted) / 2),
        };
      }),
      grid: [padding.top, padding.top + plotHeight / 2, padding.top + plotHeight],
    };
  }, [chartSize.height, chartSize.width, current, nowMs, series.comparison, series.today]);

  return (
    <div className="sparkline-card" ref={chartRef}>
      {chart && (
        <svg
          width={chart.width}
          height={chart.height}
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={label}
        >
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
          <path className="spark-line-comparison" d={chart.comparisonPath} />
          <path className="spark-line-underlay" d={chart.todayPath} />
          <path className="spark-line" d={chart.todayPath} />
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

function LandingSignalRow({
  checkpoint,
  direction,
  trafficByDirection,
  trendNowMs,
}: {
  checkpoint: Checkpoint;
  direction: Direction;
  trafficByDirection: TrafficByDirection;
  trendNowMs: number | null;
}) {
  const data = compactCheckpointData(trafficByDirection[direction], direction, checkpoint);
  const series = sparklineSeries(trafficByDirection, direction, checkpoint);
  const projection = observedTrend(series.today, data.waitMinutes, data.trend, trendNowMs);
  const durationTone = trafficSignalTone(data.waitMinutes, projection.trend);
  const directionLabel = direction === "sg-my" ? "towards Johor" : "towards Singapore";

  return (
    <div className="direction-signal-row">
      <div className="duration-row">
        <span className="checkpoint-row-label">{checkpoint}</span>
        <strong className={`duration-time duration-time-${durationTone}`}>{data.crossing} <em>min</em></strong>
        <small className={`trend-chip trend-chip-${projection.trendTone}`}>{projection.trend}</small>
      </div>
      <Sparkline24h
        series={series}
        current={data.waitMinutes}
        label={`${checkpoint} today crossing time ${directionLabel} compared with same weekday last week`}
      />
    </div>
  );
}

function LandingDirectionCard({
  direction,
  title,
  trafficByDirection,
}: {
  direction: Direction;
  title: string;
  trafficByDirection: TrafficByDirection;
}) {
  const woodlandsPoints = lastWeekComparisonPoints(trafficByDirection, direction, "Woodlands");
  const tuasPoints = lastWeekComparisonPoints(trafficByDirection, direction, "Tuas");
  const [trendNowMs, setTrendNowMs] = useState<number | null>(null);

  useEffect(() => {
    setTrendNowMs(Date.now());
    const timer = window.setInterval(() => setTrendNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="landing-direction-card">
      <div className="landing-direction-heading">
        <h1>{title}</h1>
      </div>
      <div className="landing-card-body">
        <LandingSignalRow
          checkpoint="Woodlands"
          direction={direction}
          trafficByDirection={trafficByDirection}
          trendNowMs={trendNowMs}
        />
        <div className="spark-axis-row">
          <div aria-hidden="true" />
          <SparklineAxis points={woodlandsPoints.length >= tuasPoints.length ? woodlandsPoints : tuasPoints} />
        </div>
        <LandingSignalRow
          checkpoint="Tuas"
          direction={direction}
          trafficByDirection={trafficByDirection}
          trendNowMs={trendNowMs}
        />
      </div>
    </article>
  );
}

function LandingCameraCard({
  checkpoint,
  trafficByDirection,
}: {
  checkpoint: Checkpoint;
  trafficByDirection: TrafficByDirection;
}) {
  const cameraTraffic = trafficByDirection["sg-my"] ?? trafficByDirection["my-sg"] ?? null;
  const fallbackImage = checkpoint === "Tuas" ? "tuas.jpg" : "woodlands.jpg";
  const cameras = camerasForCheckpoint(cameraTraffic, checkpoint, fallbackImage);

  return (
    <article className="landing-camera-card">
      <div className="landing-camera-header">
        <CameraCarousel
          cameras={cameras}
          title={`${checkpoint} cameras`}
          fallbackImage={fallbackImage}
          compact
          auto
        />
        <h2><span>{checkpoint}</span></h2>
      </div>
    </article>
  );
}

function directionTitle(direction: Direction) {
  return direction === "sg-my" ? "Towards Johor" : "Towards Singapore";
}

function directionShortLabel(direction: Direction) {
  return direction === "sg-my" ? "to JB" : "to SG";
}

function buildDirectionDecision(
  direction: Direction,
  trafficByDirection: TrafficByDirection,
) {
  const traffic = trafficByDirection[direction];
  const woodlands = compactCheckpointData(traffic, direction, "Woodlands");
  const tuas = compactCheckpointData(traffic, direction, "Tuas");
  const chosenRoute = traffic?.recommendation.route
    ?? (tuas.waitMinutes <= woodlands.waitMinutes ? "Tuas" : "Woodlands");
  const otherRoute: Checkpoint = chosenRoute === "Tuas" ? "Woodlands" : "Tuas";
  const chosen = chosenRoute === "Tuas" ? tuas : woodlands;
  const other = otherRoute === "Tuas" ? tuas : woodlands;
  const computedSaving = Math.max(0, other.waitMinutes - chosen.waitMinutes);
  const saving = Math.max(0, traffic?.recommendation.savingMinutes ?? computedSaving);
  const action = traffic?.recommendation.action === "wait" && traffic.recommendation.departAt
    ? `Wait until ${formatTimeLabel(traffic.recommendation.departAt)}`
    : `${chosenRoute} now`;
  const confidence = traffic?.recommendation.confidenceLabel ?? "confidence building";
  return {
    direction,
    title: directionTitle(direction),
    action,
    checkpoint: chosenRoute,
    otherCheckpoint: otherRoute,
    chosen,
    other,
    saving,
    confidence,
  };
}

function V2DecisionCard({
  decision,
}: {
  decision: ReturnType<typeof buildDirectionDecision>;
}) {
  const tone = trafficSignalTone(decision.chosen.waitMinutes, decision.chosen.trend);
  return (
    <article className="v2-decision-card">
      <div className="v2-decision-copy">
        <span className="v2-direction-label">{decision.title}</span>
        <h1>{decision.action}</h1>
        <p>
          {decision.saving > 0
            ? `Saves about ${decision.saving} min vs ${decision.otherCheckpoint}.`
            : `${decision.otherCheckpoint} is running close.`}
        </p>
      </div>
      <div className={`v2-hero-time v2-time-${tone}`}>
        <strong>{decision.chosen.crossing}</strong>
        <span>min</span>
      </div>
      <div className="v2-confidence-row">
        <span>{decision.checkpoint}</span>
        <small>{decision.confidence}</small>
      </div>
    </article>
  );
}

function V2TimeTile({
  checkpoint,
  direction,
  trafficByDirection,
  trendNowMs,
}: {
  checkpoint: Checkpoint;
  direction: Direction;
  trafficByDirection: TrafficByDirection;
  trendNowMs: number | null;
}) {
  const data = compactCheckpointData(trafficByDirection[direction], direction, checkpoint);
  const series = sparklineSeries(trafficByDirection, direction, checkpoint);
  const projection = observedTrend(series.today, data.waitMinutes, data.trend, trendNowMs);
  const tone = trafficSignalTone(data.waitMinutes, projection.trend);

  return (
    <article className="v2-time-tile">
      <div className="v2-tile-head">
        <div>
          <strong>{checkpoint}</strong>
          <span>{directionShortLabel(direction)}</span>
        </div>
        <div className={`v2-tile-time v2-time-${tone}`}>
          <b>{data.crossing}</b>
          <small>min</small>
        </div>
      </div>
      <div className="v2-tile-meta">
        <span className={`trend-chip trend-chip-${projection.trendTone}`}>{projection.trend}</span>
        <small>today vs last week</small>
      </div>
      <Sparkline24h
        series={series}
        current={data.waitMinutes}
        label={`${checkpoint} ${directionTitle(direction)} today against last week`}
      />
    </article>
  );
}

function V2CameraStrip({
  trafficByDirection,
}: {
  trafficByDirection: TrafficByDirection;
}) {
  return (
    <section className="v2-camera-section" aria-label="Camera checks">
      <div className="v2-section-head">
        <h2>Camera check</h2>
        <span>SG + MY views</span>
      </div>
      <div className="v2-camera-grid">
        <LandingCameraCard checkpoint="Woodlands" trafficByDirection={trafficByDirection} />
        <LandingCameraCard checkpoint="Tuas" trafficByDirection={trafficByDirection} />
      </div>
    </section>
  );
}

const gmapsSheetUrl = "https://docs.google.com/spreadsheets/d/1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo/export?format=csv&gid=0";
const checkpointSheetUrl = "https://docs.google.com/spreadsheets/d/1BMiLAjo9n-suZ080HRHtLGV2gNjcBJDidr_ZD8ruubo/export?format=csv&gid=734892105";
const approachGmapsColumns: Record<ApproachId, string> = {
  "woodlands-bke-right": "SG-JB A | BKE Flyover",
  "woodlands-bke-left": "SG-JB B | BKE Junction",
  "woodlands-road-left": "SG-JB C | Woodlands Rd",
  "woodlands-jln-lingkaran-dalam": "JB-SG A | Lingkaran Dalam S",
  "woodlands-ah2": "JB-SG B | AH2",
  "woodlands-bukit-chagar": "JB-SG C | Bukit Chagar",
  "woodlands-jb-city-square": "JB-SG D | Lingkaran Dalam N",
};
const approachDirections: Record<ApproachId, Direction> = {
  "woodlands-bke-right": "sg-my",
  "woodlands-bke-left": "sg-my",
  "woodlands-road-left": "sg-my",
  "woodlands-jln-lingkaran-dalam": "my-sg",
  "woodlands-ah2": "my-sg",
  "woodlands-bukit-chagar": "my-sg",
  "woodlands-jb-city-square": "my-sg",
};

function parseCsvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }
  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function singaporeDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeApproachSheetRows(csv: string) {
  const [rawHeader = [], ...rows] = parseCsvRows(csv);
  const embeddedHeader = rawHeader[0]?.split("\t").map((value) => value.trim()) ?? [];
  const header = embeddedHeader.length > 1 ? embeddedHeader : rawHeader;
  return { header, rows };
}

function parseSingaporeSheetTime(value: string) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return {
    key: `${year}-${month}-${day}`,
    hour: Number(hour) + Number(minute) / 60,
    at: new Date(`${year}-${month}-${day}T${hour.padStart(2, "0")}:${minute}:00+08:00`).getTime(),
    stamp: `${year}-${month}-${day} ${hour.padStart(2, "0")}:${minute}`,
  };
}

type CheckpointMids = { towardsJb: number | null; towardsSg: number | null; at: number };

function parseCheckpointMids(csv: string): CheckpointMids[] {
  const { header, rows } = normalizeApproachSheetRows(csv);
  const timestampIndex = header.indexOf("Timestamp (SGT)");
  const jbIndex = header.indexOf("SG-JB | Woodlands (midpoint)");
  const sgIndex = header.indexOf("JB-SG | Woodlands (midpoint)");
  if (timestampIndex === -1 || jbIndex === -1 || sgIndex === -1) {
    throw new Error("Checkpoint.sg sheet is missing Woodlands midpoint columns.");
  }
  return rows.flatMap((row) => {
    const time = parseSingaporeSheetTime(row[timestampIndex] ?? "");
    if (!time) return [];
    const towardsJb = Number(row[jbIndex]);
    const towardsSg = Number(row[sgIndex]);
    return [{
      towardsJb: Number.isFinite(towardsJb) && towardsJb > 0 ? towardsJb : null,
      towardsSg: Number.isFinite(towardsSg) && towardsSg > 0 ? towardsSg : null,
      at: time.at,
    }];
  }).sort((left, right) => left.at - right.at);
}

function quarterSlotMs(at: number) {
  return Math.floor(at / 900_000) * 900_000;
}

function meanPositive(values: Array<number | null>) {
  const finite = values.filter((value): value is number => Number.isFinite(value) && value > 0);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function parseCalibratedApproachSheet(gmapsCsv: string, checkpointCsv: string): AdjustedApproachSheet {
  const { header, rows } = normalizeApproachSheetRows(gmapsCsv);
  const timestampIndex = header.indexOf("Timestamp (SGT)");
  if (timestampIndex === -1) throw new Error("GMaps sheet is missing its timestamp column.");
  const checkpointBySlot = new Map<number, CheckpointMids>();
  for (const row of parseCheckpointMids(checkpointCsv)) {
    checkpointBySlot.set(quarterSlotMs(row.at), row);
  }
  const now = new Date();
  const comparisonDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayKey = singaporeDateKey(now);
  const comparisonKey = singaporeDateKey(comparisonDate);
  const comparisonLabel = `Last ${new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    weekday: "short",
  }).format(comparisonDate)}`;
  const columnIndex = Object.fromEntries(
    Object.entries(approachGmapsColumns).map(([approachId, column]) => [approachId, header.indexOf(column)]),
  ) as Record<ApproachId, number>;
  const historyBuckets = Object.fromEntries(
    Object.keys(approachGmapsColumns).map((approachId) => [approachId, {
      today: new Map<number, ApproachHistoryPoint>(),
      comparison: new Map<number, ApproachHistoryPoint>(),
    }]),
  ) as Record<ApproachId, { today: Map<number, ApproachHistoryPoint>; comparison: Map<number, ApproachHistoryPoint> }>;
  const latest: AdjustedApproachTimes = {};
  const sgMyIds = (Object.keys(approachDirections) as ApproachId[]).filter((id) => approachDirections[id] === "sg-my");
  const mySgIds = (Object.keys(approachDirections) as ApproachId[]).filter((id) => approachDirections[id] === "my-sg");
  const slots = new Map<number, { time: NonNullable<ReturnType<typeof parseSingaporeSheetTime>>; sourceByApproach: Record<ApproachId, number | null> }>();

  for (const row of rows) {
    const time = parseSingaporeSheetTime(row[timestampIndex] ?? "");
    if (!time) continue;
    slots.set(quarterSlotMs(time.at), {
      time,
      sourceByApproach: Object.fromEntries(
        (Object.keys(approachGmapsColumns) as ApproachId[]).map((approachId) => {
          const index = columnIndex[approachId];
          const minutes = index === -1 ? NaN : Number(row[index]);
          return [approachId, Number.isFinite(minutes) && minutes > 0 ? minutes : null];
        }),
      ) as Record<ApproachId, number | null>,
    });
  }

  const shadowState = {
    "sg-my": createShadowBiasState(),
    "my-sg": createShadowBiasState(),
  };

  for (const [slot, { time, sourceByApproach }] of [...slots.entries()].sort(([left], [right]) => left - right)) {
    const checkpoint = checkpointBySlot.get(slot) ?? null;
    const directionMeans: Record<Direction, number | null> = {
      "sg-my": meanPositive(sgMyIds.map((id) => sourceByApproach[id])),
      "my-sg": meanPositive(mySgIds.map((id) => sourceByApproach[id])),
    };
    const directionBias: Record<Direction, number> = {
      "sg-my": shadowEffectiveBias(shadowState["sg-my"], slot),
      "my-sg": shadowEffectiveBias(shadowState["my-sg"], slot),
    };
    for (const approachId of Object.keys(approachGmapsColumns) as ApproachId[]) {
      const gmapsMinutes = sourceByApproach[approachId];
      if (!Number.isFinite(gmapsMinutes) || (gmapsMinutes as number) <= 0) continue;
      const direction = approachDirections[approachId];
      const minutes = shadowMinutesForSource(gmapsMinutes as number, direction, directionBias[direction]);
      const point = { hour: time.hour, minutes };
      latest[approachId] = { minutes, timestamp: time.stamp };
      if (time.key === todayKey) historyBuckets[approachId].today.set(time.hour, point);
      if (time.key === comparisonKey) historyBuckets[approachId].comparison.set(time.hour, point);
    }
    shadowState["sg-my"] = learnShadowBias(
      shadowState["sg-my"],
      directionMeans["sg-my"] ?? Number.NaN,
      checkpoint?.towardsJb,
      "sg-my",
      slot,
      directionBias["sg-my"],
    );
    shadowState["my-sg"] = learnShadowBias(
      shadowState["my-sg"],
      directionMeans["my-sg"] ?? Number.NaN,
      checkpoint?.towardsSg,
      "my-sg",
      slot,
      directionBias["my-sg"],
    );
  }

  const history = Object.fromEntries(
    (Object.keys(approachGmapsColumns) as ApproachId[]).map((approachId) => [approachId, {
      today: [...historyBuckets[approachId].today.values()].sort((left, right) => left.hour - right.hour),
      comparison: [...historyBuckets[approachId].comparison.values()].sort((left, right) => left.hour - right.hour),
      comparisonLabel,
    }]),
  ) as Partial<Record<ApproachId, ApproachHistorySeries>>;

  return { history, latest };
}

async function fetchSheetCsv(url: string, label: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return response.text();
}

async function fetchAdjustedApproachSheet() {
  const [gmapsCsv, checkpointCsv] = await Promise.all([
    fetchSheetCsv(gmapsSheetUrl, "GMaps"),
    fetchSheetCsv(checkpointSheetUrl, "Checkpoint.sg"),
  ]);
  return parseCalibratedApproachSheet(gmapsCsv, checkpointCsv);
}

function buildAdjustedRouteOptions(
  direction: Direction,
  latest: AdjustedApproachTimes,
  locationRoutes: ApproachRouteOption[] = [],
) {
  const locationById = Object.fromEntries(locationRoutes.map((route) => [route.id, route])) as Partial<Record<ApproachId, ApproachRouteOption>>;
  return Object.fromEntries(woodlandsApproachDefinitions[direction].map((definition) => {
    const crossingMinutes = latest[definition.id]?.minutes;
    if (crossingMinutes == null) throw new Error(`Adjusted crossing time is missing ${definition.label}.`);
    const preApproachMinutes = locationById[definition.id]?.preApproachMinutes ?? null;
    return [definition.id, {
      id: definition.id,
      preApproachMinutes,
      crossingMinutes,
      totalMinutes: crossingMinutes + (preApproachMinutes ?? 0),
    }];
  })) as Record<ApproachId, ApproachRouteOption>;
}

function ApproachHistoryOverlay({
  series,
  scale,
}: {
  series: ApproachHistorySeries;
  scale: ApproachHistoryScale;
}) {
  const chart = useMemo(() => {
    const all = [...series.today, ...series.comparison];
    if (!all.length) return null;
    const { low, high } = scale;
    const plotLeft = 30;
    const plotRight = 292;
    const plotTop = 22;
    const plotBottom = 132;
    const x = (hour: number) => plotLeft + Math.max(0, Math.min(24, hour)) / 24 * (plotRight - plotLeft);
    const y = (minutes: number) => {
      const clampedMinutes = Math.max(low, Math.min(high, minutes));
      return plotBottom - (clampedMinutes - low) / (high - low) * (plotBottom - plotTop);
    };
    const path = (points: ApproachHistoryPoint[]) => {
      if (!points.length) return "";
      if (points.length === 1) return `M ${x(points[0].hour).toFixed(1)} ${y(points[0].minutes).toFixed(1)}`;
      const plotted = points.map((point) => ({ x: x(point.hour), y: y(point.minutes) }));
      const commands = [`M ${plotted[0].x.toFixed(1)} ${plotted[0].y.toFixed(1)}`];
      for (let index = 0; index < plotted.length - 1; index += 1) {
        const p0 = plotted[Math.max(0, index - 1)];
        const p1 = plotted[index];
        const p2 = plotted[index + 1];
        const p3 = plotted[Math.min(plotted.length - 1, index + 2)];
        commands.push(`C ${(p1.x + (p2.x - p0.x) / 6).toFixed(1)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(1)}, ${(p2.x - (p3.x - p1.x) / 6).toFixed(1)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
      }
      return commands.join(" ");
    };
    const todayPoint = series.today.length === 1
      ? { x: x(series.today[0].hour), y: y(series.today[0].minutes) }
      : null;
    const timeZones = [
      { key: "green", low: low, high: Math.min(high, 40) },
      { key: "yellow", low: Math.max(low, 40), high: Math.min(high, 80) },
      { key: "red", low: Math.max(low, 80), high },
    ].filter((zone) => zone.high > zone.low).map((zone) => ({
      ...zone,
      y: y(zone.high),
      height: y(zone.low) - y(zone.high),
    }));
    return {
      today: path(series.today),
      comparison: path(series.comparison),
      yTicks: [high, Math.round((low + high) / 10) * 5, low].map((minutes) => ({ minutes, y: y(minutes) })),
      todayPoint,
      timeZones,
    };
  }, [scale, series]);

  if (!chart) return null;
  return (
    <div className="v3-route-history" aria-label={`Route crossing time today compared with ${series.comparisonLabel}`}>
      <div className="v3-route-history-legend" aria-hidden="true">
        <span className="today">Today</span>
        <span className="comparison">{series.comparisonLabel}</span>
      </div>
      <div className="v3-route-history-plot">
        <svg viewBox="0 0 300 140" preserveAspectRatio="none" aria-hidden="true">
          {chart.timeZones.map((zone) => (
            <rect key={zone.key} x="30" width="262" y={zone.y} height={zone.height} className={`time-zone ${zone.key}`} />
          ))}
          {chart.yTicks.map((tick) => (
            <line key={tick.minutes} x1="30" x2="292" y1={tick.y} y2={tick.y} className="grid" />
          ))}
          {chart.comparison && <path d={chart.comparison} className="comparison" />}
          {chart.today && <path d={chart.today} className="today" />}
          {chart.todayPoint && <circle cx={chart.todayPoint.x} cy={chart.todayPoint.y} r="3" className="today-point" />}
        </svg>
        <div className="v3-route-history-axis" aria-hidden="true">
          {chart.yTicks.map((tick) => (
            <span key={tick.minutes} style={{ top: `${(tick.y / 140) * 100}%` }}>{tick.minutes}m</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function V3WoodlandsApproach({
  submitApproachReport,
}: {
  submitApproachReport: (report: ApproachTripReport) => Promise<void>;
}) {
  const [travelDirection, setTravelDirection] = useState<Direction>("sg-my");
  const [selectedApproach, setSelectedApproach] = useState<ApproachId>("woodlands-bke-left");
  const [visualLoadingApproach, setVisualLoadingApproach] = useState<ApproachId | null>("woodlands-bke-left");
  const [locationState, setLocationState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [locationMessage, setLocationMessage] = useState("");
  const [navigateState, setNavigateState] = useState<"idle" | "locating" | "error">("idle");
  const [navigateMessage, setNavigateMessage] = useState("");
  const [sideAlert, setSideAlert] = useState<string | null>(null);
  const [routeOptions, setRouteOptions] = useState<Partial<Record<ApproachId, ApproachRouteOption>>>({});
  const [routeHistory, setRouteHistory] = useState<Partial<Record<ApproachId, ApproachHistorySeries>>>({});
  const [queueCapture, setQueueCapture] = useState<QueueCapture | null>(null);
  const [queueState, setQueueState] = useState<"idle" | "locating-join" | "queued" | "locating-clear" | "saving" | "saved" | "error">("idle");
  const [queueMessage, setQueueMessage] = useState("");
  const [routeScrollThumb, setRouteScrollThumb] = useState<{ top: number; height: number } | null>(null);
  const routeListRef = useRef<HTMLDivElement>(null);
  const preloadedRouteImages = useRef<HTMLImageElement[]>([]);
  const definitions = woodlandsApproachDefinitions[travelDirection];

  const routes = useMemo(() => {
    return definitions.map((definition) => {
      const option = routeOptions[definition.id];
      return {
        ...definition,
        crossingMinutes: option?.crossingMinutes ?? null,
        preApproachMinutes: option?.preApproachMinutes ?? null,
        durationMinutes: option?.totalMinutes ?? null,
      };
    });
  }, [definitions, routeOptions]);

  const routeHistoryScale: ApproachHistoryScale = { low: 0, high: 120 };

  const readyRoutes = routes.filter((route): route is typeof route & { durationMinutes: number; crossingMinutes: number } => (
    route.durationMinutes != null && route.crossingMinutes != null
  ));
  const best = readyRoutes.reduce<typeof readyRoutes[number] | null>((current, route) => (
    !current || route.durationMinutes < current.durationMinutes ? route : current
  ), null);
  const selected = readyRoutes.find((route) => route.id === selectedApproach) ?? best;
  const hasLiveTimes = readyRoutes.length === definitions.length;

  function displayRouteOptions(options: Record<ApproachId, ApproachRouteOption>, direction: Direction) {
    const nextDefinitions = woodlandsApproachDefinitions[direction];
    setRouteOptions(options);
    const recommended = nextDefinitions
      .map((definition) => options[definition.id])
      .reduce((current, route) => route.totalMinutes < current.totalMinutes ? route : current);
    setVisualLoadingApproach(recommended.id === selectedApproach ? null : recommended.id);
    setSelectedApproach(recommended.id);
    setLocationState("ready");
  }

  function loadCrossingRoutes(direction: Direction) {
    setLocationState("loading");
    setLocationMessage("");
    void fetchAdjustedApproachSheet().then((sheet) => {
      setRouteHistory(sheet.history);
      displayRouteOptions(buildAdjustedRouteOptions(direction, sheet.latest), direction);
    }).catch((error) => {
      setRouteOptions({});
      setLocationState("error");
      setLocationMessage(error instanceof Error ? error.message : "Adjusted crossing times could not load. Reopen the app to retry.");
    });
  }

  async function startNavigation() {
    if (!selected || navigateState === "locating") return;
    setNavigateState("locating");
    setNavigateMessage("");
    try {
      const coordinate = await requestGrantedLocation();
      if (!isOnDepartureSide(coordinate, travelDirection)) {
        setNavigateState("idle");
        setSideAlert(wrongSideCheckpointMessage(travelDirection));
        return;
      }
      const url = googleMapsNavigationUrl(travelDirection, selected.id);
      const opened = window.open(url, "_blank");
      if (!opened) window.location.assign(url);
      setNavigateState("idle");
    } catch (error) {
      setNavigateState("error");
      setNavigateMessage(error instanceof Error ? error.message : "Could not start navigation.");
    }
  }

  function switchDirection(direction: Direction) {
    if (direction === travelDirection) return;
    setTravelDirection(direction);
    setRouteOptions({});
    const nextApproach = woodlandsApproachDefinitions[direction][0].id;
    setVisualLoadingApproach(nextApproach);
    setSelectedApproach(nextApproach);
    setQueueCapture(null);
    setQueueState("idle");
    setQueueMessage("");
    setNavigateState("idle");
    setNavigateMessage("");
    setSideAlert(null);
    loadCrossingRoutes(direction);
  }

  useEffect(() => {
    loadCrossingRoutes("sg-my");
  }, []);

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      preloadedRouteImages.current = Object.values(woodlandsApproachVisualImages).map((asset) => {
        const image = new Image();
        image.decoding = "async";
        image.src = staticAssetUrl(asset);
        return image;
      });
    }, 800);
    return () => window.clearTimeout(preloadTimer);
  }, []);

  useEffect(() => {
    const list = routeListRef.current;
    if (travelDirection !== "my-sg" || !hasLiveTimes || !list) {
      setRouteScrollThumb(null);
      return;
    }

    const updateThumb = () => {
      const { scrollTop, scrollHeight, clientHeight } = list;
      if (scrollHeight <= clientHeight + 1) {
        setRouteScrollThumb(null);
        return;
      }
      const trackHeight = Math.max(0, clientHeight - 16);
      const thumbHeight = Math.max(28, (clientHeight / scrollHeight) * trackHeight);
      const maxTop = Math.max(0, trackHeight - thumbHeight);
      const top = (scrollTop / (scrollHeight - clientHeight)) * maxTop;
      setRouteScrollThumb({ top, height: thumbHeight });
    };

    list.querySelector<HTMLButtonElement>('button[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
    updateThumb();
    list.addEventListener("scroll", updateThumb, { passive: true });
    return () => list.removeEventListener("scroll", updateThumb);
  }, [hasLiveTimes, selectedApproach, travelDirection]);

  function selectApproach(approachId: ApproachId) {
    if (approachId === selectedApproach) return;
    setVisualLoadingApproach(approachId);
    setSelectedApproach(approachId);
  }

  async function recordQueueJoin() {
    if (!selected) return;
    const startedAt = new Date().toISOString();
    const selectedAtJoin = selected;
    const directionAtJoin = travelDirection;
    setQueueState("locating-join");
    setQueueMessage("");
    try {
      const location = await requestGrantedLocation({ enableHighAccuracy: true, maximumAge: 0 });
      if (!isOnDepartureSide(location, directionAtJoin)) {
        setQueueState("idle");
        setSideAlert(wrongSideCheckpointMessage(directionAtJoin));
        return;
      }
      setQueueCapture({
        direction: directionAtJoin,
        approachId: selectedAtJoin.id,
        estimatedMinutes: selectedAtJoin.crossingMinutes,
        startedAt,
        location,
      });
      setQueueState("queued");
      setQueueMessage("Queue start recorded.");
    } catch (error) {
      setQueueState("error");
      setQueueMessage(error instanceof Error ? error.message : "Could not record the queue start.");
    }
  }

  async function recordCustomsClearance() {
    if (!queueCapture) return;
    const clearedAt = new Date().toISOString();
    setQueueState("locating-clear");
    setQueueMessage("");
    try {
      const location = await requestCurrentLocation({ enableHighAccuracy: true, maximumAge: 0 });
      const actualWaitMinutes = Math.max(1, Math.round((new Date(clearedAt).getTime() - new Date(queueCapture.startedAt).getTime()) / 60_000));
      setQueueState("saving");
      await submitApproachReport({
        direction: queueCapture.direction,
        checkpoint: "Woodlands",
        approachId: queueCapture.approachId,
        startedAt: queueCapture.startedAt,
        clearedAt,
        estimatedMinutes: queueCapture.estimatedMinutes,
        actualWaitMinutes,
        joinLatitude: queueCapture.location.latitude,
        joinLongitude: queueCapture.location.longitude,
        clearLatitude: location.latitude,
        clearLongitude: location.longitude,
        locationAccuracyMeters: Math.max(queueCapture.location.accuracy ?? 0, location.accuracy ?? 0) || null,
      });
      setQueueCapture(null);
      setQueueState("saved");
      setQueueMessage(`Recorded ${actualWaitMinutes} min for calibration.`);
    } catch (error) {
      setQueueState("error");
      setQueueMessage(error instanceof Error ? error.message : "Could not record customs clearance.");
    }
  }

  return (
    <section className="v3-landing" id="top" aria-label="Woodlands approach recommendation">
      <div className="v3-checkpoint-tabs" role="tablist" aria-label="Checkpoint">
        <button type="button" role="tab" aria-selected="true">Woodlands</button>
        <button type="button" role="tab" aria-selected="false" disabled>Tuas</button>
      </div>
      <article className={`v3-approach-card ${travelDirection === "my-sg" ? "returning" : ""}`}>
        {locationState === "loading" && <p className="v3-location-status">Checking live route times…</p>}
        {locationState === "error" && <p className="v3-location-status error">{locationMessage}</p>}
        {!hasLiveTimes && locationState !== "loading" && (
          <div className="v3-location-gate" aria-live="polite">
            <span>Route times could not load.</span>
            <button type="button" className="v3-location-action" onClick={() => loadCrossingRoutes(travelDirection)}>RETRY</button>
          </div>
        )}
        {hasLiveTimes && selected && <>
          <div className={`v3-route-list-shell ${travelDirection === "my-sg" ? "returning" : ""}`}>
          <div ref={routeListRef} className={`v3-route-list ${travelDirection === "my-sg" ? "returning" : ""}`} role="radiogroup" aria-label="Woodlands approach options">
          {readyRoutes.map((route) => {
            const isRecommended = route.id === best?.id;
            const isSelected = route.id === selected.id;
            return (
              <button
                key={route.id}
                type="button"
                className={`${isSelected ? "selected " : ""}${isRecommended ? "recommended" : ""}`}
                role="radio"
                aria-checked={isSelected}
                onClick={() => selectApproach(route.id)}
              >
                <span className="v3-route-letter">{route.label.slice(0, 1)}</span>
                <span className="v3-route-copy">
                  <strong>
                    <span>{route.label.slice(4)}</span>
                    {isRecommended && <span className="v3-fastest-chip">FASTEST</span>}
                  </strong>
                </span>
                <span className={`v3-route-time ${durationTone(route.durationMinutes)}`}>{route.durationMinutes} min</span>
              </button>
            );
          })}
          </div>
          {routeScrollThumb && (
            <span className="v3-route-scroll-indicator" aria-hidden="true">
              <span style={{ height: routeScrollThumb.height, transform: `translateY(${routeScrollThumb.top}px)` }} />
            </span>
          )}
          </div>
          <div className={`v3-route-visual ${travelDirection === "sg-my" ? "towards-jb" : ""} ${visualLoadingApproach === selected.id ? "loading" : ""}`} role="img" aria-label={`${selected.label} visual approach to Woodlands checkpoint`} aria-busy={visualLoadingApproach === selected.id}>
          {visualLoadingApproach === selected.id && <span className="v3-route-visual-loading" role="status">Loading route</span>}
          <img
            key={selected.id}
            className={visualLoadingApproach === selected.id ? "is-loading" : ""}
            src={woodlandsApproachVisualImages[selected.id]}
            alt=""
            decoding="async"
            loading="eager"
            fetchPriority="high"
            onLoad={() => setVisualLoadingApproach((current) => current === selected.id ? null : current)}
            onError={() => setVisualLoadingApproach((current) => current === selected.id ? null : current)}
          />
          {visualLoadingApproach !== selected.id && <span className="v3-road-chip">{selected.label.slice(4)}</span>}
          </div>
          {routeHistory[selected.id] && (
            <ApproachHistoryOverlay series={routeHistory[selected.id]!} scale={routeHistoryScale} />
          )}
          {navigateMessage && <p className="v3-navigate-status error" role="alert">{navigateMessage}</p>}
          <div className="v3-route-actions">
            <button
              type="button"
              className="v3-navigate"
              disabled={navigateState === "locating"}
              onClick={() => void startNavigation()}
            >
              {navigateState === "locating" ? "LOCATING…" : "NAVIGATE"}
            </button>
            <div className={`v3-queue-tester ${queueState}`} aria-live="polite">
              <button
                type="button"
                className="v3-queue-tester-button"
                disabled={queueState === "locating-join" || queueState === "locating-clear" || queueState === "saving"}
                onClick={() => queueCapture ? void recordCustomsClearance() : void recordQueueJoin()}
              >
                {queueState === "locating-join" || queueState === "locating-clear" ? "LOCATING..." : queueState === "saving" ? "SAVING..." : queueCapture ? "CLEARED CUSTOMS" : "JOINED QUEUE"}
              </button>
              {queueMessage && <span>{queueMessage}</span>}
            </div>
          </div>
        </>}
      </article>
      {sideAlert && (
        <div className="v3-side-alert" role="alertdialog" aria-modal="true" aria-label="Wrong side of checkpoint" onClick={() => setSideAlert(null)}>
          <p>{sideAlert}</p>
        </div>
      )}
      <nav className="v3-bottom-nav" aria-label="Travel direction">
        <button type="button" className={travelDirection === "sg-my" ? "active" : ""} aria-current={travelDirection === "sg-my" ? "page" : undefined} onClick={() => switchDirection("sg-my")}>
          <DirectionGlyph direction="sg-my" />
          <strong>To Johor</strong>
        </button>
        <button type="button" className={travelDirection === "my-sg" ? "active" : ""} aria-current={travelDirection === "my-sg" ? "page" : undefined} onClick={() => switchDirection("my-sg")}>
          <DirectionGlyph direction="my-sg" />
          <strong>To Singapore</strong>
        </button>
      </nav>
    </section>
  );
}

function V2Landing({
  trafficByDirection,
}: {
  trafficByDirection: TrafficByDirection;
}) {
  const [trendNowMs, setTrendNowMs] = useState<number | null>(null);

  useEffect(() => {
    setTrendNowMs(Date.now());
    const timer = window.setInterval(() => setTrendNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const decisions = [
    buildDirectionDecision("sg-my", trafficByDirection),
    buildDirectionDecision("my-sg", trafficByDirection),
  ];

  return (
    <section className="v2-landing" id="top" aria-label="CrossBorder.sg V2 checkpoint decision board">
      <div className="v2-decision-grid">
        {decisions.map((decision) => (
          <V2DecisionCard key={decision.direction} decision={decision} />
        ))}
      </div>
      <section className="v2-times-card" aria-label="All current checkpoint crossing times">
        <div className="v2-section-head">
          <h2>All crossings</h2>
          <span>today vs last week</span>
        </div>
        <div className="v2-time-grid">
          <V2TimeTile checkpoint="Woodlands" direction="sg-my" trafficByDirection={trafficByDirection} trendNowMs={trendNowMs} />
          <V2TimeTile checkpoint="Tuas" direction="sg-my" trafficByDirection={trafficByDirection} trendNowMs={trendNowMs} />
          <V2TimeTile checkpoint="Woodlands" direction="my-sg" trafficByDirection={trafficByDirection} trendNowMs={trendNowMs} />
          <V2TimeTile checkpoint="Tuas" direction="my-sg" trafficByDirection={trafficByDirection} trendNowMs={trendNowMs} />
        </div>
      </section>
      <V2CameraStrip trafficByDirection={trafficByDirection} />
    </section>
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

function googleClientId() {
  return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
}

const authStorageKey = "crossborder.google-auth.v2";
const locationGrantStorageKey = "crossborder.location-granted.v1";
const woodlandsCheckpointLatitude = 1.455;

function hasRememberedLocationGrant() {
  try {
    return window.localStorage.getItem(locationGrantStorageKey) === "granted";
  } catch {
    return false;
  }
}

function rememberLocationGrant() {
  try {
    window.localStorage.setItem(locationGrantStorageKey, "granted");
  } catch {
    return;
  }
}

function forgetLocationGrant() {
  try {
    window.localStorage.removeItem(locationGrantStorageKey);
  } catch {
    return;
  }
}

function isOnDepartureSide(coordinate: Coordinate, direction: Direction) {
  return direction === "sg-my"
    ? coordinate.latitude < woodlandsCheckpointLatitude
    : coordinate.latitude > woodlandsCheckpointLatitude;
}

function wrongSideCheckpointMessage(direction: Direction) {
  return direction === "sg-my"
    ? "You're already on the Johor side of Woodlands. Switch to To Singapore to continue."
    : "You're already on the Singapore side of Woodlands. Switch to To Johor to continue.";
}

function DirectionGlyph({ direction }: { direction: Direction }) {
  return (
    <svg className="v3-direction-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <g transform={direction === "sg-my" ? undefined : "rotate(180 12 12)"}>
        <path
          d="M6 18L18 6M10 6h8v8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}

async function geolocationPermissionState(): Promise<PermissionState | "unknown"> {
  if (!("permissions" in navigator)) return "unknown";
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    return permission.state;
  } catch {
    return "unknown";
  }
}

function requestCurrentLocation(options: PositionOptions = {}) {
  return new Promise<CapturedLocation>((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("This browser does not support location access."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
      }),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          forgetLocationGrant();
          reject(new Error("Location permission is needed."));
          return;
        }
        reject(new Error("Could not get your location. Check location services and try again."));
      },
      { enableHighAccuracy: false, timeout: 20_000, maximumAge: 5 * 60_000, ...options },
    );
  });
}

async function requestGrantedLocation(options: PositionOptions = {}) {
  if (!hasRememberedLocationGrant()) {
    const permission = await geolocationPermissionState();
    if (permission === "denied") {
      throw new Error("Location is blocked. Enable it in browser settings.");
    }
  }
  const location = await requestCurrentLocation(options);
  rememberLocationGrant();
  return location;
}

const woodlandsApproachDefinitions: Record<Direction, Array<{
  id: ApproachId;
  label: string;
  instruction: string;
  waypoint: Coordinate;
}>> = {
  "sg-my": [
  {
    id: "woodlands-bke-right",
    label: "A · BKE (right) → Flyover",
    instruction: "Right flyover lane",
    waypoint: { latitude: 1.439328, longitude: 103.768422 },
  },
  {
    id: "woodlands-bke-left",
    label: "B · BKE (left) → Junction",
    instruction: "Left mainline lane",
    waypoint: { latitude: 1.439356, longitude: 103.768285 },
  },
  {
    id: "woodlands-road-left",
    label: "C · Woodlands Road",
    instruction: "Left-turn feeder",
    waypoint: { latitude: 1.440516, longitude: 103.768108 },
  },
  ],
  "my-sg": [
    {
      id: "woodlands-jln-lingkaran-dalam",
      label: "A · Jln Lingkaram Dalam (South)",
      instruction: "Johor city approach",
      waypoint: { latitude: 1.472085, longitude: 103.7651 },
    },
    {
      id: "woodlands-ah2",
      label: "B · AH2",
      instruction: "North-south approach",
      waypoint: { latitude: 1.482406, longitude: 103.7832 },
    },
    {
      id: "woodlands-bukit-chagar",
      label: "C · Bukit Chagar",
      instruction: "Central Johor approach",
      waypoint: { latitude: 1.46734, longitude: 103.7658 },
    },
    {
      id: "woodlands-jb-city-square",
      label: "D · Jln Lingkaram Dalam (North)",
      instruction: "Northern city approach",
      waypoint: { latitude: 1.465356, longitude: 103.7702 },
    },
  ],
};

const woodlandsApproachVisualImages: Record<ApproachId, string> = {
  "woodlands-bke-right": "woodlands-approach-a.gif?v=4",
  "woodlands-bke-left": "woodlands-approach-b.gif?v=3",
  "woodlands-road-left": "woodlands-approach-c.gif?v=4",
  "woodlands-jln-lingkaran-dalam": "woodlands-approach-jld-south.gif?v=2",
  "woodlands-ah2": "woodlands-approach-ah2.gif?v=2",
  "woodlands-bukit-chagar": "woodlands-approach-bukit-chagar.gif?v=2",
  "woodlands-jb-city-square": "woodlands-approach-jld-north.gif?v=2",
};

function staticAssetUrl(asset: string) {
  if (typeof window === "undefined") return asset;
  return new URL(asset, document.baseURI).toString();
}

function googleMapsNavigationUrl(direction: Direction, approach: ApproachId) {
  const definition = woodlandsApproachDefinitions[direction].find((item) => item.id === approach)
    ?? woodlandsApproachDefinitions[direction][0];
  const destination = direction === "sg-my" ? "1.466582,103.768091" : "1.4430746,103.7683229";
  const waypoint = `${definition.waypoint.latitude},${definition.waypoint.longitude}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving&waypoints=${encodeURIComponent(waypoint)}`;
}

function durationTone(minutes: number) {
  if (minutes < 40) return "good";
  if (minutes <= 80) return "amber";
  return "bad";
}

function initialAuthState(): AuthState {
  if (!googleClientId()) return { status: "disabled" };
  if (typeof window === "undefined") return { status: "signed-out" };
  try {
    const saved = JSON.parse(window.localStorage.getItem(authStorageKey) ?? "null") as {
      sessionToken?: string;
      expiresAt?: string;
      user?: AuthUser;
    } | null;
    if (saved?.sessionToken && saved.user && saved.expiresAt && new Date(saved.expiresAt).getTime() > Date.now() + 60_000) {
      return { status: "ready", sessionToken: saved.sessionToken, user: saved.user };
    }
  } catch {
    // Ignore corrupt local auth state and show the sign-in gate.
  }
  window.localStorage.removeItem("crossborder.google-auth.v1");
  window.localStorage.removeItem(authStorageKey);
  return { status: "signed-out" };
}

function initialDirection(): Direction {
  if (typeof window === "undefined") return "sg-my";
  return new URLSearchParams(window.location.search).get("direction") === "my-sg"
    ? "my-sg"
    : "sg-my";
}

export default function Home() {
  const [direction, setDirection] = useState<Direction>(() => initialDirection());
  const [auth, setAuth] = useState<AuthState>(() => initialAuthState());
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
  const hasLiveTraffic = useRef(false);
  const isAuthConfigured = Boolean(googleClientId());

  const signOut = useCallback(() => {
    window.google?.accounts.id.disableAutoSelect();
    window.localStorage.removeItem(authStorageKey);
    setAuth({ status: "signed-out" });
    hasLiveTraffic.current = false;
    setTrafficByDirection({});
    setLiveTraffic(null);
  }, []);

  const expireAuth = useCallback(() => {
    window.localStorage.removeItem(authStorageKey);
    setAuth({ status: "signed-out" });
  }, []);

  const completeGoogleSignIn = useCallback(async (credential: string) => {
    setAuth({ status: "loading" });
    try {
      const response = await fetch(`${apiBase()}/api/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const payload = await response.json() as { user?: AuthUser; session?: { token?: string; expiresAt?: string }; message?: string };
      if (!response.ok) throw new Error(payload.message ?? `Google auth returned ${response.status}`);
      if (!payload.user || !payload.session?.token || !payload.session.expiresAt) {
        throw new Error("Google auth response missing session");
      }
      window.localStorage.setItem(authStorageKey, JSON.stringify({
        sessionToken: payload.session.token,
        expiresAt: payload.session.expiresAt,
        user: payload.user,
      }));
      setAuth({ status: "ready", sessionToken: payload.session.token, user: payload.user });
    } catch (error) {
      window.localStorage.removeItem(authStorageKey);
      setAuth({
        status: "error",
        message: error instanceof Error ? error.message : "Google sign-in could not be verified. Try again.",
      });
    }
  }, []);

  const authFetch = useCallback(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (auth.status === "ready") headers.set("Authorization", `Bearer ${auth.sessionToken}`);
    const response = await fetch(input, { ...init, headers });
    if (response.status === 401 && isAuthConfigured) {
      expireAuth();
      throw new Error("Google sign-in expired");
    }
    return response;
  }, [auth, expireAuth, isAuthConfigured]);

  const submitApproachReport = useCallback(async (report: ApproachTripReport) => {
    const response = await authFetch(`${apiBase()}/api/approach-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    const payload = await response.json() as { message?: string };
    if (!response.ok) throw new Error(payload.message ?? `Calibration report returned ${response.status}`);
  }, [authFetch]);

  const loadTraffic = useCallback(async () => {
    if (isAuthConfigured && auth.status !== "ready") {
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    try {
      const directions: Direction[] = ["sg-my", "my-sg"];
      const responses = await Promise.all(directions.map(async (travelDirection) => {
        const response = await authFetch(`${apiBase()}/api/traffic?direction=${travelDirection}`, {
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
      hasLiveTraffic.current = true;
      setLastChecked(new Intl.DateTimeFormat("en-SG", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(primary?.generatedAt ?? Date.now())));
    } catch {
      if (!hasLiveTraffic.current) {
        setLiveTraffic(null);
        setTrafficByDirection({});
        setFeedState("fallback");
      }
      setLastChecked(new Intl.DateTimeFormat("en-SG", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date()));
    } finally {
      setRefreshing(false);
    }
  }, [auth.status, authFetch, direction, isAuthConfigured]);

  useEffect(() => {
    if (!isAuthConfigured || auth.status === "ready") return;
    const clientId = googleClientId();
    let cancelled = false;
    const renderGoogleButton = () => {
      const button = document.getElementById("google-signin-button");
      if (!button || !window.google || cancelled) return;
      button.replaceChildren();
      window.google.accounts.id.initialize({
        client_id: clientId,
        auto_select: false,
        use_fedcm_for_prompt: false,
        callback: (response) => {
          if (response.credential) void completeGoogleSignIn(response.credential);
        },
      });
      window.google.accounts.id.renderButton(button, {
        theme: "outline",
        size: "large",
        shape: "pill",
        text: "continue_with",
        width: 292,
      });
    };

    if (window.google) {
      renderGoogleButton();
      return () => {
        cancelled = true;
      };
    }

    const existing = document.querySelector<HTMLScriptElement>("script[data-google-identity]");
    if (existing) {
      existing.addEventListener("load", renderGoogleButton, { once: true });
      return () => {
        cancelled = true;
        existing.removeEventListener("load", renderGoogleButton);
      };
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.addEventListener("load", renderGoogleButton, { once: true });
    document.head.appendChild(script);

    return () => {
      cancelled = true;
      script.removeEventListener("load", renderGoogleButton);
    };
  }, [auth.status, completeGoogleSignIn, isAuthConfigured]);

  useEffect(() => {
    window.setTimeout(() => {
      void loadTraffic();
    }, 0);
  }, [loadTraffic]);

  useEffect(() => {
    const root = document.documentElement;
    const fitCameras = () => {
      window.requestAnimationFrame(() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const topbar = document.querySelector<HTMLElement>(".topbar");
        const topbarHeight = topbar?.getBoundingClientRect().height ?? 42;
        root.style.setProperty("--landing-visible-height", `${viewportHeight.toFixed(1)}px`);
        root.style.setProperty("--landing-topbar-height", `${topbarHeight.toFixed(1)}px`);
        root.style.setProperty("--landing-summary-height", `${Math.max(360, viewportHeight * 0.6).toFixed(1)}px`);
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
      const response = await authFetch(`${apiBase()}/api/reports`, {
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

  if (isAuthConfigured && auth.status !== "ready") {
    return (
      <main className="app-shell login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <a className="brand login-brand" href="#top" aria-label="CrossBorder.sg home">
            <span>CrossBorder<span>.sg</span></span>
          </a>
          <div>
            <h1 id="login-title">Sign in to continue</h1>
          </div>
          <div id="google-signin-button" className="google-signin-slot" />
          <p className="login-note">Codex V3 · 1.5</p>
          {auth.status === "loading" && <p className="login-note">Verifying Google sign-in…</p>}
          {auth.status === "error" && <p className="login-error">{auth.message}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell landing-shell" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <header className="topbar">
        <div className="updated-line">
          <span>{refreshing ? "Updating…" : `Last updated ${lastChecked}`}</span>
          <small>Codex V3 · 1.5</small>
        </div>
        <a className="brand compact" href="#top" aria-label="CrossBorder.sg home">
          <span>CrossBorder<span>.sg</span></span>
        </a>
        {auth.status === "ready" && (
          <button className="signout-button" type="button" onClick={signOut}>
            Sign out
          </button>
        )}
      </header>

      <V3WoodlandsApproach submitApproachReport={submitApproachReport} />

    </main>
  );
}
