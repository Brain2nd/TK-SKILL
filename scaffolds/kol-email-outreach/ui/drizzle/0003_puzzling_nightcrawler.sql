ALTER TABLE `creators` ADD `evidence_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `creators` ADD `source` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `creators` ADD `source_updated_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_accounts` ADD `provider` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_accounts` ADD `auth_mode` text DEFAULT 'smtp' NOT NULL;