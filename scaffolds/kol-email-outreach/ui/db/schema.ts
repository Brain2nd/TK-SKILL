import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  name: text("name").notNull(),
  campaignId: text("campaign_id").notNull(),
  brandName: text("brand_name").notNull().default(""),
  market: text("market").notNull().default(""),
  offerAmount: integer("offer_amount").notNull().default(0),
  offerCurrency: text("offer_currency").notNull().default("EUR"),
  targetCount: integer("target_count").notNull().default(0),
  defaultSenderId: text("default_sender_id").notNull().default(""),
  subjectTemplate: text("subject_template").notNull(),
  bodyTemplate: text("body_template").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("projects_owner_campaign_uq").on(table.ownerEmail, table.campaignId),
  index("projects_owner_updated_idx").on(table.ownerEmail, table.updatedAt),
]);

export const creators = sqliteTable("creators", {
  id: text("id").primaryKey(),
  platform: text("platform").notNull().default("tiktok"),
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull().default(""),
  profileUrl: text("profile_url").notNull().default(""),
  contactEmail: text("contact_email").notNull(),
  country: text("country").notNull().default(""),
  city: text("city").notNull().default(""),
  followers: integer("followers").notNull().default(0),
  avgViews: integer("avg_views").notNull().default(0),
  engagementRate: real("engagement_rate").notNull().default(0),
  traitsJson: text("traits_json").notNull().default("[]"),
  reviewWarningsJson: text("review_warnings_json").notNull().default("[]"),
  bio: text("bio").notNull().default(""),
  defaultHook: text("default_hook").notNull().default(""),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  source: text("source").notNull().default(""),
  sourceUpdatedAt: text("source_updated_at").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("creators_platform_handle_uq").on(table.platform, table.handle),
  index("creators_country_idx").on(table.country),
]);

export const senderAccounts = sqliteTable("sender_accounts", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  label: text("label").notNull(),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  replyToEmail: text("reply_to_email").notNull().default(""),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  secure: integer("secure", { mode: "boolean" }).notNull().default(true),
  provider: text("provider").notNull().default("custom"),
  authMode: text("auth_mode").notNull().default("smtp"),
  dailyCap: integer("daily_cap").notNull().default(50),
  verificationStatus: text("verification_status").notNull().default("configured"),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("sender_owner_email_uq").on(table.ownerEmail, table.fromEmail),
]);

export const projectRecipients = sqliteTable("project_recipients", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  creatorId: text("creator_id").notNull(),
  senderOverrideId: text("sender_override_id").notNull().default(""),
  personalizedHook: text("personalized_hook").notNull().default(""),
  status: text("status").notNull().default("selected"),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("project_recipients_project_creator_uq").on(table.projectId, table.creatorId),
  index("project_recipients_project_idx").on(table.projectId, table.position),
]);

export const sendBatches = sqliteTable("send_batches", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  requestKey: text("request_key").notNull(),
  status: text("status").notNull().default("pending"),
  mode: text("mode").notNull().default("live"),
  itemCount: integer("item_count").notNull().default(0),
  payloadHash: text("payload_hash").notNull(),
  approvedBy: text("approved_by").notNull().default(""),
  approvedAt: text("approved_at").notNull().default(""),
  jobId: text("job_id").notNull().default(""),
  jobRevision: integer("job_revision").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  unknownCount: integer("unknown_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("send_batches_project_request_uq").on(table.projectId, table.requestKey),
  index("send_batches_project_created_idx").on(table.projectId, table.createdAt),
]);

export const sendBatchItems = sqliteTable("send_batch_items", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  projectId: text("project_id").notNull(),
  creatorId: text("creator_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  handle: text("handle").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  senderId: text("sender_id").notNull(),
  fromName: text("from_name").notNull(),
  fromEmail: text("from_email").notNull(),
  replyToEmail: text("reply_to_email").notNull().default(""),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  reviewWarningsJson: text("review_warnings_json").notNull().default("[]"),
  payloadHash: text("payload_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  messageId: text("message_id").notNull().default(""),
  position: integer("position").notNull().default(0),
  status: text("status").notNull().default("pending"),
  lastError: text("last_error").notNull().default(""),
  sentAt: text("sent_at").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("send_items_idempotency_uq").on(table.idempotencyKey),
  uniqueIndex("send_items_project_recipient_step_uq").on(table.projectId, table.recipientEmail),
  index("send_items_batch_status_idx").on(table.batchId, table.status),
]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull(),
  projectId: text("project_id").notNull().default(""),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  eventType: text("event_type").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("audit_owner_created_idx").on(table.ownerEmail, table.createdAt),
  index("audit_project_created_idx").on(table.projectId, table.createdAt),
]);
