CREATE TABLE `traffic_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observed_at` text NOT NULL,
	`direction` text NOT NULL,
	`checkpoint` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`camera_id` text NOT NULL,
	`image_url` text NOT NULL,
	`estimated_wait_minutes` integer NOT NULL,
	`forecast_30_minutes` integer,
	`method` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `traffic_lookup_idx` ON `traffic_observations` (`direction`,`checkpoint`,`observed_at`);