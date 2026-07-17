"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Direction = "sg-my" | "my-sg";
type Checkpoint = "Tuas" | "Woodlands";

const chartSeries = {
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

function WaitTimeChart({ direction, recommended }: { direction: Direction; recommended: Checkpoint }) {
  const [checkpoint, setCheckpoint] = useState<Checkpoint>(recommended);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selected = chartSeries[direction][checkpoint];

  useEffect(() => {
    setCheckpoint(recommended);
  }, [direction, recommended]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;

    const draw = () => {
      const width = Math.max(280, container.clientWidth);
      const height = width < 520 ? 240 : 270;
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

      const padding = { top: 22, right: 16, bottom: 38, left: 37 };
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

      const nowX = x(3);
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
          <p>{selected.insight}</p>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [direction, setDirection] = useState<Direction>("sg-my");
  const [refreshing, setRefreshing] = useState(false);
  const [lastChecked, setLastChecked] = useState("12:29 pm");
  const [locationEnabled, setLocationEnabled] = useState(false);
  const data = tripData[direction];

  const cards = useMemo(
    () => [
      {
        name: "Tuas",
        ...data.tuas,
        image: "/tuas.jpg",
        cameraTime: "12:27 pm",
      },
      {
        name: "Woodlands",
        ...data.woodlands,
        image: "/woodlands.jpg",
        cameraTime: "12:27 pm",
      },
    ],
    [data],
  );

  function refresh() {
    setRefreshing(true);
    window.setTimeout(() => {
      setRefreshing(false);
      setLastChecked(
        new Intl.DateTimeFormat("en-SG", {
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date()),
      );
    }, 700);
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
        <button
          className={`location-chip ${locationEnabled ? "enabled" : ""}`}
          onClick={() => setLocationEnabled((value) => !value)}
        >
          <span aria-hidden="true">⌖</span>
          {locationEnabled ? "From your location" : "Use my location"}
        </button>
      </section>

      <section className="recommendation-panel" aria-labelledby="recommendation-title">
        <div className="signal-line">
          <span><i aria-hidden="true" /> Live recommendation</span>
          <span>4 signals aligned</span>
        </div>
        <p className="recommendation-kicker">Leave now via</p>
        <h1 id="recommendation-title">{data.route}</h1>
        <p className="recommendation-copy">
          Save about <strong>{data.saving} minutes</strong> compared with the other checkpoint.
        </p>

        <div className="arrival-estimate">
          <div>
            <span>Total time to cross</span>
            <strong>{data.total} <small>min</small></strong>
          </div>
          <div className="leave-window">
            <span aria-hidden="true">◷</span>
            {data.leaveWindow}
          </div>
        </div>

        <div className="reason-row">
          <span className="spark" aria-hidden="true">✦</span>
          <p>{data.reason}</p>
        </div>
      </section>

      <div className="freshness-bar">
        <span className="freshness-icon" aria-hidden="true">●</span>
        <div>
          <strong>Official traffic data checked {lastChecked}</strong>
          <span>Latest camera images available from 12:27 pm</span>
        </div>
      </div>

      <WaitTimeChart direction={direction} recommended={data.route as Checkpoint} />

      <section className="checkpoint-section" aria-labelledby="compare-title">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Your two options</p>
            <h2 id="compare-title">Compare checkpoints</h2>
          </div>
          <span className="updated-badge">Updated just now</span>
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
            Live checkpoint cameras, approach-road traffic, current queue movement and typical conditions for this time.
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
        <span>Codex build · MVP 0.2</span>
      </footer>
    </main>
  );
}
