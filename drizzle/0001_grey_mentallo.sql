CREATE TABLE `traveler_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reported_at` text NOT NULL,
	`direction` text NOT NULL,
	`checkpoint` text NOT NULL,
	`actual_wait_minutes` integer NOT NULL,
	`estimated_wait_minutes` integer,
	`source_updated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `traveler_reports_lookup_idx` ON `traveler_reports` (`direction`,`checkpoint`,`reported_at`);