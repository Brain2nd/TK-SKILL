/**
 * kol_crm — KOL CRM core business logic (plain module, no MCP)
 */
import * as lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { execFileSync } from "child_process";
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
const client = new lark.Client({ appId: FEISHU_APP_ID, appSecret: FEISHU_APP_SECRET });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowMs() { return Date.now(); }
function daysFromNow(days) { return Date.now() + days * 86400000; }

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
  const res = await client.bitable.appTableRecord.list(params);
  if (res.code !== 0) throw new Error(`btListRecords failed (table=${tableId}): code=${res.code} ${res.msg}`);
  return {
    items: res.data?.items || [],
    hasMore: res.data?.has_more,
    pageToken: res.data?.page_token,
    total: res.data?.total,
  };
}

// Write ops use bot token (c3 base is app-accessible, no user token needed)
function larkCliWrite(method, path, data) {
  const out = execFileSync("lark-cli", ["api", method, path, "--as", "bot", "--data", JSON.stringify(data)], { encoding: "utf8" });
  const json = JSON.parse(out);
  if (json.code !== 0) throw new Error(`lark-cli ${method} ${path} failed: code=${json.code} ${json.msg}`);
  return json.data;
}

export async function btCreateRecord(tableId, fields) {
  await rateLimitWrite();
  const data = larkCliWrite("POST", `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records`, { fields });
  return data?.record;
}

export async function btUpdateRecord(tableId, recordId, fields) {
  await rateLimitWrite();
  const data = larkCliWrite("PUT", `/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${recordId}`, { fields });
  return data?.record;
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
  "01_FirstOutreach": [{ type: "response", days: 3 }],
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
  const { items } = await btListRecords(TBL.creators, {
    filter: `CurrentValue.[Creator Username] = "${handle}"`,
    pageSize: 1,
  });
  return items[0] || null;
}

// ============ Template engine ============
async function getTemplate(step, tier, variant) {
  let matches = _localTemplates.filter(t => t.step === step);
  if (!matches.length) return null;

  const tierMatch = matches.filter(t => t.tier === tier || t.tier === "all" || !t.tier);
  if (tierMatch.length) matches = tierMatch;

  if (variant) {
    const varMatch = matches.filter(t => t.variant === variant);
    if (varMatch.length) matches = varMatch;
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
    creator_name: creator.fields["username"] || creatorHandle,
    creator_tiktok: (() => {
      const stored = creator.fields["profile_url"];
      if (stored && typeof stored === "string" && stored.includes("tiktok.com/")) return stored;
      return `www.tiktok.com/@${creator.fields["username"] || creatorHandle}`;
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
export async function searchCreators({ stage, category, assigned_to, handle } = {}) {
  const conditions = [];
  if (stage) conditions.push(`CurrentValue.[Pipeline Stage] = "${stage}"`);
  if (category) conditions.push(`CurrentValue.[Category] = "${category}"`);
  if (assigned_to) conditions.push(`CurrentValue.[Assigned To] = "${assigned_to}"`);
  if (handle) conditions.push(`CurrentValue.[Creator Username].contains("${handle}")`);

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
  creator_handle, step, variant, custom_vars, sender_override,
} = {}) {
  const creator = await findCreator(creator_handle);
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);

  const tier = followerTier(creator.fields["followers"] || 0);
  const template = await getTemplate(step, tier, variant);
  if (!template)
    throw new Error(`No active template for step ${step} (tier=${tier}, variant=${variant || "default"})`);

  const assignedTo = (
    sender_override || creator.fields["Assigned To"] || cfg.default_sender_name || "biz"
  ).toLowerCase();

  const vars = buildVars(creator, creator_handle, assignedTo, custom_vars);
  const rendered = _renderTemplate(template, vars);
  const fromEmail = SENDER_MAP[assignedTo] || cfg.default_sender_email || "";
  const toEmail = creator.fields["email"] || "";

  return { ...rendered, fromEmail, toEmail };
}

/**
 * Build outreach content for all channels.
 * Returns { emailTo, subject, body, bodyHtml, tkMsg, igHandle, igDmText, tkDmText }.
 */
export async function buildOutreach({ creator_handle, step, variant, custom_vars } = {}) {
  const creator = await findCreator(creator_handle);
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);

  const tier = followerTier(creator.fields["followers"] || 0);
  const template = await getTemplate(step, tier, variant);
  if (!template) throw new Error(`No active template for step ${step}`);

  const assignedTo = (creator.fields["Assigned To"] || cfg.default_sender_name || "biz").toLowerCase();
  const vars = buildVars(creator, creator_handle, assignedTo, custom_vars);
  const rendered = _renderTemplate(template, vars);
  const toEmail = creator.fields["email"] || "";
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
export async function advancePipeline({ creator_handle, to_stage, notes } = {}) {
  const creator = await findCreator(creator_handle);
  if (!creator) throw new Error(`Creator @${creator_handle} not found`);

  const fromStage = creator.fields["Pipeline Stage"];
  const allowed = ALLOWED_TRANSITIONS[fromStage] || [];
  if (!allowed.includes(to_stage)) {
    throw new Error(
      `Transition from ${fromStage} to ${to_stage} not allowed (allowed: ${allowed.join(", ") || "none"})`
    );
  }

  const now = nowMs();
  const deadlineRules = DEADLINE_RULES[to_stage] || [];
  const nextDeadline = deadlineRules.length > 0 ? daysFromNow(deadlineRules[0].days) : null;

  await btUpdateRecord(TBL.creators, creator.record_id, {
    "Pipeline Stage": to_stage,
    "Stage Entered At": now,
    ...(nextDeadline ? { "Next Deadline Date": nextDeadline } : {}),
  });

  await btCreateRecord(TBL.pipeline_log, {
    "Creator Username": creator_handle,
    "From Stage": fromStage,
    "To Stage": to_stage,
    "Timestamp": now,
    "Transitioned By": creator.fields["Assigned To"] || "system",
    "Notes": notes || "",
  });

  // Cancel old pending deadlines
  const oldDeadlines = await btListRecords(TBL.deadlines, {
    filter: `AND(CurrentValue.[Creator Username] = "${creator_handle}", CurrentValue.[Status] = "pending")`,
  });
  for (const d of oldDeadlines.items) {
    await btUpdateRecord(TBL.deadlines, d.record_id, { "Status": "cancelled" });
  }

  // Create new deadlines
  for (const rule of deadlineRules) {
    await btCreateRecord(TBL.deadlines, {
      "Creator Username": creator_handle,
      "Stage": to_stage,
      "Deadline Type": rule.type,
      "Due At": daysFromNow(rule.days),
      "Status": "pending",
      "Escalation Count": 0,
      "Created At": now,
    });
  }

  return { success: true, fromStage, toStage: to_stage, nextDeadline };
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
