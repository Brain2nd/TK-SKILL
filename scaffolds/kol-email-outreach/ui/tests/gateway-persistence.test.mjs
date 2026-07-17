import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { canonicalBatchSnapshot, canonicalItemPayload } from "../lib/outreach-contract.mjs";

const TENANT = "b".repeat(16);
const CAMPAIGN = `${TENANT}:campaign_persist`;

function executionPayload() {
  const item = {
    id: "item_persist", project_id: "project_persist", creator_id: "tiktok:persist",
    candidate_id: "tiktok:persist", handle: "persist", recipient_email: "persist@example.com",
    sender_id: "sender_missing", from_name: "Vira", from_email: "vira@example.com",
    reply_to_email: "", subject: "Paid collaboration", body: "Hi!\n\nWould you be interested?\n\nVira",
    idempotency_key: `${CAMPAIGN}:tiktok:persist:step01`,
  };
  item.payload_hash = createHash("sha256").update(canonicalItemPayload(item)).digest("hex");
  const payload = {
    run_id: `run_persist_${randomUUID()}`, batch_id: "batch_persist", project_id: "project_persist",
    campaign_id: CAMPAIGN, delay_ms: 1000, items: [item],
  };
  payload.approved_hash = createHash("sha256").update(canonicalBatchSnapshot(payload)).digest("hex");
  return payload;
}

async function listen(module, options = {}) {
  const server = await module.startGateway({ host: "127.0.0.1", port: 0, ...options });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("send jobs survive a gateway restart without retrying SMTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-gateway-"));
  process.env.LOOP_GATEWAY_DATA_ROOT = root;
  process.env.LOOP_OUTREACH_JOURNAL = join(root, "journal.jsonl");
  process.env.LOOP_OUTREACH_LOCK = join(root, "run.lock");
  process.env.LOOP_SENDER_STATE = join(root, "sender-state.json");
  const payload = executionPayload();
  let firstServer;
  let secondServer;
  try {
    const firstModule = await import(`../server/outreach-gateway.mjs?first=${randomUUID()}`);
    const first = await listen(firstModule);
    firstServer = first.server;
    const configured = await fetch(`${first.base}/senders`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        id: "sender_write_only", owner_key: TENANT, label: "Write only", from_name: "Vira", from_email: "vira@example.com",
        smtp_host: "smtp.example.com", smtp_port: 465, secure: true, daily_cap: 5, password: "never-return-this",
      }),
    }).then((response) => response.json());
    assert.equal(configured.ok, true);
    assert.doesNotMatch(JSON.stringify(configured), /never-return-this|password/i);
    const listed = await fetch(`${first.base}/senders?owner_key=${TENANT}`).then((response) => response.json());
    assert.doesNotMatch(JSON.stringify(listed), /never-return-this|password/i);
    const aiConfigured = await fetch(`${first.base}/ai/configure`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        owner_key: TENANT, provider: "anthropic", model: "claude-sonnet-4-6",
        api_key: "never-return-this-ai-key-1234567890",
      }),
    }).then((response) => response.json());
    assert.equal(aiConfigured.ok, true);
    assert.equal(aiConfigured.ai.configured, true);
    assert.doesNotMatch(JSON.stringify(aiConfigured), /never-return-this|api_key/i);
    const aiStatus = await fetch(`${first.base}/ai?owner_key=${TENANT}`).then((response) => response.json());
    assert.equal(aiStatus.ai.configured, true);
    assert.doesNotMatch(JSON.stringify(aiStatus), /never-return-this|api_key/i);
    const accepted = await fetch(`${first.base}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    }).then((response) => response.json());
    assert.equal(accepted.ok, true);

    let job = accepted.job;
    const deadline = Date.now() + 5000;
    while (!["paused", "completed", "delivery_unknown"].includes(job.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = await fetch(`${first.base}/jobs/${payload.run_id}`).then((response) => response.json()).then((value) => value.job);
    }
    assert.equal(job.status, "paused");
    assert.equal(job.counts.failed, 1);
    assert.equal(job.counts.sent, 0);
    await new Promise((resolve, reject) => firstServer.close((error) => error ? reject(error) : resolve()));
    firstServer = null;

    const ledger = await readFile(join(root, "send-jobs.json"), "utf8");
    assert.match(ledger, new RegExp(payload.run_id));
    assert.doesNotMatch(ledger, /password/i);

    const secondModule = await import(`../server/outreach-gateway.mjs?second=${randomUUID()}`);
    const second = await listen(secondModule);
    secondServer = second.server;
    const restored = await fetch(`${second.base}/jobs/${payload.run_id}`).then((response) => response.json());
    assert.equal(restored.ok, true);
    assert.equal(restored.job.status, "paused");
    assert.equal(restored.job.counts.sent, 0);
    assert.ok(restored.job.revision >= job.revision);
  } finally {
    if (firstServer) await new Promise((resolve) => firstServer.close(resolve));
    if (secondServer) await new Promise((resolve) => secondServer.close(resolve));
    delete process.env.LOOP_GATEWAY_DATA_ROOT;
    delete process.env.LOOP_OUTREACH_JOURNAL;
    delete process.env.LOOP_OUTREACH_LOCK;
    delete process.env.LOOP_SENDER_STATE;
    await rm(root, { recursive: true, force: true });
  }
});
