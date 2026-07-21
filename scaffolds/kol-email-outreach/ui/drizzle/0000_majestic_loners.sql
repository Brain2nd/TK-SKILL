CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`project_id` text DEFAULT '' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`event_type` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_owner_created_idx` ON `audit_events` (`owner_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_project_created_idx` ON `audit_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `creators` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text DEFAULT 'tiktok' NOT NULL,
	`handle` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`profile_url` text DEFAULT '' NOT NULL,
	`contact_email` text NOT NULL,
	`country` text DEFAULT '' NOT NULL,
	`city` text DEFAULT '' NOT NULL,
	`followers` integer DEFAULT 0 NOT NULL,
	`avg_views` integer DEFAULT 0 NOT NULL,
	`engagement_rate` real DEFAULT 0 NOT NULL,
	`traits_json` text DEFAULT '[]' NOT NULL,
	`review_warnings_json` text DEFAULT '[]' NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`default_hook` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creators_platform_handle_uq` ON `creators` (`platform`,`handle`);--> statement-breakpoint
CREATE INDEX `creators_country_idx` ON `creators` (`country`);--> statement-breakpoint
CREATE TABLE `project_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`sender_override_id` text DEFAULT '' NOT NULL,
	`personalized_hook` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'selected' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_recipients_project_creator_uq` ON `project_recipients` (`project_id`,`creator_id`);--> statement-breakpoint
CREATE INDEX `project_recipients_project_idx` ON `project_recipients` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`name` text NOT NULL,
	`campaign_id` text NOT NULL,
	`brand_name` text DEFAULT '' NOT NULL,
	`market` text DEFAULT '' NOT NULL,
	`offer_amount` integer DEFAULT 0 NOT NULL,
	`offer_currency` text DEFAULT 'EUR' NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`default_sender_id` text DEFAULT '' NOT NULL,
	`subject_template` text NOT NULL,
	`body_template` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_owner_campaign_uq` ON `projects` (`owner_email`,`campaign_id`);--> statement-breakpoint
CREATE INDEX `projects_owner_updated_idx` ON `projects` (`owner_email`,`updated_at`);--> statement-breakpoint
CREATE TABLE `send_batch_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`project_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`handle` text NOT NULL,
	`recipient_email` text NOT NULL,
	`sender_id` text NOT NULL,
	`from_name` text NOT NULL,
	`from_email` text NOT NULL,
	`reply_to_email` text DEFAULT '' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`review_warnings_json` text DEFAULT '[]' NOT NULL,
	`payload_hash` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`message_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`sent_at` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_items_idempotency_uq` ON `send_batch_items` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `send_items_project_recipient_step_uq` ON `send_batch_items` (`project_id`,`recipient_email`);--> statement-breakpoint
CREATE INDEX `send_items_batch_status_idx` ON `send_batch_items` (`batch_id`,`status`);--> statement-breakpoint
CREATE TABLE `send_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`request_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`mode` text DEFAULT 'live' NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`payload_hash` text NOT NULL,
	`approved_by` text DEFAULT '' NOT NULL,
	`approved_at` text DEFAULT '' NOT NULL,
	`job_id` text DEFAULT '' NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`unknown_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_batches_project_request_uq` ON `send_batches` (`project_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `send_batches_project_created_idx` ON `send_batches` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sender_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`label` text NOT NULL,
	`from_name` text NOT NULL,
	`from_email` text NOT NULL,
	`reply_to_email` text DEFAULT '' NOT NULL,
	`smtp_host` text NOT NULL,
	`smtp_port` integer NOT NULL,
	`secure` integer DEFAULT true NOT NULL,
	`daily_cap` integer DEFAULT 50 NOT NULL,
	`verification_status` text DEFAULT 'configured' NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_owner_email_uq` ON `sender_accounts` (`owner_email`,`from_email`);