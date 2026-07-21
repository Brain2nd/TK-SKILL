import test from "node:test";
import assert from "node:assert/strict";
import { runFirstOutreach } from "../lib/first_outreach_agent.mjs";

function record(overrides = {}) {
  return {
    record_id: "rec1",
    fields: {
      username: "creator",
      email: "creator@example.com",
      screening_decision: "approved",
      "Pipeline Stage": "00_Discovered",
      ...overrides,
    },
  };
}

function fakeDeps(records = [record()]) {
  const calls = { sends: 0, records: 0, advances: 0 };
  let prior = false;
  return {
    calls,
    setPrior(value) { prior = value; },
    async listCandidates() { return records; },
    async listEvents() { return []; },
    idempotencyKey(candidate, campaignId) { return `${campaignId}:${candidate.candidateId}:step01`; },
    async hasPriorOutreach() { return prior; },
    async hasPriorRecipient() { return false; },
    pickSender() { return { name: "alice", user: "alice@example.com" }; },
    getSender() { return { name: "alice", user: "alice@example.com" }; },
    async buildOutreach() {
      return { subject: "Rate inquiry", body: "Hi creator,\n\nCould you share your current rate?", dmBody: "Could you share your email?" };
    },
    async personalize({ subject, body }) { return { subject, body }; },
    async getCurrentStage() { return "00_Discovered"; },
    async sendEmail() { calls.sends++; return { ok: true, messageId: "<mid@example.com>" }; },
    async sendDm() { calls.sends++; return { ok: true, messageId: "dm-1" }; },
    async reserveDelivery() {
      return {
        outreach_attempt_id: "attempt-1",
        campaign_id: "cmp1",
        candidate_id: "tiktok:creator",
        template_id: "step01",
        provider_message_id: "<outreach.attempt-1@example.com>",
      };
    },
    async recordDeliveryFailure() {},
    async recordDeliveryUnknown() {},
    async recordDelivery() { calls.records++; prior = true; },
    async syncDelivery() {},
    async advance() { calls.advances++; },
    async recordSynced() {},
    async sleep() {},
  };
}

function executeOptions(extra = {}) {
  return {
    campaignId: "cmp1",
    execute: true,
    delayMs: 1000,
    approvedItems: {
      "tiktok:creator": {
        candidate_id: "tiktok:creator",
        handle: "creator",
        idempotency_key: "cmp1:tiktok:creator:step01",
        channel: "email",
        to: "creator@example.com",
        sender_account: "alice",
        from: "alice@example.com",
        subject: "Rate inquiry",
        body: "Hi creator,\n\nCould you share your current rate?",
        personalization: "template",
      },
    },
    ...extra,
  };
}

function approvedItem(handle, email = `${handle}@example.com`) {
  return {
    candidate_id: `tiktok:${handle}`,
    handle,
    idempotency_key: `cmp1:tiktok:${handle}:step01`,
    channel: "email",
    to: email,
    sender_account: "alice",
    from: "alice@example.com",
    subject: "Rate inquiry",
    body: `Hi ${handle},\n\nCould you share your current rate?`,
    personalization: "template",
  };
}

test("dry-run produces a preview without side effects", async () => {
  const deps = fakeDeps();
  const report = await runFirstOutreach({ campaignId: "cmp1" }, deps);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.planned, 1);
  assert.equal(report.sent, 0);
  assert.deepEqual(deps.calls, { sends: 0, records: 0, advances: 0 });
  assert.equal(report.results[0].body.includes("current rate"), true);
});

test("execute reserves and records delivery before advancing", async () => {
  const deps = fakeDeps();
  const order = [];
  deps.reserveDelivery = async () => { order.push("reserve"); return { outreach_attempt_id: "attempt-1" }; };
  deps.recordDelivery = async () => { order.push("record"); deps.calls.records++; };
  deps.syncDelivery = async () => { order.push("sync"); };
  deps.advance = async () => { order.push("advance"); deps.calls.advances++; };
  deps.recordSynced = async () => { order.push("synced"); };
  const report = await runFirstOutreach(executeOptions(), deps);
  assert.equal(report.sent, 1);
  assert.equal(deps.calls.sends, 1);
  assert.deepEqual(order, ["reserve", "record", "sync", "advance", "synced"]);
});

test("prior success and a final-stage race both prevent sending", async () => {
  const priorDeps = fakeDeps();
  priorDeps.setPrior(true);
  const prior = await runFirstOutreach(executeOptions(), priorDeps);
  assert.equal(prior.results[0].reason, "already_sent");
  assert.equal(priorDeps.calls.sends, 0);

  const raceDeps = fakeDeps();
  raceDeps.getCurrentStage = async () => "01_FirstOutreach";
  const race = await runFirstOutreach(executeOptions(), raceDeps);
  assert.equal(race.results[0].reason, "stage_changed_before_send");
  assert.equal(raceDeps.calls.sends, 0);
});

test("an already-contacted creator does not consume the batch limit", async () => {
  const deps = fakeDeps([
    record({ username: "old", email: "old@example.com", candidate_id: "tiktok:old" }),
    record({ username: "fresh", email: "fresh@example.com", candidate_id: "tiktok:fresh" }),
  ]);
  deps.hasPriorOutreach = async candidate => candidate.handle === "old";
  const report = await runFirstOutreach({ campaignId: "cmp1", limit: 1 }, deps);
  assert.equal(report.results.find(item => item.handle === "old").reason, "already_sent");
  assert.equal(report.results.find(item => item.handle === "fresh").status, "planned");
  assert.equal(report.planned, 1);
});

test("failed delivery does not record or advance", async () => {
  const deps = fakeDeps();
  deps.sendEmail = async () => { deps.calls.sends++; return { ok: false, error: "smtp rejected" }; };
  const report = await runFirstOutreach(executeOptions(), deps);
  assert.equal(report.failed, 1);
  assert.equal(deps.calls.records, 0);
  assert.equal(deps.calls.advances, 0);
});

test("execute refuses to run without an approved batch", async () => {
  await assert.rejects(
    () => runFirstOutreach({ campaignId: "cmp1", execute: true }, fakeDeps()),
    /approved batch manifest/,
  );
});

test("execute cannot disable the minimum send interval", async () => {
  await assert.rejects(
    () => runFirstOutreach(executeOptions({ delayMs: 0 }), fakeDeps()),
    /delayMs must be at least/,
  );
});

test("CRM sync failure is reported without converting a sent email into a retry", async () => {
  const deps = fakeDeps();
  deps.syncDelivery = async () => { throw new Error("CRM unavailable"); };
  const report = await runFirstOutreach(executeOptions(), deps);
  assert.equal(report.sent, 1);
  assert.equal(report.pending_sync, 1);
  assert.equal(report.results[0].status, "sent_pending_sync");
});

test("an approved sender that is unavailable or capped cannot send", async () => {
  const deps = fakeDeps();
  deps.getSender = () => null;
  const report = await runFirstOutreach(executeOptions(), deps);
  assert.equal(report.results[0].reason, "approved_sender_unavailable");
  assert.equal(deps.calls.sends, 0);
});

test("execute rejects an approved channel that current contact policy no longer allows", async () => {
  const deps = fakeDeps([record({ "Allowed Channels": "tiktok_dm" })]);
  const report = await runFirstOutreach(executeOptions({ allowDmFallback: true }), deps);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].reason, "approved_channel_no_longer_allowed");
  assert.equal(deps.calls.sends, 0);
});

test("an uncertain provider exception remains blocked for reconciliation", async () => {
  const deps = fakeDeps();
  let unknown = 0;
  deps.sendEmail = async () => { deps.calls.sends++; throw new Error("socket closed after DATA"); };
  deps.recordDeliveryUnknown = async () => { unknown++; };
  const report = await runFirstOutreach(executeOptions(), deps);
  assert.equal(report.results[0].status, "needs_reconciliation");
  assert.equal(unknown, 1);
  assert.equal(deps.calls.records, 0);
  assert.equal(deps.calls.advances, 0);
});

test("one ambiguous delivery opens the circuit and defers the rest of the batch", async () => {
  const records = [
    record({ username: "first", email: "first@example.com", candidate_id: "tiktok:first" }),
    record({ username: "second", email: "second@example.com", candidate_id: "tiktok:second" }),
  ];
  const fake = fakeDeps(records);
  fake.reserveDelivery = async ({ candidate }) => ({
    outreach_attempt_id: `attempt-${candidate.handle}`,
    campaign_id: "cmp1",
    candidate_id: candidate.candidateId,
    idempotency_key: `cmp1:${candidate.candidateId}:step01`,
    template_id: "step01",
    provider_message_id: `<outreach.${candidate.handle}@example.com>`,
  });
  fake.sendEmail = async () => {
    fake.calls.sends++;
    throw new Error("socket closed after SMTP DATA");
  };
  const report = await runFirstOutreach(executeOptions({
    approvedItems: {
      "tiktok:first": approvedItem("first"),
      "tiktok:second": approvedItem("second"),
    },
    limit: 2,
  }), fake);
  assert.equal(fake.calls.sends, 1);
  assert.equal(report.delivery_circuit.open, true);
  assert.equal(report.results.find(item => item.handle === "first").status, "needs_reconciliation");
  assert.equal(report.results.find(item => item.handle === "second").reason, "delivery_circuit_open");
});

test("an unresolved reservation from a prior process blocks every new provider call", async () => {
  const fake = fakeDeps();
  fake.listEvents = async () => [{
    event: "sending",
    event_at: "2026-07-17T00:00:00.000Z",
    campaign_id: "cmp1",
    candidate_id: "tiktok:other",
    idempotency_key: "cmp1:tiktok:other:step01",
    outreach_attempt_id: "orphan-attempt",
    template_id: "step01",
  }];
  const report = await runFirstOutreach(executeOptions(), fake);
  assert.equal(fake.calls.sends, 0);
  assert.equal(report.delivery_circuit.reason, "unresolved_sending");
  assert.equal(report.results[0].reason, "delivery_circuit_open");
});

test("a confirmed send whose sent event cannot be persisted stops the batch", async () => {
  const records = [
    record({ username: "first", email: "first@example.com", candidate_id: "tiktok:first" }),
    record({ username: "second", email: "second@example.com", candidate_id: "tiktok:second" }),
  ];
  const fake = fakeDeps(records);
  fake.recordDelivery = async () => { throw new Error("journal disk unavailable"); };
  const report = await runFirstOutreach(executeOptions({
    approvedItems: {
      "tiktok:first": approvedItem("first"),
      "tiktok:second": approvedItem("second"),
    },
    limit: 2,
  }), fake);
  assert.equal(fake.calls.sends, 1);
  assert.equal(report.sent, 1);
  assert.equal(report.pending_sync, 1);
  assert.equal(report.results.find(item => item.handle === "second").reason, "delivery_circuit_open");
});

test("runtime dedupe never sends twice to one normalized recipient endpoint", async () => {
  const records = [
    record({ username: "first", email: "same@example.com", candidate_id: "tiktok:first" }),
    record({ username: "second", email: "same@example.com", candidate_id: "tiktok:second" }),
  ];
  const fake = fakeDeps(records);
  const report = await runFirstOutreach(executeOptions({
    approvedItems: {
      "tiktok:first": approvedItem("first", "same@example.com"),
      "tiktok:second": approvedItem("second", "same@example.com"),
    },
    limit: 2,
  }), fake);
  assert.equal(fake.calls.sends, 1);
  assert.equal(report.results.find(item => item.handle === "second").reason, "duplicate_recipient_endpoint");
});

test("a new candidate identity cannot re-contact an endpoint already used in the campaign", async () => {
  const fake = fakeDeps();
  fake.hasPriorRecipient = async ({ recipientEndpoint }) => recipientEndpoint === "email:creator@example.com";
  const report = await runFirstOutreach(executeOptions(), fake);
  assert.equal(fake.calls.sends, 0);
  assert.equal(report.results[0].reason, "recipient_already_contacted");
});

test("execute never silently changes an approved subject", async () => {
  const deps = fakeDeps();
  const options = executeOptions();
  options.approvedItems["tiktok:creator"].subject = "Approved\r\nBcc: victim@example.com";
  const report = await runFirstOutreach(options, deps);
  assert.equal(report.results[0].reason, "approved_batch_subject_not_canonical");
  assert.equal(deps.calls.sends, 0);
});
