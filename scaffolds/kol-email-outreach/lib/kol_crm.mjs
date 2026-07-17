/**
 * kol_crm — KOL CRM core business logic (plain module, no MCP)
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import cfg from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const _localTemplates = JSON.parse(readFileSync(join(__dirname, "../templates.json"), "utf8"));

// ============ Config ============
const FEISHU_APP_ID = cfg.feishu_app_id || "";
const FEISHU_APP_SECRET = cfg.feishu_app_secret || "";
const APP_TOKEN = cfg.kol_crm_app_token || "";

const TBL = {
  creators: cfg.kol_tbl_creators || "",
  pipeline_log: cfg.kol_tbl_pipeline_log || "",
  email_log: cfg.kol_tbl_email_log || "",
  templates: cfg.kol_tbl_templates || "",
  deadlines: cfg.kol_tbl_deadlines || "",
  daily_summary: cfg.kol_tbl_summary || "",
};

// ============ Feishu Client ============
let client;
function feishuClient() {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) throw new Error("Feishu app credentials are not configured");
  client ||= new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });
  return client;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowMs() { return Date.now(); }
function daysFromNow(days) { return Date.now() + days * 86400000; }
function filterValue(value) { return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

function fieldText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join("");
  if (typeof value === "object") return fieldText(value.text || value.name || value.link || value.value);
  return String(value).trim();
}

let lastWriteTime = 0;
async function rateLimitWrite() {
  const elapsed = Date.now() - lastWriteTime;
  if (elapsed < 500) await sleep(500 - elapsed);
  lastWriteTime = Date.now();
}

// ============ Bitable helpers ============
export async function btListRecords(tableId, opts = {}) {
  const params = {
    path: { app_token: APP_TOKEN, table_id: tableId },
    params: { page_size: opts.pageSize || 100 },
  };
  if (opts.filter) params.params.filter = opts.filter;
  if (opts.sort) params.params.sort = opts.sort;
  if (opts.pageToken) params.params.page_token = opts.pageToken;
  if (opts.fieldNames) params.params.field_names = JSON.stringify(opts.fieldNames);
  const res = await feishuClient().bitable.appTableRecord.list(params);
  if (res.code !== 0) throw new Error(`btListRecords failed (table=${tableId}): code=${res.code} ${res.msg}`);
  return {
    items: res.data?.items || [],
    hasMore: res.data?.has_more,
    pageToken: res.data?.page_token,
    total: res.data?.total,
  };
}

export async function btCreateRecord(tableId, fields) {
  await rateLimitWrite();
  const response = await feishuClient().bitable.appTableRecord.create({
    path: { app_token: APP_TOKEN, table_id: tableId },
    data: { fields },
  });
  if (response.code !== 0) throw new Error(`btCreateRecord failed (table=${tableId}): code=${response.code} ${response.msg}`);
  return response.data?.record;
}

export async function btGetRecord(tableId, recordId) {
  const response = await feishuClient().bitable.appTableRecord.get({
    path: { app_token: APP_TOKEN, table_id: tableId, record_id: recordId },
  });
  if (response.code !== 0) throw new Error(`btGetRecord failed (table=${tableId}): code=${response.code} ${response.msg}`);
  return response.data?.record || null;
}

export async function btUpdateRecord(tableId, recordId, fields) {
  await rateLimitWrite();
  const response = await feishuClient().bitable.appTableRecord.update({
    path: { app_token: APP_TOKEN, table_id: tableId, record_id: recordId },
    data: { fields },
  });
  if (response.code !== 0) throw new Error(`btUpdateRecord failed (table=${tableId}): code=${response.code} ${response.msg}`);
  return response.data?.record;
}

// ============ Pipeline constants ============
export const STAGES = [
  "00_Discovered", "01_FirstOutreach", "02_CollabOffer", "03_Agreed",
  "04_ContractSigned", "05_TeaserDraftDue", "06_PackageShipped",
  "07_PackageDelivered", "08_TryOnVideo", "09_Completed", "XX_Dropped",
];

export const ALLOWED_TRANSITIONS = {
  "00_Discovered": ["01_FirstOutreach", "XX_Dropped"],
  "01_FirstOutreach": ["02_CollabOffer", "XX_Dropped"],
  "02_CollabOffer": ["03_Agreed", "XX_Dropped"],
  "03_Agreed": ["04_ContractSigned", "XX_Dropped"],
  "04_ContractSigned": ["05_TeaserDraftDue", "XX_Dropped"],
  "05_TeaserDraftDue": ["06_PackageShipped", "XX_Dropped"],
  "06_PackageShipped": ["07_PackageDelivered", "XX_Dropped"],
  "07_PackageDelivered": ["08_TryOnVideo", "XX_Dropped"],
  "08_TryOnVideo": ["09_Completed", "XX_Dropped"],
  "09_Completed": [],
  "XX_Dropped": [],
};

const DEADLINE_RULES = {
  "01_FirstOutreach": [{ type: "response", days: 7 }],
  "02_CollabOffer": [{ type: "response", days: 3 }],
  "05_TeaserDraftDue": [{ type: "draft_submission", days: 5 }],
  "07_PackageDelivered": [{ type: "video_delivery", days: 7 }, { type: "draft_submission", days: 5 }],
  "08_TryOnVideo": [{ type: "video_delivery", days: 10 }],
};

export function calcTier(followers) {
  if (followers >= 200000) return "Macro(200k+)";
  if (followers >= 50000) return "Mid(50k-200k)";
  if (followers >= 5000) return "Micro(5k-50k)";
  return "Nano(1.5k-5k)";
}

export function calcOffer(tier) {
  if (tier.startsWith("Macro")) return 1200;
  if (tier.startsWith("Mid")) return 800;
  if (tier.startsWith("Micro")) return 500;
  return 300;
}

const SENDER_MAP = (() => {
  const arr = cfg.sender_accounts;
  if (!Array.isArray(arr) || arr.length === 0) return {};
  return Object.fromEntries(arr.map(a => [a.name, a.user]));
})();

// ============ Creator lookup ============
export async function findCreator(handle) {
  const normalized = String(handle || "").replace(/^@/, "").trim().toLowerCase();
  let { items } = await btListRecords(TBL.creators, {
    filter: `CurrentValue.[username] = "${filterValue(handle)}"`,
    pageSize: 1,
  });
  if (items[0]) return items[0];
  ({ items } = await btListRecords(TBL.creators, {
    filter: `CurrentValue.[username].contains("${filterValue(normalized)}")`,
    pageSize: 20,
  }));
  return items.find(item =>
    fieldText(item.fields?.username).replace(/^@/, "").trim().toLowerCase() === normalized
  ) || null;
}

/** Resolve a creator by immutable CRM record/candidate identity; handle is legacy fallback only. */
export function assertCandidateIdentity(record, candidateId, recordId = record?.record_id || "unknown") {
  if (!candidateId) return record;
  const storedId = fieldText(record?.fields?.candidate_id);
  if (!storedId) throw new Error(`candidate_id missing for record ${recordId}`);
  if (storedId !== candidateId) throw new Error(`candidate identity changed for record ${recordId}`);
  return record;
}

export async function findCreatorByIdentity({ recordId, candidateId, handle } = {}) {
  if (recordId) {
    const record = await btGetRecord(TBL.creators, recordId);
    if (!record) return null;
    return assertCandidateIdentity(record, candidateId, recordId);
  }
  if (candidateId) {
    const { items } = await btListRecords(TBL.creators, {
      filter: `CurrentValue.[candidate_id] = "${filterValue(candidateId)}"`,
      pageSize: 2,
    });
    if (items.length > 1) throw new Error(`duplicate candidate_id in CRM: ${candidateId}`);
    if (items[0]) return items[0];
    return null;
  }
  return handle ? findCreator(handle) : null;
}

// ============ Template engine ============
async function getTemplate(step, tier, variant) {
  let matches = _localTemplates.filter(t => t.step === step);
  if (!matches.length) return null;

  const tierMatch = matches.filter(t => t.tier === tier || t.tier === "all" || !t.tier);
  if (tierMatch.length) matches = tierMatch;

  if (variant) {
    const varMatch = matches.filter(t => t.variant === variant);
    if (!varMatch.length) return null;
    matches = varMatch;
  } else {
    const defaultMatch = matches.filter(t => !t.variant);
    if (defaultMatch.length) matches = defaultMatch;
  }

  // Wrap in shape that _renderTemplate expects
  const t = matches[0];
  return { fields: { "Template ID": t.template_id, "Subject Template": t.subject, "Body Template": t.body, "Internal Notes": t.notes || "" } };
}

function _renderTemplate(template, vars) {
  let subject = template.fields["Subject Template"] || "";
  let body = template.fields["Body Template"] || "";

  for (const [key, val] of Object.entries(vars)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    subject = subject.replace(regex, val || "");
    body = body.replace(regex, val || "");
  }

  body = body.replace(/\[\s*内部备注\s*\][\s\S]*?(?=\n\n|\n$|$)/g, "").trim();
  body = body.replace(/\[\s*INTERNAL\s*\][\s\S]*?\[\s*\/INTERNAL\s*\]/g, "").trim();

  const TRACK_HOST = cfg.track_host || "";
  const tid = template.fields["Template ID"] || "";
  const cname = encodeURIComponent(vars.creator_name || "");
  const ets = Date.now();

  const wrapClick = (url) =>
    TRACK_HOST ? `${TRACK_HOST}/track/click?t=${tid}&c=${cname}&u=${encodeURIComponent(url)}` : url;
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
  const bodyTracked = body.replace(urlRegex, (url) => wrapClick(url));

  const bodyHtml = body
    .replace(urlRegex, (url) => `<a href="${wrapClick(url)}">${url}</a>`)
    .replace(/\n/g, "<br>") +
    (TRACK_HOST
      ? `<br><img src="${TRACK_HOST}/track/open?t=${tid}&c=${cname}&ets=${ets}" width="1" height="1" style="display:none" alt="">`
      : "");

  return {
    subject,
    body: bodyTracked,
    bodyHtml,
    templateId: tid,
    internalNotes: template.fields["Internal Notes"] || "",
  };
}

function followerTier(followers) {
  if (followers >= 1000000) return "Macro(1M+)";
  if (followers >= 100000)  return "Mid(100k-1M)";
  if (followers >= 10000)   return "Micro(10k-100k)";
  return "Nano(1.5k-10k)";
}

function buildVars(creator, creatorHandle, assignedTo, customVars) {
  const tier = calcTier(creator.fields["followers"] || 0);
  const offer = calcOffer(tier);
  const shippingWeight =
    tier.startsWith("Macro") || tier.startsWith("Mid") ? "5-10 kg" :
    tier.startsWith("Micro") ? "3-5 kg" : "3 kg";
  return {
    creator_name: fieldText(
      creator.fields["display_name"] || creator.fields["nickname"] ||
      creator.fields["tiktok_nickname"] || creator.fields["username"]
    ) || creatorHandle,
    creator_tiktok: (() => {
      const stored = fieldText(creator.fields["profile_url"]);
      if (stored.includes("tiktok.com/")) return stored;
      return `www.tiktok.com/@${fieldText(creator.fields["username"]) || creatorHandle}`;
    })(),
    your_name: assignedTo.charAt(0).toUpperCase() + assignedTo.slice(1),
    offer_amount: String(offer),
    shipping_weight: shippingWeight,
    affiliate_link: creator.fields["Affiliate Link"] || "",
    tracking_number: creator.fields["Tracking Number"] || "",
    deadline_date: creator.fields["Stage Entered At"]
      ? new Date(creator.fields["Stage Entered At"]).toISOString().split("T")[0]
      : "",
    registration_count: "X",
    commission_amount: "X",
    ...(customVars
      ? (typeof customVars === "string" ? JSON.parse(customVars) : customVars)
      : {}),
  };
}

// ============ Exported functions ============

/** Search creators by filter. Returns { items, total }. */
export async function searchCreators({ stage, category, assigned_to, handle, candidate_id } = {}) {
  const conditions = [];
  if (stage) conditions.push(`CurrentValue.[Pipeline Stage] = "${stage}"`);
  if (category) conditions.push(`CurrentValue.[primary_category] = "${filterValue(category)}"`);
  if (assigned_to) conditions.push(`CurrentValue.[Assigned To] = "${filterValue(assigned_to)}"`);
  if (handle) conditions.push(`CurrentValue.[username].contains("${filterValue(handle)}")`);
  if (candidate_id) conditions.push(`CurrentValue.[candidate_id] = "${filterValue(candidate_id)}"`);

  const filter =
    conditions.length > 1 ? `AND(${conditions.join(", ")})` : conditions[0] || undefined;
  // Paginate through all matching records to avoid hard 500-row cap
  const all = [];
  let pageToken = '';
  do {
    const res = await btListRecords(TBL.creators, {
      filter,
      pageSize: 500,
      ...(pageToken ? { pageToken } : {}),
    });
    all.push(...res.items);
    pageToken = res.pageToken || '';
  } while (pageToken);
  return { items: all, total: all.length };
}

/**
 * Render template for a creator.
 * Returns { subject, body, bodyHtml, templateId, internalNotes, fromEmail, toEmail }.
 */
export async function renderTemplateForCreator({
  creator_handle, creator_record, step, variant, custom_vars, sender_override,
} = {}) {
  const creator = creator_record || await findCreator(creator_handle);
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);

  const tier = followerTier(creator.fields["followers"] || 0);
  const template = await getTemplate(step, tier, variant);
  if (!template)
    throw new Error(`No active template for step ${step} (tier=${tier}, variant=${variant || "default"})`);

  const assignedTo = fieldText(
    sender_override || creator.fields["Assigned To"] || cfg.default_sender_name || "biz"
  ).toLowerCase();

  const vars = buildVars(creator, creator_handle, assignedTo, custom_vars);
  const rendered = _renderTemplate(template, vars);
  const fromEmail = SENDER_MAP[assignedTo] || cfg.default_sender_email || "";
  const toEmail = fieldText(creator.fields["email"]);

  return { ...rendered, fromEmail, toEmail };
}

/**
 * Build outreach content for all channels.
 * Returns { emailTo, subject, body, bodyHtml, tkMsg, igHandle, igDmText, tkDmText }.
 */
export async function buildOutreach({ creator_handle, creator_record, step, variant, custom_vars } = {}) {
  const creator = creator_record || await findCreator(creator_handle);
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);

  const tier = followerTier(creator.fields["followers"] || 0);
  const template = await getTemplate(step, tier, variant);
  if (!template) throw new Error(`No active template for step ${step}`);

  const assignedTo = fieldText(
    creator.fields["Assigned To"] || cfg.default_sender_name || "biz"
  ).toLowerCase();
  const vars = buildVars(creator, creator_handle, assignedTo, custom_vars);
  const rendered = _renderTemplate(template, vars);
  const toEmail = fieldText(creator.fields["email"]);
  const igHandle = creator.fields["instagram"] || creator_handle;

  const brandName = cfg.your_brand || cfg.our_brand_name || "{{your_brand}}";
  const igDmText = toEmail
    ? `Hi ${vars.creator_name}! I'm ${vars.your_name} from ${brandName} — we just sent you an email about a collab. Also reaching out here in case you see this first! 💌`
    : `Hi ${vars.creator_name}! I'm ${vars.your_name} from ${brandName} 🐶 We love your content and would love to collaborate! We're a China-based shopping & shipping platform helping creators like you access trending fashion (sneakers, streetwear, designer-quality dupes, heels, ballet flats and more) directly from Taobao/1688/Weidian — interested in trying some pieces and sharing with your audience? DM me back! 💌`;

  const tkDmText = toEmail
    ? `Hi ${vars.creator_name}! I'm ${vars.your_name} from ${brandName} — just sent you an email + IG DM about a collab opportunity. Reaching out here too to make sure you see it! 💌`
    : `Hi ${vars.creator_name}! I'm ${vars.your_name} from ${brandName} 🐶 We love your content! We're a China-based shopping & shipping platform helping creators access trending fashion (sneakers, streetwear, designer-quality dupes, heels, ballet flats and more) directly from Chinese marketplaces — want to try some pieces and share with your audience? DM me back if interested! 💌`;

  return {
    emailTo: toEmail,
    subject: rendered.subject,
    body: rendered.body,
    bodyHtml: rendered.bodyHtml,
    tkMsg: tkDmText,
    igHandle,
    igDmText,
    tkDmText,
  };
}

/** Advance creator to next pipeline stage. */
export async function advancePipeline({ creator_handle, creator_record_id, candidate_id, to_stage, notes } = {}) {
  const creator = await findCreatorByIdentity({
    recordId: creator_record_id,
    candidateId: candidate_id,
    handle: creator_handle,
  });
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);

  const fromStage = fieldText(creator.fields["Pipeline Stage"]);
  const effectiveHandle = fieldText(creator.fields?.username) || creator_handle;
  const allowed = ALLOWED_TRANSITIONS[fromStage] || [];
  if (!allowed.includes(to_stage)) {
    throw new Error(
      `Transition from ${fromStage} to ${to_stage} not allowed (allowed: ${allowed.join(", ") || "none"})`
    );
  }

  const now = nowMs();
  const deadlineRules = DEADLINE_RULES[to_stage] || [];
  const nextDeadline = deadlineRules.length > 0 ? now + deadlineRules[0].days * 86400000 : null;

  await btUpdateRecord(TBL.creators, creator.record_id, {
    "Pipeline Stage": to_stage,
    "Stage Entered At": now,
    ...(nextDeadline ? { "Next Deadline Date": nextDeadline } : {}),
  });

  await btCreateRecord(TBL.pipeline_log, {
    "Creator Username": effectiveHandle,
    "From Stage": fromStage,
    "To Stage": to_stage,
    "Timestamp": now,
    "Transitioned By": fieldText(creator.fields["Assigned To"]) || "system",
    "Notes": notes || "",
  });

  // Cancel old pending deadlines
  const oldDeadlines = await btListRecords(TBL.deadlines, {
    filter: `AND(CurrentValue.[Creator Username] = "${filterValue(effectiveHandle)}", CurrentValue.[Status] = "pending")`,
  });
  for (const d of oldDeadlines.items) {
    await btUpdateRecord(TBL.deadlines, d.record_id, { "Status": "cancelled" });
  }

  // Create new deadlines
  for (const rule of deadlineRules) {
    await btCreateRecord(TBL.deadlines, {
      "Creator Username": effectiveHandle,
      "Stage": to_stage,
      "Deadline Type": rule.type,
      "Due At": now + rule.days * 86400000,
      "Status": "pending",
      "Escalation Count": 0,
      "Created At": now,
    });
  }

  return { success: true, fromStage, toStage: to_stage, nextDeadline };
}

/**
 * Repair the non-atomic artifacts of an already-applied stage transition.
 * This never advances a creator by itself; it only fills a missing transition
 * log/deadline set after the creator row has reached the expected target stage.
 */
export async function repairPipelineArtifacts({
  creator_handle,
  creator_record_id,
  candidate_id,
  expected_from_stage,
  to_stage,
  notes,
} = {}) {
  const creator = await findCreatorByIdentity({
    recordId: creator_record_id,
    candidateId: candidate_id,
    handle: creator_handle,
  });
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);
  const effectiveHandle = fieldText(creator.fields?.username) || creator_handle;
  const currentStage = fieldText(creator.fields?.["Pipeline Stage"]);
  if (currentStage !== to_stage) {
    throw new Error(`cannot repair transition artifacts at stage ${currentStage}; expected ${to_stage}`);
  }
  if (!expected_from_stage || !(ALLOWED_TRANSITIONS[expected_from_stage] || []).includes(to_stage)) {
    throw new Error(`invalid repair transition ${expected_from_stage || "?"} -> ${to_stage}`);
  }

  const logRows = await btListRecords(TBL.pipeline_log, {
    filter: `AND(CurrentValue.[Creator Username] = "${filterValue(effectiveHandle)}", CurrentValue.[From Stage] = "${filterValue(expected_from_stage)}", CurrentValue.[To Stage] = "${filterValue(to_stage)}")`,
    pageSize: 500,
  });
  const matchingLog = logRows.items.length > 0;
  if (!matchingLog) {
    const enteredAt = Number(creator.fields?.["Stage Entered At"]);
    await btCreateRecord(TBL.pipeline_log, {
      "Creator Username": effectiveHandle,
      "From Stage": expected_from_stage,
      "To Stage": to_stage,
      "Timestamp": Number.isFinite(enteredAt) && enteredAt > 0 ? enteredAt : nowMs(),
      "Transitioned By": fieldText(creator.fields?.["Assigned To"]) || "system",
      "Notes": notes || "",
    });
  }

  const deadlineRules = DEADLINE_RULES[to_stage] || [];
  const storedEnteredAt = Number(creator.fields?.["Stage Entered At"]);
  const anchorAt = Number.isFinite(storedEnteredAt) && storedEnteredAt > 0 ? storedEnteredAt : nowMs();
  const desired = new Map(deadlineRules.map(rule => [`${to_stage}:${rule.type}`, rule]));
  const kept = new Set();
  const pending = await btListRecords(TBL.deadlines, {
    filter: `AND(CurrentValue.[Creator Username] = "${filterValue(effectiveHandle)}", CurrentValue.[Status] = "pending")`,
    pageSize: 500,
  });
  for (const row of pending.items) {
    const key = `${fieldText(row.fields?.Stage)}:${fieldText(row.fields?.["Deadline Type"])}`;
    if (desired.has(key) && !kept.has(key)) {
      const expectedDueAt = anchorAt + desired.get(key).days * 86400000;
      const actualDueAt = Number(row.fields?.["Due At"]);
      if (!Number.isFinite(actualDueAt) || Math.abs(actualDueAt - expectedDueAt) > 1000) {
        await btUpdateRecord(TBL.deadlines, row.record_id, { "Due At": expectedDueAt });
      }
      kept.add(key);
      continue;
    }
    await btUpdateRecord(TBL.deadlines, row.record_id, { "Status": "cancelled" });
  }
  for (const [key, rule] of desired) {
    if (kept.has(key)) continue;
    await btCreateRecord(TBL.deadlines, {
      "Creator Username": effectiveHandle,
      "Stage": to_stage,
      "Deadline Type": rule.type,
      "Due At": anchorAt + rule.days * 86400000,
      "Status": "pending",
      "Escalation Count": 0,
      "Created At": nowMs(),
    });
  }

  if (deadlineRules.length) {
    const expectedNextDeadline = anchorAt + deadlineRules[0].days * 86400000;
    const currentNextDeadline = Number(creator.fields?.["Next Deadline Date"]);
    if (!Number.isFinite(currentNextDeadline) || Math.abs(currentNextDeadline - expectedNextDeadline) > 1000) {
      await btUpdateRecord(TBL.creators, creator.record_id, { "Next Deadline Date": expectedNextDeadline });
    }
  }
  return { success: true, repaired: true, fromStage: expected_from_stage, toStage: to_stage };
}

/** Log email sent/received to email_log table. */
export async function logEmailSent({
  handle, direction, templateId, subject, body, sender, messageId, status,
} = {}) {
  const fields = {
    "Creator Username": handle,
    "Direction": direction || "outbound",
    "Template ID": templateId || "",
    "Subject": subject || "",
    "Body Preview": (body || "").substring(0, 500),
    "Body Full": body || "",
    "From Email": sender || "",
    "Sent At": nowMs(),
    "Status": status || "sent",
  };
  if (messageId) fields["Message ID"] = messageId;
  return btCreateRecord(TBL.email_log, fields);
}

/** Return true when the CRM already contains a successful outbound template event. */
export async function hasLoggedOutreach(handle, templateId = "step01") {
  const filters = [
    `CurrentValue.[Creator Username] = "${filterValue(handle)}"`,
    `CurrentValue.[Direction] = "outbound"`,
    `CurrentValue.[Template ID] = "${filterValue(templateId)}"`,
    `CurrentValue.[Status] = "sent"`,
  ];
  const { items } = await btListRecords(TBL.email_log, {
    filter: `AND(${filters.join(", ")})`,
    pageSize: 1,
  });
  return items.length > 0;
}

/** Return true when this exact provider Message-ID is already in the CRM log. */
export async function hasLoggedMessage(messageId) {
  const value = String(messageId || "").trim();
  if (!value) return false;
  const { items } = await btListRecords(TBL.email_log, {
    filter: `CurrentValue.[Message ID] = "${filterValue(value)}"`,
    pageSize: 1,
  });
  return items.length > 0;
}

/** Log email open event. */
export async function logEmailOpen({
  creator_handle, opened_at, open_count, template_id, ip,
} = {}) {
  try {
    return await btCreateRecord(TBL.email_log, {
      "Creator Username": creator_handle,
      "Direction": "open_event",
      "Template ID": template_id || "",
      "Sent At": opened_at || nowMs(),
      "Status": `opened:${open_count}x${ip ? " ip=" + ip : ""}`,
    });
  } catch { /* silent fail */ }
}
