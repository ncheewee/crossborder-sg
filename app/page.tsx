"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Direction = "sg-my" | "my-sg";
type Checkpoint = "Tuas" | "Woodlands";

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
    route: Checkpoint;
    totalRange: [number, number];
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
    depart: "Now–1:30 pm",
    saving: 24,
    total: "54–69",
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
    depart: "Now–2:00 pm",
    saving: 18,
    total: "48–63",
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

function CheckpointCard({
  name,
  recommended,
  crossing,
  drive,
  trend,
  trendTone,
  condition,
  image,
  cameraTime,
}: {
  name: string;
  recommended: boolean;
  crossing: string;
  drive: number;
  trend: string;
  trendTone: string;
  condition: string;
  image: string;
  cameraTime: string;
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

      <div className="camera-frame">
        <img src={image} alt={`Official traffic camera view at ${name} checkpoint`} />
        <div className="camera-shade" />
        <div className="camera-meta">
          <span><i aria-hidden="true" /> Official camera</span>
          <span>{cameraTime}</span>
        </div>
      </div>
    </article>
  );
}

function WaitTimeChart({
  recommended,
  series,
  accuracy,
}: {
  recommended: Checkpoint;
  series: Record<Checkpoint, ChartSeries>;
  accuracy?: Record<Checkpoint, LiveCheckpoint["accuracy"]>;
}) {
  const [checkpoint, setCheckpoint] = useState<Checkpoint>(recommended);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selected = series[checkpoint];

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
      const maxWait = 100;
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
      [0, 25, 50, 75, 100].forEach((value) => {
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
        if (width < 440 && index % 2 !== 0 && index !== 3) return;
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
          <p className="section-kicker">AI departure forecast</p>
          <h2 id="forecast-title">When should you leave?</h2>
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
            aria-label={`${checkpoint} wait-time chart showing actual waits until now, AI predictions through 3 pm, and shaded recommended departure windows.`}
          />
        </div>
        <div className="chart-insight">
          <span aria-hidden="true">✦</span>
          <p>
            {selected.insight}
            {accuracy?.[checkpoint]?.meanAbsoluteErrorMinutes !== null &&
              accuracy?.[checkpoint]?.meanAbsoluteErrorMinutes !== undefined
              ? ` Typical 30-minute error: ±${accuracy[checkpoint].meanAbsoluteErrorMinutes} min across ${accuracy[checkpoint].sampleSize} samples.`
              : ` ${accuracy?.[checkpoint]?.label ?? "Collecting baseline samples"}.`}
          </p>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [direction, setDirection] = useState<Direction>("sg-my");
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState("12:29 pm");
  const [liveTraffic, setLiveTraffic] = useState<LiveTraffic | null>(null);
  const [feedState, setFeedState] = useState<"loading" | "live" | "fallback">("loading");

  const loadTraffic = useCallback(async () => {
    setRefreshing(true);
    try {
      const apiBase = window.location.hostname.endsWith("github.io")
        ? "https://crossborder-sg-mvp.ncheewee.chatgpt.site"
        : "";
      const response = await fetch(`${apiBase}/api/traffic?direction=${direction}`, {
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
      saving: liveTraffic.recommendation.savingMinutes,
      total: `${liveTraffic.recommendation.totalRange[0]}–${liveTraffic.recommendation.totalRange[1]}`,
      leaveWindow: liveTraffic.recommendation.depart,
      reason: liveTraffic.recommendation.reason,
      tuas: checkpointData("Tuas"),
      woodlands: checkpointData("Woodlands"),
    };
  }, [direction, liveTraffic]);

  const liveSeries = useMemo<Record<Checkpoint, ChartSeries>>(() => {
    if (!liveTraffic) return chartSeries[direction];
    return Object.fromEntries((["Tuas", "Woodlands"] as Checkpoint[]).map((checkpoint) => {
      const savedHistory = liveTraffic.checkpoints[checkpoint].history.slice(-4);
      const future = liveTraffic.forecasts[checkpoint].slice(1, 6);
      const current = liveTraffic.checkpoints[checkpoint].waitMinutes;
      const history = savedHistory.length
        ? savedHistory
        : [{ timestamp: liveTraffic.generatedAt, observed: current }];
      const times = [
        ...history.map((point) => new Intl.DateTimeFormat("en-SG", {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(point.timestamp))),
        ...future.map((point) => point.time),
      ];
      const actual = [
        ...history.map((point) => point.observed),
        ...future.map(() => null),
      ];
      if (actual.length) actual[Math.max(0, history.length - 1)] = current;
      const prediction = [
        ...history.map(() => null),
        ...future.map((point) => point.predicted),
      ];
      if (prediction.length && history.length) prediction[history.length - 1] = current;
      const allPredictions = future.map((point) => point.predicted);
      const low = Math.min(current, ...allPredictions);
      const windows = Array.from({ length: Math.max(0, times.length - 1) }, (_, index) => {
        const predicted = index < history.length - 1
          ? history[index]?.observed ?? current
          : future[Math.max(0, index - history.length + 1)]?.predicted ?? current;
        return predicted <= low + 4 ? "good" as const : "amber" as const;
      });
      const best = future.reduce((lowest, point) => point.predicted < lowest.predicted ? point : lowest, future[0]);
      return [checkpoint, {
        times,
        actual,
        prediction,
        windows,
        insight: best
          ? `The lowest ${checkpoint} estimate in this window is ${best.predicted} minutes around ${best.time}.`
          : `The current ${checkpoint} estimate is ${current} minutes.`,
      }];
    })) as Record<Checkpoint, ChartSeries>;
  }, [direction, liveTraffic]);

  const recommendedCamera = data.route === "Tuas"
    ? { image: liveTraffic?.checkpoints.Tuas.imageUrl ?? "tuas.jpg", name: "Tuas Second Link" }
    : { image: liveTraffic?.checkpoints.Woodlands.imageUrl ?? "woodlands.jpg", name: "Woodlands Causeway" };

  const cameraTime = (checkpoint: Checkpoint) => liveTraffic
    ? new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit" })
        .format(new Date(liveTraffic.checkpoints[checkpoint].cameraUpdatedAt))
    : "12:27 pm";

  const cards = useMemo(
    () => [
      {
        name: "Tuas",
        ...data.tuas,
        image: liveTraffic?.checkpoints.Tuas.imageUrl ?? "tuas.jpg",
        cameraTime: cameraTime("Tuas"),
      },
      {
        name: "Woodlands",
        ...data.woodlands,
        image: liveTraffic?.checkpoints.Woodlands.imageUrl ?? "woodlands.jpg",
        cameraTime: cameraTime("Woodlands"),
      },
    ],
    [data, liveTraffic],
  );

  function refresh() {
    void loadTraffic();
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
            <div className="answer-metrics">
              <span><strong>{data.total} min</strong> total to cross</span>
              <span><strong>Save {data.saving} min</strong> vs the other checkpoint</span>
            </div>
          </div>
          <div className="hero-camera">
            <img src={recommendedCamera.image} alt={`Official camera at ${recommendedCamera.name}`} />
            <div className="camera-shade" />
            <div className="camera-meta">
              <span><i aria-hidden="true" /> {recommendedCamera.name}</span>
              <span>{cameraTime(data.route as Checkpoint)}</span>
            </div>
          </div>
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
          <button>See the signals <span aria-hidden="true">→</span></button>
        </div>
      </section>

      <section className="feedback-card">
        <div>
          <span className="feedback-kicker">Help improve estimates</span>
          <h2>Crossed recently?</h2>
          <p>Share your actual crossing time in two taps.</p>
        </div>
        <button>I’ve crossed</button>
      </section>

      <footer>
        <span>CrossBorder.sg preview</span>
        <span>Codex build · Live beta 0.4</span>
      </footer>
    </main>
  );
}
