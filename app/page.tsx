"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Direction = "sg-my" | "my-sg";
type Checkpoint = "Tuas" | "Woodlands";
type ForecastWindow = "current" | "next";

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
  windows: Array<"good" | "amber">;
  insight: string;
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
  }>>;
};

type FeedbackStatus = "idle" | "saving" | "saved" | "error";

const chartSeries: Record<Direction, Record<Checkpoint, ChartSeries>> = {
  "sg-my": {
    Tuas: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [64, 56, 49, 41, null, null, null, null, null],
      prediction: [67, 58, 47, 39, 34, 41, 56, 73, 86],
      windows: ["amber", "amber", "good", "good", "good", "amber", "amber", "amber"],
      insight: "Depart between 12:00–1:30 pm for the shortest predicted wait.",
    },
    Woodlands: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [49, 57, 66, 74, null, null, null, null, null],
      prediction: [51, 59, 68, 76, 82, 85, 77, 66, 55],
      windows: ["amber", "amber", "amber", "amber", "amber", "amber", "amber", "amber"],
      insight: "Woodlands remains elevated; Tuas is the better departure choice now.",
    },
  },
  "my-sg": {
    Tuas: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [43, 48, 54, 58, null, null, null, null, null],
      prediction: [45, 49, 55, 59, 64, 68, 61, 53, 47],
      windows: ["amber", "amber", "amber", "amber", "amber", "amber", "amber", "amber"],
      insight: "Tuas is expected to stay moderate through the afternoon.",
    },
    Woodlands: {
      times: ["11:00", "11:30", "12:00", "12:30", "1:00", "1:30", "2:00", "2:30", "3:00"],
      actual: [48, 43, 39, 36, null, null, null, null, null],
      prediction: [50, 45, 40, 36, 33, 38, 49, 61, 70],
      windows: ["amber", "good", "good", "good", "good", "good", "amber", "amber"],
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

function camerasForCheckpoint(live: LiveTraffic | null, checkpoint: Checkpoint, fallbackImage: string): LiveCamera[] {
  const current = live?.checkpoints[checkpoint];
  return current?.cameras?.length
    ? current.cameras
    : [{
        cameraId: checkpoint,
        imageUrl: current?.imageUrl ?? fallbackImage,
        updatedAt: current?.cameraUpdatedAt ?? new Date().toISOString(),
        label: `${checkpoint} checkpoint`,
      }];
}

function CameraCarousel({
  cameras,
  title,
  compact = false,
  auto = false,
}: {
  cameras: LiveCamera[];
  title: string;
  compact?: boolean;
  auto?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [interacted, setInteracted] = useState(false);
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

  if (!current) return null;

  return (
    <div
      className={`camera-carousel ${compact ? "compact" : ""}`}
      onPointerDown={() => setInteracted(true)}
    >
      <div className="camera-frame">
        <img src={current.imageUrl} alt={`${title}: ${current.label ?? current.cameraId}`} />
        <div className="camera-shade" />
        <div className="camera-meta">
          <span><i aria-hidden="true" /> {current.label ?? title}</span>
          <span>{formatTimeLabel(current.updatedAt)}</span>
        </div>
      </div>
      {safeCameras.length > 1 && (
        <div className="camera-controls" aria-label={`${title} camera controls`}>
          <button onClick={() => move(-1)} aria-label="Previous camera">‹</button>
          <span>{index + 1}/{safeCameras.length}</span>
          <button onClick={() => move(1)} aria-label="Next camera">›</button>
        </div>
      )}
    </div>
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
}: {
  name: Checkpoint;
  recommended: boolean;
  crossing: string;
  drive: number;
  trend: string;
  trendTone: string;
  condition: string;
  cameras: LiveCamera[];
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

      <CameraCarousel cameras={cameras} title={`${name} official cameras`} compact />
    </article>
  );
}

function WaitTimeChart({
  recommended,
  series,
  accuracy,
  travelerReports,
}: {
  recommended: Checkpoint;
  series: Record<Checkpoint, Record<ForecastWindow, ChartSeries>>;
  accuracy?: Record<Checkpoint, LiveCheckpoint["accuracy"]>;
  travelerReports?: Record<Checkpoint, LiveCheckpoint["travelerReports"]>;
}) {
  const [checkpoint, setCheckpoint] = useState<Checkpoint>(recommended);
  const [forecastWindow, setForecastWindow] = useState<ForecastWindow>("current");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selected = series[checkpoint][forecastWindow];

  useEffect(() => {
    setCheckpoint(recommended);
  }, [recommended]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const draw = () => {
      const width = Math.max(280, container.clientWidth);
      const height = width < 520 ? 178 : 230;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);

      const styles = getComputedStyle(document.documentElement);
      const actualColor = styles.getPropertyValue("--chart-actual").trim();
      const predictionColor = styles.getPropertyValue("--teal").trim();
      const gridColor = styles.getPropertyValue("--chart-grid").trim();
      const labelColor = styles.getPropertyValue("--muted").trim();
      const goodFill = styles.getPropertyValue("--good-zone").trim();
      const amberFill = styles.getPropertyValue("--amber-zone").trim();
      const nowColor = styles.getPropertyValue("--teal-bright").trim();

      const padding = { top: 20, right: 12, bottom: 32, left: 34 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const maxWait = Math.max(100, Math.ceil(Math.max(...selected.prediction.filter((value): value is number => value !== null), 80) / 25) * 25);
      const x = (index: number) => padding.left + (index / (selected.times.length - 1)) * plotWidth;
      const y = (value: number) => padding.top + plotHeight - (value / maxWait) * plotHeight;

      context.clearRect(0, 0, width, height);

      selected.windows.forEach((windowType, index) => {
        const left = x(index);
        const right = x(index + 1);
        context.fillStyle = windowType === "good" ? goodFill : amberFill;
        context.fillRect(left, padding.top, right - left, plotHeight);
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
      selected.times.forEach((label, index) => {
        const labelStep = width < 440 ? 8 : 4;
        if (index % labelStep !== 0 && index !== selected.times.length - 1) return;
        context.fillText(label, x(index), padding.top + plotHeight + 12);
      });

      const drawLine = (values: Array<number | null>, color: string, dashed: boolean) => {
        context.beginPath();
        context.lineWidth = dashed ? 2 : 2.5;
        context.strokeStyle = color;
        context.setLineDash(dashed ? [6, 5] : []);
        let started = false;
        values.forEach((value, index) => {
          if (value === null) return;
          if (!started) {
            context.moveTo(x(index), y(value));
            started = true;
          } else {
            context.lineTo(x(index), y(value));
          }
        });
        context.stroke();
        context.setLineDash([]);

        values.forEach((value, index) => {
          if (value === null) return;
          context.beginPath();
          context.fillStyle = color;
          context.arc(x(index), y(value), dashed ? 2.5 : 3, 0, Math.PI * 2);
          context.fill();
        });
      };

      drawLine(selected.prediction, predictionColor, true);
      drawLine(selected.actual, actualColor, false);

      const currentIndex = Math.max(0, selected.actual.reduce(
        (last, value, index) => value === null ? last : index,
        0,
      ));
      const nowX = x(currentIndex);
      context.beginPath();
      context.strokeStyle = nowColor;
      context.lineWidth = 1;
      context.setLineDash([3, 4]);
      context.moveTo(nowX, padding.top - 4);
      context.lineTo(nowX, padding.top + plotHeight);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = nowColor;
      context.font = "10px Arial, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "bottom";
      context.fillText("NOW", nowX, padding.top - 7);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [selected]);

  return (
    <section className="forecast-section" aria-labelledby="forecast-title">
      <div className="section-heading forecast-heading">
        <div>
          <p className="section-kicker">24-hour AI departure forecast</p>
          <h2 id="forecast-title">When should you leave?</h2>
        </div>
        <div className="forecast-controls">
          <div className="chart-tabs" aria-label="Choose forecast window">
            <button
              className={forecastWindow === "current" ? "active" : ""}
              onClick={() => setForecastWindow("current")}
              aria-pressed={forecastWindow === "current"}
            >
              This 24h
            </button>
            <button
              className={forecastWindow === "next" ? "active" : ""}
              onClick={() => setForecastWindow("next")}
              aria-pressed={forecastWindow === "next"}
            >
              Next 24h
            </button>
          </div>
          <div className="chart-tabs" aria-label="Choose checkpoint">
            {(["Tuas", "Woodlands"] as Checkpoint[]).map((name) => (
              <button
                key={name}
                className={checkpoint === name ? "active" : ""}
                onClick={() => setCheckpoint(name)}
                aria-pressed={checkpoint === name}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="forecast-card">
        <div className="chart-legend" aria-label="Chart legend">
          <span><i className="legend-line legend-actual" aria-hidden="true" /> Actual wait</span>
          <span><i className="legend-line legend-ai" aria-hidden="true" /> AI prediction</span>
          <span><i className="legend-zone legend-good" aria-hidden="true" /> Good to depart</span>
          <span><i className="legend-zone legend-amber" aria-hidden="true" /> Less ideal</span>
        </div>
        <div className="chart-wrap">
          <span className="chart-unit">Wait time · minutes</span>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`${checkpoint} 24-hour wait-time chart showing actual waits until now, AI predictions, and shaded recommended departure windows.`}
          />
        </div>
        <div className="chart-insight">
          <span aria-hidden="true">✦</span>
          <p>
            {selected.insight}
            {travelerReports?.[checkpoint]?.count24h
              ? ` ${travelerReports[checkpoint].count24h} traveler reports in the last 24h; average reported crossing ${travelerReports[checkpoint].averageActualWaitMinutes} min.`
              : accuracy?.[checkpoint]?.meanAbsoluteErrorMinutes !== null &&
              accuracy?.[checkpoint]?.meanAbsoluteErrorMinutes !== undefined
              ? ` Typical 30-minute error: ±${accuracy[checkpoint].meanAbsoluteErrorMinutes} min across ${accuracy[checkpoint].sampleSize} samples.`
              : ` ${accuracy?.[checkpoint]?.label ?? "Collecting baseline samples"}.`}
          </p>
        </div>
      </div>
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

export default function Home() {
  const [direction, setDirection] = useState<Direction>("sg-my");
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState("12:29 pm");
  const [liveTraffic, setLiveTraffic] = useState<LiveTraffic | null>(null);
  const [feedState, setFeedState] = useState<"loading" | "live" | "fallback">("loading");
  const [feedbackCheckpoint, setFeedbackCheckpoint] = useState<Checkpoint>("Tuas");
  const [actualWaitMinutes, setActualWaitMinutes] = useState(45);
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackStatus>("idle");
  const [showSignals, setShowSignals] = useState(false);

  const loadTraffic = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${apiBase()}/api/traffic?direction=${direction}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Traffic API returned ${response.status}`);
      const payload = await response.json() as LiveTraffic;
      setLiveTraffic(payload);
      setFeedState("live");
      setLastChecked(new Intl.DateTimeFormat("en-SG", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(payload.generatedAt)));
    } catch {
      setLiveTraffic(null);
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
      const times = future.map((point, index) => {
        if (index === 0 && forecastWindow === "current") return "Now";
        return point.time;
      });
      const actual = future.map((_, index) => index === 0 && forecastWindow === "current"
        ? savedHistory[0]?.observed ?? current
        : null);
      const prediction = future.map((point, index) => index === 0 && forecastWindow === "current"
        ? current
        : point.predicted);
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
        windows,
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
    data.route as Checkpoint,
    data.route === "Tuas" ? "tuas.jpg" : "woodlands.jpg",
  );

  const recommendedCameraName = data.route === "Tuas"
    ? "Tuas Second Link"
    : "Woodlands Causeway";

  const cards = useMemo(
    () => [
      {
        name: "Tuas" as Checkpoint,
        ...data.tuas,
        cameras: camerasForCheckpoint(liveTraffic, "Tuas", "tuas.jpg"),
      },
      {
        name: "Woodlands" as Checkpoint,
        ...data.woodlands,
        cameras: camerasForCheckpoint(liveTraffic, "Woodlands", "woodlands.jpg"),
      },
    ],
    [data, liveTraffic],
  );

  useEffect(() => {
    setFeedbackCheckpoint(data.route as Checkpoint);
    setFeedbackStatus("idle");
  }, [data.route, direction]);

  function refresh() {
    void loadTraffic();
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
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="CrossBorder.sg home">
          <span className="brand-mark">CB</span>
          <span>CrossBorder<span>.sg</span></span>
        </a>
        <button className="refresh-button" onClick={refresh} disabled={refreshing}>
          <span className={refreshing ? "spin" : ""} aria-hidden="true">↻</span>
          {refreshing ? "Checking" : "Refresh"}
        </button>
      </header>

      <section className="controls" id="top">
        <div className="direction-tabs" aria-label="Travel direction">
          <button
            className={direction === "sg-my" ? "active" : ""}
            onClick={() => setDirection("sg-my")}
          >
            Singapore <span>→</span> Johor
          </button>
          <button
            className={direction === "my-sg" ? "active" : ""}
            onClick={() => setDirection("my-sg")}
          >
            Johor <span>→</span> Singapore
          </button>
        </div>
      </section>

      <section className="recommendation-panel" aria-labelledby="recommendation-title">
        <div className="signal-line">
          <span><i aria-hidden="true" /> {feedState === "live" ? "Live recommendation" : "Baseline recommendation"}</span>
          <span>{feedState === "live" ? "Official data checked" : "Last check attempted"} {lastChecked}</span>
        </div>
        <div className="recommendation-layout">
          <div className="recommendation-answer">
            <p className="recommendation-kicker">Best time to depart</p>
            <h1 id="recommendation-title">{data.depart}</h1>
            <p className="recommendation-route">via <strong>{data.route}</strong></p>
            <p className="clearance-line">
              Expected to clear {data.clearDestination ?? "the border"} around <strong>{data.clearTime ?? "—"}</strong>
            </p>
            <div className="answer-metrics">
              <span><strong>{data.border} min</strong> border crossing only</span>
              <span><strong>{data.drive} min</strong> fixed approach estimate</span>
              <span><strong>{data.total} min</strong> combined approach + border</span>
              <span><strong>Save {data.saving} min</strong> vs the other checkpoint</span>
            </div>
          </div>
          <CameraCarousel
            cameras={recommendedCameras}
            title={`${recommendedCameraName} official cameras`}
            auto
          />
        </div>

        <div className="reason-row">
          <span className="spark" aria-hidden="true">✦</span>
          <p>{data.reason}</p>
        </div>
      </section>

      <WaitTimeChart
        recommended={data.route as Checkpoint}
        series={liveSeries}
        accuracy={liveTraffic ? {
          Tuas: liveTraffic.checkpoints.Tuas.accuracy,
          Woodlands: liveTraffic.checkpoints.Woodlands.accuracy,
        } : undefined}
        travelerReports={liveTraffic ? {
          Tuas: liveTraffic.checkpoints.Tuas.travelerReports,
          Woodlands: liveTraffic.checkpoints.Woodlands.travelerReports,
        } : undefined}
      />

      <section className="checkpoint-section" aria-labelledby="compare-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Your two options</p>
            <h2 id="compare-title">Compare checkpoints</h2>
          </div>
          <span className="updated-badge">
            {feedState === "loading" ? "Checking official feed" : feedState === "live" ? "Official feed live" : "Baseline active"}
          </span>
        </div>

        <div className="checkpoint-grid">
          {cards
            .sort((a, b) => Number(b.name === data.route) - Number(a.name === data.route))
            .map((card) => (
              <CheckpointCard
                key={`${direction}-${card.name}`}
                {...card}
                recommended={card.name === data.route}
              />
            ))}
        </div>
      </section>

      <section className="method-card">
        <div className="method-icon" aria-hidden="true">✦</div>
        <div>
          <h2>How we reached this recommendation</h2>
          <p>
            {liveTraffic?.model.description ?? "A time-of-week baseline remains active while the official feed reconnects."}
          </p>
          <button
            onClick={() => setShowSignals((value) => !value)}
            aria-expanded={showSignals}
          >
            {showSignals ? "Hide signals" : "See the signals"} <span aria-hidden="true">→</span>
          </button>
          {showSignals && (
            <div className="signals-panel">
              <div>
                <span>Official source</span>
                <strong>{liveTraffic?.source.status ?? "fallback"}</strong>
              </div>
              <div>
                <span>Camera updated</span>
                <strong>{liveTraffic ? formatTimeLabel(liveTraffic.source.officialUpdatedAt) : "—"}</strong>
              </div>
              <div>
                <span>Recommendation route</span>
                <strong>{data.route}</strong>
              </div>
              <div>
                <span>Approach basis</span>
                <strong>Fixed estimate, not your GPS</strong>
              </div>
              <div>
                <span>Model status</span>
                <strong>{liveTraffic?.model.status ?? "baseline"}</strong>
              </div>
              <div>
                <span>Driver reports</span>
                <strong>
                  {liveTraffic
                    ? liveTraffic.checkpoints[data.route as Checkpoint].travelerReports.count24h
                    : 0} in 24h
                </strong>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="feedback-card">
        <div>
          <span className="feedback-kicker">Help improve estimates</span>
          <h2>Crossed recently?</h2>
          <p>
            {feedbackStatus === "saved"
              ? "Report saved. Future estimates get sharper as these build up."
              : feedbackStatus === "error"
                ? "Couldn’t save that report. Try again after the next refresh."
                : "Share your actual crossing time in two taps."}
          </p>
        </div>
        <div className="feedback-controls">
          <div className="mini-tabs" aria-label="Checkpoint crossed">
            {(["Tuas", "Woodlands"] as Checkpoint[]).map((checkpoint) => (
              <button
                key={checkpoint}
                className={feedbackCheckpoint === checkpoint ? "active" : ""}
                onClick={() => {
                  setFeedbackCheckpoint(checkpoint);
                  setFeedbackStatus("idle");
                }}
                aria-pressed={feedbackCheckpoint === checkpoint}
              >
                {checkpoint}
              </button>
            ))}
          </div>
          <div className="wait-chips" aria-label="Actual crossing time">
            {[20, 35, 50, 75, 100].map((minutes) => (
              <button
                key={minutes}
                className={actualWaitMinutes === minutes ? "active" : ""}
                onClick={() => {
                  setActualWaitMinutes(minutes);
                  setFeedbackStatus("idle");
                }}
                aria-pressed={actualWaitMinutes === minutes}
              >
                {minutes}m
              </button>
            ))}
          </div>
          <button
            className="submit-feedback"
            onClick={submitFeedback}
            disabled={feedbackStatus === "saving"}
          >
            {feedbackStatus === "saving" ? "Saving" : "I’ve crossed"}
          </button>
        </div>
      </section>

      <footer>
        <span>CrossBorder.sg preview</span>
        <span>Codex build · Live beta 0.5</span>
      </footer>
    </main>
  );
}
