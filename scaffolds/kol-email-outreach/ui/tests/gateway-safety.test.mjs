import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { validateExecutionPayload, validateSenderInput } from "../server/outreach-gateway.mjs";
import { canonicalBatchSnapshot, canonicalItemPayload } from "../lib/outreach-contract.mjs";

const TENANT = "a".repeat(16);
const CAMPAIGN = `${TENANT}:campaign_1`;

function item(overrides = {}) {
  const value = {
    id: "item_1",
    project_id: "project_1",
    creator_id: "tiktok:creator",
    candidate_id: "tiktok:creator",
    handle: "creator",
    recipient_email: "creator@example.com",
    sender_id: "sender_1",
    from_name: "Vira",
    from_email: "vira@example.com",
    reply_to_email: "",
    subject: "Paid collaboration",
    body: "Hi!\n\nWould you be interested?\n\nVira",
    idempotency_key: `${CAMPAIGN}:tiktok:creator:step01`,
    ...overrides,
  };
  value.payload_hash = createHash("sha256").update(canonicalItemPayload(value)).digest("hex");
  return value;
}

function batch(items, overrides = {}) {
  const value = {
    run_id: "run_1", batch_id: "batch_1", project_id: "project_1", campaign_id: CAMPAIGN,
    delay_ms: 0, items, ...overrides,
  };
  value.approved_hash = createHash("sha256").update(canonicalBatchSnapshot(value)).digest("hex");
  return value;
}

test("sender credentials are validated and remain a write-only input", () => {
  const input = {
    id: "sender_1",
    owner_key: TENANT,
    label: "Vira Gmail",
    from_name: "Vira",
    from_email: "VIRA@example.com",
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    secure: true,
    daily_cap: 25,
    password: "app-password",
  };
  const sender = validateSenderInput(input);
  assert.equal(sender.email, "vira@example.com");
  assert.equal(sender.dailyCap, 25);
  assert.equal(sender.verified, false);
  assert.throws(() => validateSenderInput({ ...input, from_email: "bad", password: "x" }), /invalid sender email/);
  assert.throws(() => validateSenderInput({ ...input, from_name: "Bad\nBcc", password: "x" }), /invalid sender name/);
});

test("a frozen batch validates stable ids, endpoints and item hashes", () => {
  const parsed = validateExecutionPayload(batch([item()]));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.delayMs, 1000);

  const tampered = item();
  tampered.payload_hash = "0".repeat(64);
  assert.throws(() => validateExecutionPayload(batch([tampered])), /payload hash mismatch/);

  const second = item({ id: "item_2", creator_id: "tiktok:other", candidate_id: "tiktok:other", handle: "other", idempotency_key: `${CAMPAIGN}:tiktok:other:step01` });
  assert.throws(() => validateExecutionPayload(batch([item(), second])), /duplicate recipient/);

  const altered = batch([item()]);
  altered.items[0].body += " changed";
  altered.items[0].payload_hash = createHash("sha256").update(canonicalItemPayload(altered.items[0])).digest("hex");
  assert.throws(() => validateExecutionPayload(altered), /approved batch hash mismatch/);

  const ordered = batch([item(), item({
    id: "item_3", creator_id: "tiktok:third", candidate_id: "tiktok:third", handle: "third",
    recipient_email: "third@example.com", idempotency_key: `${CAMPAIGN}:tiktok:third:step01`,
  })]);
  assert.equal(validateExecutionPayload(ordered).items.length, 2);
  assert.throws(() => validateExecutionPayload({ ...ordered, items: [...ordered.items].reverse() }), /approved batch hash mismatch/);
});
