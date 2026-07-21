import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const apiKey = process.env.GOOGLE_ROUTES_API_KEY;
const routesUrl = "https://routes.googleapis.com/directions/v2:computeRoutes";
const destination = { latitude: 1.4599, longitude: 103.7649 };
const routes = [
  {
    id: "woodlands-bke-right",
    label: "A · BKE flyover",
    instruction: "Keep right on the flyover",
    origin: { latitude: 1.4377, longitude: 103.7750 },
    waypoint: { latitude: 1.4428, longitude: 103.7721 },
  },
  {
    id: "woodlands-bke-left",
    label: "B · BKE mainline",
    instruction: "Keep left through the traffic lights",
    origin: { latitude: 1.4377, longitude: 103.7750 },
    waypoint: { latitude: 1.4417, longitude: 103.7733 },
  },
  {
    id: "woodlands-road-left",
    label: "C · Woodlands Rd",
    instruction: "Turn left towards the checkpoint",
    origin: { latitude: 1.4260, longitude: 103.7595 },
    waypoint: { latitude: 1.4350, longitude: 103.7600 },
  },
];

function parseMinutes(value) {
  const seconds = typeof value === "string" ? Number(value.replace(/s$/, "")) : Number.NaN;
  return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
}

async function routeDuration(route) {
  const response = await fetch(routesUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
    },
    body: JSON.stringify({
      origin: { location: { latLng: route.origin } },
      destination: { location: { latLng: destination } },
      intermediates: [{ location: { latLng: route.waypoint } }],
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
    }),
  });
  if (!response.ok) throw new Error(`${route.id}: Google Routes returned ${response.status}`);
  const result = (await response.json()).routes?.[0];
  return {
    ...route,
    durationMinutes: parseMinutes(result?.duration),
    staticMinutes: parseMinutes(result?.staticDuration),
    distanceMeters: Number.isFinite(result?.distanceMeters) ? result.distanceMeters : null,
  };
}

if (!apiKey) throw new Error("GOOGLE_ROUTES_API_KEY is required");

const generatedAt = new Date().toISOString();
const results = await Promise.all(routes.map(routeDuration));
if (results.some((route) => route.durationMinutes == null)) throw new Error("Google Routes response did not include all durations");

const snapshot = {
  generatedAt,
  source: "Google Routes API traffic-aware duration",
  scope: "Woodlands towards JB · queue join to post-Johor clearance",
  routes: results,
};
const output = `${JSON.stringify(snapshot, null, 2)}\n`;
await mkdir("docs", { recursive: true });
await Promise.all([
  writeFile(join("public", "approaches.json"), output),
  writeFile(join("docs", "approaches.json"), output),
]);

console.log(`Updated ${results.length} Woodlands approach durations at ${generatedAt}`);
