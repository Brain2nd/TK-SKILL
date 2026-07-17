/**
 * Offline persona-analyzer handoff preview.
 *
 * This command never imports sender providers, writes Feishu, creates an
 * approvable manifest or sends a message. It exercises the same eligibility,
 * template rendering and message validation used by the production agent.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { parseCsv } from "./import_candidates.mjs";
import { runFirstOutreach } from "./lib/first_outreach_agent.mjs";
import { normalizeEmail, normalizeHandle } from "./lib/outreach_policy.mjs";
import { loadFirstContactTemplate } from "./lib/first_contact_template.mjs";
import { buildTemplatedFirstContact } from "./lib/creator_hook.mjs";

const root = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    candidates: resolve(root, "../tikhub-kol-analyzer/output/tts_l1_eu/final.csv"),
    country: "ES",
    template: resolve(root, "outreach_templates/spain-tiktok-shop-eur20.json"),
    campaignId: "spain-tiktok-shop-eur20-test",
    limit: 10,
    writeReport: resolve(root, "outreach_batches/spain-eur20-dry-run.json"),
    writeHtml: resolve(root, "outreach_batches/spain-eur20-dry-run.html"),
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidates") args.candidates = resolve(argv[++index] || "");
    else if (arg === "--country") args.country = String(argv[++index] || "").trim().toUpperCase();
    else if (arg === "--template" || arg === "--template-file") args.template = resolve(argv[++index] || "");
    else if (arg === "--campaign-id") args.campaignId = String(argv[++index] || "").trim();
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--write-report") args.writeReport = resolve(argv[++index] || "");
    else if (arg === "--write-html") args.writeHtml = resolve(argv[++index] || "");
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.candidates || !args.template || !args.campaignId) throw new Error("candidates, template and campaign-id are required");
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) throw new Error("--limit must be 1..500");
  return args;
}

function analyzerRecord(row, index) {
  const handle = normalizeHandle(row.username || row.handle || row.profile_url);
  return {
    record_id: `offline-preview-${index + 1}`,
    fields: {
      username: handle,
      candidate_id: handle ? `tiktok:${handle}` : "",
      display_name: handle,
      platform: "tiktok",
      screening_decision: "approved",
      "Pipeline Stage": "00_Discovered",
      "Allowed Channels": "email",
      email: normalizeEmail(row.email),
      email_source: row.email_source || "",
      email_verified: String(row.email_verified || "").toLowerCase() === "true",
      profile_url: row.profile_url || (handle ? `https://www.tiktok.com/@${handle}` : ""),
      bio: row.bio || "",
      country: row.country || "",
      followers: Number(row.followers || 0),
      avg_views: Number(row.avg_views_10 || row.avg_views || 0),
      engagement_rate: Number(row.engagement_rate || 0),
      shop_signals: Number(row.shop_signals || 0),
    },
  };
}

function offlineDependencies(records, template) {
  return {
    async listCandidates() { return records; },
    idempotencyKey(candidate, campaignId) { return `${campaignId}:${candidate.candidateId}:step01`; },
    async hasPriorOutreach() { return false; },
    pickSender() { return { name: "vira-preview", user: "preview-only@local.invalid" }; },
    async buildOutreach(candidate) {
      return buildTemplatedFirstContact({ template, candidate, senderName: "Vira" });
    },
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const TRAIT_LABELS_ZH = {
  home_decor: "家居装饰",
  fashion: "时尚穿搭",
  beauty: "美妆",
  ugc_creator: "UGC 创作者",
  versatile_brand_content: "多类型品牌内容",
  creator_education: "创作者教育",
  skincare: "护肤",
  product_reviews: "产品测评",
  honest_skin: "真实肌肤内容",
  shop_bio_signal: "主页含电商信号",
  brand_storytelling: "品牌故事表达",
  ugc_from_handle: "账号名含 UGC 信号",
  travel: "旅行",
  ugc_manager: "UGC 管理/策划",
};

const REVIEW_WARNING_LABELS_ZH = {
  tiktok_shop_product_link_capability_unverified: "尚未确认该账号具备添加 TikTok Shop 商品链接的能力",
  stable_candidate_identity_not_proven_by_snapshot: "当前画像快照尚未证明稳定的达人身份 ID",
  email_domain_verified_not_mailbox_confirmed: "仅验证了邮箱域名，尚未确认该具体邮箱真实可收件",
};

function traitLabelZh(value) {
  if (String(value).startsWith("city:")) return `城市：${String(value).slice(5)}`;
  return TRAIT_LABELS_ZH[value] || "其他公开内容特征";
}

function reviewWarningLabelZh(value) {
  return REVIEW_WARNING_LABELS_ZH[value] || "存在一项尚未映射的人工审核事项";
}

export function renderHtml(report) {
  const cards = report.results.filter(item => item.status === "planned").map(item => {
    const profile = item.creator_profile || {};
    const traits = (item.personalization_traits || []).map(value => `<span class="pill">${escapeHtml(traitLabelZh(value))}</span>`).join("");
    const warnings = (item.review_warnings || []).map(value => `<li>${escapeHtml(reviewWarningLabelZh(value))}</li>`).join("");
    return `<article class="card">
      <header><div><h2>@${escapeHtml(item.handle)}</h2><p>${Number(profile.followers || 0).toLocaleString("zh-CN")} 粉丝 · ${Number(profile.avg_views_10 || 0).toLocaleString("zh-CN")} 平均播放 · ${(Number(profile.engagement_rate || 0) * 100).toFixed(2)}% 互动率</p></div><span class="status">仅预览</span></header>
      <div class="traits">${traits || '<span class="pill muted">暂无可用公开特征</span>'}</div>
      <div class="mail"><div class="subject"><span class="subject-label">邮件主题：</span><span lang="en">${escapeHtml(item.subject)}</span></div><pre lang="en">${escapeHtml(item.body)}</pre></div>
      <details><summary>人工审核项（${(item.review_warnings || []).length}）</summary><ul>${warnings}</ul></details>
    </article>`;
  }).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>西班牙首次建联邮件预览</title><style>
  :root{color-scheme:light;font-family:Inter,"PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#172033;background:#f4f7fb}body{margin:0}.wrap{max-width:1100px;margin:auto;padding:36px 24px 80px}.top{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;margin-bottom:28px}.eyebrow{color:#6c4df6;font-weight:800;letter-spacing:.12em;font-size:12px}.top h1{font-size:34px;margin:8px 0}.top p{color:#5a6478;margin:0}.summary{background:#172033;color:white;border-radius:18px;padding:18px 24px;min-width:180px}.summary strong{font-size:34px;display:block}.notice{padding:14px 18px;background:#fff3cd;border:1px solid #ffe08a;border-radius:12px;margin-bottom:22px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:18px}.card{background:white;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 8px 28px #26395f12;padding:20px}.card header{display:flex;justify-content:space-between;gap:16px}.card h2{margin:0;font-size:20px}.card header p{margin:4px 0 0;color:#687386;font-size:13px}.status{height:min-content;background:#e9fbf2;color:#087443;padding:6px 9px;border-radius:999px;font-size:11px;font-weight:800}.traits{margin:14px 0}.pill{display:inline-block;padding:5px 8px;background:#eef1ff;color:#4b3f9f;border-radius:999px;font-size:11px;margin:0 5px 5px 0}.pill.muted{color:#6b7280;background:#f1f3f5}.mail{border:1px solid #e5e9f0;border-radius:12px;overflow:hidden}.subject{padding:11px 14px;background:#f8fafc;border-bottom:1px solid #e5e9f0;font-weight:700;font-size:13px}.subject-label{color:#687386}.mail pre{white-space:pre-wrap;font:14px/1.55 Inter,ui-sans-serif,system-ui;margin:0;padding:15px;color:#293247}details{margin-top:13px;color:#7c2d12;font-size:12px}details ul{padding-left:20px}</style></head><body><main class="wrap"><section class="top"><div><div class="eyebrow">首次建联 · 西班牙</div><h1>个性化邮件审批预览</h1><p>模板：${escapeHtml(report.content_template_id)} · 版本：${escapeHtml(report.content_template_version)}</p></div><div class="summary"><strong>${report.planned}</strong>封待审核<br><small>已发送 0 封</small></div></section><div class="notice"><strong>仅供预览。</strong> 本次未执行 SMTP、TikTok 私信或飞书写入；每位收件人仍需人工审核。</div><section class="grid">${cards}</section></main></body></html>`;
}

export async function buildAnalyzerPreview(args) {
  const template = await loadFirstContactTemplate(args.template);
  const rows = parseCsv(await readFile(args.candidates, "utf8"));
  const selectedRows = rows.filter(row => !args.country || String(row.country || "").toUpperCase() === args.country);
  const records = selectedRows.map(analyzerRecord);
  const report = await runFirstOutreach({
    campaignId: args.campaignId,
    execute: false,
    limit: args.limit,
    requireApproval: true,
    personalize: false,
  }, offlineDependencies(records, template));
  const rowByHandle = new Map(selectedRows.map(row => [normalizeHandle(row.username || row.profile_url), row]));
  for (const item of report.results) {
    const row = rowByHandle.get(item.handle) || {};
    item.creator_profile = {
      country: row.country || "",
      profile_url: row.profile_url || "",
      followers: Number(row.followers || 0),
      avg_views_10: Number(row.avg_views_10 || 0),
      engagement_rate: Number(row.engagement_rate || 0),
      shop_signals: Number(row.shop_signals || 0),
      email_source: row.email_source || "",
      email_verified: String(row.email_verified || "").toLowerCase() === "true",
      bio: row.bio || "",
    };
  }
  return {
    ...report,
    preview_only: true,
    side_effects: { smtp_sends: 0, tiktok_dm_sends: 0, feishu_writes: 0 },
    source_file: args.candidates,
    source_rows: rows.length,
    country_filter: args.country,
    country_rows: selectedRows.length,
    content_template_id: template.content_template_id,
    content_template_version: template.content_template_version,
    outreach_intent: template.intent,
    followup_mode: template.followup.mode,
    data_limitations: [
      "candidate_id falls back to platform:handle because the analyzer CSV has no stable TikTok user ID",
      "email_verified indicates domain/MX validation, not mailbox ownership or SMTP deliverability",
      "recent-video evidence and TikTok Shop product-link capability are not verified in this CSV",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildAnalyzerPreview(args);
  if (args.writeReport) {
    await mkdir(dirname(args.writeReport), { recursive: true });
    await writeFile(args.writeReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (args.writeHtml) {
    await mkdir(dirname(args.writeHtml), { recursive: true });
    await writeFile(args.writeHtml, renderHtml(report), "utf8");
  }
  console.log(JSON.stringify({
    mode: report.mode,
    preview_only: report.preview_only,
    source_rows: report.source_rows,
    country_rows: report.country_rows,
    planned: report.planned,
    sent: report.sent,
    failed: report.failed,
    report: args.writeReport,
    html: args.writeHtml,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Preview failed: ${error.message}`);
    process.exit(1);
  });
}
