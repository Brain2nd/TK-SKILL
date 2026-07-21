import test from "node:test";
import assert from "node:assert/strict";
import { classifyFirstReply, extractRateQuotes } from "../lib/first_reply_classifier.mjs";

test("extracts common rate and currency formats", () => {
  assert.deepEqual(extractRateQuotes("My TikTok rate is USD 1,200 and IG is €500."), [
    { amount: 1200, currency: "USD", deliverable: "TikTok short-form video", raw: "USD 1,200" },
    { amount: 500, currency: "EUR", deliverable: "Instagram Reel/Post", raw: "€500" },
  ]);
});

test("rate quote becomes a structured handoff", () => {
  const result = classifyFirstReply({
    text: "I'd be interested. My rate is $750 per TikTok. Organic usage is included for 30 days.",
    attachments: [{ filename: "Creator Rate Card.pdf" }],
  });
  assert.equal(result.outcome, "rate_quote");
  assert.equal(result.quotes[0].amount, 750);
  assert.match(result.usage_rights, /usage/i);
  assert.deepEqual(result.media_kit_files, ["Creator Rate Card.pdf"]);
});

test("unsubscribe and decline take precedence over positive words", () => {
  assert.equal(classifyFirstReply({ text: "Not interested, please unsubscribe me." }).outcome, "unsubscribe");
  assert.equal(classifyFirstReply({ text: "Thanks, but we're not interested." }).outcome, "declined");
});
