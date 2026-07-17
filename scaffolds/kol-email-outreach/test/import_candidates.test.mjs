import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, parseCsv, planCandidateImport } from "../import_candidates.mjs";

test("legacy CSV parser preserves commas, escaped quotes, and multiline fields", () => {
  const rows = parseCsv('username,bio,email\r\ncreator,"Says ""hello"", posts\nweekly",CREATOR@example.com\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bio, 'Says "hello", posts\nweekly');
});

test("a reused handle cannot overwrite another stable creator identity", () => {
  const oldRecord = { record_id: "old", fields: { username: "creator", candidate_id: "tiktok:old", email: "old@example.com" } };
  const incoming = canonicalize({
    candidate_id: "tiktok:new", handle: "creator", email: "new@example.com",
    screening: { decision: "approved" },
  });
  const plan = planCandidateImport(incoming, {
    byId: new Map([["tiktok:old", oldRecord]]),
    byHandle: new Map([["creator", oldRecord]]),
  });
  assert.equal(plan.action, "reject");
  assert.equal(plan.reason, "handle_identity_conflict_in_crm");
});

test("the same stable identity may update its handle and stage-00 contact", () => {
  const oldRecord = {
    record_id: "rec1",
    fields: { username: "old_handle", candidate_id: "tiktok:stable", email: "old@example.com", "Pipeline Stage": "00_Discovered" },
  };
  const incoming = canonicalize({
    candidate_id: "tiktok:stable", handle: "new_handle", email: "new@example.com",
    screening: { decision: "approved" },
  });
  const plan = planCandidateImport(incoming, {
    byId: new Map([["tiktok:stable", oldRecord]]),
    byHandle: new Map([["old_handle", oldRecord]]),
  });
  assert.equal(plan.action, "update");
  assert.equal(plan.fields.username, "new_handle");
  assert.equal(plan.fields.email, "new@example.com");
});

test("canonical persona handoff maps only traceable outreach inputs", () => {
  const candidate = canonicalize({
    schema_version: "outreach-candidate.v1",
    candidate_id: "tiktok:stable-1",
    platform: "tiktok",
    handle: "@Creator",
    display_name: "Creator Name",
    contacts: { emails: [{ address: "Creator@Example.com", status: "valid" }] },
    screening: { decision: "approved", final_score: 0.8 },
    contact_policy: { do_not_contact: false, allowed_channels: ["email"] },
    profile: { followers: 120000, recent_videos: [{ description: "Summer haul" }] },
  });
  assert.equal(candidate.handle, "creator");
  assert.equal(candidate.fields.candidate_id, "tiktok:stable-1");
  assert.equal(candidate.fields.email, "creator@example.com");
  assert.equal(candidate.fields.screening_decision, "approved");
  assert.equal(candidate.fields["Allowed Channels"], "email");
  assert.match(candidate.fields["Recent Videos JSON"], /Summer haul/);
});

test("EU analyzer aliases preserve public metrics and contact provenance", () => {
  const candidate = canonicalize({
    username: "spain_creator",
    avg_views_10: "47,423",
    engagement_rate: "0.1074",
    shop_signals: "1",
    email: "creator@example.com",
    email_source: "bio",
    email_verified: "True",
  });
  assert.equal(candidate.fields.avg_views, "47,423");
  assert.equal(candidate.fields.engagement_rate, 0.1074);
  assert.equal(candidate.fields.shop_signals, 1);
  assert.equal(candidate.fields.email_source, "bio");
  assert.equal(candidate.fields.email_verified, true);
});
