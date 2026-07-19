import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreatorRows, parseCandidateDocument, parseCsv } from "../lib/creator-import.mjs";

test("creator import accepts analyzer CSV and preserves public evidence", () => {
  const csv = `candidate_id,username,email,followers,avg_views,category,bio,recent_video_titles,source\n` +
    `tiktok:ana,ana.es,ana@example.com,"8,200",12500,"beauty;ugc_creator","Beauty creator, Madrid","summer routine|lip review",fastmoss_web\n`;
  const parsed = parseCsv(csv);
  const result = normalizeCreatorRows(parsed, { source: "spain-final.csv" });
  assert.equal(result.contract_version, "outreach-candidate.v1");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted[0].followers, 8200);
  assert.deepEqual(result.accepted[0].traits, ["beauty", "ugc_creator"]);
  assert.deepEqual(result.accepted[0].evidence.map((item) => item.title), ["summer routine", "lip review"]);
});

test("creator import supports MCP JSON envelopes and rejects unsafe rows", () => {
  const document = JSON.stringify({ rows: [
    { username: "valid_creator", email: "valid@example.com", profile_url: "https://www.tiktok.com/@valid_creator", bio: "Spanish home creator" },
    { username: "missing_email", followers: 1000 },
    { username: "duplicate_email", email: "valid@example.com" },
  ] });
  const rows = parseCandidateDocument(document, "mcp-result.json");
  const result = normalizeCreatorRows(rows);
  assert.equal(result.total, 3);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /联系邮箱/);
  assert.match(result.rejected[1].reason, /邮箱重复/);
});

test("creator import accepts one JSON creator and percentage engagement", () => {
  const rows = parseCandidateDocument(JSON.stringify({ username: "solo_creator", email: "solo@example.com", engagement_rate: "3.8%" }), "creator.json");
  const result = normalizeCreatorRows(rows);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].engagement_rate, 0.038);
});

test("creator import caps file size and row count", () => {
  assert.throws(() => parseCandidateDocument("x".repeat(5_000_001), "data.json"), /5 MB/);
  const rows = Array.from({ length: 1001 }, (_, index) => ({ username: `creator${index}`, email: `c${index}@example.com` }));
  assert.throws(() => parseCandidateDocument(JSON.stringify(rows), "data.json"), /1,000/);
});
