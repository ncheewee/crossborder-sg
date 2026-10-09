// Pure helpers for the once-a-day Telegram report: Crossborder vs
// Checkpoint.sg over the previous Singapore day, plus where both stand now.

export const MATCH_MINUTES = 8;
// Checkpoint.sg readings older than this are not compared against a slot.
export const CHECKPOINT_STALE_MS = 45 * 60 * 1000;

export function singaporeDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function previousSingaporeDate(now = new Date()) {
  return singaporeDate(new Date(now.getTime() - 24 * 3_600_000));
}

function singaporeTime(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

function prettyDate(day) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short",
  }).format(new Date(`${day}T12:00:00+08:00`));
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${value}m`;
}

// points: 15-minute slots from buildQuarterDayPoints. Only slots where both
// sources have a reading, and the Checkpoint.sg one is fresh, are compared.
export function summarizeDay(points) {
  const compared = points.filter((point) => (
    Number.isFinite(point.oursMid)
    && Number.isFinite(point.checkpointMid)
    && (point.checkpointAgeMs ?? 0) <= CHECKPOINT_STALE_MS
  ));
  const peak = (key) => points.reduce((best, point) => (
    Number.isFinite(point[key]) && (!best || point[key] > best[key]) ? point : best
  ), null);
  const oursPeak = peak("oursMid");
  const checkpointPeak = peak("checkpointMid");
  const base = {
    slots: compared.length,
    oursPeak: oursPeak ? { minutes: oursPeak.oursMid, at: singaporeTime(oursPeak.capturedAt) } : null,
    checkpointPeak: checkpointPeak
      ? { minutes: checkpointPeak.checkpointMid, at: singaporeTime(checkpointPeak.capturedAt) }
      : null,
  };
  if (!compared.length) return { ...base, bias: null, meanAbsGap: null, matchShare: null, worst: null };
  const gaps = compared.map((point) => point.oursMid - point.checkpointMid);
  const worstIndex = gaps.reduce((best, gap, index) => (Math.abs(gap) > Math.abs(gaps[best]) ? index : best), 0);
  return {
    ...base,
    bias: Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length),
    meanAbsGap: Math.round(gaps.reduce((sum, gap) => sum + Math.abs(gap), 0) / gaps.length),
    matchShare: Math.round((gaps.filter((gap) => Math.abs(gap) <= MATCH_MINUTES).length / gaps.length) * 100),
    worst: { gap: gaps[worstIndex], at: singaporeTime(compared[worstIndex].capturedAt) },
  };
}

function nowLine(now) {
  const ours = Number.isFinite(now?.oursMid) ? `CB ${now.oursMid}m` : "CB —";
  if (!Number.isFinite(now?.checkpointMid)) return `${ours} · CP —`;
  const gap = now.oursMid - now.checkpointMid;
  const verdict = Math.abs(gap) <= MATCH_MINUTES ? "match" : `${signed(gap)} vs CP`;
  return `${ours} · CP ${now.checkpointMid}m · ${verdict}`;
}

// directions: [{ name: "SG→JB", summary, now: { oursMid, checkpointMid } }]
export function buildDailyMessage({ reportDate, directions, checkpointSource, sentAt = new Date() }) {
  const lines = [`Daily · Crossborder vs Checkpoint.sg · ${prettyDate(reportDate)}`];
  for (const { name, summary, now } of directions) {
    lines.push("", name);
    if (summary.slots) {
      const average = summary.bias === 0 ? "Avg level with CP"
        : `Avg ${Math.abs(summary.bias)}m ${summary.bias > 0 ? "over" : "under"} CP`;
      lines.push(
        `  ${average} · typical gap ${summary.meanAbsGap}m · within ±${MATCH_MINUTES}m ${summary.matchShare}% of ${summary.slots} slots`,
        `  Widest ${signed(summary.worst.gap)} at ${summary.worst.at}`,
      );
    } else {
      lines.push("  No overlapping Checkpoint.sg readings yesterday.");
    }
    const peaks = [
      summary.oursPeak ? `CB ${summary.oursPeak.minutes}m at ${summary.oursPeak.at}` : null,
      summary.checkpointPeak ? `CP ${summary.checkpointPeak.minutes}m at ${summary.checkpointPeak.at}` : null,
    ].filter(Boolean);
    if (peaks.length) lines.push(`  Peak ${peaks.join(" · ")}`);
    lines.push(`  Now ${nowLine(now)}`);
  }
  const sourceNote = checkpointSource === "mi6-macrodroid" ? "Mi6"
    : checkpointSource === "android-emulator" ? "emulator stand-in"
      : checkpointSource === "unavailable" ? "no fresh reading" : checkpointSource;
  lines.push("", `CP now: ${sourceNote} · sent ${singaporeTime(sentAt.toISOString())} SGT`);
  return lines.join("\n");
}
