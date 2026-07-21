import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createOutreachJournal, deliveryCircuitFrom, dispatchBlockedFrom, dispatchKey,
  providerMessageIdForAttempt, recipientBlockedFrom,
} from "../lib/outreach_journal.mjs";
import { withRunLock } from "../lib/run_lock.mjs";
import { buildEmail, renderEmailHtml } from "../lib/email_thread_builder.mjs";

test("journal persists the idempotency event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outreach-journal-"));
  try {
    const journal = createOutreachJournal(join(dir, "events.jsonl"));
    const key = dispatchKey({ campaignId: "cmp", candidateId: "tt:1", templateId: "step01" });
    await journal.append({ idempotency_key: key, event: "sent" });
    assert.equal((await journal.find(key))?.event, "sent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt journal fails closed instead of forgetting sent events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outreach-journal-corrupt-"));
  try {
    const file = join(dir, "events.jsonl");
    await writeFile(file, '{"event":"sent"}\nnot-json\n', "utf8");
    const journal = createOutreachJournal(file);
    await assert.rejects(() => journal.entries(), /corrupt outreach journal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run lock rejects a concurrent process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outreach-lock-"));
  const lock = join(dir, "run.lock");
  try {
    await withRunLock(lock, async () => {
      await assert.rejects(() => withRunLock(lock, async () => {}), /already active/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale-looking lock is never auto-taken over", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outreach-stale-lock-"));
  const lock = join(dir, "run.lock");
  try {
    await writeFile(lock, JSON.stringify({ pid: 2147483647, owner_token: "old-owner" }), "utf8");
    const old = new Date(Date.now() - 60000);
    await utimes(lock, old, old);
    await assert.rejects(
      () => withRunLock(lock, async () => {}, { staleMs: 1 }),
      /automatic takeover is disabled/,
    );
    assert.equal(JSON.parse(await readFile(lock, "utf8")).owner_token, "old-owner");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delivery circuit survives restarts and a racing failure cannot erase a success", () => {
  const base = {
    campaign_id: "cmp", candidate_id: "tt:1", template_id: "step01",
    idempotency_key: "cmp:tt:1:step01",
  };
  const unknown = [{ ...base, outreach_attempt_id: "a1", event: "sending" }];
  assert.equal(deliveryCircuitFrom(unknown, "cmp").open, true);
  assert.equal(deliveryCircuitFrom([
    ...unknown,
    { ...base, outreach_attempt_id: "a1", event: "delivery_not_sent" },
  ], "cmp").open, false);
  const wronglyFailedUnknown = [
    { ...base, outreach_attempt_id: "sticky", event: "delivery_unknown" },
    { ...base, outreach_attempt_id: "sticky", event: "failed" },
  ];
  assert.equal(deliveryCircuitFrom(wronglyFailedUnknown, "cmp").open, true);
  assert.equal(dispatchBlockedFrom(wronglyFailedUnknown, base.idempotency_key), true);
  assert.equal(dispatchBlockedFrom([
    { ...base, outreach_attempt_id: "a1", event: "sent", recipient_endpoint: "email:same@example.com" },
    { ...base, outreach_attempt_id: "a2", event: "failed" },
  ], base.idempotency_key), true);
  assert.equal(recipientBlockedFrom([
    { ...base, outreach_attempt_id: "a1", event: "sent", recipient_endpoint: "email:same@example.com" },
  ], "cmp", "email:same@example.com"), true);
});

test("HTML is derived from personalized text and keeps one tracking pixel", () => {
  const html = renderEmailHtml(
    "Hi Ava & team\nSee https://example.com/x?a=1",
    '<img src="https://track.test/track/open?t=step01">',
  );
  assert.match(html, /Hi Ava &amp; team/);
  assert.match(html, /<a href="https:\/\/example.com\/x\?a=1">/);
  assert.equal((html.match(/track\/open/g) || []).length, 1);
});

test("first outreach always starts a new thread and preserves approved content", async () => {
  const approved = { subject: "Approved subject", body: "Approved body" };
  const email = await buildEmail({
    creatorHandle: "creator",
    env: {},
    to: "creator@example.com",
    from: "sender@example.com",
    ...approved,
    threadMode: "new",
    outboundChain: [{ messageId: "<old>", subject: "Old campaign", bodyFull: "Old offer" }],
  });
  assert.equal(email.subject, approved.subject);
  assert.equal(email.text, approved.body);
  assert.equal(email.headers, undefined);
});

test("first outreach carries a validated Reply-To address", async () => {
  const email = await buildEmail({
    creatorHandle: "creator",
    to: "creator@example.com",
    from: "sender@example.com",
    replyTo: "Replies@Example.com",
    subject: "Hello",
    body: "Body",
    outboundChain: [],
  });
  assert.equal(email.replyTo, "replies@example.com");
  await assert.rejects(
    () => buildEmail({
      creatorHandle: "creator", to: "creator@example.com",
      replyTo: "bad\nBcc: x@example.com", subject: "Hello", body: "Body", outboundChain: [],
    }),
    /replyTo is invalid/,
  );
});

test("outbound Message-ID is allocated before SMTP and preserved by the mail builder", async () => {
  const messageId = providerMessageIdForAttempt("attempt-123", "sender@example.com");
  const email = await buildEmail({
    creatorHandle: "creator", env: {}, to: "creator@example.com", from: "sender@example.com",
    subject: "Approved subject", body: "Approved body", threadMode: "new", messageId,
  });
  assert.equal(messageId, "<outreach.attempt-123@example.com>");
  assert.equal(email.messageId, messageId);
});

test("follow-up refuses to fall out of the original thread", async () => {
  await assert.rejects(
    () => buildEmail({
      creatorHandle: "creator", env: {}, to: "creator@example.com",
      subject: "Follow-up", body: "Following up", threadMode: "reply", outboundChain: [],
    }),
    /original Message-ID|outbound chain is empty/,
  );
});

test("follow-up rejects empty or header-injection Message-IDs", async () => {
  await assert.rejects(
    () => buildEmail({
      creatorHandle: "creator", env: {}, to: "creator@example.com",
      subject: "Follow-up", body: "Following up", threadMode: "reply",
      replyToMessageId: "", outboundChain: [{ messageId: "" }],
    }),
    /Message-ID is missing or invalid/,
  );
  await assert.rejects(
    () => buildEmail({
      creatorHandle: "creator", env: {}, to: "creator@example.com",
      subject: "Follow-up", body: "Following up", threadMode: "reply",
      replyToMessageId: "<root@example.com>",
      outboundChain: [{ messageId: "<root@example.com>\r\nBcc: victim@example.com" }],
    }),
    /invalid Message-ID/,
  );
});

test("follow-up binds to the current campaign Message-ID instead of a newer unrelated email", async () => {
  const email = await buildEmail({
    creatorHandle: "creator", env: {}, to: "creator@example.com",
    subject: "Approved follow-up", body: "Following up", threadMode: "reply",
    replyToMessageId: "<current-campaign>",
    outboundChain: [
      { messageId: "<current-campaign>", subject: "Current rate inquiry", bodyFull: "Current body" },
      { messageId: "<newer-unrelated>", subject: "Unrelated", bodyFull: "Other body" },
    ],
  });
  assert.equal(email.headers["In-Reply-To"], "<current-campaign>");
  assert.equal(email.subject, "Re: Current rate inquiry");
  assert.doesNotMatch(email.text, /Other body/);
});
