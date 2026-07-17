import test from "node:test";
import assert from "node:assert/strict";
import { runFirstOutreachMonitor } from "../lib/first_outreach_monitor_agent.mjs";
import { classifyFirstReply } from "../lib/first_reply_classifier.mjs";

const sentAt = "2026-07-01T00:00:00.000Z";

function creator(handle = "creator", email = `${handle}@example.com`) {
  return {
    record_id: `rec-${handle}`,
    fields: {
      username: handle,
      email,
      "Pipeline Stage": "01_FirstOutreach",
    },
  };
}

function initialEvent(handle = "creator", overrides = {}) {
  return {
    event: "sent",
    event_at: sentAt,
    campaign_id: "cmp1",
    candidate_id: `tiktok:${handle}`,
    handle,
    template_id: "step01",
    channel: "email",
    sender: "alice@example.com",
    provider_message_id: handle === "creator" ? "<outbound-1@example.com>" : `<outbound-${handle}@example.com>`,
    outreach_attempt_id: handle === "creator" ? "attempt-1" : `attempt-${handle}`,
    idempotency_key: `cmp1:tiktok:${handle}:step01`,
    ...overrides,
  };
}

function deps({ replies = [], events = [initialEvent()] } = {}) {
  const calls = { replyRecords: 0, replySyncs: 0, followupSends: 0, followupRecords: 0 };
  let currentEvents = [...events];
  return {
    calls,
    async listCandidates() { return [creator()]; },
    async listEvents() { return currentEvents; },
    async listReplies() { return replies; },
    async classifyReply(reply) { return classifyFirstReply(reply); },
    async recordReply({ candidate, replyKey, classification }) {
      calls.replyRecords++;
      currentEvents.push({ event: "reply_received", campaign_id: "cmp1", candidate_id: candidate.candidateId, reply_key: replyKey, outcome: classification.outcome });
    },
    async ensureReplyLog() {},
    async applyReplyState() { calls.replySyncs++; },
    async applyReplyEventState() { calls.replySyncs++; },
    async recordReplySynced({ candidate, replyKey }) {
      currentEvents.push({ event: "reply_synced", campaign_id: "cmp1", candidate_id: candidate.candidateId, reply_key: replyKey });
    },
    getSender() { return { name: "alice", user: "alice@example.com" }; },
    async buildFollowup() { return { subject: "Follow-up", body: "Could you share your rate?" }; },
    async hasReply() { return currentEvents.some(event => event.event === "reply_received"); },
    async hasFollowup() { return currentEvents.some(event => event.template_id === "step01_followup" && event.event !== "failed"); },
    async reserveFollowup({ candidate }) {
      return {
        outreach_attempt_id: `followup-${candidate.handle}`,
        campaign_id: "cmp1",
        candidate_id: candidate.candidateId,
        idempotency_key: `cmp1:${candidate.candidateId}:step01_followup`,
        template_id: "step01_followup",
        provider_message_id: `<followup-${candidate.handle}@example.com>`,
      };
    },
    async sendFollowup() { calls.followupSends++; return { ok: true, messageId: "<followup@example.com>" }; },
    async recordFollowupUnknown() {},
    async recordFollowupFailure() {},
    async recordFollowupSent() { calls.followupRecords++; },
    async syncFollowup() {},
    async sleep() {},
  };
}

test("a rate reply is structured and handed off without a follow-up", async () => {
  const reply = {
    inbox: "alice",
    uid: 10,
    messageId: "<reply-1@example.com>",
    inReplyTo: "<outbound-1@example.com>",
    references: [],
    fromAddress: "creator@example.com",
    text: "Interested — my rate is USD 900 and 30 days organic usage is included.",
  };
  const fake = deps({ replies: [reply] });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", now: new Date("2026-07-16T00:00:00Z"),
  }, fake);
  assert.equal(report.handoffs, 1);
  assert.equal(report.followups_due, 0);
  assert.equal(fake.calls.replyRecords, 1);
  assert.equal(fake.calls.replySyncs, 1);
  assert.equal(fake.calls.followupSends, 0);
});

test("seven days without a reply produces exactly one same-sender follow-up", async () => {
  const fake = deps();
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(report.followups_due, 1);
  assert.equal(report.followups_sent, 1);
  assert.equal(fake.calls.followupSends, 1);
  assert.equal(fake.calls.followupRecords, 1);
});

test("one ambiguous follow-up stops every later provider call in the same run", async () => {
  const events = [initialEvent("first"), initialEvent("second")];
  const fake = deps({ events });
  fake.listCandidates = async () => [creator("first"), creator("second")];
  fake.sendFollowup = async () => {
    fake.calls.followupSends++;
    throw new Error("SMTP connection closed after DATA");
  };
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(fake.calls.followupSends, 1);
  assert.equal(report.delivery_circuit.open, true);
  assert.equal(report.results.find(item => item.handle === "first").status, "needs_reconciliation");
  assert.equal(report.results.find(item => item.handle === "second").reason, "delivery_circuit_open");
});

test("an unresolved outbound attempt from a prior process blocks follow-up SMTP", async () => {
  const events = [
    initialEvent(),
    {
      event: "delivery_unknown", event_at: "2026-07-07T00:00:00Z", campaign_id: "cmp-old",
      candidate_id: "tiktok:other", idempotency_key: "cmp-old:tiktok:other:step01",
      outreach_attempt_id: "unknown-old", template_id: "step01",
    },
  ];
  const fake = deps({ events });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(fake.calls.followupSends, 0);
  assert.equal(report.delivery_circuit.open, true);
  assert.equal(report.results.find(item => item.action === "followup").reason, "delivery_circuit_open");
});

test("a confirmed follow-up whose sent event cannot be persisted opens the circuit", async () => {
  const events = [initialEvent("first"), initialEvent("second")];
  const fake = deps({ events });
  fake.listCandidates = async () => [creator("first"), creator("second")];
  fake.recordFollowupSent = async () => { throw new Error("journal disk unavailable"); };
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(fake.calls.followupSends, 1);
  assert.equal(report.followups_sent, 1);
  assert.equal(report.pending_sync, 1);
  assert.equal(report.results.find(item => item.handle === "second").reason, "delivery_circuit_open");
});

test("a fresh opt-out or stage change blocks follow-up at the final send barrier", async () => {
  const fake = deps();
  fake.refreshCandidate = async () => ({
    ...creator(),
    candidateId: "tiktok:creator",
    handle: "creator",
    email: "creator@example.com",
    stage: "Suppressed",
    suppressed: true,
    allowedChannels: [],
  });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(fake.calls.followupSends, 0);
  assert.equal(report.results[0].reason, "candidate_changed_before_followup");
});

test("a reply arriving after the main inbox scan blocks follow-up", async () => {
  const fake = deps();
  fake.hasLiveReply = async () => true;
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(fake.calls.followupSends, 0);
  assert.equal(report.results[0].reason, "reply_arrived_during_send_barrier");
});

test("a missing original Message-ID blocks follow-up before any provider call", async () => {
  const event = { ...initialEvent(), provider_message_id: "" };
  const fake = deps({ events: [event] });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].reason, "missing_original_message_id");
  assert.equal(fake.calls.followupSends, 0);
});

test("an unsafe original Message-ID is rejected before reserving a follow-up", async () => {
  const event = { ...initialEvent(), provider_message_id: "<root@example.com>\r\nBcc: victim@example.com" };
  const fake = deps({ events: [event] });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].reason, "missing_original_message_id");
  assert.equal(fake.calls.followupSends, 0);
});

test("a DM first contact can never trigger an email follow-up", async () => {
  const event = { ...initialEvent(), channel: "tiktok_dm", provider_message_id: "dm-1" };
  const fake = deps({ events: [event] });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(report.results[0].reason, "non_email_initial_contact");
  assert.equal(fake.calls.followupSends, 0);
});

test("a fixed-offer template with disabled follow-up never receives the old rate inquiry", async () => {
  const event = { ...initialEvent(), outreach_intent: "fixed_offer", followup_mode: "disabled" };
  const fake = deps({ events: [event] });
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", followupDays: 7, now: new Date("2026-07-08T00:00:01Z"),
  }, fake);
  assert.equal(report.results[0].reason, "followup_disabled_for_content_template");
  assert.equal(report.followups_due, 0);
  assert.equal(fake.calls.followupSends, 0);
});

test("monitor dry-run never writes replies or sends follow-ups", async () => {
  const fake = deps();
  const report = await runFirstOutreachMonitor({
    campaignId: "cmp1", now: new Date("2026-07-16T00:00:00Z"),
  }, fake);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.followups_due, 1);
  assert.equal(fake.calls.followupSends, 0);
  assert.equal(fake.calls.followupRecords, 0);
});

test("multiple replies are applied oldest-to-newest so the latest status wins", async () => {
  const replies = [
    {
      inbox: "alice", uid: 2, messageId: "<new>", inReplyTo: "<outbound-1@example.com>", references: [],
      fromAddress: "creator@example.com", date: "2026-07-10T00:00:00Z", text: "No thanks, not interested.",
    },
    {
      inbox: "alice", uid: 1, messageId: "<old>", inReplyTo: "<outbound-1@example.com>", references: [],
      fromAddress: "creator@example.com", date: "2026-07-09T00:00:00Z", text: "My TikTok rate is USD 900.",
    },
  ];
  const fake = deps({ replies });
  const order = [];
  fake.applyReplyState = async ({ classification }) => { order.push(classification.outcome); };
  await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", now: new Date("2026-07-11T00:00:00Z"),
  }, fake);
  assert.deepEqual(order, ["rate_quote", "declined"]);
});

test("retrying an old reply marker restores a newer already-synced state", async () => {
  const oldReply = {
    inbox: "alice", uid: 1, messageId: "<old>", inReplyTo: "<outbound-1@example.com>", references: [],
    fromAddress: "creator@example.com", date: "2026-07-09T00:00:00Z", text: "My rate is USD 900.",
  };
  const oldEvent = {
    event: "reply_received", event_at: "2026-07-09T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:old", outcome: "rate_quote",
  };
  const newEvent = {
    event: "reply_received", event_at: "2026-07-10T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:new", outcome: "declined",
  };
  const fake = deps({
    replies: [oldReply],
    events: [
      initialEvent(), oldEvent, newEvent,
      { event: "reply_synced", campaign_id: "cmp1", candidate_id: "tiktok:creator", reply_key: "reply:new" },
    ],
  });
  const order = [];
  fake.applyReplyState = async ({ classification }) => { order.push(classification.outcome); };
  fake.applyReplyEventState = async ({ event }) => { order.push(event.outcome); };
  await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", now: new Date("2026-07-11T00:00:00Z"),
  }, fake);
  assert.deepEqual(order, ["declined"]);
});

test("a newly discovered delayed old email cannot overwrite a newer reply state", async () => {
  const delayedOldReply = {
    inbox: "alice", uid: 1, messageId: "<delayed-old>", inReplyTo: "<outbound-1@example.com>", references: [],
    fromAddress: "creator@example.com", date: "2026-07-09T00:00:00Z", text: "My rate is USD 900.",
  };
  const newerEvent = {
    event: "reply_received", event_at: "2026-07-10T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:new", outcome: "declined",
  };
  const fake = deps({
    replies: [delayedOldReply],
    events: [
      initialEvent(), newerEvent,
      { event: "reply_synced", campaign_id: "cmp1", candidate_id: "tiktok:creator", reply_key: "reply:new" },
    ],
  });
  const order = [];
  fake.applyReplyState = async ({ classification }) => { order.push(classification.outcome); };
  fake.applyReplyEventState = async ({ event }) => { order.push(event.outcome); };
  await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", now: new Date("2026-07-11T00:00:00Z"),
  }, fake);
  assert.deepEqual(order, ["declined"]);
});

test("an inbound-log failure cannot overwrite a newer CRM reply state", async () => {
  const oldReply = {
    inbox: "alice", uid: 1, messageId: "<old-log-failure>", inReplyTo: "<outbound-1@example.com>", references: [],
    fromAddress: "creator@example.com", date: "2026-07-09T00:00:00Z", text: "My rate is USD 900.",
  };
  const oldEvent = {
    event: "reply_received", event_at: "2026-07-09T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:old-log-failure", outcome: "rate_quote",
  };
  const newerEvent = {
    event: "reply_received", event_at: "2026-07-10T00:00:00Z", campaign_id: "cmp1",
    candidate_id: "tiktok:creator", reply_key: "reply:new", outcome: "declined",
  };
  const fake = deps({
    replies: [oldReply],
    events: [
      initialEvent(), oldEvent, newerEvent,
      { event: "reply_synced", campaign_id: "cmp1", candidate_id: "tiktok:creator", reply_key: "reply:new" },
    ],
  });
  let state = "declined";
  fake.ensureReplyLog = async () => { throw new Error("email log unavailable"); };
  fake.applyReplyState = async ({ classification }) => { state = classification.outcome; };
  fake.applyReplyEventState = async ({ event }) => { state = event.outcome; };
  const report = await runFirstOutreachMonitor({
    execute: true, campaignId: "cmp1", now: new Date("2026-07-11T00:00:00Z"),
  }, fake);
  assert.equal(report.pending_sync, 1);
  assert.equal(state, "declined");
});

test("headerless fallback requires a post-send matching subject and stays in human review", async () => {
  const event = { ...initialEvent(), subject: "Paid TikTok rate inquiry" };
  const replies = [
    {
      inbox: "alice", uid: 1, messageId: "<historical>", references: [], fromAddress: "creator@example.com",
      date: "2026-06-20T00:00:00Z", subject: "Paid TikTok rate inquiry", text: "USD 100",
    },
    {
      inbox: "alice", uid: 2, messageId: "<fallback>", references: [], fromAddress: "creator@example.com",
      date: "2026-07-02T00:00:00Z", subject: "Re: Paid TikTok rate inquiry", text: "USD 900",
    },
  ];
  const fake = deps({ replies, events: [event] });
  const report = await runFirstOutreachMonitor({ campaignId: "cmp1", now: new Date("2026-07-03T00:00:00Z") }, fake);
  assert.equal(report.results.some(item => item.reason === "unmatched_reply"), true);
  const fallback = report.results.find(item => item.reply_key === "reply:fallback");
  assert.equal(fallback.outcome, "needs_review");
  assert.equal(fallback.detected_outcome, "rate_quote");
});
