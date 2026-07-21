import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "path";
import { buildAnalyzerPreview, renderHtml } from "../preview_analyzer_batch.mjs";

test("the checked Spain batch renders ten previews with zero side effects", async () => {
  const report = await buildAnalyzerPreview({
    candidates: resolve("../tikhub-kol-analyzer/output/eu5_10_tikhub_20260717/final.csv"),
    country: "ES",
    template: resolve("outreach_templates/spain-tiktok-shop-eur20.json"),
    campaignId: "spain-preview-test",
    limit: 10,
  });
  assert.equal(report.country_rows, 10);
  assert.equal(report.planned, 10);
  assert.equal(report.sent, 0);
  assert.deepEqual(report.side_effects, { smtp_sends: 0, tiktok_dm_sends: 0, feishu_writes: 0 });
  const planned = report.results.filter(item => item.status === "planned");
  assert.equal(new Set(planned.map(item => item.body)).size > 1, true);
  assert.equal(planned.every(item => item.body.includes("You will receive €20 for the post.")), true);
  assert.equal(planned.every(item => item.body.includes("https://vm.tiktok.com/ZNRoT8PuT/")), true);
  assert.equal(planned.every(item => item.review_warnings.includes("tiktok_shop_product_link_capability_unverified")), true);
  const html = renderHtml(report);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /个性化邮件审批预览/);
  assert.match(html, /人工审核项/);
  assert.match(html, /尚未确认该账号具备添加 TikTok Shop 商品链接的能力/);
  assert.doesNotMatch(html, /Personalized email approval preview|Review gates|followers|avg views/);
  assert.match(html, /You will receive €20 for the post\./);
});
