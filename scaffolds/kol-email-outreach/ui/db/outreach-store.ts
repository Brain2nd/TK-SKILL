import { env } from "cloudflare:workers";
import demoData from "../app/demo-data.json";
import { canonicalBatchSnapshot, canonicalItemPayload } from "../lib/outreach-contract.mjs";

const DEFAULT_SUBJECT = "Paid TikTok Shop short-form video opportunity";
const LEGACY_DEFAULT_BODY = `Hi!

{{personalized_hook}}

We have a paid TikTok Shop short-form video posting opportunity.

We will provide the video for you, and you only need to post it on your TikTok account and add the TikTok Shop product link. You will receive €20 for the post.

Would you be interested in collaborating with us?

{{sender_name}}`;
const DEFAULT_BODY = LEGACY_DEFAULT_BODY.replace(
  "\n\nWould you be interested in collaborating with us?",
  "\n\nHere is a sample video for reference: https://vm.tiktok.com/ZNRoT8PuT/\n\nWould you be interested in collaborating with us?",
);

function database() {
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseJson(value: unknown, fallback: unknown = []) {
  try { return JSON.parse(String(value || "")); }
  catch { return fallback; }
}

function normalizeEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : "";
}

function normalizeCampaign(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

function assertTemplate(subject: unknown, body: unknown) {
  const cleanSubject = String(subject || "").trim();
  const cleanBody = String(body || "").replace(/\r\n?/g, "\n").trim();
  if (!cleanSubject || /\r|\n/.test(cleanSubject)) throw new Error("邮件主题必须是一行非空文本");
  if (!cleanBody) throw new Error("邮件正文不能为空");
  if ((cleanBody.match(/\{\{personalized_hook\}\}/g) || []).length !== 1) {
    throw new Error("正文必须且只能包含一个 {{personalized_hook}} 段落");
  }
  if (!cleanBody.split(/\n\n/).some((part) => part.trim() === "{{personalized_hook}}")) {
    throw new Error("{{personalized_hook}} 必须独占一个段落");
  }
  if ((cleanBody.match(/\{\{sender_name\}\}/g) || []).length !== 1) {
    throw new Error("正文必须且只能包含一个 {{sender_name}} 签名");
  }
  const placeholders = [...`${cleanSubject}\n${cleanBody}`.matchAll(/\{\{([a-z0-9_]+)\}\}/gi)].map((match) => match[1]);
  const unknown = [...new Set(placeholders.filter((name) => !["personalized_hook", "sender_name", "brand_name"].includes(name)))];
  if (unknown.length) throw new Error(`不支持的模板变量：${unknown.join(", ")}`);
  return { subject: cleanSubject.slice(0, 180), body: cleanBody };
}

function renderTemplate(subject: string, body: string, variables: { hook: string; senderName: string; brandName: string }) {
  const checked = assertTemplate(subject, body);
  const renderedBody = checked.body.split(/\n\n/).flatMap((paragraph) => {
    if (paragraph.trim() !== "{{personalized_hook}}") return [paragraph];
    return variables.hook.trim() ? [variables.hook.trim()] : [];
  }).join("\n\n")
    .replaceAll("{{sender_name}}", variables.senderName.trim())
    .replaceAll("{{brand_name}}", variables.brandName.trim());
  const renderedSubject = checked.subject.replaceAll("{{sender_name}}", variables.senderName.trim()).replaceAll("{{brand_name}}", variables.brandName.trim());
  if (/\{\{[^}]+\}\}/.test(`${renderedSubject}\n${renderedBody}`)) throw new Error("邮件仍包含未替换变量");
  return { subject: renderedSubject, body: renderedBody };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function scopedCampaignId(ownerEmail: string, campaignId: string) {
  return `${(await sha256(ownerEmail.trim().toLowerCase())).slice(0, 16)}:${campaignId}`;
}

async function ensureSchema() {
  const db = database();
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, name TEXT NOT NULL, campaign_id TEXT NOT NULL,
      brand_name TEXT NOT NULL DEFAULT '', market TEXT NOT NULL DEFAULT '', offer_amount INTEGER NOT NULL DEFAULT 0,
      offer_currency TEXT NOT NULL DEFAULT 'EUR', target_count INTEGER NOT NULL DEFAULT 0,
      default_sender_id TEXT NOT NULL DEFAULT '', subject_template TEXT NOT NULL, body_template TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_campaign_uq ON projects(owner_email, campaign_id)`,
    `CREATE INDEX IF NOT EXISTS projects_owner_updated_idx ON projects(owner_email, updated_at)`,
    `CREATE TABLE IF NOT EXISTS creators (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT 'tiktok', handle TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', profile_url TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL,
      country TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '', followers INTEGER NOT NULL DEFAULT 0,
      avg_views INTEGER NOT NULL DEFAULT 0, engagement_rate REAL NOT NULL DEFAULT 0,
      traits_json TEXT NOT NULL DEFAULT '[]', review_warnings_json TEXT NOT NULL DEFAULT '[]',
      bio TEXT NOT NULL DEFAULT '', default_hook TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS creators_platform_handle_uq ON creators(platform, handle)`,
    `CREATE INDEX IF NOT EXISTS creators_country_idx ON creators(country)`,
    `CREATE TABLE IF NOT EXISTS sender_accounts (
      id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, label TEXT NOT NULL, from_name TEXT NOT NULL,
      from_email TEXT NOT NULL, reply_to_email TEXT NOT NULL DEFAULT '', smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL, secure INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'custom', auth_mode TEXT NOT NULL DEFAULT 'smtp', daily_cap INTEGER NOT NULL DEFAULT 50,
      verification_status TEXT NOT NULL DEFAULT 'configured', is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sender_owner_email_uq ON sender_accounts(owner_email, from_email)`,
    `CREATE TABLE IF NOT EXISTS project_recipients (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, creator_id TEXT NOT NULL, sender_override_id TEXT NOT NULL DEFAULT '',
      personalized_hook TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'selected', position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS project_recipients_project_creator_uq ON project_recipients(project_id, creator_id)`,
    `CREATE INDEX IF NOT EXISTS project_recipients_project_idx ON project_recipients(project_id, position)`,
    `CREATE TABLE IF NOT EXISTS send_batches (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      mode TEXT NOT NULL DEFAULT 'live', item_count INTEGER NOT NULL DEFAULT 0, payload_hash TEXT NOT NULL,
      approved_by TEXT NOT NULL DEFAULT '', approved_at TEXT NOT NULL DEFAULT '', job_id TEXT NOT NULL DEFAULT '',
      job_revision INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
      unknown_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS send_batches_project_request_uq ON send_batches(project_id, request_key)`,
    `CREATE INDEX IF NOT EXISTS send_batches_project_created_idx ON send_batches(project_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS send_batch_items (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, project_id TEXT NOT NULL, creator_id TEXT NOT NULL,
      candidate_id TEXT NOT NULL, handle TEXT NOT NULL, recipient_email TEXT NOT NULL, sender_id TEXT NOT NULL,
      from_name TEXT NOT NULL, from_email TEXT NOT NULL, reply_to_email TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL, body TEXT NOT NULL, review_warnings_json TEXT NOT NULL DEFAULT '[]',
      payload_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS send_items_idempotency_uq ON send_batch_items(idempotency_key)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS send_items_project_recipient_step_uq ON send_batch_items(project_id, recipient_email)`,
    `CREATE INDEX IF NOT EXISTS send_items_batch_status_idx ON send_batch_items(batch_id, status)`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, event_type TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS audit_owner_created_idx ON audit_events(owner_email, created_at)`,
    `CREATE INDEX IF NOT EXISTS audit_project_created_idx ON audit_events(project_id, created_at)`,
  ];
  await db.batch(statements.map((statement) => db.prepare(statement)));
  const batchColumns = await db.prepare("PRAGMA table_info(send_batches)").all();
  if (!(batchColumns.results || []).some((column: any) => column.name === "job_revision")) {
    await db.prepare("ALTER TABLE send_batches ADD COLUMN job_revision INTEGER NOT NULL DEFAULT 0").run();
  }
  const itemColumns = await db.prepare("PRAGMA table_info(send_batch_items)").all();
  if (!(itemColumns.results || []).some((column: any) => column.name === "position")) {
    await db.prepare("ALTER TABLE send_batch_items ADD COLUMN position INTEGER NOT NULL DEFAULT 0").run();
  }
  const senderColumns = await db.prepare("PRAGMA table_info(sender_accounts)").all();
  if (!(senderColumns.results || []).some((column: any) => column.name === "provider")) {
    await db.prepare("ALTER TABLE sender_accounts ADD COLUMN provider TEXT NOT NULL DEFAULT 'custom'").run();
  }
  if (!(senderColumns.results || []).some((column: any) => column.name === "auth_mode")) {
    await db.prepare("ALTER TABLE sender_accounts ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'smtp'").run();
  }
}

async function audit(ownerEmail: string, projectId: string, entityType: string, entityId: string, eventType: string, details: unknown = {}) {
  await database().prepare(
    "INSERT INTO audit_events (id, owner_email, project_id, entity_type, entity_id, event_type, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id("evt"), ownerEmail, projectId, entityType, entityId, eventType, JSON.stringify(details), now()).run();
}

async function seedDemo(ownerEmail: string) {
  const db = database();
  const creatorStatements = (demoData.creators as any[]).map((creator) => {
    const result = (demoData.report.results as any[]).find((item) => item.handle === creator.username) || {};
    const paragraphs = String(result.body || "").split(/\n\n/);
    const hook = paragraphs.length > 5 ? paragraphs[1] : "";
    return db.prepare(
      `INSERT OR IGNORE INTO creators (
        id, platform, handle, display_name, profile_url, contact_email, country, city, followers, avg_views,
        engagement_rate, traits_json, review_warnings_json, bio, default_hook
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      creator.candidate_id, "tiktok", creator.username, creator.display_name || `@${creator.username}`,
      creator.profile_url || `https://www.tiktok.com/@${creator.username}`, normalizeEmail(creator.email),
      creator.country || "ES", creator.city || "西班牙", Number(creator.followers || 0), Number(creator.avg_views || 0),
      Number(creator.engagement_rate || 0), JSON.stringify(creator.personalization_traits || []),
      JSON.stringify(creator.review_warnings || result.review_warnings || []), creator.bio || "", hook,
    );
  });
  if (creatorStatements.length) await db.batch(creatorStatements);

  const seedCampaignId = String(demoData.report.campaign_id);
  const projectId = `project_spain_eur20_${(await sha256(ownerEmail.trim().toLowerCase())).slice(0, 12)}`;
  const existing = await db.prepare("SELECT id FROM projects WHERE owner_email = ? AND campaign_id = ?").bind(ownerEmail, seedCampaignId).first();
  if (!existing) {
    await db.prepare(
      `INSERT INTO projects (
        id, owner_email, name, campaign_id, brand_name, market, offer_amount, offer_currency, target_count,
        default_sender_id, subject_template, body_template, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'draft', ?, ?)`,
    ).bind(
      projectId, ownerEmail, "西班牙 TikTok Shop €20", seedCampaignId,
      "TikTok Shop", "ES", 20, "EUR", demoData.report.planned, DEFAULT_SUBJECT, DEFAULT_BODY, now(), now(),
    ).run();
    const recipientStatements = (demoData.creators as any[]).map((creator, index) => {
      const result = (demoData.report.results as any[]).find((item) => item.handle === creator.username) || {};
      const hook = String(result.body || "").split(/\n\n/)[1] || "";
      return db.prepare(
        "INSERT INTO project_recipients (id, project_id, creator_id, personalized_hook, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'selected', ?, ?, ?)",
      ).bind(`pr_${projectId}_${creator.candidate_id}`, projectId, creator.candidate_id, hook, index, now(), now());
    });
    if (recipientStatements.length) await db.batch(recipientStatements);
    await audit(ownerEmail, projectId, "project", projectId, "project.seeded", { recipients: recipientStatements.length });
  } else {
    await db.prepare(
      "UPDATE projects SET body_template = ?, updated_at = ? WHERE id = ? AND status = 'draft' AND body_template = ?",
    ).bind(DEFAULT_BODY, now(), String((existing as any).id), LEGACY_DEFAULT_BODY).run();
  }
}

export async function initializeWorkspace(ownerEmail: string) {
  await ensureSchema();
  await seedDemo(ownerEmail);
}

function mapProject(row: any) {
  return {
    id: row.id,
    owner_email: row.owner_email,
    name: row.name,
    campaign_id: row.campaign_id,
    brand_name: row.brand_name,
    market: row.market,
    offer_amount: Number(row.offer_amount || 0),
    offer_currency: row.offer_currency,
    target_count: Number(row.target_count || 0),
    default_sender_id: row.default_sender_id || "",
    subject_template: row.subject_template,
    body_template: row.body_template,
    status: row.status,
    recipient_count: Number(row.recipient_count || 0),
    pending_count: Number(row.pending_count || 0),
    sent_count: Number(row.sent_count || 0),
    failed_count: Number(row.failed_count || 0),
    unknown_count: Number(row.unknown_count || 0),
    updated_at: row.updated_at,
  };
}

export async function workspaceSnapshot(ownerEmail: string, projectId = "") {
  await initializeWorkspace(ownerEmail);
  const db = database();
  const projectRows = await db.prepare(
    `SELECT p.*,
      (SELECT COUNT(*) FROM project_recipients pr WHERE pr.project_id = p.id) AS recipient_count,
      (SELECT COUNT(*) FROM send_batch_items i WHERE i.project_id = p.id AND i.status IN ('pending','approved','queued','sending')) AS pending_count,
      (SELECT COUNT(*) FROM send_batch_items i WHERE i.project_id = p.id AND i.status = 'sent') AS sent_count,
      (SELECT COUNT(*) FROM send_batch_items i WHERE i.project_id = p.id AND i.status = 'failed') AS failed_count,
      (SELECT COUNT(*) FROM send_batch_items i WHERE i.project_id = p.id AND i.status = 'delivery_unknown') AS unknown_count
     FROM projects p WHERE p.owner_email = ? ORDER BY p.updated_at DESC`,
  ).bind(ownerEmail).all();
  const projects = (projectRows.results || []).map(mapProject);
  const selectedProjectId = projectId && projects.some((project: any) => project.id === projectId) ? projectId : projects[0]?.id || "";
  const [creatorRows, senderRows, recipientRows, batchRows, itemRows, auditRows] = await Promise.all([
    db.prepare("SELECT * FROM creators ORDER BY avg_views DESC, followers DESC").all(),
    db.prepare("SELECT * FROM sender_accounts WHERE owner_email = ? ORDER BY created_at DESC").bind(ownerEmail).all(),
    selectedProjectId
      ? db.prepare(`SELECT pr.*, c.handle, c.display_name, c.profile_url, c.contact_email, c.country, c.city,
          c.followers, c.avg_views, c.engagement_rate, c.traits_json, c.review_warnings_json, c.bio
        FROM project_recipients pr JOIN creators c ON c.id = pr.creator_id
        WHERE pr.project_id = ? ORDER BY pr.position`).bind(selectedProjectId).all()
      : Promise.resolve({ results: [] }),
    selectedProjectId
      ? db.prepare("SELECT * FROM send_batches WHERE project_id = ? ORDER BY created_at DESC").bind(selectedProjectId).all()
      : Promise.resolve({ results: [] }),
    selectedProjectId
      ? db.prepare("SELECT * FROM send_batch_items WHERE project_id = ? ORDER BY position, handle").bind(selectedProjectId).all()
      : Promise.resolve({ results: [] }),
    db.prepare("SELECT * FROM audit_events WHERE owner_email = ? ORDER BY created_at DESC LIMIT 50").bind(ownerEmail).all(),
  ]);

  return {
    projects,
    selected_project_id: selectedProjectId,
    creators: (creatorRows.results || []).map((row: any) => ({
      ...row,
      followers: Number(row.followers || 0),
      avg_views: Number(row.avg_views || 0),
      engagement_rate: Number(row.engagement_rate || 0),
      traits: parseJson(row.traits_json),
      review_warnings: parseJson(row.review_warnings_json),
    })),
    senders: (senderRows.results || []).map((row: any) => ({ ...row, secure: Boolean(row.secure), is_enabled: Boolean(row.is_enabled) })),
    recipients: (recipientRows.results || []).map((row: any) => ({
      ...row,
      followers: Number(row.followers || 0), avg_views: Number(row.avg_views || 0),
      engagement_rate: Number(row.engagement_rate || 0), traits: parseJson(row.traits_json),
      review_warnings: parseJson(row.review_warnings_json),
    })),
    batches: (batchRows.results || []).map((row: any) => ({
      ...row,
      item_count: Number(row.item_count || 0), sent_count: Number(row.sent_count || 0),
      failed_count: Number(row.failed_count || 0), unknown_count: Number(row.unknown_count || 0),
      skipped_count: Number(row.skipped_count || 0), job_revision: Number(row.job_revision || 0),
    })),
    batch_items: (itemRows.results || []).map((row: any) => ({ ...row, review_warnings: parseJson(row.review_warnings_json) })),
    audit_events: (auditRows.results || []).map((row: any) => ({ ...row, details: parseJson(row.details_json, {}) })),
  };
}

async function projectForOwner(ownerEmail: string, projectId: string) {
  const project = await database().prepare("SELECT * FROM projects WHERE id = ? AND owner_email = ?").bind(projectId, ownerEmail).first<any>();
  if (!project) throw new Error("项目不存在或无权访问");
  return project;
}

async function assertSenderOwned(ownerEmail: string, senderId: string) {
  if (!senderId) return;
  const sender = await database().prepare(
    "SELECT id FROM sender_accounts WHERE id = ? AND owner_email = ? AND is_enabled = 1",
  ).bind(senderId, ownerEmail).first();
  if (!sender) throw new Error("选择的发件邮箱不存在或无权使用");
}

async function assertProjectEditable(projectId: string) {
  const active = await database().prepare(
    "SELECT id, status FROM send_batches WHERE project_id = ? AND status IN ('queued','sending','paused','delivery_unknown','failed','completed') LIMIT 1",
  ).bind(projectId).first<any>();
  if (active) throw new Error("项目已有正式发送记录，不能修改首次建联内容");
}

async function invalidateDraftBatches(projectId: string) {
  const db = database();
  const batches = await db.prepare("SELECT id FROM send_batches WHERE project_id = ? AND status IN ('pending','approved')").bind(projectId).all();
  const ids: string[] = (batches.results || []).map((row: any) => String(row.id));
  if (!ids.length) return;
  await db.batch(ids.flatMap((batchId) => [
    db.prepare("DELETE FROM send_batch_items WHERE batch_id = ?").bind(batchId),
    db.prepare("DELETE FROM send_batches WHERE id = ?").bind(batchId),
  ]));
}

export async function createProject(ownerEmail: string, input: any) {
  await initializeWorkspace(ownerEmail);
  const name = String(input.name || "").trim().slice(0, 100);
  if (!name) throw new Error("项目名称不能为空");
  const campaignId = normalizeCampaign(input.campaign_id || `${name}-${crypto.randomUUID().slice(0, 8)}`);
  if (campaignId.length < 3) throw new Error("Campaign ID 无效");
  const template = assertTemplate(input.subject_template || DEFAULT_SUBJECT, input.body_template || DEFAULT_BODY);
  const creatorIds: string[] = [...new Set<string>((Array.isArray(input.creator_ids) ? input.creator_ids : []).map((value: unknown) => String(value)))];
  if (!creatorIds.length) throw new Error("至少选择一位达人");
  const targetCount = Math.min(500, Math.max(1, Number(input.target_count || creatorIds.length)));
  if (creatorIds.length !== targetCount) throw new Error("已选达人数必须等于目标发送数量");
  const defaultSenderId = String(input.default_sender_id || "");
  await assertSenderOwned(ownerEmail, defaultSenderId);
  const projectId = id("project");
  const db = database();
  await db.prepare(
    `INSERT INTO projects (
      id, owner_email, name, campaign_id, brand_name, market, offer_amount, offer_currency, target_count,
      default_sender_id, subject_template, body_template, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
  ).bind(
    projectId, ownerEmail, name, campaignId, String(input.brand_name || "").trim().slice(0, 100),
    String(input.market || "").trim().slice(0, 40), Math.max(0, Number(input.offer_amount || 0)),
    String(input.offer_currency || "EUR").trim().toUpperCase().slice(0, 8), targetCount,
    defaultSenderId, template.subject, template.body, now(), now(),
  ).run();
  const selected = await db.prepare(`SELECT id, default_hook FROM creators WHERE id IN (${creatorIds.map(() => "?").join(",")})`).bind(...creatorIds).all();
  if ((selected.results || []).length !== creatorIds.length) throw new Error("选择中包含不存在的达人");
  const byId = new Map<string, any>((selected.results || []).map((row: any) => [String(row.id), row]));
  await db.batch(creatorIds.map((creatorId, position) => db.prepare(
    "INSERT INTO project_recipients (id, project_id, creator_id, personalized_hook, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'selected', ?, ?, ?)",
  ).bind(id("pr"), projectId, creatorId, byId.get(creatorId)?.default_hook || "", position, now(), now())));
  await audit(ownerEmail, projectId, "project", projectId, "project.created", { recipients: creatorIds.length });
  return projectId;
}

export async function updateProject(ownerEmail: string, input: any) {
  const project = await projectForOwner(ownerEmail, String(input.project_id || ""));
  await assertProjectEditable(project.id);
  const template = assertTemplate(input.subject_template ?? project.subject_template, input.body_template ?? project.body_template);
  const name = String(input.name ?? project.name).trim().slice(0, 100);
  if (!name) throw new Error("项目名称不能为空");
  const defaultSenderId = String(input.default_sender_id ?? project.default_sender_id);
  await assertSenderOwned(ownerEmail, defaultSenderId);
  await invalidateDraftBatches(project.id);
  await database().prepare(
    `UPDATE projects SET name = ?, brand_name = ?, market = ?, offer_amount = ?, offer_currency = ?,
      target_count = ?, default_sender_id = ?, subject_template = ?, body_template = ?, status = 'draft', updated_at = ?
     WHERE id = ? AND owner_email = ?`,
  ).bind(
    name, String(input.brand_name ?? project.brand_name).trim().slice(0, 100),
    String(input.market ?? project.market).trim().slice(0, 40), Math.max(0, Number(input.offer_amount ?? project.offer_amount)),
    String(input.offer_currency ?? project.offer_currency).trim().toUpperCase().slice(0, 8),
    Math.min(500, Math.max(1, Number(input.target_count ?? project.target_count))),
    defaultSenderId, template.subject, template.body, now(), project.id, ownerEmail,
  ).run();
  await audit(ownerEmail, project.id, "project", project.id, "project.updated", { approval_invalidated: true });
}

export async function setProjectRecipients(ownerEmail: string, input: any) {
  const project = await projectForOwner(ownerEmail, String(input.project_id || ""));
  await assertProjectEditable(project.id);
  const creatorIds: string[] = [...new Set<string>((Array.isArray(input.creator_ids) ? input.creator_ids : []).map((value: unknown) => String(value)))];
  if (!creatorIds.length) throw new Error("至少选择一位达人");
  await invalidateDraftBatches(project.id);
  const db = database();
  const selected = await db.prepare(`SELECT id, default_hook FROM creators WHERE id IN (${creatorIds.map(() => "?").join(",")})`).bind(...creatorIds).all();
  if ((selected.results || []).length !== creatorIds.length) throw new Error("选择中包含不存在的达人");
  const byId = new Map<string, any>((selected.results || []).map((row: any) => [String(row.id), row]));
  const statements = [db.prepare("DELETE FROM project_recipients WHERE project_id = ?").bind(project.id)];
  statements.push(...creatorIds.map((creatorId, position) => db.prepare(
    "INSERT INTO project_recipients (id, project_id, creator_id, personalized_hook, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'selected', ?, ?, ?)",
  ).bind(id("pr"), project.id, creatorId, byId.get(creatorId)?.default_hook || "", position, now(), now())));
  statements.push(db.prepare("UPDATE projects SET target_count = ?, status = 'draft', updated_at = ? WHERE id = ?").bind(creatorIds.length, now(), project.id));
  await db.batch(statements);
  await audit(ownerEmail, project.id, "project", project.id, "project.recipients_updated", { recipients: creatorIds.length });
}

export async function setRecipientSender(ownerEmail: string, input: any) {
  const project = await projectForOwner(ownerEmail, String(input.project_id || ""));
  await assertProjectEditable(project.id);
  const recipientId = String(input.recipient_id || "");
  const senderId = String(input.sender_id || "");
  if (senderId) {
    const sender = await database().prepare("SELECT id FROM sender_accounts WHERE id = ? AND owner_email = ? AND is_enabled = 1").bind(senderId, ownerEmail).first();
    if (!sender) throw new Error("选择的发件邮箱不存在或已停用");
  }
  await invalidateDraftBatches(project.id);
  const result = await database().prepare(
    "UPDATE project_recipients SET sender_override_id = ?, updated_at = ? WHERE id = ? AND project_id = ?",
  ).bind(senderId, now(), recipientId, project.id).run();
  if (!result.meta.changes) throw new Error("项目达人分配不存在");
  await database().prepare("UPDATE projects SET status = 'draft', updated_at = ? WHERE id = ?").bind(now(), project.id).run();
  await audit(ownerEmail, project.id, "recipient", recipientId, "recipient.sender_updated", { sender_id: senderId });
}

export async function upsertSender(ownerEmail: string, input: any) {
  await initializeWorkspace(ownerEmail);
  const fromEmail = normalizeEmail(input.from_email);
  const replyTo = input.reply_to_email ? normalizeEmail(input.reply_to_email) : "";
  if (!fromEmail || (input.reply_to_email && !replyTo)) throw new Error("发件邮箱或 Reply-To 无效");
  const senderId = String(input.id || id("sender"));
  const db = database();
  const existingOwner = await db.prepare("SELECT * FROM sender_accounts WHERE id = ?").bind(senderId).first<any>();
  if (existingOwner && existingOwner.owner_email !== ownerEmail) throw new Error("发件账户 ID 已属于其他用户");
  await db.prepare(
    `INSERT INTO sender_accounts (
      id, owner_email, label, from_name, from_email, reply_to_email, smtp_host, smtp_port, secure,
      provider, auth_mode, daily_cap, verification_status, is_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, from_name = excluded.from_name,
      from_email = excluded.from_email, reply_to_email = excluded.reply_to_email, smtp_host = excluded.smtp_host,
      smtp_port = excluded.smtp_port, secure = excluded.secure, provider = excluded.provider,
      auth_mode = excluded.auth_mode, daily_cap = excluded.daily_cap,
      verification_status = excluded.verification_status, is_enabled = 1, updated_at = excluded.updated_at`,
  ).bind(
    senderId, ownerEmail, String(input.label || input.from_name || fromEmail).trim().slice(0, 80),
    String(input.from_name || "Partnerships").trim().slice(0, 80), fromEmail, replyTo,
    String(input.smtp_host || "").trim().toLowerCase().slice(0, 255), Number(input.smtp_port || 465),
    input.secure === false ? 0 : 1, String(input.provider || "custom").trim().toLowerCase(),
    String(input.auth_mode || "smtp").trim().toLowerCase(), Math.min(500, Math.max(1, Number(input.daily_cap || 50))),
    String(input.verification_status || "configured"), now(), now(),
  ).run();
  const identityChanged = existingOwner && (
    existingOwner.from_name !== String(input.from_name || "Partnerships").trim().slice(0, 80) ||
    existingOwner.from_email !== fromEmail || (existingOwner.reply_to_email || "") !== replyTo
  );
  if (identityChanged) {
    const affected = await db.prepare(
      `SELECT DISTINCT i.project_id FROM send_batch_items i JOIN send_batches b ON b.id = i.batch_id
       WHERE i.sender_id = ? AND b.status IN ('pending','approved')`,
    ).bind(senderId).all();
    for (const row of affected.results || []) {
      const projectId = String((row as any).project_id);
      await invalidateDraftBatches(projectId);
      await db.prepare("UPDATE projects SET status = 'draft', updated_at = ? WHERE id = ? AND owner_email = ?").bind(now(), projectId, ownerEmail).run();
      await audit(ownerEmail, projectId, "sender", senderId, "sender.identity_changed_batch_invalidated", {});
    }
  }
  await audit(ownerEmail, "", "sender", senderId, "sender.configured", { from_email: fromEmail });
  return senderId;
}

export async function setSenderVerification(ownerEmail: string, senderId: string, status: string) {
  await initializeWorkspace(ownerEmail);
  await database().prepare(
    "UPDATE sender_accounts SET verification_status = ?, updated_at = ? WHERE id = ? AND owner_email = ?",
  ).bind(status, now(), senderId, ownerEmail).run();
  await audit(ownerEmail, "", "sender", senderId, `sender.${status}`, {});
}

async function personalizationStateForProject(ownerEmail: string, projectId: string) {
  const project = await projectForOwner(ownerEmail, projectId);
  await assertProjectEditable(project.id);
  const db = database();
  const rows = await db.prepare(
    `SELECT pr.*, c.handle, c.contact_email, c.review_warnings_json, c.bio, c.traits_json,
      c.city, c.country, c.followers, c.avg_views, c.engagement_rate, c.default_hook,
      COALESCE(NULLIF(pr.sender_override_id, ''), p.default_sender_id) AS resolved_sender_id,
      s.from_name, s.from_email, s.reply_to_email, s.verification_status, s.is_enabled
     FROM project_recipients pr
     JOIN projects p ON p.id = pr.project_id
     JOIN creators c ON c.id = pr.creator_id
     LEFT JOIN sender_accounts s ON s.id = COALESCE(NULLIF(pr.sender_override_id, ''), p.default_sender_id)
       AND s.owner_email = p.owner_email
     WHERE pr.project_id = ? ORDER BY pr.position`,
  ).bind(project.id).all();
  const recipients = rows.results || [];
  if (!recipients.length) throw new Error("项目没有已分配达人");
  if (recipients.length !== Number(project.target_count)) throw new Error("已分配达人数与项目目标数量不一致");
  const recipientEndpoints = new Set<string>();
  for (const row of recipients as any[]) {
    if (!row.resolved_sender_id || !row.from_email) throw new Error(`@${row.handle} 尚未分配发件邮箱`);
    if (row.verification_status !== "verified" || !row.is_enabled) throw new Error(`${row.from_email} 尚未通过连接验证`);
    const to = normalizeEmail(row.contact_email);
    if (!to) throw new Error(`@${row.handle} 的收件邮箱无效`);
    if (recipientEndpoints.has(to)) throw new Error(`收件邮箱 ${to} 在项目中重复，已阻止生成审批批次`);
    recipientEndpoints.add(to);
  }
  const publicRequest = {
    project: {
      id: project.id,
      brand_name: project.brand_name || "",
      subject: project.subject_template,
      body: project.body_template,
    },
    recipients: (recipients as any[]).map((row) => {
      const traits = parseJson(row.traits_json, []);
      const styleParts = [
        ...(Array.isArray(traits) ? traits.map(String) : []),
        row.city ? `city:${row.city}` : "",
        row.country ? `country:${row.country}` : "",
      ].filter(Boolean);
      return {
        recipient_id: String(row.id),
        handle: String(row.handle || ""),
        bio: String(row.bio || ""),
        style_summary: styleParts.join(", "),
        recent_videos: [],
        base_hook: String(row.personalized_hook || row.default_hook || ""),
        base_evidence_ids: [],
      };
    }),
  };
  const privateSnapshot = {
    project: {
      id: project.id,
      campaign_id: project.campaign_id,
      brand_name: project.brand_name || "",
      subject: project.subject_template,
      body: project.body_template,
    },
    recipients: (recipients as any[]).map((row) => ({
      id: row.id,
      creator_id: row.creator_id,
      handle: row.handle,
      contact_email: normalizeEmail(row.contact_email),
      sender_id: row.resolved_sender_id,
      from_name: row.from_name,
      from_email: row.from_email,
      reply_to_email: row.reply_to_email || "",
      bio: row.bio || "",
      traits_json: row.traits_json || "[]",
      city: row.city || "",
      country: row.country || "",
      base_hook: row.personalized_hook || row.default_hook || "",
      position: Number(row.position || 0),
    })),
  };
  return {
    project,
    rows: recipients as any[],
    snapshotHash: await sha256(JSON.stringify(privateSnapshot)),
    publicRequest,
  };
}

export async function personalizationRequestForProject(ownerEmail: string, projectId: string) {
  const state = await personalizationStateForProject(ownerEmail, projectId);
  return { snapshot_hash: state.snapshotHash, ...state.publicRequest };
}

function safePersonalizedHook(value: unknown) {
  const hook = String(value || "").trim();
  if (hook.length > 240 || /[\r\n]|https?:\/\//i.test(hook)) throw new Error("AI 个性化开场不符合安全格式");
  return hook;
}

export async function createPendingBatch(ownerEmail: string, projectId: string, personalization?: any) {
  const state = await personalizationStateForProject(ownerEmail, projectId);
  const { project, rows: recipients } = state;
  let personalizationByRecipient = new Map<string, any>();
  if (personalization) {
    if (String(personalization.snapshot_hash || "") !== state.snapshotHash) {
      throw new Error("AI 生成期间项目模板、达人或发件邮箱已变化，请重新生成");
    }
    const results = Array.isArray(personalization.results) ? personalization.results : [];
    if (results.length !== recipients.length) throw new Error("AI 个性化结果数量与项目达人不一致");
    personalizationByRecipient = new Map(results.map((result: any) => [String(result.recipient_id || ""), result]));
    if (personalizationByRecipient.size !== recipients.length || recipients.some((row: any) => !personalizationByRecipient.has(String(row.id)))) {
      throw new Error("AI 个性化结果与项目达人身份不一致");
    }
  }
  await invalidateDraftBatches(project.id);
  const db = database();
  const batchId = id("batch");
  const campaignScope = await scopedCampaignId(ownerEmail, project.campaign_id);
  const items = [];
  const recipientEndpoints = new Set<string>();
  for (const row of recipients as any[]) {
    const to = normalizeEmail(row.contact_email);
    recipientEndpoints.add(to);
    const personalized = personalizationByRecipient.get(String(row.id));
    const hook = personalized ? safePersonalizedHook(personalized.hook) : safePersonalizedHook(row.personalized_hook || row.default_hook || "");
    const parsedWarnings = parseJson(row.review_warnings_json);
    const reviewWarnings = Array.isArray(parsedWarnings) ? [...parsedWarnings] : [];
    if (personalized?.method === "ai" && (!Array.isArray(personalized.evidence_ids) || !personalized.evidence_ids.length)) {
      throw new Error(`@${row.handle} 的 AI 个性化结果缺少公开证据引用`);
    }
    if (personalized?.fallback_reason) {
      const reason = String(personalized.fallback_reason).replace(/[\r\n]+/g, " ").slice(0, 180);
      reviewWarnings.push(`AI 个性化已降级为规则文案：${reason}`);
    }
    const rendered = renderTemplate(project.subject_template, project.body_template, {
      hook,
      senderName: row.from_name,
      brandName: project.brand_name || "",
    });
    const idempotencyKey = `${campaignScope}:${row.creator_id}:step01`;
    const itemPayload = {
      project_id: project.id, creator_id: row.creator_id, candidate_id: row.creator_id, handle: row.handle,
      recipient_email: to, sender_id: row.resolved_sender_id, from_name: row.from_name,
      from_email: row.from_email, reply_to_email: row.reply_to_email || "", subject: rendered.subject,
      body: rendered.body, idempotency_key: idempotencyKey,
    };
    items.push({
      id: id("item"), ...itemPayload, position: Number(row.position || 0), review_warnings: reviewWarnings,
      payload_hash: await sha256(canonicalItemPayload(itemPayload)),
    });
  }
  const payloadHash = await sha256(canonicalBatchSnapshot({
    batch_id: batchId, project_id: project.id, campaign_id: campaignScope, items,
  }));
  const requestKey = `${project.id}:${payloadHash}`;
  const statements = [db.prepare(
    `INSERT INTO send_batches (id, project_id, request_key, status, mode, item_count, payload_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 'live', ?, ?, ?, ?)`,
  ).bind(batchId, project.id, requestKey, items.length, payloadHash, now(), now())];
  statements.push(...items.map((item) => db.prepare(
    `INSERT INTO send_batch_items (
      id, batch_id, project_id, creator_id, candidate_id, handle, recipient_email, sender_id, from_name,
      from_email, reply_to_email, subject, body, review_warnings_json, payload_hash, idempotency_key,
      position, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).bind(
    item.id, batchId, project.id, item.creator_id, item.candidate_id, item.handle, item.recipient_email,
    item.sender_id, item.from_name, item.from_email, item.reply_to_email, item.subject, item.body,
    JSON.stringify(item.review_warnings), item.payload_hash, item.idempotency_key, item.position, now(), now(),
  )));
  statements.push(db.prepare("UPDATE projects SET status = 'pending_approval', updated_at = ? WHERE id = ?").bind(now(), project.id));
  await db.batch(statements);
  const fallbackCount = [...personalizationByRecipient.values()].filter((result) => result?.fallback_reason).length;
  await audit(ownerEmail, project.id, "batch", batchId, "batch.created", {
    items: items.length,
    payload_hash: payloadHash,
    personalization: personalization ? "ai_with_guarded_fallback" : "stored_hook",
    ai_fallback_count: fallbackCount,
  });
  return batchId;
}

export async function approvePendingBatch(ownerEmail: string, input: any) {
  const batchId = String(input.batch_id || "");
  const batch = await database().prepare(
    `SELECT b.*, p.name, p.owner_email FROM send_batches b JOIN projects p ON p.id = b.project_id
     WHERE b.id = ? AND p.owner_email = ?`,
  ).bind(batchId, ownerEmail).first<any>();
  if (!batch || batch.status !== "pending") throw new Error("待审批批次不存在或状态已变化");
  if (String(input.confirmation || "").trim() !== batch.name) throw new Error("请输入完整项目名确认审批");
  const warningRows = await database().prepare(
    "SELECT id FROM send_batch_items WHERE batch_id = ? AND review_warnings_json != '[]'",
  ).bind(batchId).all();
  const warningItemIds = (warningRows.results || []).map((row: any) => String(row.id));
  const reviewedWarningIds = new Set<string>((Array.isArray(input.reviewed_warning_item_ids) ? input.reviewed_warning_item_ids : []).map((value: unknown) => String(value)));
  if (warningItemIds.length && (input.accept_warnings !== true || warningItemIds.some((itemId) => !reviewedWarningIds.has(itemId)))) {
    throw new Error("必须逐封查看并确认所有人工审核警告后才能批准");
  }
  const approvedBy = String(input.approved_by || ownerEmail).trim().slice(0, 120);
  const db = database();
  await db.batch([
    db.prepare("UPDATE send_batches SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(approvedBy, now(), now(), batchId),
    db.prepare("UPDATE send_batch_items SET status = 'approved', updated_at = ? WHERE batch_id = ? AND status = 'pending'").bind(now(), batchId),
    db.prepare("UPDATE projects SET status = 'approved', updated_at = ? WHERE id = ?").bind(now(), batch.project_id),
  ]);
  await audit(ownerEmail, batch.project_id, "batch", batchId, "batch.approved", {
    approved_by: approvedBy, warnings_accepted: Boolean(input.accept_warnings), reviewed_warning_item_ids: warningItemIds,
  });
}

export async function approvedBatchForExecution(ownerEmail: string, batchId: string) {
  const batch = await database().prepare(
    `SELECT b.*, p.name, p.campaign_id, p.owner_email FROM send_batches b JOIN projects p ON p.id = b.project_id
     WHERE b.id = ? AND p.owner_email = ?`,
  ).bind(batchId, ownerEmail).first<any>();
  if (!batch || !["approved", "queued", "sending"].includes(batch.status)) throw new Error("批次尚未批准或不可执行");
  batch.campaign_id = await scopedCampaignId(ownerEmail, batch.campaign_id);
  const items = await database().prepare("SELECT * FROM send_batch_items WHERE batch_id = ? ORDER BY position, handle").bind(batchId).all();
  return { batch, items: items.results || [] };
}

export async function markBatchQueued(ownerEmail: string, batchId: string, jobId: string) {
  const db = database();
  const initial = await db.prepare(
    `SELECT b.*, p.owner_email FROM send_batches b JOIN projects p ON p.id = b.project_id
     WHERE b.id = ? AND p.owner_email = ?`,
  ).bind(batchId, ownerEmail).first<any>();
  if (!initial) throw new Error("发送批次不存在或无权访问");
  let transitioned = false;
  if (initial.status === "approved") {
    const reserved = await db.prepare(
      `UPDATE send_batches SET status = 'queued', job_id = ?, job_revision = 0, updated_at = ?
       WHERE id = ? AND status = 'approved' AND (job_id = '' OR job_id = ?)`,
    ).bind(jobId, now(), batchId, jobId).run();
    transitioned = Number(reserved.meta.changes || 0) === 1;
  }
  const batch = await db.prepare("SELECT * FROM send_batches WHERE id = ?").bind(batchId).first<any>();
  if (!batch || !["queued", "sending"].includes(batch.status) || batch.job_id !== jobId) {
    throw new Error("批次已绑定其他发送任务或状态不可入队");
  }
  await db.batch([
    db.prepare("UPDATE send_batch_items SET status = CASE WHEN status = 'approved' THEN 'queued' ELSE status END, updated_at = ? WHERE batch_id = ?").bind(now(), batchId),
    db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").bind(batch.status, now(), batch.project_id),
  ]);
  if (transitioned) await audit(ownerEmail, batch.project_id, "batch", batchId, "batch.queued", { job_id: jobId });
}

export async function applyJobStatus(ownerEmail: string, batchId: string, job: any) {
  const batch = await database().prepare(
    `SELECT b.*, p.owner_email FROM send_batches b JOIN projects p ON p.id = b.project_id
     WHERE b.id = ? AND p.owner_email = ?`,
  ).bind(batchId, ownerEmail).first<any>();
  if (!batch) throw new Error("发送批次不存在或无权访问");
  if (String(job?.batch_id || "") !== batchId || String(job?.project_id || "") !== String(batch.project_id)) {
    throw new Error("发送任务与项目批次不匹配");
  }
  if (batch.job_id && String(job?.id || "") !== String(batch.job_id)) {
    throw new Error("发送任务 ID 与已入队批次不匹配");
  }
  const revision = Number(job?.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("发送任务版本无效");
  if (revision <= Number(batch.job_revision || 0)) return;
  const db = database();
  const counts = job.counts || {};
  const batchStatus = ["completed", "paused", "delivery_unknown", "failed", "sending", "queued"].includes(job.status) ? job.status : "queued";
  const statements = [db.prepare(
    `UPDATE send_batches SET status = ?, sent_count = ?, failed_count = ?, unknown_count = ?, skipped_count = ?,
      last_error = ?, job_revision = ?, updated_at = ? WHERE id = ? AND job_id = ? AND job_revision < ?`,
  ).bind(
    batchStatus, Number(counts.sent || 0), Number(counts.failed || 0), Number(counts.delivery_unknown || 0),
    Number(counts.skipped_existing || 0), job.error || "", revision, now(), batchId, job.id, revision,
  )];
  for (const result of job.results || []) {
    const status = ["sent", "failed", "delivery_unknown", "skipped_existing"].includes(result.status) ? result.status : "sending";
    statements.push(db.prepare(
      `UPDATE send_batch_items SET status = ?, message_id = ?, last_error = ?, sent_at = ?, updated_at = ?
       WHERE batch_id = ? AND id = ? AND EXISTS (
         SELECT 1 FROM send_batches WHERE id = ? AND job_revision = ?
       )`,
    ).bind(
      status, result.message_id || "", result.error || "", status === "sent" ? (result.sent_at || now()) : "",
      now(), batchId, result.item_id, batchId, revision,
    ));
  }
  statements.push(db.prepare(
    `UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND EXISTS (
      SELECT 1 FROM send_batches WHERE id = ? AND job_revision = ? AND status = ?
    )`,
  ).bind(batchStatus, now(), batch.project_id, batchId, revision, batchStatus));
  const results = await db.batch(statements);
  const transitioned = Number(results[0]?.meta?.changes || 0) === 1;
  if (transitioned && ["completed", "paused", "delivery_unknown", "failed"].includes(batchStatus)) {
    await audit(ownerEmail, batch.project_id, "batch", batchId, `batch.${batchStatus}`, { counts });
  }
}

export async function senderForOwner(ownerEmail: string, senderId: string) {
  await initializeWorkspace(ownerEmail);
  return database().prepare("SELECT * FROM sender_accounts WHERE id = ? AND owner_email = ?").bind(senderId, ownerEmail).first<any>();
}

export async function assertSenderIdAvailable(ownerEmail: string, senderId: string) {
  if (!senderId) return;
  await initializeWorkspace(ownerEmail);
  const existing = await database().prepare("SELECT owner_email FROM sender_accounts WHERE id = ?").bind(senderId).first<any>();
  if (existing && existing.owner_email !== ownerEmail) throw new Error("发件账户 ID 已属于其他用户");
}

export const defaults = { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY };
