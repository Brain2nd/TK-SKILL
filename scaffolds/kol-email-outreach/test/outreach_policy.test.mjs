import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFromRecord, evaluateCandidate, normalizeEmail, normalizeHandle, sanitizeSubject,
} from "../lib/outreach_policy.mjs";

test("normalizes profile URLs, handles, and emails", () => {
  assert.equal(normalizeHandle("https://www.tiktok.com/@Creator.Name?x=1"), "creator.name");
  assert.equal(normalizeHandle("@Creator_Name"), "creator_name");
  assert.equal(normalizeHandle("https://instagram.com/Creator-Name/"), "creator-name");
  assert.equal(normalizeHandle("bad handle"), "");
  assert.equal(normalizeEmail(" Creator@Example.COM "), "creator@example.com");
  assert.equal(normalizeEmail("bad@example"), "");
});

test("maps the v1-compatible CRM aliases", () => {
  const candidate = candidateFromRecord({
    record_id: "rec1",
    fields: {
      username: "@Creator",
      nickname: "Creator Name",
      user_id: "stable-123",
      platform: "TikTok",
      email: "CREATOR@example.com",
      "Pipeline Stage": "00_Discovered",
      screening_decision: "approved",
    },
  });
  assert.deepEqual(
    { id: candidate.candidateId, handle: candidate.handle, name: candidate.displayName, email: candidate.email },
    { id: "stable-123", handle: "creator", name: "Creator Name", email: "creator@example.com" },
  );
});

test("requires approval, valid contact, and no suppression", () => {
  const base = { username: "creator", email: "creator@example.com", "Pipeline Stage": "00_Discovered" };
  assert.equal(evaluateCandidate({ fields: base }, { requireApproval: true }).reason, "screening_not_approved");
  assert.equal(evaluateCandidate({ fields: { ...base, screening_decision: "approved", "Do Not Contact": true } }, { requireApproval: true }).reason, "suppressed");
  assert.equal(evaluateCandidate({ fields: { ...base, email: "", screening_decision: "approved" } }, { requireApproval: true }).reason, "missing_valid_email");
  assert.equal(evaluateCandidate({ fields: { ...base, email: "", screening_decision: "approved" } }, { requireApproval: true, allowDmFallback: true }).eligible, true);
  assert.equal(
    evaluateCandidate({ fields: { ...base, screening_decision: "approved", "Allowed Channels": "tiktok_dm" } }, { requireApproval: true }).reason,
    "contact_channel_not_allowed",
  );
});

test("removes header injection from subjects", () => {
  assert.equal(sanitizeSubject("Hello\r\nBcc: victim@example.com"), "Hello Bcc: victim@example.com");
});
