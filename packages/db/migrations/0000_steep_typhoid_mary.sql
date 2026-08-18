CREATE TABLE `collected_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`row_key` text NOT NULL,
	`data_json` text NOT NULL,
	`collected_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collected_rows_run_key_idx` ON `collected_rows` (`run_id`,`row_key`);--> statement-breakpoint
CREATE INDEX `collected_rows_source_key_idx` ON `collected_rows` (`source_id`,`row_key`);--> statement-breakpoint
CREATE TABLE `field_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`field` text NOT NULL,
	`present_count` integer NOT NULL,
	`missing_count` integer NOT NULL,
	`fill_rate` real NOT NULL,
	`distinct_count` integer NOT NULL,
	`invalid_count` integer NOT NULL,
	`median` real,
	`minimum` real,
	`maximum` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_stats_run_field_idx` ON `field_stats` (`run_id`,`field`);--> statement-breakpoint
CREATE INDEX `field_stats_source_field_idx` ON `field_stats` (`source_id`,`field`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`source_id` text NOT NULL,
	`code` text NOT NULL,
	`field` text,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`observed` text,
	`expected` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `findings_run_idx` ON `findings` (`run_id`);--> statement-breakpoint
CREATE TABLE `incident_events` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`detail_json` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `incident_events_incident_idx` ON `incident_events` (`incident_id`,`at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`collector_id` text,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`summary` text NOT NULL,
	`detected_run_id` text,
	`resolved_run_id` text,
	`heal_attempts` integer DEFAULT 0 NOT NULL,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`mttr_ms` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`detected_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `incidents_source_idx` ON `incidents` (`source_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `incidents_status_idx` ON `incidents` (`status`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`collection_id` text,
	`mode` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`row_count` integer NOT NULL,
	`severity` text NOT NULL,
	`raw_payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `runs_source_started_idx` ON `runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_severity_idx` ON `runs` (`severity`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`collector_id` text,
	`target_url` text NOT NULL,
	`contract_hash` text NOT NULL,
	`field_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
