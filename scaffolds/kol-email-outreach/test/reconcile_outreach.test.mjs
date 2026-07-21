import test from "node:test";
import assert from "node:assert/strict";
import {
  pendingReplyEventsFrom, pendingSentEventsFrom, reconcileReplyGroup, replyReconciliationGroupsFrom,
} from "../reconcile_outreach.mjs";

test("reconciliation selects confirmed sends without CRM sync", () => {
  const base = {
    campaign_id: "cmp1", candidate_id: "tiktok:creator", handle: "creator",
    template_id: "step01", idempotency_key: "cmp1:tiktok:creator:step01",
  };
  const pending = pendingSentEventsFrom([{ ...base, event: "sent", provider_message_id: "<mid>" }], "cmp1");
  assert.equal(pending.length, 1);
  const done = pendingSentEventsFrom([
    { ...base, event: "sent", provider_message_id: "<mid>" },
    { ...base, event: "crm_synced" },
  ], "cmp1");
  assert.equal(done.length, 0);
});

test("reconciliation never treats a sending reservation as confirmed delivery", () => {
  const events = [{
    campaign_id: "cmp1", candidate_id: "tiktok:creator", handle: "creator",
    template_id: "step01", idempotency_key: "cmp1:tiktok:creator:step01", event: "sending",
  }];
  assert.equal(pendingSentEventsFrom(events, "cmp1").length, 0);
});

test("reconciliation keeps unsynced replies after they leave the IMAP scan window", () => {
  const reply = {
    event: "reply_received",
    event_at: "2026-07-09T00:00:00Z",
    campaign_id: "cmp1",
    candidate_id: "tiktok:creator",
    handle: "creator",
    reply_key: "reply:mid",
  };
  assert.deepEqual(pendingReplyEventsFrom([reply], "cmp1"), [reply]);
  assert.equal(pendingReplyEventsFrom([
    reply,
    { event: "reply_synced", campaign_id: "cmp1", reply_key: "reply:mid" },
  ], "cmp1").length, 0);
});

test("reply reconciliation preserves chronological order so the newest state wins", () => {
  const later = {
    event: "reply_received", event_at: "2026-07-10T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:2",
  };
  const earlier = {
    event: "reply_received", event_at: "2026-07-09T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:1",
  };
  assert.deepEqual(pendingReplyEventsFrom([later, earlier], "cmp1"), [earlier, later]);
});

test("retrying an old marker always reapplies the candidate's latest reply state", async () => {
  const oldReply = {
    event: "reply_received", event_at: "2026-07-09T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:old", outcome: "rate_quote",
  };
  const newReply = {
    event: "reply_received", event_at: "2026-07-10T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:new", outcome: "declined",
  };
  const groups = replyReconciliationGroupsFrom([
    oldReply,
    newReply,
    { event: "reply_synced", campaign_id: "cmp1", reply_key: "reply:new" },
  ], "cmp1");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].pending, [oldReply]);
  assert.equal(groups[0].latest, newReply);

  const applied = [];
  const logged = [];
  const marked = [];
  await reconcileReplyGroup(groups[0], {
    async ensureLog(event) { logged.push(event.reply_key); },
    async applyState(event) { applied.push(event.outcome); },
    async markSynced(event) { marked.push(event.reply_key); },
  });
  assert.deepEqual(logged, ["reply:old"]);
  assert.deepEqual(applied, ["declined"]);
  assert.deepEqual(marked, ["reply:old"]);
});
