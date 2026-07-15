/**
 * 自动建联 — cron定时运行
 * 找到所有 00_Discovered 的达人 → 发三渠道outreach → 推进到 01_FirstOutreach
 *
 * 邮件发件走 lib/email_thread_builder.mjs 的 sendThreaded，自动续 thread（首封不影响）。
 */
import { sendThreaded } from "./lib/email_thread_builder.mjs";
import { personalize, fetchPersonalizeContext } from "./lib/claude_personalizer.mjs";

import cfg from "./lib/config.mjs";
import { searchCreators, buildOutreach, advancePipeline, logEmailSent, btUpdateRecord, btListRecords } from "./lib/kol_crm.mjs";
import { sendDM } from "./lib/tiktok_dm.mjs";
import { pickSender, incrementSend, getPoolStatus } from "./sender_pool.mjs";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function senderEnvToSmtp(env) {
  return {
    host: env.SMTP_HOST,
    port: parseInt(env.SMTP_PORT, 10),
    secure: parseInt(env.SMTP_PORT, 10) === 465,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
  };
}

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
};

const ts = () => new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

// Helper: write "Outreach Sender" + "Last Outreach At" back to creators table.
async function findCreatorRecordId(handle) {
  const { items } = await btListRecords(cfg.kol_tbl_creators, {
    filter: `CurrentValue.[Creator Username].contains("${handle}")`,
    pageSize: 1,
  });
  return items[0]?.record_id || null;
}

async function setOutreachSender(handle, senderName) {
  try {
    const rid = await findCreatorRecordId(handle);
    if (!rid) return false;
    await btUpdateRecord(cfg.kol_tbl_creators, rid, { "Assigned To": senderName, "Last Contact Date": Date.now() });
    return true;
  } catch { return false; }
}

async function saveNickname(handle, nickname) {
  try {
    const rid = await findCreatorRecordId(handle);
    if (!rid) return;
    await btUpdateRecord(cfg.kol_tbl_creators, rid, { "tiktok_nickname": nickname });
  } catch { /* non-critical */ }
}

async function saveProfileUrl(handle, profileUrl) {
  if (!profileUrl || !profileUrl.includes("tiktok.com/")) return;
  try {
    const rid = await findCreatorRecordId(handle);
    if (!rid) return;
    await btUpdateRecord(cfg.kol_tbl_creators, rid, { "profile_url": profileUrl });
  } catch { /* non-critical */ }
}

const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

async function main() {
  console.error(`[${ts()}] === 自动建联启动 ===`);
  const pool = getPoolStatus();
  console.error(`[${ts()}] 储备池: ${pool.per_account.map(a => `${a.name}=${a.sent}/${pool.cap_per_account}`).join(" ")} | 今日剩余 ${pool.total_remaining_today}`);
  if (pool.total_remaining_today === 0) {
    console.error(`[${ts()}] 池已满，跳过本轮`);
    return;
  }

  // Step 1: Find all 00_Discovered creators
  let discovered = [];
  try {
    const { items } = await searchCreators({ stage: "00_Discovered" });
    const seen = new Set();
    for (const item of items) {
      const handle = item.fields["username"];
      if (!handle || typeof handle !== "string" || handle.length < 3) continue;
      if (handle === "undefined" || handle === "null" || handle === "NaN") continue;
      if (handle.includes(".com") || handle.includes(".edu")) continue;
      if (seen.has(handle)) continue;
      seen.add(handle);
      discovered.push(handle);
    }
  } catch (e) {
    console.error(`[${ts()}] CRM search failed: ${e.message}`);
    return;
  }

  if (!discovered.length) {
    console.error(`[${ts()}] 无待建联达人`);
    return;
  }

  console.error(`[${ts()}] 发现 ${discovered.length} 个待建联达人`);

  // Step 2: For each, pick sender → render template → send → advance pipeline
  let sent = 0;
  const sentHandles = [];
  for (let i = 0; i < discovered.length; i++) {
    const handle = discovered[i];
    console.error(`\n[${i + 1}/${discovered.length}] @${handle}`);

    // 2a-pre. Guard: re-fetch creator stage to prevent duplicate sends from concurrent runs
    try {
      const { items: guardItems } = await btListRecords(cfg.kol_tbl_creators, {
        filter: `CurrentValue.[Creator Username] = "${handle}"`,
        pageSize: 1,
      });
      const currentStage = guardItems[0]?.fields?.["Pipeline Stage"];
      if (currentStage !== "00_Discovered") {
        console.error(`  ⏭️ stage已变更为 ${currentStage}，跳过（并发保护）`);
        continue;
      }
    } catch (e) {
      console.error(`  stage guard失败: ${e.message}，继续`);
    }

    // 2a. Pre-pick sender so template's your_name matches the SMTP From
    const picked = pickSender();
    if (!picked) { console.error(`  邮件 ⏭️ 储备池今日已满，跳过`); continue; }

    // 2b. Build outreach content
    let emailTo = "", subject = "", body = "", bodyHtml = "", tkMsg = "";
    try {
      const outreach = await buildOutreach({
        creator_handle: handle, step: 1,
        custom_vars: { your_name: cap(picked.name) },
      });
      emailTo = outreach.emailTo;
      subject = outreach.subject;
      body = outreach.body;
      bodyHtml = outreach.bodyHtml;
      tkMsg = outreach.tkMsg;
      console.error(`  模板 ✅ sender=${picked.name} email=${!!emailTo} html=${!!bodyHtml} tk=${!!tkMsg}`);
    } catch (e) {
      console.error(`  模板 ❌ ${e.message}`);
      continue;
    }

    // 2c. Personalize via Claude（邮件 + TikTok DM 共用同一次 context 拉取）
    let personalizedSubject = subject, personalizedBody = body;
    let personalizedTkMsg = tkMsg;
    let creatorCtx = null;
    try {
      creatorCtx = await fetchPersonalizeContext(CRM_ENV, handle);
    } catch (e) {
      console.error(`  Context ❌ ${e.message}`);
    }

    // 2c-i. 邮件个性化
    if (creatorCtx && emailTo) {
      try {
        const p = await personalize({
          template_subject: subject,
          template_body: body,
          sender_name: cap(picked.name),
          creator_context: creatorCtx,
          channel: "email",
        });
        personalizedSubject = p.subject;
        personalizedBody = p.body;
        if (p.fallback_reason) {
          console.error(`  邮件个性化 ⏭️ ${p.fallback_reason}`);
        } else {
          console.error(`  邮件个性化 ✅ Claude 重写`);
        }
      } catch (e) {
        console.error(`  邮件个性化 ❌ ${e.message}（用模板原文继续发）`);
      }
    }

    // 2c-ii. TikTok DM 个性化（仅无邮箱时才走，末尾永远索要邮箱）
    if (!emailTo && creatorCtx && tkMsg) {
      try {
        const p = await personalize({
          template_body: tkMsg,
          sender_name: cap(picked.name),
          creator_context: creatorCtx,
          channel: "tiktok_dm",
        });
        personalizedTkMsg = p.body;
        if (p.fallback_reason) {
          console.error(`  DM个性化 ⏭️ ${p.fallback_reason}`);
        } else {
          console.error(`  DM个性化 ✅ Claude 重写（含索要邮箱）`);
        }
      } catch (e) {
        console.error(`  DM个性化 ❌ ${e.message}（用原文继续发）`);
      }
    }

    // 2d. Final stage guard immediately before send (as close as possible to catch concurrent advances)
    let currentStage = null;
    try {
      const { items: guardItems } = await btListRecords(cfg.kol_tbl_creators, {
        filter: `CurrentValue.[Creator Username] = "${handle}"`,
        pageSize: 1,
      });
      currentStage = guardItems[0]?.fields?.["Pipeline Stage"];
      if (currentStage !== "00_Discovered") {
        console.error(`  ⏭️ stage已变为 ${currentStage}（并发保护），跳过发送`);
        continue;
      }
    } catch (e) {
      console.error(`  stage guard失败: ${e.message}，跳过发送`);
      continue;
    }

    // 2d-2. Send email via sendThreaded
    let emailOk = false, emailSender = null, messageId = null, isReply = false;
    if (emailTo && personalizedSubject && personalizedBody) {
      emailSender = picked.name;
      try {
        const sendRes = await sendThreaded({
          creatorHandle: handle,
          env: CRM_ENV,
          smtp: senderEnvToSmtp(picked.env),
          to: emailTo,
          subject: personalizedSubject,
          body: personalizedBody,
          html: bodyHtml,
        });
        emailOk = sendRes.ok;
        messageId = sendRes.messageId;
        isReply = sendRes.isReply;
        if (emailOk) {
          incrementSend(picked.name);
          await setOutreachSender(handle, picked.name);
          await logEmailSent({
            handle, direction: "outbound", templateId: "step01",
            subject: sendRes.subject || personalizedSubject,
            body: personalizedBody, sender: picked.name,
            messageId, status: "sent",
          });
        } else if (sendRes.error) {
          console.error(`  邮件 SMTP error: ${sendRes.error}`);
        }
        const tag = isReply ? `🧵 reply (chain=${sendRes.chainLength})` : "✉️ first";
        console.error(`  邮件 ${emailOk ? "✅" : "❌"} ${tag} via ${picked.user || picked.name} → ${emailTo}${messageId ? " mid=" + messageId.substring(0, 40) : ""}`);
      } catch (e) { console.error(`  邮件 ❌ via ${picked.name}: ${e.message}`); }
    } else {
      console.error("  邮件 ⏭️ 无邮箱");
    }

    // 2e. Send TikTok DM（仅无邮箱时发）
    let dmOk = false;
    if (!emailTo && personalizedTkMsg) {
      try {
        const dmRes = await sendDM({ username: handle, message: personalizedTkMsg });
        dmOk = dmRes.success || false;
        console.error(`  TikTok DM ${dmOk ? "✅" : "❌"}`);
        // Store display name for reliable reply matching
        if (dmOk && dmRes.displayName) {
          await saveNickname(handle, dmRes.displayName);
          console.error(`  nickname 存储: "${dmRes.displayName}"`);
        }
        if (dmOk && dmRes.profileUrl) {
          await saveProfileUrl(handle, dmRes.profileUrl);
          console.error(`  profile_url 回写: "${dmRes.profileUrl}"`);
        }
      } catch (e) { console.error(`  TikTok DM ❌ ${e.message}`); }
    } else {
      console.error(`  TikTok DM ⏭️ 无模板消息`);
    }

    // 2f. Advance pipeline only if a real message went out on at least one channel
    if (emailOk || dmOk) {
      try {
        await advancePipeline({
          creator_handle: handle,
          to_stage: "01_FirstOutreach",
          notes: `Auto outreach: Email:${emailOk ? "Y" : "N"} TK:${dmOk ? "Y" : "N"} Template:step01`,
        });
        console.error(`  Pipeline → 01 ✅`);
        sent++;
        sentHandles.push(handle);
      } catch (e) { console.error(`  Pipeline ❌ ${e.message}`); }
    }

    await sleep(5000);
  }

  console.error(`\n[${ts()}] === 建联完成: ${sent}/${discovered.length} ===`);

  if (sent > 0) {
    const handleList = sentHandles.map(h => `@${h}`).join(" ");
    const text =
      `📨 自动建联完成 [${ts()}]\n` +
      `step01 首封外联：${sent} 封（共 ${discovered.length} 个候选）\n` +
      `达人：${handleList}\n` +
      `\n` +
      `📌 当前自动跟进规则：仍在自动推进（达人回信 → 自动推 02 → 发 step02 报价）。\n` +
      `如需在 step01 后停止等人工确认再继续，告诉我，我加截断开关。`;
    console.log(text);
  }
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
