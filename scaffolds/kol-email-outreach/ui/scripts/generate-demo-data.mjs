import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, "..");
const coreRoot = resolve(siteRoot, "..");

const { buildAnalyzerPreview } = await import(
  pathToFileURL(resolve(coreRoot, "preview_analyzer_batch.mjs")).href
);
const { createBatchManifest, payloadSha256 } = await import(
  pathToFileURL(resolve(coreRoot, "lib", "outreach_batch.mjs")).href
);

const campaignId = "spain-tiktok-shop-eur20-test";
const sourceFile = resolve(
  process.env.KOL_CANDIDATES_FILE ||
  resolve(coreRoot, "..", "tikhub-kol-analyzer", "output", "eu5_10_tikhub_20260717", "final.csv"),
);
const templateFile = resolve(coreRoot, "outreach_templates", "spain-tiktok-shop-eur20.json");
const reportFile = resolve(coreRoot, "outreach_batches", "spain-eur20-dry-run.json");

// Rebuild the preview from the latest analyzer handoff every time the UI starts.
// buildAnalyzerPreview is offline-only: execute=false, local.invalid sender, no CRM writes.
const report = await buildAnalyzerPreview({
  candidates: sourceFile,
  country: "ES",
  template: templateFile,
  campaignId,
  limit: 10,
});

if (
  report.mode !== "dry-run" ||
  report.preview_only !== true ||
  report.campaign_id !== campaignId ||
  report.planned !== 10 ||
  report.sent !== 0 ||
  report.pending_sync !== 0 ||
  report.failed !== 0 ||
  report.delivery_circuit?.open !== false ||
  report.content_template_id !== "spain-tiktok-shop-eur20" ||
  report.outreach_intent !== "fixed_offer" ||
  report.followup_mode !== "disabled" ||
  Object.values(report.side_effects || {}).some((count) => Number(count) !== 0)
) {
  throw new Error("Refusing to generate UI data because the Spain batch is not a zero-side-effect dry-run");
}

const plannedItems = report.results.filter((item) => item.status === "planned");
const uniqueValues = (values) => new Set(values).size === values.length;
if (
  plannedItems.length !== 10 ||
  !uniqueValues(plannedItems.map((item) => item.candidate_id)) ||
  !uniqueValues(plannedItems.map((item) => String(item.to || "").toLowerCase())) ||
  !uniqueValues(plannedItems.map((item) => item.idempotency_key)) ||
  plannedItems.some((item) =>
    item.from !== "preview-only@local.invalid" ||
    item.content_template_id !== "spain-tiktok-shop-eur20" ||
    item.outreach_intent !== "fixed_offer" ||
    item.followup_mode !== "disabled" ||
    !item.body.includes("You will receive €20 for the post.")
    || !item.body.includes("https://vm.tiktok.com/ZNRoT8PuT/")
  )
) {
  throw new Error("Refusing to generate UI data because the Spain recipient or template invariants failed");
}

// Keep generated artifacts portable and safe to publish. The absolute local
// path is used only to read the source file and never written to demo JSON.
report.source_file = "scaffolds/tikhub-kol-analyzer/output/eu5_10_tikhub_20260717/final.csv";
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const traitLabels = {
  home_decor: "家居装饰",
  fashion: "时尚穿搭",
  beauty: "美妆",
  ugc_creator: "UGC 创作者",
  versatile_brand_content: "品牌内容",
  creator_education: "创作者教育",
  skincare: "护肤",
  product_reviews: "产品测评",
  honest_skin: "真实肌肤",
  shop_bio_signal: "电商内容",
  brand_storytelling: "品牌故事",
  ugc_from_handle: "UGC",
  travel: "旅行",
  ugc_manager: "UGC 管理",
};

function traitLabel(value) {
  if (String(value).startsWith("city:")) return String(value).slice(5);
  return traitLabels[value] || String(value).replaceAll("_", " ");
}

function cityFor(item) {
  const cityTrait = (item.personalization_traits || []).find((value) => String(value).startsWith("city:"));
  if (cityTrait) return String(cityTrait).slice(5).replace(/^./, (letter) => letter.toUpperCase());
  const bio = String(item.creator_profile?.bio || "");
  const match = bio.match(/\b(Barcelona|Madrid|Murcia|BCN)\b/i);
  if (!match) return "西班牙";
  return match[1].toUpperCase() === "BCN" ? "Barcelona" : match[1];
}

const creators = report.results.map((item) => {
  const profile = item.creator_profile || {};
  const traits = item.personalization_traits || [];
  return {
    candidate_id: item.candidate_id,
    username: item.handle,
    display_name: `@${item.handle}`,
    platform: "TikTok",
    "Pipeline Stage": "01_FirstOutreach",
    email: item.to || "",
    "Screening Decision": item.status === "planned" ? "approved" : "review",
    "Allowed Channels": "email",
    followers: Number(profile.followers || 0),
    avg_views: Number(profile.avg_views_10 || 0),
    engagement_rate: Number(profile.engagement_rate || 0),
    category: traits.slice(0, 3).map(traitLabel).join(" · ") || "待补充画像",
    city: cityFor(item),
    country: profile.country || "ES",
    profile_url: profile.profile_url || `https://www.tiktok.com/@${item.handle}`,
    bio: profile.bio || "",
    personalization_traits: traits,
    review_warnings: item.review_warnings || [],
  };
});

const pendingManifest = createBatchManifest({ campaignId: report.campaign_id, report });
const manifest = {
  ...pendingManifest,
  preview_payload_sha256: payloadSha256(pendingManifest),
};

const tests = spawnSync(process.execPath, ["--test"], {
  cwd: coreRoot,
  encoding: "utf8",
});
const testOutput = `${tests.stdout || ""}\n${tests.stderr || ""}`;
const passMatch = testOutput.match(/(?:ℹ\s+)?pass\s+(\d+)/i);
const failMatch = testOutput.match(/(?:ℹ\s+)?fail\s+(\d+)/i);

const data = {
  generated_at: new Date().toISOString(),
  environment: "LOCAL_SANDBOX",
  campaign: {
    id: report.campaign_id,
    name: "西班牙 · TikTok Shop €20 首次建联",
    market: "ES",
    offer: { amount: 20, currency: "EUR" },
  },
  test_run: {
    ok: tests.status === 0,
    passed: Number(passMatch?.[1] || 0),
    failed: Number(failMatch?.[1] || 0),
  },
  creators,
  report,
  manifest,
  replies: [],
};

await writeFile(
  resolve(siteRoot, "app", "demo-data.json"),
  `${JSON.stringify(data, null, 2)}\n`,
  "utf8",
);

console.log(
  `Spain UI data generated from core modules: ${report.planned} planned, ${report.sent} sent, ${data.test_run.passed} tests passed.`,
);
