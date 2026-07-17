import test from "node:test";
import assert from "node:assert/strict";
import {
  approveBatch, createBatchManifest, payloadSha256, validateApprovedBatch,
} from "../lib/outreach_batch.mjs";

function report() {
  return {
    results: [{
      status: "planned",
      candidate_id: "tiktok:creator",
      handle: "creator",
      idempotency_key: "cmp1:tiktok:creator:step01",
      channel: "email",
      to: "creator@example.com",
      sender_account: "alice",
      from: "alice@example.com",
      subject: "Rate inquiry",
      body: "Please share your rate.",
      personalization: "template",
    }],
  };
}

test("approved manifest binds the exact reviewed payload", () => {
  const pending = createBatchManifest({ campaignId: "cmp1", report: report() });
  assert.equal(pending.approval.status, "pending");
  const approved = approveBatch(pending, "reviewer@example.com");
  assert.equal(approved.approval.payload_sha256, payloadSha256(approved));
  assert.equal(validateApprovedBatch(approved, "cmp1").items.length, 1);
});

test("editing a payload after approval invalidates the manifest", () => {
  const approved = approveBatch(
    createBatchManifest({ campaignId: "cmp1", report: report() }),
    "reviewer@example.com",
  );
  approved.items[0].body = "Changed after review";
  assert.throws(() => validateApprovedBatch(approved, "cmp1"), /changed after approval/);
});

test("content-template identity and personalization evidence are approval-bound", () => {
  const source = report();
  source.results[0] = {
    ...source.results[0],
    content_template_id: "spain-tiktok-shop-eur20",
    content_template_version: "2026-07-17.1",
    content_template_sha256: "a".repeat(64),
    outreach_intent: "fixed_offer",
    followup_mode: "disabled",
    personalization_evidence: ["bio"],
    personalization_traits: ["ugc_creator"],
    review_warnings: ["tiktok_shop_product_link_capability_unverified"],
  };
  const approved = approveBatch(
    createBatchManifest({ campaignId: "cmp1", report: source }),
    "reviewer",
    { acceptReviewWarnings: true },
  );
  approved.items[0].personalization_evidence.push("invented_video");
  assert.throws(() => validateApprovedBatch(approved, "cmp1"), /changed after approval/);
});

test("review warnings require a separate explicit acknowledgement", () => {
  const source = report();
  source.results[0].review_warnings = ["tiktok_shop_product_link_capability_unverified"];
  const manifest = createBatchManifest({ campaignId: "cmp1", report: source });
  assert.throws(() => approveBatch(manifest, "reviewer"), /unresolved review warnings/);
  const approved = approveBatch(manifest, "reviewer", { acceptReviewWarnings: true });
  assert.equal(approved.approval.review_warnings_accepted, true);
  assert.doesNotThrow(() => validateApprovedBatch(approved, "cmp1"));
});

test("a multi-recipient default rate-inquiry batch shares one content-template identity", () => {
  const source = report();
  source.results.push({
    ...source.results[0],
    candidate_id: "tiktok:second",
    handle: "second",
    idempotency_key: "cmp1:tiktok:second:step01",
    to: "second@example.com",
    subject: "Rate inquiry for second",
    body: "Hi second, please share your rate.",
  });
  const manifest = createBatchManifest({ campaignId: "cmp1", report: source });
  assert.equal(manifest.items[0].content_template_sha256, manifest.items[1].content_template_sha256);
  assert.doesNotThrow(() => validateApprovedBatch(approveBatch(manifest, "reviewer"), "cmp1"));
});

test("approval rejects a subject that execute would otherwise normalize", () => {
  const source = report();
  source.results[0].subject = "Approved subject\r\nBcc: victim@example.com";
  const manifest = createBatchManifest({ campaignId: "cmp1", report: source });
  assert.throws(() => approveBatch(manifest, "reviewer"), /subject is not in canonical send form/);
});

test("approval rejects different candidate IDs that point to the same recipient", () => {
  const source = report();
  source.results.push({
    ...source.results[0],
    candidate_id: "tiktok:duplicate-record",
    handle: "duplicate-record",
    idempotency_key: "cmp1:tiktok:duplicate-record:step01",
  });
  const manifest = createBatchManifest({ campaignId: "cmp1", report: source });
  assert.throws(() => approveBatch(manifest, "reviewer"), /duplicate recipient endpoint/);
});
