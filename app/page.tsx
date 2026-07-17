"use client";

import { useMemo, useState } from "react";

type Direction = "sg-my" | "my-sg";

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
        <span>Codex build · MVP 0.1</span>
      </footer>
    </main>
  );
}
