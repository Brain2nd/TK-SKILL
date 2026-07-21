import test from "node:test";
import assert from "node:assert/strict";
import { buildResolutionEvent } from "../resolve_delivery_unknown.mjs";

const source = {
  event: "delivery_unknown",
  event_at: "2026-07-17T00:00:00.000Z",
  campaign_id: "cmp1",
  candidate_id: "tiktok:creator",
  template_id: "step01",
  idempotency_key: "cmp1:tiktok:creator:step01",
  outreach_attempt_id: "attempt-1",
  provider_message_id: "<outreach.attempt-1@example.com>",
  recipient_endpoint: "email:creator@example.com",
};

test("manual sent resolution must match the preallocated Message-ID", () => {
  assert.throws(() => buildResolutionEvent(source, {
    resolution: "sent", messageId: "<different@example.com>", note: "Checked the Sent folder",
  }), /does not match/);
  const event = buildResolutionEvent(source, {
    resolution: "sent", messageId: "<outreach.attempt-1@example.com>", note: "Checked the Sent folder",
  });
  assert.equal(event.event, "sent");
  assert.equal(event.reconciliation, "manual_provider_check");
});

test("manual not-sent resolution is explicit and preserves the attempt identity", () => {
  const event = buildResolutionEvent(source, {
    resolution: "not-sent", messageId: "", note: "Provider and Sent folder both checked",
  });
  assert.equal(event.event, "delivery_not_sent");
  assert.equal(event.outreach_attempt_id, source.outreach_attempt_id);
  assert.equal(event.recipient_endpoint, source.recipient_endpoint);
});
