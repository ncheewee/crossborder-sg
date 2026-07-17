import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const trafficObservations = sqliteTable(
  "traffic_observations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    observedAt: text("observed_at").notNull(),
    direction: text("direction").notNull(),
    checkpoint: text("checkpoint").notNull(),
    sourceUpdatedAt: text("source_updated_at").notNull(),
    cameraId: text("camera_id").notNull(),
    imageUrl: text("image_url").notNull(),
    estimatedWaitMinutes: integer("estimated_wait_minutes").notNull(),
    forecast30Minutes: integer("forecast_30_minutes"),
    method: text("method").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("traffic_lookup_idx").on(
      table.direction,
      table.checkpoint,
      table.observedAt,
    ),
  ],
);

export const travelerReports = sqliteTable(
  "traveler_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reportedAt: text("reported_at").notNull(),
    direction: text("direction").notNull(),
    checkpoint: text("checkpoint").notNull(),
    actualWaitMinutes: integer("actual_wait_minutes").notNull(),
    estimatedWaitMinutes: integer("estimated_wait_minutes"),
    sourceUpdatedAt: text("source_updated_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("traveler_reports_lookup_idx").on(
      table.direction,
      table.checkpoint,
      table.reportedAt,
    ),
  ],
);
