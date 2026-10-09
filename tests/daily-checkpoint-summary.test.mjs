import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDailyMessage,
  previousSingaporeDate,
  summarizeDay,
} from "../scripts/daily-checkpoint-summary.mjs";

function slot(hhmm, oursMid, checkpointMid, checkpointAgeMs = 0) {
  return { capturedAt: new Date(`2026-10-08T${hhmm}:00+08:00`).toISOString(), oursMid, checkpointMid, checkpointAgeMs };
}

test("yesterday is the Singapore calendar day before", () => {
  assert.equal(previousSingaporeDate(new Date("2026-10-08T22:30:00Z")), "2026-10-08");
  assert.equal(previousSingaporeDate(new Date("2026-10-09T15:59:00Z")), "2026-10-08");
});

test("the day summary compares only slots with fresh readings from both", () => {
  const summary = summarizeDay([
    slot("07:00", 30, 25),
    slot("07:15", 40, 50),
    slot("07:30", 20, 20),
    slot("07:45", 90, 20, 2 * 3_600_000), // stale Checkpoint reading: not compared
    slot("08:00", 35, null),
  ]);
  assert.equal(summary.slots, 3);
  assert.equal(summary.bias, -2);
  assert.equal(summary.meanAbsGap, 5);
  assert.equal(summary.matchShare, 67);
  assert.deepEqual(summary.worst, { gap: -10, at: "07:15" });
  assert.deepEqual(summary.oursPeak, { minutes: 90, at: "07:45" });
  assert.deepEqual(summary.checkpointPeak, { minutes: 50, at: "07:15" });
});

test("a day with no Checkpoint readings still reports", () => {
  const summary = summarizeDay([slot("09:00", 30, null)]);
  assert.equal(summary.slots, 0);
  const text = buildDailyMessage({
    reportDate: "2026-10-08",
    checkpointSource: "unavailable",
    sentAt: new Date("2026-10-08T22:31:00Z"),
    directions: [{ name: "SG→JB", summary, now: { oursMid: 22, checkpointMid: null } }],
  });
  assert.match(text, /No overlapping Checkpoint\.sg readings/);
  assert.match(text, /Now CB 22m · CP —/);
  assert.match(text, /no fresh reading · sent 06:31 SGT/);
});

test("the daily message reads cleanly", () => {
  const text = buildDailyMessage({
    reportDate: "2026-10-08",
    checkpointSource: "mi6-macrodroid",
    sentAt: new Date("2026-10-08T22:34:00Z"),
    directions: [
      { name: "SG→JB", summary: summarizeDay([slot("18:00", 45, 40), slot("18:15", 50, 38)]), now: { oursMid: 18, checkpointMid: 20 } },
      { name: "JB→SG", summary: summarizeDay([slot("07:00", 60, 75)]), now: { oursMid: 40, checkpointMid: 55 } },
    ],
  });
  assert.equal(text, [
    "Daily · Crossborder vs Checkpoint.sg · Thu 8 Oct",
    "",
    "SG→JB",
    "  Avg 9m over CP · typical gap 9m · within ±8m 50% of 2 slots",
    "  Widest +12m at 18:15",
    "  Peak CB 50m at 18:15 · CP 40m at 18:00",
    "  Now CB 18m · CP 20m · match",
    "",
    "JB→SG",
    "  Avg 15m under CP · typical gap 15m · within ±8m 0% of 1 slots",
    "  Widest -15m at 07:00",
    "  Peak CB 60m at 07:00 · CP 75m at 07:00",
    "  Now CB 40m · CP 55m · -15m vs CP",
    "",
    "CP now: Mi6 · sent 06:34 SGT",
  ].join("\n"));
});

test("an even day reads as level", () => {
  const text = buildDailyMessage({
    reportDate: "2026-10-08",
    checkpointSource: "mi6-macrodroid",
    directions: [{ name: "SG→JB", summary: summarizeDay([slot("08:00", 30, 34), slot("08:15", 34, 30)]), now: {} }],
  });
  assert.match(text, /Avg level with CP · typical gap 4m/);
});
