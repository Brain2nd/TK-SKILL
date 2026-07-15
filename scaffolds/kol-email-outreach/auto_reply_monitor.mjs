/**
 * 自动回复监控 — cron每2小时运行
 * 1. 从CRM取活跃达人列表
 * 2. 扫描发件邮箱的回复（biz）
 * 3. 用CDP检查TikTok私信回复
 * 4. 有回复的自动推进管道
 * 全自动，无需人工干预
 */
import { sendThreaded } from "./lib/email_thread_builder.mjs";
import { ACCOUNTS as SENDER_ACCOUNTS } from "./sender_pool.mjs";

import cfg from "./lib/config.mjs";
import { renderTemplateForCreator, advancePipeline, logEmailOpen, btListRecords, btUpdateRecord } from "./lib/kol_crm.mjs";
import { listEmails, getEmail } from "./lib/imap_email.mjs";
import { sendDM, checkReplies } from "./lib/tiktok_dm.mjs";

const CRM_ENV = {
  FEISHU_APP_ID: cfg.feishu_app_id,
  FEISHU_APP_SECRET: cfg.feishu_app_secret,
  KOL_CRM_APP_TOKEN: cfg.kol_crm_app_token,
  KOL_TBL_CREATORS: cfg.kol_tbl_creators,
  KOL_TBL_PIPELINE_LOG: cfg.kol_tbl_pipeline_log,
  KOL_TBL_EMAIL_LOG: cfg.kol_tbl_email_log,
  KOL_TBL_TEMPLATES: cfg.kol_tbl_templates,
  KOL_TBL_DEADLINES: cfg.kol_tbl_deadlines,
  KOL_TBL_SUMMARY: cfg.kol_tbl_summary,
  KOL_TBL_MANUAL_EVENTS: cfg.kol_tbl_manual_events || "",
};

const ANTHROPIC_API_KEY = cfg.anthropic_api_key || "";
let _tenantTok = null, _tenantTokExp = 0;
async function tenantToken() {
  if (_tenantTok && Date.now() < _tenantTokExp - 60000) return _tenantTok;
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: CRM_ENV.FEISHU_APP_ID, app_secret: CRM_ENV.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  _tenantTok = r?.tenant_access_token;
  _tenantTokExp = Date.now() + (r?.expire || 7200) * 1000;
  return _tenantTok;
}

// Classify reply intent using Claude → map to target stage
/**
 * Classify a reply and decide what actions to take.
 * @param {object} opts
 * @param {string} opts.currentStage
 * @param {string} opts.handle
 * @param {string} opts.subject
 * @param {string} opts.body
 * @param {string} opts.senderEmail  - "tiktok_dm" for TikTok DMs
 * @param {boolean} opts.hasEmail    - whether we already have the creator's email in CRM
 * @returns {Promise<{target, confidence, reasoning, actions: Array<{type, message?}>}>}
 *   action types: "reply_dm" (send DM with message), "advance_stage", "save_email"
 */
async function classifyReply({ currentStage, handle, subject, body, senderEmail, hasEmail = true }) {
  const snippet = (body || "").replace(/\s+/g, " ").trim().substring(0, 1500);
  const channel = senderEmail === "tiktok_dm" ? "tiktok_dm" : "email";
  const brandName = cfg.our_brand_name || cfg.your_brand || "brand";

  if (!ANTHROPIC_API_KEY) {
    return { target: currentStage, confidence: 0, reasoning: "no ANTHROPIC_API_KEY", actions: [] };
  }

  const dmEmailContext = channel === "tiktok_dm" && !hasEmail ? `
IMPORTANT: This creator replied via TikTok DM and we do NOT have their contact info yet.
Priority when replying (in this order):
1. Ask for Discord or WhatsApp — these are the preferred communication channels for collaboration discussions.
2. If they don't have Discord/WhatsApp, fall back to asking for their email.
3. Do NOT advance stage until we have at least one contact method (Discord / WhatsApp / email).
- If they show any interest (not explicit rejection): reply asking for Discord or WhatsApp. Keep target at 01_FirstOutreach until we get contact info.
- If they provide Discord or WhatsApp in the message: output "save_contact" with the info, then advance if appropriate.
- If they explicitly decline: XX_Dropped, no reply needed.
` : channel === "tiktok_dm" && hasEmail ? `
NOTE: This creator replied via TikTok DM and we already have their email. Treat interest same as email channel — advance stage normally. Still ask in DM if they have Discord or WhatsApp for faster communication.
` : "";

  const prompt = `You manage a KOL outreach pipeline for ${brandName}.

Pipeline stages:
  01_FirstOutreach  — cold outreach sent, waiting for any response
  02_CollabOffer    — creator showed interest; we sent collab terms (price, deliverables, affiliate link)
  03_Agreed         — creator explicitly accepted our offer after seeing terms
  04_ContractSigned — contract signed
  05_TeaserDraftDue — teaser draft submitted
  06_PackageShipped — package shipped
  07_PackageDelivered — package arrived
  08_TryOnVideo     — try-on video published
  09_Completed      — deal fulfilled
  XX_Dropped        — creator declined or dropped
${dmEmailContext}
Creator @${handle} is currently at ${currentStage}.
Channel: ${channel}${channel === "email" ? ` | from: ${senderEmail} | subject: "${subject}"` : ""}
${hasEmail ? "" : "(no email on file)"}

Their reply:
---
${snippet}
---

Evidence patterns for stage:
  01_FirstOutreach — ONLY for non-human signals: autoresponder, OOO, bounce, system notification ("Message request accepted", "You can start chatting", delivery receipts). Any real human typing = NOT 01. System notifications → no reply_dm action.
  02_CollabOffer   — DEFAULT for any real human reply that is not explicit rejection, UNLESS this is a TikTok DM with no email (see above).
  03_Agreed        — explicitly accepts terms AFTER seeing our offer (must have been at 02 already).
  04+              — creator confirms specific deliverable milestone.
  XX_Dropped       — ONLY explicit rejection or hostile message.

Output strict JSON, no prose:
{
  "target": "<stage or XX_Dropped>",
  "confidence": 0.0-1.0,
  "reasoning": "<one sentence>",
  "actions": [
    // Include ONLY applicable actions. Possible types:
    // {"type":"reply_dm","message":"<DM text, friendly, in English, ≤300 chars, ask for Discord or WhatsApp FIRST, then email as fallback>"}
    // {"type":"save_contact","contact_type":"discord"|"whatsapp"|"email","value":"<contact value>"}
    // {"type":"advance_stage"}   — omit if target === currentStage
    // {"type":"save_email","email":"<extracted email>"}  — only if email found in reply text
  ]
}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    let text = data?.content?.[0]?.text || "";
    if (text.startsWith("```")) { text = text.split("```")[1]; if (text.startsWith("json")) text = text.slice(4); text = text.trim(); }
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { target: currentStage, confidence: 0, reasoning: "parse fail", actions: [] };
    if (parsed.target === "keep") parsed.target = currentStage;
    if (!Array.isArray(parsed.actions)) parsed.actions = [];
    return parsed;
  } catch (e) {
    return { target: currentStage, confidence: 0, reasoning: `classifier err: ${e.message?.substring(0, 60)}`, actions: [] };
  }
}

// stage→{step,variant,tmplId} mapping: when advancing to a stage, auto-send this template
const STAGE_TEMPLATES = {
  "02_CollabOffer": { step: 2, tmplId: "step02" },
  "03_Agreed": { step: 3, variant: "A", tmplId: "step03a" },
  "04_ContractSigned": { step: 4, tmplId: "step04" },
  "05_TeaserDraftDue": { step: 5, tmplId: "step05_followup" },
  "06_PackageShipped": { step: 6, tmplId: "step06_shipped" },
  "07_PackageDelivered": { step: 7, tmplId: "step07_unbox_brief" },
  "08_TryOnVideo": { step: 8, tmplId: "step08_tryon_brief" },
};

/** Advance to toStage then immediately send the corresponding template email (threaded). */
async function sendStageFollowup({ handle, toStage, senderName, creatorEmail }) {
  const tmpl = STAGE_TEMPLATES[toStage];
  if (!tmpl) return null;
  if (!creatorEmail) return { ok: false, error: "no creator email" };
  if (!senderName) return { ok: false, error: "no sender (Outreach Sender field empty)" };

  // 1. Render template via direct function call
  let subject, body;
  try {
    const rendered = await renderTemplateForCreator({
      creator_handle: handle, step: tmpl.step, variant: tmpl.variant,
      sender_override: senderName,
    });
    subject = rendered.subject;
    body = rendered.body;
  } catch (e) { return { ok: false, error: `render: ${e.message}` }; }

  // 2. Find sender SMTP config
  const acct = SENDER_ACCOUNTS.find(a => a.name === senderName.toLowerCase());
  if (!acct) return { ok: false, error: `sender ${senderName} not in pool` };
  const smtp = {
    host: acct.env.SMTP_HOST, port: parseInt(acct.env.SMTP_PORT, 10),
    secure: acct.env.SMTP_PORT === "465",
    auth: { user: acct.env.IMAP_USER, pass: acct.env.IMAP_PASSWORD },
  };

  // 3. sendThreaded (auto-adds In-Reply-To + References + Re: prefix + quote block)
  const sendRes = await sendThreaded({
    creatorHandle: handle, env: CRM_ENV, smtp,
    to: creatorEmail, subject, body,
  });
  if (!sendRes.ok) return sendRes;

  // 4. Write email_log (with Message ID + Body Full)
  try {
    const tok = await tenantToken();
    const logRes = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_EMAIL_LOG}/records`,
      {
        method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
          "Creator Username": handle, "Direction": "outbound", "Template ID": tmpl.tmplId,
          "Subject": sendRes.subject || subject,
          "Body Preview": body.substring(0, 500), "Body Full": body,
          "From Email": senderName.toLowerCase(),
          "Sent At": Date.now(),
          "Message ID": sendRes.messageId, "Status": "sent",
        }}),
      }
    ).then(r => r.json());
    if (logRes?.code !== 0) console.error(`      email_log write failed: ${logRes?.code} ${logRes?.msg}`);
  } catch (e) { console.error(`      email_log write exception: ${e.message}`); }

  return sendRes;
}

async function setCreatorStage(handle, newStage) {
  const tok = await tenantToken();
  const srch = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/search?page_size=1`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "username", operator: "is", value: [handle] }] } }),
    }
  ).then(r => r.json());
  const rec = srch?.data?.items?.[0];
  if (!rec) return false;
  const upd = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/${rec.record_id}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Pipeline Stage": newStage, "Stage Entered At": Date.now() } }),
    }
  ).then(r => r.json());
  return upd?.code === 0;
}

async function logPipelineEvent(handle, fromStage, toStage, notes) {
  try {
    const tok = await tenantToken();
    await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_PIPELINE_LOG}/records`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: {
          "Creator Username": handle,
          "From Stage": fromStage,
          "To Stage": toStage,
          "Transitioned At": Date.now(),
          "Notes": (notes || "").substring(0, 500),
        }}),
      }
    );
  } catch {}
}

async function writeInboundLog({ handle, subject, body, account, uid, sentAtMs, senderEmail, realMessageId }) {
  try {
    const tok = await tenantToken();
    const messageId = realMessageId && realMessageId.trim()
      ? (realMessageId.startsWith("<") ? realMessageId : `<${realMessageId}>`)
      : `<inbound:${account}/${uid}@${cfg.brand_domain || "brand.com"}>`;
    const fields = {
      "Creator Username": handle,
      "Direction": "inbound",
      "Subject": subject || "",
      "Body Preview": (body || "").substring(0, 500),
      "Body Full": body || "",
      "From Email": senderEmail || account || "",
      "Sent At": sentAtMs || Date.now(),
      "Message ID": messageId,
      "Status": "received",
      "Reply Detected At": Date.now(),
    };
    const r = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_EMAIL_LOG}/records`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      }
    ).then(r => r.json());
    return r?.code === 0;
  } catch (e) {
    console.error(`  inbound email_log 写入失败: ${e.message}`);
    return false;
  }
}

const ALLOWED_NEXT = {
  "01_FirstOutreach": "02_CollabOffer",
  "02_CollabOffer": "03_Agreed",
  "03_Agreed": "04_ContractSigned",
  "04_ContractSigned": "05_TeaserDraftDue",
  "05_TeaserDraftDue": "06_PackageShipped",
  "06_PackageShipped": "07_PackageDelivered",
  "07_PackageDelivered": "08_TryOnVideo",
  "08_TryOnVideo": "09_Completed",
};

const STAGE_ORDER = [
  "00_Discovered", "01_FirstOutreach", "02_CollabOffer", "03_Agreed", "04_ContractSigned",
  "05_TeaserDraftDue", "06_PackageShipped", "07_PackageDelivered", "08_TryOnVideo", "09_Completed",
];
const MAX_AUTO_STAGE = cfg.auto_pipeline_max_stage || "09_Completed";
const MAX_AUTO_IDX = STAGE_ORDER.indexOf(MAX_AUTO_STAGE);
function shouldHoldAdvance(currentStage, targetStage) {
  if (targetStage === "XX_Dropped") return false;
  const ci = STAGE_ORDER.indexOf(currentStage);
  const ti = STAGE_ORDER.indexOf(targetStage);
  if (ti < 0) return false;
  if (ti <= ci) return false;
  return ti > MAX_AUTO_IDX;
}

const ts = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

async function main() {
  console.error(`[${ts()}] === 自动回复监控启动 ===`);
  if (MAX_AUTO_STAGE !== "09_Completed") {
    console.error(`[${ts()}] 🛑 自动流程上限：${MAX_AUTO_STAGE}`);
  }

  const summary = {
    manualSync: null,
    detector: null,
    capDropped: [],
    deadlineDropped: [],
    deadlineAlerts: [],
    dmAdvanced: [],
    held: [],
  };

  // Step 0a: Apply manual_events (QC pass / package delivered)
  try {
    const { applyPending } = await import("./lib/manual_events_sync.mjs");
    const r = await applyPending(CRM_ENV);
    console.error(`[${ts()}] manual_events 同步: processed=${r.processed} applied=${r.applied} skipped=${r.skipped}`);
    if (r.errors?.length) for (const e of r.errors.slice(0, 3)) console.error(`  err: ${e}`);
    summary.manualSync = r;
  } catch (e) {
    console.error(`[${ts()}] manual_events 同步失败: ${e.message}`);
  }

  // Step 0b: Auto-detect video live + affiliate link
  try {
    const { detectBatch } = await import("./lib/auto_status_detector.mjs");
    const tok = await tenantToken();
    const all = [];
    let pt = "";
    do {
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records?page_size=500${pt ? "&page_token=" + pt : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
      for (const it of r.data?.items || []) all.push(it);
      pt = r.data?.page_token || "";
    } while (pt);
    const detEnv = { ...CRM_ENV, TIKHUB_API_KEY: cfg.tikhub_api_key };
    const r = await detectBatch(all, detEnv);
    console.error(`[${ts()}] auto-detect (视频上线/affiliate link): scanned=${r.scanned} updated=${r.updated} errors=${r.errors.length}`);
    for (const e of r.errors.slice(0, 3)) console.error(`  err: ${e}`);
    summary.detector = { scanned: r.scanned, updated: r.updated };
  } catch (e) {
    console.error(`[${ts()}] auto_status_detector 失败: ${e.message}`);
  }

  // Step 1: Get active creators via direct Bitable query
  const creators = [];
  const stageMap = {};
  const emailToHandle = {};
  const notesMap = {};
  const ACTIVE_STAGES = new Set(["01_FirstOutreach", "02_CollabOffer", "03_Agreed", "04_ContractSigned", "05_TeaserDraftDue", "06_PackageShipped", "07_PackageDelivered", "08_TryOnVideo", "09_Completed"]);
  try {
    const tokRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: CRM_ENV.FEISHU_APP_ID, app_secret: CRM_ENV.FEISHU_APP_SECRET }),
    }).then(r => r.json());
    const tok = tokRes?.tenant_access_token;
    if (!tok) throw new Error(`tenant_access_token fail code=${tokRes?.code} msg=${tokRes?.msg}`);

    const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records`;
    const fieldNames = encodeURIComponent(JSON.stringify(["username", "email", "Pipeline Stage", "Internal Notes", "tiktok_nickname"]));
    let pt = "";
    do {
      const url = `${base}?page_size=500&field_names=${fieldNames}${pt ? `&page_token=${pt}` : ""}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
      if (res?.code !== 0) throw new Error(`list records code=${res?.code} msg=${res?.msg}`);
      for (const it of res.data?.items || []) {
        const f = it.fields || {};
        let h = f["username"];
        if (Array.isArray(h)) h = h.map(x => x.text || x).join("");
        const stage = f["Pipeline Stage"];
        let email = f["email"];
        if (typeof email !== "string") email = "";
        if (!h || typeof h !== "string" || h.length < 3 || h === "undefined") continue;
        if (!ACTIVE_STAGES.has(stage)) continue;
        const nickname = typeof f["tiktok_nickname"] === "string" ? f["tiktok_nickname"].trim() : "";
        creators.push({ handle: h, stage, record_id: it.record_id, nickname });
        stageMap[h.toLowerCase()] = stage;
        let notesParsed = {};
        try { notesParsed = JSON.parse(f["Internal Notes"] || "{}"); } catch {}
        notesMap[h.toLowerCase()] = { record_id: it.record_id, notes: notesParsed };
        if (email && email.includes("@") && !email.includes(cfg.brand_domain || "brand.com")) {
          emailToHandle[email.toLowerCase().trim()] = h;
        }
      }
      pt = res.data?.page_token || "";
    } while (pt);
  } catch (e) {
    console.error(`[${ts()}] Bitable active-creators fetch failed: ${e.message}`);
    return;
  }

  if (!creators.length) { console.error(`[${ts()}] 无活跃达人`); return; }
  console.error(`[${ts()}] 监控 ${creators.length} 个达人, ${Object.keys(emailToHandle).length} 个邮箱映射`);

  const advancedHandles = new Set();

  // Step 2: Check email replies across all inbound accounts
  console.error(`[${ts()}] 扫描邮箱回复...`);
  const yesterday = new Date(Date.now() - 7 * 86400 * 1000).toISOString().split("T")[0];

  for (const account of SENDER_ACCOUNTS) {
    try {
      const emailList = await listEmails(account.env, { folder: "INBOX", sinceDate: yesterday, limit: 50 });

      for (const email of emailList) {
        const from = (email.from || "").toLowerCase();
        const subject = (email.subject || "").toLowerCase();
        if (!subject.startsWith("re:")) continue;

        const senderEmail = from.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
        if (!senderEmail) continue;
        const handle = emailToHandle[senderEmail];
        if (!handle || advancedHandles.has(handle)) continue;

        // Dedup by UID per inbox
        const nEntry = notesMap[handle.toLowerCase()] || { record_id: null, notes: {} };
        const processedMap = nEntry.notes.processed_reply_uids || {};
        const lastUid = processedMap[account.name] || 0;
        if (email.uid && email.uid <= lastUid) continue;
        advancedHandles.add(handle);

        const currentStage = stageMap[handle.toLowerCase()] || "01_FirstOutreach";

        // get_email with RFC 5322 headers
        let body = "", realMid = "";
        if (email.uid) {
          try {
            const gj = await getEmail(account.env, { uid: email.uid, folder: "INBOX" });
            if (gj) {
              body = gj.text || "";
              realMid = gj.messageId || "";
            }
          } catch {}
        }
        body = body.split("\n").filter(l => !l.trim().startsWith(">")).join("\n").trim();
        body = body.split(/^On .{1,80}wrote:$/m)[0].trim();

        const sentAtMs = email.date ? new Date(email.date).getTime() : Date.now();
        await writeInboundLog({
          handle, subject: email.subject || subject, body,
          account: account.name, uid: email.uid,
          sentAtMs, senderEmail, realMessageId: realMid,
        });

        const decision = await classifyReply({ currentStage, handle, subject, body, senderEmail, hasEmail: true });
        console.error(`  📧 @${handle}: reply via ${account.name} subj="${subject.substring(0, 60)}" → ${decision.target} (conf=${decision.confidence?.toFixed(2)}) — ${decision.reasoning?.substring(0, 100)}`);

        const markProcessed = async () => {
          if (!email.uid || !nEntry.record_id) return;
          nEntry.notes.processed_reply_uids = { ...(nEntry.notes.processed_reply_uids || {}), [account.name]: email.uid };
          try {
            const tok = await tenantToken();
            await fetch(
              `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/${nEntry.record_id}`,
              {
                method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
                body: JSON.stringify({ fields: { "Internal Notes": JSON.stringify(nEntry.notes) } }),
              }
            );
          } catch {}
        };

        if (!decision.target || decision.target === currentStage || decision.target === "keep") {
          await logPipelineEvent(handle, currentStage, currentStage, `Email reply [classifier:keep] ${senderEmail} uid=${email.uid}: ${decision.reasoning}`);
          await markProcessed();
          continue;
        }

        if (shouldHoldAdvance(currentStage, decision.target)) {
          console.error(`    ${handle}: ${currentStage} → ${decision.target} 🛑 HOLD (max=${MAX_AUTO_STAGE})`);
          await logPipelineEvent(handle, currentStage, currentStage, `[HOLD by AUTO_PIPELINE_MAX_STAGE=${MAX_AUTO_STAGE}] would advance to ${decision.target} from email reply ${senderEmail} uid=${email.uid}: ${decision.reasoning}`);
          summary.held.push({ handle, fromStage: currentStage, wantedStage: decision.target, source: "email", reasoning: decision.reasoning });
          console.log(`🛑 阶段推进被 hold [${ts()}]\n@${handle} 应推进 ${currentStage} → ${decision.target}（信心 ${decision.confidence?.toFixed(2)}），但自动流程上限 = ${MAX_AUTO_STAGE}\n理由：${decision.reasoning}\n回信片段：${(body || "").substring(0, 100).replace(/\s+/g, " ")}\n→ 等你手动在 Bitable 改 Pipeline Stage 或开 AUTO_PIPELINE_MAX_STAGE 释放`);
          await markProcessed();
          continue;
        }

        const upOk = await setCreatorStage(handle, decision.target);
        if (upOk) {
          await logPipelineEvent(handle, currentStage, decision.target, `Email reply [classifier:${decision.confidence?.toFixed(2)}] ${senderEmail} uid=${email.uid}: ${decision.reasoning}`);
          console.error(`    ${handle}: ${currentStage} → ${decision.target} ✅`);
          let followupTag = "";
          if (STAGE_TEMPLATES[decision.target]) {
            const fr = await sendStageFollowup({
              handle, toStage: decision.target,
              senderName: account.name,
              creatorEmail: senderEmail,
            });
            if (fr) {
              const tag = `${STAGE_TEMPLATES[decision.target].tmplId}`;
              if (fr.ok) {
                console.error(`      → ${tag} ✅ chain=${fr.chainLength} reply=${fr.isReply} mid=${(fr.messageId || "").substring(0, 40)}`);
                followupTag = `\n后续模板 ${tag} 已自动发出 (thread chain=${fr.chainLength})`;
              } else {
                console.error(`      → ${tag} ❌ ${fr.error}`);
                followupTag = `\n⚠️ 后续模板 ${tag} 发送失败: ${fr.error}`;
              }
            }
          }
          console.log(`✉️ 达人回信触发阶段推进 [${ts()}]\n@${handle}\n${currentStage} → ${decision.target} (信心 ${decision.confidence?.toFixed(2)})\n理由：${decision.reasoning}\n回信片段：${(body || "").substring(0, 100).replace(/\s+/g, " ")}` + followupTag);
          await markProcessed();
        } else {
          console.error(`    ${handle}: update FAIL`);
        }
      }
    } catch (e) {
      console.error(`  ${account.user || account.name} scan failed: ${e.message}`);
    }
  }

  // Step 2.5: Check email OPEN tracking
  console.error(`[${ts()}] 扫描邮件已读追踪...`);
  const openedHandles = new Set();
  try {
    const resp = await fetch(`${cfg.email_track_base}/track/list`, { signal: AbortSignal.timeout(10000) });
    const lines = (await resp.text()).trim().split("\n").filter(Boolean);
    const since = Date.now() / 1000 - 7 * 86400;

    const handleOpens = {};
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.ts < since) continue;
        const creator = (e.creator || "").toLowerCase();
        if (!creator) continue;
        if (!handleOpens[creator]) handleOpens[creator] = [];
        handleOpens[creator].push(e);
      } catch {}
    }

    for (const c of creators) {
      const handleLower = c.handle.toLowerCase();
      const opens = handleOpens[handleLower] || [];
      if (opens.length > 0) {
        openedHandles.add(handleLower);
        const latestOpen = opens[opens.length - 1];
        console.error(`  📬 @${c.handle}: opened ${opens.length}x, latest ${latestOpen.iso} (IP:${latestOpen.ip})`);
        try {
          await logEmailOpen({
            creator_handle: c.handle,
            opened_at: latestOpen.ts * 1000,
            open_count: opens.length,
            template_id: latestOpen.template || "",
            ip: latestOpen.ip || "",
          });
        } catch {}
      }
    }
    console.error(`[${ts()}] 已读统计: ${openedHandles.size}/${creators.length} 打开过邮件`);

    if (MAX_AUTO_STAGE !== "09_Completed") {
      console.error(`[${ts()}] 🛑 AUTO_PIPELINE_MAX_STAGE=${MAX_AUTO_STAGE}，整个 followup 段 skip`);
    } else {
      // Identify "opened but not replied for 3+ days SINCE WE SENT" → auto-send step01_followup
      const followupNeeded = [];
      for (const handle of openedHandles) {
        if (advancedHandles.has(handle)) continue;
        const evs = handleOpens[handle];
        const latestSendMs = evs
          .map(e => parseInt(e.email_ts || "0", 10))
          .filter(v => v > 1e10)
          .reduce((a, b) => b > a ? b : a, 0);
        if (!latestSendMs) continue;
        const daysSinceSend = (Date.now() - latestSendMs) / 86400000;
        if (daysSinceSend >= 3) followupNeeded.push({ handle, daysSinceSend: daysSinceSend.toFixed(1), latestSendMs });
      }
      console.error(`[${ts()}] 已读但自发信起>3天未回候选: ${followupNeeded.length}`);

      for (const f of followupNeeded) {
        const origHandle = creators.find(c => c.handle.toLowerCase() === f.handle)?.handle || f.handle;
        try {
          const tok = await tenantToken();
          const srch = await fetch(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/search?page_size=1`,
            {
              method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
              body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "username", operator: "is", value: [origHandle] }] }, field_names: ["Internal Notes", "Pipeline Stage", "email", "username", "followers"] }),
            }
          ).then(r => r.json());
          const rec = srch?.data?.items?.[0];
          if (!rec) { console.error(`    @${origHandle} skip: record not found`); continue; }
          if (rec.fields?.["Pipeline Stage"] !== "01_FirstOutreach") continue;
          const hasEmail = rec.fields?.["email"] && String(rec.fields["email"]).trim();
          let notesJson = {};
          try { notesJson = JSON.parse(rec.fields?.["Internal Notes"] || "{}"); } catch {}
          const lastTs = notesJson.last_followup_ts || 0;
          const count = notesJson.followup_count || 0;
          if (count >= 2) { console.error(`    @${origHandle} skip: followup cap (${count}/2) reached`); continue; }
          if (Date.now() - lastTs < 4 * 86400 * 1000) { const h = Math.round((Date.now() - lastTs) / 3600000); console.error(`    @${origHandle} skip: last followup ${h}h ago (<96h cooldown)`); continue; }

          // Import sender pool functions lazily to avoid circular issues
          const { pickSender: poolPick, incrementSend: poolInc } = await import("./sender_pool.mjs");
          const picked = poolPick();
          if (!picked) { console.error(`    @${origHandle} skip: pool exhausted`); continue; }
          const senderCap = picked.name.charAt(0).toUpperCase() + picked.name.slice(1);

          // Write count+1 before sending (prevents infinite retry on failure)
          const newNotes = JSON.stringify({ ...notesJson, last_followup_ts: Date.now(), followup_count: count + 1, last_followup_attempt_via: picked.name });
          await fetch(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/${rec.record_id}`,
            {
              method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
              body: JSON.stringify({ fields: { "Internal Notes": newNotes } }),
            }
          );

          // Render step01 followup template
          let subject = "", emailBody = "";
          try {
            const rendered = await renderTemplateForCreator({
              creator_handle: origHandle, step: 1, variant: "followup",
              sender_override: picked.name,
            });
            subject = rendered.subject;
            emailBody = rendered.body;
          } catch (e) {
            console.error(`    @${origHandle} render fail: ${e.message?.substring(0, 80)}`);
            continue;
          }
          if (!subject || !emailBody) { console.error(`    @${origHandle} skip: render empty`); continue; }
          const emailTo = String(rec.fields["email"] || "").trim();

          let emailSent = false, messageId = null, sendError = null;
          if (hasEmail && emailTo) {
            const smtp = {
              host: picked.env.SMTP_HOST, port: parseInt(picked.env.SMTP_PORT, 10),
              secure: picked.env.SMTP_PORT === "465",
              auth: { user: picked.env.IMAP_USER, pass: picked.env.IMAP_PASSWORD },
            };
            try {
              const sr = await sendThreaded({ creatorHandle: origHandle, env: CRM_ENV, smtp, to: emailTo, subject, body: emailBody });
              if (sr.ok) {
                emailSent = true;
                messageId = sr.messageId;
                poolInc(picked.name);
                try {
                  await fetch(
                    `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/${rec.record_id}`,
                    {
                      method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ fields: { "Assigned To": picked.name, "Last Contact Date": Date.now() } }),
                    }
                  );
                } catch {}
                try {
                  await fetch(
                    `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_EMAIL_LOG}/records`,
                    {
                      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
                      body: JSON.stringify({ fields: {
                        "Creator Username": origHandle, "Direction": "outbound", "Template ID": "step01_followup",
                        "Subject": sr.subject || subject,
                        "Body Preview": emailBody.substring(0, 500), "Body Full": emailBody,
                        "From Email": picked.name,
                        "Sent At": Date.now(),
                        "Message ID": messageId, "Status": "sent",
                      }}),
                    }
                  );
                } catch {}
              } else {
                sendError = sr.error || "unknown";
              }
            } catch (e) { sendError = e.message?.substring(0, 120); }
          }

          // TikTok DM nudge
          let tkSent = false;
          try {
            const tkText = `Hey ${rec.fields["username"] || origHandle}! 👋 Quick follow-up — I sent you an email about a collab opportunity. Also, for faster replies, feel free to ping me on Discord or WhatsApp! 💌`;
            const dr = await sendDM({ username: origHandle, message: tkText });
            tkSent = dr.success || false;
          } catch {}

          await logPipelineEvent(origHandle, "01_FirstOutreach", "01_FirstOutreach", `Auto followup ${count + 1}/2 after ${f.daysSinceSend}d send-no-reply — email:${emailSent ? "Y" : "N"}(via ${picked.name}${sendError ? " err=" + sendError : ""}) tk:${tkSent ? "Y" : "N"}`);
          console.error(`    @${origHandle} ${emailSent ? "✅" : "❌"} followup ${count + 1}/2 via ${picked.name} (email=${emailSent}${sendError ? " " + sendError : ""} tk=${tkSent}, sent ${f.daysSinceSend}d ago)`);
        } catch (e) {
          console.error(`    @${origHandle} followup err: ${e.message?.substring(0, 120)}`);
        }
      }
    }

    // Step 2.6: Drop creators at 01_FirstOutreach with exhausted followup cap + 14 days silence
    console.error(`[${ts()}] 扫描 followup cap 耗尽达人...`);
    const CAP_MAX = 2, DROP_AFTER_DAYS = 14;
    let dropCount = 0;
    for (const c of creators) {
      if (c.stage !== "01_FirstOutreach") continue;
      if (advancedHandles.has(c.handle.toLowerCase())) continue;
      try {
        const tok = await tenantToken();
        const s = await fetch(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records/search?page_size=1`,
          {
            method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
            body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "username", operator: "is", value: [c.handle] }] } }),
          }
        ).then(r => r.json());
        const rec = s?.data?.items?.[0];
        if (!rec) continue;
        let notes = {};
        try { notes = JSON.parse(rec.fields?.["Internal Notes"] || "{}"); } catch {}
        const count = notes.followup_count || 0;
        const lastTs = notes.last_followup_ts || 0;
        if (count < CAP_MAX) continue;
        const daysSince = lastTs ? (Date.now() - lastTs) / 86400000 : 0;
        if (daysSince < DROP_AFTER_DAYS) continue;
        await setCreatorStage(c.handle, "XX_Dropped");
        await logPipelineEvent(c.handle, "01_FirstOutreach", "XX_Dropped", `Auto drop: followup cap=${count} exhausted, ${daysSince.toFixed(1)}d since last attempt, no reply`);
        console.error(`  🗑️ @${c.handle} → XX_Dropped (cap=${count}, ${daysSince.toFixed(1)}d silent)`);
        summary.capDropped.push({ handle: c.handle, count, daysSilent: daysSince.toFixed(1) });
        dropCount++;
      } catch (e) { console.error(`  @${c.handle} drop-check err: ${e.message?.substring(0, 80)}`); }
    }
    console.error(`[${ts()}] cap-exhausted drop: ${dropCount}`);
  } catch (e) {
    console.error(`[${ts()}] 已读追踪失败: ${e.message}`);
  }

  // Step 3: Check TikTok DM replies via CDP
  console.error(`[${ts()}] 扫描TikTok私信回复...`);
  const watchListHandles = creators
    .filter(c => !advancedHandles.has(c.handle))
    .map(c => ({ handle: c.handle, nickname: c.nickname || "" }));
  if (watchListHandles.length) {
    try {
      const result = await checkReplies(watchListHandles);
      console.error(`[${ts()}] TikTok 对话总数: ${result.conversations} | 有回复: ${result.replies.length}`);

      for (const rep of result.replies) {
        const handle = rep.handle;
        if (advancedHandles.has(handle)) continue;
        advancedHandles.add(handle);

        const currentStage = stageMap[handle.toLowerCase()] || "01_FirstOutreach";
        const creatorHasEmail = Object.values(emailToHandle).includes(handle);

        // ── AI 分类 + 决定动作（结构化输出） ──────────────────────────────
        const decision = await classifyReply({
          currentStage, handle, subject: "", body: rep.preview || "",
          senderEmail: "tiktok_dm", hasEmail: creatorHasEmail,
        });
        console.error(`  📱 @${handle}: DM reply="${(rep.preview || "").substring(0, 60)}" → ${decision.target} (conf=${decision.confidence?.toFixed(2)}) — ${decision.reasoning?.substring(0, 80)}`);
        if (decision.actions?.length) console.error(`     actions: ${decision.actions.map(a => a.type).join(", ")}`);

        // ── 执行 actions ────────────────────────────────────────────────────

        // action: save_contact（从回复中提取 Discord / WhatsApp / Email）
        const contactActions = decision.actions?.filter(a => a.type === "save_contact") || [];
        const DISCORD_RE = /(?:discord|discord\.com\/@|discord\.gg)[^\s]{3,50}/gi;
        const WHATSAPP_RE = /(?:whatsapp|\+?1?\s*\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}|\+\d{1,3}[\s\-\d]{7,15})/gi;
        const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

        const saveContact = async (type, value) => {
          try {
            const { items } = await btListRecords(cfg.kol_tbl_creators, {
              filter: `CurrentValue.[Creator Username].contains("${handle}")`, pageSize: 1,
            });
            const rec = items[0];
            if (!rec) return;
            const fieldMap = { discord: "Twitter", whatsapp: "WhatsApp", email: "email" };
            const field = fieldMap[type];
            if (field && !rec.fields?.[field]) {
              await btUpdateRecord(cfg.kol_tbl_creators, rec.record_id, { [field]: value });
              console.error(`  📱 联系方式提取 @${handle}: ${type}=${value} ✅`);
              await logPipelineEvent(handle, currentStage, currentStage, `TikTok DM 回复中提取联系方式 (${type}): ${value}`);
            }
          } catch (e) { console.error(`  📱 联系方式保存失败 @${handle}: ${e.message}`); }
        };

        for (const ca of contactActions) {
          const ctype = ca.contact_type?.toLowerCase();
          const cvalue = (ca.value || "").trim();
          if (!ctype || !cvalue) continue;
          await saveContact(ctype, cvalue);
        }

        // AI未提取时：regex 兜底提取 email（保持向后兼容）
        if (!contactActions.find(a => a.contact_type?.toLowerCase() === "email")) {
          const emailFromRegex = EMAIL_RE.exec(rep.preview || "")?.[0]?.toLowerCase();
          if (emailFromRegex && !creatorHasEmail) {
            try {
              const { items } = await btListRecords(cfg.kol_tbl_creators, {
                filter: `CurrentValue.[Creator Username].contains("${handle}")`, pageSize: 1,
              });
              const rec = items[0];
              if (rec && !rec.fields?.["email"]) {
                await btUpdateRecord(cfg.kol_tbl_creators, rec.record_id, { "email": emailFromRegex });
                emailToHandle[emailFromRegex] = handle;
                console.error(`  📧 DM 邮箱提取: @${handle} → ${emailFromRegex} ✅`);
                await logPipelineEvent(handle, currentStage, currentStage, `TikTok DM 回复中提取邮箱: ${emailFromRegex}`);
              }
            } catch (e) { console.error(`  📧 DM 邮箱写回失败 @${handle}: ${e.message}`); }
          }
        }

        // action: reply_dm（回复 DM，索要 Discord / WhatsApp / Email）
        const replyDmAction = decision.actions?.find(a => a.type === "reply_dm");
        if (replyDmAction?.message) {
          try {
            const dmRes = await sendDM({ username: handle, message: replyDmAction.message });
            if (dmRes.success) {
              console.error(`  📱 DM 回复已发: "${replyDmAction.message.substring(0, 60)}" ✅`);
              console.log(`📱 TikTok DM 自动回复 [${ts()}]\n@${handle} 回复了我们的私信，已自动回复询问联系方式\n回复内容：${replyDmAction.message}`);
              await logPipelineEvent(handle, currentStage, currentStage, `TikTok DM auto-reply sent: ${replyDmAction.message.substring(0, 80)}`);
            } else {
              console.error(`  📱 DM 回复失败 @${handle}`);
            }
          } catch (e) { console.error(`  📱 DM 回复出错 @${handle}: ${e.message}`); }
        }

        // action: advance_stage / target 推进
        if (!decision.target || decision.target === currentStage) {
          await logPipelineEvent(handle, currentStage, currentStage, `TikTok DM reply [keep]: ${decision.reasoning}`);
          continue;
        }

        if (decision.target === "XX_Dropped") {
          const upOk = await setCreatorStage(handle, "XX_Dropped");
          if (upOk) {
            await logPipelineEvent(handle, currentStage, "XX_Dropped", `TikTok DM reply [declined]: ${decision.reasoning} | "${(rep.preview || "").substring(0, 80)}"`);
            console.error(`  @${handle}: ${currentStage} → XX_Dropped ✅`);
            console.log(`🚫 TikTok DM 拒绝 [${ts()}]\n@${handle} 明确拒绝，已标记 XX_Dropped\n理由：${decision.reasoning}`);
          }
          continue;
        }

        if (shouldHoldAdvance(currentStage, decision.target)) {
          console.error(`  @${handle}: ${currentStage} → ${decision.target} 🛑 HOLD (max=${MAX_AUTO_STAGE})`);
          summary.held.push({ handle, fromStage: currentStage, wantedStage: decision.target, source: "DM", reasoning: rep.preview.substring(0, 80) });
          console.log(`🛑 TikTok DM 阶段推进被 hold [${ts()}]\n@${handle}: ${currentStage} → ${decision.target}，超过自动上限 ${MAX_AUTO_STAGE}\nDM 内容：${rep.preview.substring(0, 100)}`);
          continue;
        }

        try {
          await advancePipeline({
            creator_handle: handle, to_stage: decision.target,
            notes: `TikTok DM reply [conf=${decision.confidence?.toFixed(2)}]: "${(rep.preview || "").substring(0, 50)}" [${rep.date}]`,
          });
          console.error(`  @${handle}: ${currentStage} → ${decision.target} ✅`);
          summary.dmAdvanced.push({ handle, fromStage: currentStage, toStage: decision.target, reply: (rep.preview || "").substring(0, 80) });
        } catch (e) { console.error(`  @${handle}: advance failed: ${e.message}`); }
      }
    } catch (e) {
      console.error(`[${ts()}] TikTok check failed: ${e.message}`);
    }
  }

  // Step 4: deadline_engine global scan (stage 02-08)
  console.error(`[${ts()}] 扫描全局阶段 deadline (stage 02-08 + red lines)...`);
  try {
    const { nudgesForBatch } = await import("./lib/deadline_engine.mjs");
    const { setOperationAlert, actionToAlert } = await import("./lib/manual_events_sync.mjs");
    const tok = await tenantToken();
    const allActive = [];
    let pageToken = "";
    do {
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CRM_ENV.KOL_CRM_APP_TOKEN}/tables/${CRM_ENV.KOL_TBL_CREATORS}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ""}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.json());
      for (const it of r.data?.items || []) {
        const stage = it.fields?.["Pipeline Stage"];
        const stageStr = Array.isArray(stage) ? (stage[0]?.text || "") : (stage || "");
        if (stageStr && stageStr !== "09_Completed" && stageStr !== "XX_Dropped") allActive.push(it);
      }
      pageToken = r.data?.page_token || "";
    } while (pageToken);

    const nudges = nudgesForBatch(allActive);
    const stats = {};
    for (const n of nudges) stats[n.action] = (stats[n.action] || 0) + 1;
    console.error(`[${ts()}] deadline 扫描: ${allActive.length} active → ${nudges.length} 待动作 (${Object.entries(stats).map(([k, v]) => `${k}:${v}`).join(" ")})`);

    for (const n of nudges) {
      if (n.stage === "01_FirstOutreach" && n.action === "nudge") continue;
      const tag = `[${n.action}] @${n.handle} stage=${n.stage} overdue=${n.days_overdue}d anchor=${n.anchor}`;
      console.error(`  ${tag} — ${n.reason}${n.template_step ? " | template=" + n.template_step : ""}`);

      if (n.action === "drop") {
        if (advancedHandles.has(n.handle)) continue;
        const upOk = await setCreatorStage(n.handle, "XX_Dropped");
        if (upOk) {
          await logPipelineEvent(n.handle, n.stage, "XX_Dropped", `[deadline_engine drop] overdue ${n.days_overdue}d at ${n.anchor}: ${n.reason}`);
          advancedHandles.add(n.handle);
          console.error(`    ${n.handle}: ${n.stage} → XX_Dropped (deadline drop) ✅`);
          summary.deadlineDropped.push({ handle: n.handle, fromStage: n.stage, daysOverdue: n.days_overdue, reason: n.reason });
        }
      } else if (n.action === "missing_anchor") {
        await logPipelineEvent(n.handle, n.stage, n.stage, `[deadline_engine missing_anchor] ${n.reason}`);
      } else {
        const alertVal = actionToAlert(n.action);
        if (alertVal) {
          await setOperationAlert(CRM_ENV, n.handle, alertVal);
          console.error(`    @${n.handle}: Operation Alert = "${alertVal}" ✅`);
          summary.deadlineAlerts.push({ handle: n.handle, stage: n.stage, alert: alertVal, daysOverdue: n.days_overdue, reason: n.reason });
        }
        await logPipelineEvent(n.handle, n.stage, n.stage, `[deadline_engine ${n.action}] overdue ${n.days_overdue}d at ${n.anchor}: ${n.reason}${n.template_step ? " (template=" + n.template_step + ")" : ""}`);
      }
    }
  } catch (e) {
    console.error(`[${ts()}] deadline_engine 扫描失败: ${e.message}`);
  }

  console.error(`[${ts()}] === 监控完成 | 本次推进 ${advancedHandles.size} 个达人 ===`);

  // Feishu summary notification
  const lines = [];
  if (summary.dmAdvanced.length) {
    lines.push(`📱 TikTok DM 推进：${summary.dmAdvanced.length} 个达人`);
    for (const e of summary.dmAdvanced.slice(0, 10)) lines.push(`  • @${e.handle}: ${e.fromStage} → ${e.toStage}`);
    if (summary.dmAdvanced.length > 10) lines.push(`  …+${summary.dmAdvanced.length - 10} 更多`);
  }
  if (summary.capDropped.length) {
    lines.push(`🗑️ Followup-cap drop：${summary.capDropped.length} 个达人`);
    for (const e of summary.capDropped.slice(0, 5)) lines.push(`  • @${e.handle} (cap=${e.count}, ${e.daysSilent}d 静默)`);
  }
  if (summary.deadlineDropped.length) {
    lines.push(`🚨 deadline 红线 drop：${summary.deadlineDropped.length} 个达人`);
    for (const e of summary.deadlineDropped.slice(0, 5)) lines.push(`  • @${e.handle} (${e.fromStage}, ${e.daysOverdue}d 超期): ${e.reason}`);
  }
  if (summary.deadlineAlerts.length) {
    const byAlert = {};
    for (const e of summary.deadlineAlerts) (byAlert[e.alert] = byAlert[e.alert] || []).push(e.handle);
    lines.push(`⚠️ deadline Operation Alert：${summary.deadlineAlerts.length} 个达人`);
    for (const [alert, hs] of Object.entries(byAlert)) {
      lines.push(`  • ${alert}: ${hs.length}（@${hs.slice(0, 5).join(" @")}${hs.length > 5 ? " …" : ""}）`);
    }
  }
  if (summary.manualSync && summary.manualSync.applied > 0) {
    lines.push(`📝 manual_events 同步：${summary.manualSync.applied} 条 QC通过/包裹送达 已写回 creators`);
  }
  if (summary.detector && summary.detector.updated > 0) {
    lines.push(`🤖 自动检测：${summary.detector.scanned} 个达人扫描 → ${summary.detector.updated} 个字段更新`);
  }
  if (summary.held.length > 0) {
    lines.push(`🛑 HOLD（自动流程上限 ${MAX_AUTO_STAGE}）：${summary.held.length} 个达人`);
    for (const e of summary.held.slice(0, 8)) lines.push(`  • @${e.handle} [${e.source}]: ${e.fromStage} → ${e.wantedStage}`);
    if (summary.held.length > 8) lines.push(`  …+${summary.held.length - 8} 更多`);
  }
  if (lines.length > 0) {
    const text = `🛰️ 定时巡检汇总 [${ts()}]${MAX_AUTO_STAGE !== "09_Completed" ? ` (max=${MAX_AUTO_STAGE})` : ""}\n` + lines.join("\n");
    console.log(text);
  }
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
