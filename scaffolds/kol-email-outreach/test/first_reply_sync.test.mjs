import test from "node:test";
import assert from "node:assert/strict";
import { replyCrmFields, syncFirstReplyToCrm } from "../lib/first_reply_sync.mjs";

const candidate = { candidateId: "tiktok:creator", handle: "creator", recordId: "rec1" };
const reply = {
  messageId: "<reply@example.com>",
  subject: "Re: rate inquiry",
  text: "USD 900 including 30 days usage",
  fromAddress: "creator@example.com",
  date: "2026-07-09T00:00:00Z",
};
const classification = {
  outcome: "rate_quote",
  quotes: [{ amount: 900, currency: "USD", deliverable: "TikTok video" }],
  usage_rights: "30 days",
  media_kit_urls: ["https://example.com/kit"],
  media_kit_files: [],
};

test("reply fields create a private-pool handoff with structured quote data", () => {
  const fields = replyCrmFields({ fields: {} }, reply, classification);
  assert.equal(fields["Outreach Pool"], "Private");
  assert.equal(fields["Quote Amount"], 900);
  assert.equal(fields["Quote Currency"], "USD");
  assert.equal(fields["Usage Rights"], "30 days");
});

test("reply sync durably logs once before applying idempotent creator state", async () => {
  const order = [];
  let logged = false;
  const deps = {
    async findCreatorByIdentity() { return { record_id: "rec1", fields: {} }; },
    async updateCreator() { order.push("creator"); },
    async hasLoggedMessage(messageId) {
      order.push(`check:${messageId}`);
      return logged;
    },
    async logEmailSent() { order.push("email_log"); logged = true; },
  };
  const args = { candidate, reply, classification, replyKey: "reply:key", creatorsTable: "creators" };
  await syncFirstReplyToCrm(args, deps);
  await syncFirstReplyToCrm(args, deps);
  assert.deepEqual(order, [
    "check:<reply@example.com>", "email_log", "creator",
    "check:<reply@example.com>", "creator",
  ]);
});

test("reply key is a durable CRM log key when an inbound Message-ID is absent", async () => {
  let loggedMessageId = "";
  await syncFirstReplyToCrm({
    candidate,
    reply: { ...reply, messageId: "" },
    classification,
    replyKey: "reply:alice:42",
    creatorsTable: "creators",
  }, {
    async findCreatorByIdentity() { return { record_id: "rec1", fields: {} }; },
    async updateCreator() {},
    async hasLoggedMessage() { return false; },
    async logEmailSent(payload) { loggedMessageId = payload.messageId; },
  });
  assert.equal(loggedMessageId, "reply:alice:42");
});
