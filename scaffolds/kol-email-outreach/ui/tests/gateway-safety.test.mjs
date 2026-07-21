import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createOAuthAuthorization,
  deliveryPolicyFor,
  publicAccount,
  validateExecutionPayload,
  validateOAuthSenderInput,
  validatePersonalizationRequest,
  validateSesSenderInput,
  validateSenderInput,
} from "../server/outreach-gateway.mjs";
import { canonicalBatchSnapshot, canonicalItemPayload } from "../lib/outreach-contract.mjs";

const TENANT = "a".repeat(16);
const CAMPAIGN = `${TENANT}:campaign_1`;

function item(overrides = {}) {
  const value = {
    id: "item_1",
    project_id: "project_1",
    creator_id: "tiktok:creator",
    candidate_id: "tiktok:creator",
    handle: "creator",
    recipient_email: "creator@example.com",
    sender_id: "sender_1",
    from_name: "Vira",
    from_email: "vira@example.com",
    reply_to_email: "",
    subject: "Paid collaboration",
    body: "Hi!\n\nWould you be interested?\n\nVira",
    idempotency_key: `${CAMPAIGN}:tiktok:creator:step01`,
    ...overrides,
  };
  value.payload_hash = createHash("sha256").update(canonicalItemPayload(value)).digest("hex");
  return value;
}

function batch(items, overrides = {}) {
  const value = {
    run_id: "run_1", batch_id: "batch_1", project_id: "project_1", campaign_id: CAMPAIGN,
    delay_ms: 0, items, ...overrides,
  };
  value.approved_hash = createHash("sha256").update(canonicalBatchSnapshot(value)).digest("hex");
  return value;
}

test("sender credentials are validated and remain a write-only input", () => {
  const input = {
    id: "sender_1",
    owner_key: TENANT,
    label: "Vira Gmail",
    from_name: "Vira",
    from_email: "VIRA@example.com",
    smtp_host: "smtp.example.com",
    smtp_port: 465,
    secure: true,
    daily_cap: 25,
    password: "app-password",
  };
  const sender = validateSenderInput(input);
  assert.equal(sender.email, "vira@example.com");
  assert.equal(sender.dailyCap, 25);
  assert.equal(sender.accountType, "personal");
  assert.equal(publicAccount(sender).safety_policy.min_interval_seconds, 30);
  assert.equal(sender.verified, false);
  assert.throws(() => validateSenderInput({ ...input, from_email: "bad", password: "x" }), /invalid sender email/);
  assert.throws(() => validateSenderInput({ ...input, from_name: "Bad\nBcc", password: "x" }), /invalid sender name/);
});

test("company and personal sender routes enforce different server-side safety ceilings", () => {
  assert.deepEqual(deliveryPolicyFor("personal", "gmail"), {
    accountType: "personal", maxDailyCap: 100, minIntervalMs: 30000,
  });
  assert.deepEqual(deliveryPolicyFor("company", "gmail"), {
    accountType: "company", maxDailyCap: 500, minIntervalMs: 10000,
  });
  assert.deepEqual(deliveryPolicyFor("company", "ses"), {
    accountType: "company", maxDailyCap: 5000, minIntervalMs: 2000,
  });
  const base = {
    id: "sender_cap", owner_key: TENANT, label: "Pool", from_name: "Vira",
    from_email: "vira@example.com", smtp_host: "smtp.example.com", smtp_port: 465,
    password: "app-password",
  };
  assert.throws(() => validateSenderInput({ ...base, account_type: "personal", daily_cap: 101 }), /between 1 and 100/);
  assert.equal(validateSenderInput({ ...base, account_type: "company", daily_cap: 500 }).dailyCap, 500);
  assert.throws(() => deliveryPolicyFor("personal", "ses"), /company\/domain/);
});

test("OAuth senders need only an address plus a provider authorization", () => {
  const previousClientId = process.env.LOOP_GOOGLE_OAUTH_CLIENT_ID;
  const previousRedirect = process.env.LOOP_OAUTH_REDIRECT_URI;
  process.env.LOOP_GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
  try {
    const input = {
      id: "sender_oauth",
      owner_key: TENANT,
      provider: "gmail",
      label: "Vira Gmail",
      from_name: "Vira",
      from_email: "VIRA@example.com",
      daily_cap: 25,
    };
    const sender = validateOAuthSenderInput(input);
    assert.equal(sender.email, "vira@example.com");
    assert.equal(sender.authMode, "oauth");
    assert.equal(sender.verified, false);
    const authorization = createOAuthAuthorization(input);
    const url = new URL(authorization.authorizationUrl);
    assert.equal(url.hostname, "accounts.google.com");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("scope"), /gmail\.send/);
    assert.equal(url.searchParams.has("client_secret"), false);
    assert.throws(() => validateOAuthSenderInput({ ...input, provider: "unknown" }), /gmail or outlook/);
    process.env.LOOP_OAUTH_REDIRECT_URI = "https://example.com/oauth/callback";
    assert.throws(() => createOAuthAuthorization(input), /local http:\/\/ loopback/);
  } finally {
    if (previousClientId === undefined) delete process.env.LOOP_GOOGLE_OAUTH_CLIENT_ID;
    else process.env.LOOP_GOOGLE_OAUTH_CLIENT_ID = previousClientId;
    if (previousRedirect === undefined) delete process.env.LOOP_OAUTH_REDIRECT_URI;
    else process.env.LOOP_OAUTH_REDIRECT_URI = previousRedirect;
  }
});

test("Amazon SES sender configuration keeps API credentials in the local gateway", () => {
  const input = {
    id: "sender_ses",
    owner_key: TENANT,
    provider: "ses",
    label: "SES Europe",
    from_name: "Vira",
    from_email: "VIRA@outreach.example.com",
    reply_to_email: "team@example.com",
    aws_region: "eu-west-1",
    access_key_id: "AKIA1234567890ABCDEF",
    secret_access_key: "a".repeat(40),
    daily_cap: 5000,
  };
  const sender = validateSesSenderInput(input);
  assert.equal(sender.provider, "ses");
  assert.equal(sender.accountType, "company");
  assert.equal(sender.authMode, "api");
  assert.equal(sender.email, "vira@outreach.example.com");
  assert.equal(sender.smtpHost, "email.eu-west-1.amazonaws.com");
  assert.equal(sender.dailyCap, 5000);
  const publicSender = JSON.stringify(publicAccount(sender));
  assert.doesNotMatch(publicSender, /AKIA1234567890ABCDEF/);
  assert.doesNotMatch(publicSender, /a{40}/);
  assert.throws(() => validateSesSenderInput({ ...input, aws_region: "Europe" }), /AWS region/);
});

test("AI personalization rejects recipients without public content evidence", () => {
  const input = {
    owner_key: TENANT,
    snapshot_hash: "b".repeat(64),
    project: { subject: "Paid collaboration", body: "Hi!\n\n{{personalized_hook}}" },
    recipients: [{
      recipient_id: "recipient_1", handle: "creator", bio: "",
      style_summary: "city:Madrid, country:ES", recent_videos: [],
    }],
  };
  assert.throws(() => validatePersonalizationRequest(input), /no public content evidence/);
  assert.equal(validatePersonalizationRequest({
    ...input,
    recipients: [{ ...input.recipients[0], bio: "Beauty and skincare reviews" }],
  }).recipients.length, 1);
});

test("a frozen batch validates stable ids, endpoints and item hashes", () => {
  const parsed = validateExecutionPayload(batch([item()]));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.delayMs, 1000);

  const tampered = item();
  tampered.payload_hash = "0".repeat(64);
  assert.throws(() => validateExecutionPayload(batch([tampered])), /payload hash mismatch/);

  const second = item({ id: "item_2", creator_id: "tiktok:other", candidate_id: "tiktok:other", handle: "other", idempotency_key: `${CAMPAIGN}:tiktok:other:step01` });
  assert.throws(() => validateExecutionPayload(batch([item(), second])), /duplicate recipient/);

  const altered = batch([item()]);
  altered.items[0].body += " changed";
  altered.items[0].payload_hash = createHash("sha256").update(canonicalItemPayload(altered.items[0])).digest("hex");
  assert.throws(() => validateExecutionPayload(altered), /approved batch hash mismatch/);

  const ordered = batch([item(), item({
    id: "item_3", creator_id: "tiktok:third", candidate_id: "tiktok:third", handle: "third",
    recipient_email: "third@example.com", idempotency_key: `${CAMPAIGN}:tiktok:third:step01`,
  })]);
  assert.equal(validateExecutionPayload(ordered).items.length, 2);
  assert.throws(() => validateExecutionPayload({ ...ordered, items: [...ordered.items].reverse() }), /approved batch hash mismatch/);
});
