/**
 * claude-personalizer — 用 Claude 把 SOP 模板按 creator 风格重写
 *
 * 与 kol-crm-mcp 现有 renderTemplate 的区别：
 *   renderTemplate    : 只做 {{var}} 字符串替换；信件骨架完全相同
 *   personalize       : 在替换基础上，让 Claude 看 creator 的 bio + Recent Videos JSON +
 *                       邮件历史，把开头 hook 句换成具体引用（"saw your Travis Scott unboxing
 *                       last week — that batch from Yupoo was solid"），其余段落保持模板原意
 *
 * 输入数据源（缺一不可，否则降级回纯模板）：
 *   1. Bitable creators 行（含 Bio / Style Summary / Recent Videos JSON / Display Name）
 *   2. SOP 模板（subject + body 已经过 renderTemplate 替换变量）
 *   3. 发件人显示名（"Biz"/"Alice"/...）
 *   4. 可选：之前的邮件往来历史（让 Claude 不重复说过的话）
 *
 * 输出：{ subject, body }（subject 通常不动，body 头几句重写）
 */

import cfg from "./config.mjs";

const ANTHROPIC_API_KEY = cfg.anthropic_api_key || "";
const MODEL = cfg.personalize_model || "claude-sonnet-4-6";

async function btToken(env) {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  return r?.tenant_access_token;
}

function val(rec, name) {
  const v = rec.fields?.[name];
  if (Array.isArray(v)) return v.map(x => (x?.text ?? x?.name ?? x ?? "")).join("");
  return v == null ? "" : String(v);
}

/** 拉 creator 行 + 最近 5 条邮件历史。返回 personalize() 直接可用的 context。 */
export async function fetchPersonalizeContext(env, creatorHandle, emailLogLimit = 5) {
  const tok = await btToken(env);

  const cr = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_CREATORS}/records/search?page_size=1`,
    {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: { conjunction: "and", conditions: [{ field_name: "username", operator: "is", value: [creatorHandle] }] },
      }),
    }
  ).then(r => r.json());
  const cRec = cr?.data?.items?.[0];
  if (!cRec) return null;

  let recentVideos = [];
  try {
    const j = val(cRec, "Recent Videos JSON");
    if (j) recentVideos = JSON.parse(j);
  } catch {}

  // 最近邮件历史（取 outbound + inbound 各几条）
  const er = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_EMAIL_LOG}/records/search?page_size=${emailLogLimit}`,
    {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: { conjunction: "and", conditions: [{ field_name: "Creator Username", operator: "is", value: [creatorHandle] }] },
        sort: [{ field_name: "Sent At", desc: true }],
      }),
    }
  ).then(r => r.json());
  const emailHistory = (er?.data?.items || []).map(e => ({
    direction: val(e, "Direction"),
    subject: val(e, "Subject"),
    body_preview: val(e, "Body Preview"),
    sent_at: e.fields?.["Sent At"] || 0,
  }));

  return {
    handle: creatorHandle,
    display_name: val(cRec, "username") || creatorHandle,
    bio: val(cRec, "bio"),
    style_summary: val(cRec, "primary_category"),
    follower_tier: val(cRec, "primary_category"),
    followers: cRec.fields?.["followers"] || 0,
    recent_videos: recentVideos,
    email_history: emailHistory,
  };
}

function summarizeVideos(videos, max = 5) {
  if (!videos || !videos.length) return "(无视频快照)";
  return videos.slice(0, max).map((v, i) => {
    const desc = (v.desc || "").substring(0, 120);
    const tags = (v.hashtags || []).slice(0, 5).join(", ");
    return `${i + 1}. ${desc}${tags ? ` [#${tags}]` : ""}`;
  }).join("\n");
}

function summarizeHistory(history, max = 3) {
  if (!history?.length) return "(首次接触，无历史)";
  return history.slice(0, max).map(h => {
    const dir = h.direction === "outbound" ? "我们 →" : "← 达人";
    const date = h.sent_at ? new Date(h.sent_at).toISOString().substring(0, 10) : "?";
    return `[${date} ${dir}] ${h.subject} — ${h.body_preview?.substring(0, 100) || ""}`;
  }).join("\n");
}

/**
 * 把模板信件或 TikTok DM 按 creator 风格重写。
 *
 * @param {object} args
 * @param {string} args.template_subject   渲染后的 subject（email 专用）
 * @param {string} args.template_body      渲染后的 body / DM 基础文案
 * @param {string} args.sender_name        发件人显示名（如 "Claire"）
 * @param {object} args.creator_context    fetchPersonalizeContext() 的返回
 * @param {string} [args.channel]          "email"（默认）或 "tiktok_dm"
 * @returns {Promise<{subject?, body, fallback_reason?}>}
 */
export async function personalize(args) {
  const { template_subject, template_body, sender_name, creator_context, channel = "email" } = args;

  if (!ANTHROPIC_API_KEY) {
    return { subject: template_subject, body: template_body, fallback_reason: "no ANTHROPIC_API_KEY" };
  }
  if (!creator_context) {
    return { subject: template_subject, body: template_body, fallback_reason: "creator not in CRM" };
  }
  if (!creator_context.bio && !creator_context.style_summary && !(creator_context.recent_videos?.length)) {
    return { subject: template_subject, body: template_body, fallback_reason: "no bio/style/videos to personalize from" };
  }

  const isDM = channel === "tiktok_dm";
  const senderName = sender_name.charAt(0).toUpperCase() + sender_name.slice(1);

  // ── TikTok DM 提示词 ──────────────────────────────────────────────────────
  if (isDM) {
    const sys = `You are a creator partnerships manager sending a TikTok DM to a creator for the first time.

Task: Write a short, natural DM personalised to this creator's content style and niche.

Rules:
1. Open with a specific, genuine reference to their content (a recent video topic, their style, or their niche — not generic praise)
2. Introduce yourself (${senderName}) and JoyaGoo in 1-2 sentences — dynamically adapt the product description to match the creator's vertical (e.g. designer bags, luxury dupes, bag hauls, fashion finds, etc.)
3. Express interest in a collab in one natural sentence
4. End with: politely mention you'd prefer to continue the conversation over email (easier to share the details), and ask if they can share their email address

Tone: casual, genuine, warm — like a real person, not a marketing bot.
Length: 4-6 sentences max. No bullet points. No emojis beyond one at most.
Language: English only.

Return strict JSON only: {"body": "..."}`;

    const userMsg = `# Creator
- Handle: @${creator_context.handle}
- Followers: ${creator_context.followers?.toLocaleString?.() || creator_context.followers}
- Bio: ${creator_context.bio || "(none)"}
- Style Summary: ${creator_context.style_summary || "(none)"}

# Recent Videos
${summarizeVideos(creator_context.recent_videos)}

# Sender name: ${senderName}
# Brand: JoyaGoo — China-based platform, creators order items from Chinese marketplaces (Taobao/1688/Weidian), we ship internationally at a fraction of local prices

Write the DM. Return JSON.`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: userMsg }] }),
      });
      const data = await res.json();
      let raw = data?.content?.[0]?.text?.trim() || "";
      if (raw.startsWith("```")) { raw = raw.split("```")[1]; if (raw.startsWith("json")) raw = raw.slice(4); raw = raw.trim(); }
      const start = raw.indexOf("{"), end = raw.lastIndexOf("}") + 1;
      if (start >= 0 && end > start) raw = raw.substring(start, end);
      const parsed = JSON.parse(raw);
      return { body: String(parsed.body || template_body) };
    } catch (e) {
      return { body: template_body, fallback_reason: `Claude DM error: ${e.message}` };
    }
  }

  // ── Email 提示词 ──────────────────────────────────────────────────────────
  // 拆段：前两段（称呼 + hook 句）交 Claude 重写，剩余段落硬保留原文
  const paras = template_body.split(/\n\n+/);
  const editableParas = paras.slice(0, 2);   // 称呼行 + hook 句
  const fixedParas    = paras.slice(2);       // JoyaGoo 介绍 + offer + CTA + 落款（原文不动）
  const editableText  = editableParas.join("\n\n");

  const sys = `You are a creator partnerships manager writing a cold outreach email.

Task: Rewrite ONLY the opening section (greeting line + hook sentence) to personalise it for this specific creator. The rest of the email is fixed and will be appended unchanged.

Rules:
1. Keep the greeting line format: "Hi [name],"
2. Replace the hook sentence with a specific, genuine reference to the creator's content (a recent video topic, niche, or style — not generic praise)
3. Stay in English. Warm, natural tone — not a marketing bot.
4. Do NOT add new paragraphs, do NOT touch anything beyond the greeting + hook.

Return strict JSON only: {"subject": "...", "opening": "..."}
  "opening" = the rewritten greeting line + hook sentence (two lines, no extra paragraphs)`;

  const userMsg = `# Opening section to rewrite
${editableText}

# Subject to keep (minor personalisation allowed)
${template_subject}

# Creator info
- Handle: @${creator_context.handle}
- Followers: ${creator_context.followers?.toLocaleString?.() || creator_context.followers}
- Bio: ${creator_context.bio || "(none)"}
- Style Summary: ${creator_context.style_summary || "(none)"}

# Recent videos
${summarizeVideos(creator_context.recent_videos)}

# Email history
${summarizeHistory(creator_context.email_history)}

Rewrite the opening only. Return JSON.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: sys, messages: [{ role: "user", content: userMsg }] }),
    });
    const data = await res.json();
    let raw = data?.content?.[0]?.text?.trim() || "";
    if (raw.startsWith("```")) { raw = raw.split("```")[1]; if (raw.startsWith("json")) raw = raw.slice(4); raw = raw.trim(); }
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}") + 1;
    if (start >= 0 && end > start) raw = raw.substring(start, end);
    const parsed = JSON.parse(raw);

    // 拼合：Claude 重写的开头 + 原文固定段落
    const rewrittenOpening = String(parsed.opening || editableText);
    const finalBody = [rewrittenOpening, ...fixedParas].join("\n\n");
    return {
      subject: String(parsed.subject || template_subject),
      body: finalBody,
    };
  } catch (e) {
    return { subject: template_subject, body: template_body, fallback_reason: `Claude error: ${e.message}` };
  }
}
