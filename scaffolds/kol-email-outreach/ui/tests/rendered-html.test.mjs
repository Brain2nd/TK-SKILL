import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the app defines a Chinese LOOP project workspace shell", async () => {
  const [layout, page] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /LOOP Creator OS · First Outreach Agent/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(page, /正在读取项目工作台/);
  assert.match(page, /本地 D1 与安全发送网关/);
  assert.doesNotMatch(`${layout}\n${page}`, /Northstar|APAC-Q3-LAUNCH|Maya Chen/);
});

test("Spain seed remains ten personalized English EUR20 previews with zero sends", async () => {
  const data = JSON.parse(await readFile(new URL("../app/demo-data.json", import.meta.url), "utf8"));
  assert.equal(data.report.mode, "dry-run");
  assert.equal(data.report.preview_only, true);
  assert.equal(data.report.planned, 10);
  assert.equal(data.report.sent, 0);
  assert.equal(data.manifest.items.length, 10);
  for (const item of data.manifest.items) {
    assert.equal(item.subject, "Paid TikTok Shop short-form video opportunity");
    assert.match(item.body, /You will receive €20 for the post\./);
    assert.match(item.body, /https:\/\/vm\.tiktok\.com\/ZNRoT8PuT\//);
    assert.match(item.body, /\n\nVira$/);
    assert.equal(item.followup_mode, "disabled");
  }
});

test("project UI delegates persistence and sending to server routes", async () => {
  const [page, workspaceRoute, sendRoute, gateway, schema] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/send/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../server/outreach-gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /项目中心/);
  assert.match(page, /新建项目/);
  assert.match(page, /正式入队发送/);
  assert.match(page, /应用密码.*只写/s);
  assert.match(page, /AI 个性化配置/);
  assert.match(page, /AI 生成.*封审批邮件/);
  assert.doesNotMatch(page, /\bsendMail\s*\(/i);
  assert.match(workspaceRoute, /create_project/);
  assert.doesNotMatch(workspaceRoute, /createPendingBatch/);
  assert.match(sendRoute, /personalizationRequestForProject/);
  assert.match(sendRoute, /personalize-batch/);
  assert.match(sendRoute, /createPendingBatch/);
  assert.match(sendRoute, /execute_batch/);
  assert.match(gateway, /personalizeHook/);
  assert.match(gateway, /personalizationCache/);
  assert.match(gateway, /event: "sending"/);
  assert.match(gateway, /event: "delivery_unknown"/);
  assert.match(gateway, /withRunLock/);
  assert.match(gateway, /jobs\.get\(parsed\.runId\)/);
  assert.match(schema, /sendBatchItems/);
  assert.doesNotMatch(schema, /password|appPassword|smtpPassword/i);
});
