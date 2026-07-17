import test from "node:test";
import assert from "node:assert/strict";
import { assertCandidateIdentity, buildOutreach, renderTemplateForCreator } from "../lib/kol_crm.mjs";

test("stable identity resolution fails closed when candidate_id is missing", () => {
  assert.throws(
    () => assertCandidateIdentity({ record_id: "rec1", fields: { username: "creator" } }, "tiktok:creator"),
    /candidate_id missing/,
  );
});

test("stable identity resolution rejects a reused record or handle", () => {
  assert.throws(
    () => assertCandidateIdentity({ record_id: "rec1", fields: { candidate_id: "tiktok:other" } }, "tiktok:creator"),
    /candidate identity changed/,
  );
  const record = { record_id: "rec1", fields: { candidate_id: [{ text: "tiktok:creator" }] } };
  assert.equal(assertCandidateIdentity(record, "tiktok:creator"), record);
});

test("template rendering normalizes Feishu people/select field shapes", async () => {
  const creator = {
    record_id: "rec1",
    fields: {
      username: [{ text: "creator" }],
      email: [{ text: "creator@example.com" }],
      followers: 10000,
      "Assigned To": [{ name: "Alice" }],
    },
  };
  const rendered = await renderTemplateForCreator({
    creator_handle: "creator", creator_record: creator, step: 1,
  });
  const outreach = await buildOutreach({ creator_handle: "creator", creator_record: creator, step: 1 });
  assert.equal(rendered.toEmail, "creator@example.com");
  assert.equal(outreach.emailTo, "creator@example.com");
});
