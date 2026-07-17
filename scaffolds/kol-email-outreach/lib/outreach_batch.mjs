import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { normalizeEmail, normalizeHandle, sanitizeSubject } from "./outreach_policy.mjs";

export const BATCH_SCHEMA = "first-outreach-batch.v1";
const DEFAULT_CONTENT_TEMPLATE_SHA256 = createHash("sha256")
  .update("step01-rate-inquiry-v1")
  .digest("hex");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function payload(manifest) {
  return {
    schema_version: manifest.schema_version,
    batch_id: manifest.batch_id,
    campaign_id: manifest.campaign_id,
    template_id: manifest.template_id,
    template_version: manifest.template_version,
    content_template_id: manifest.content_template_id,
    content_template_version: manifest.content_template_version,
    content_template_sha256: manifest.content_template_sha256,
    outreach_intent: manifest.outreach_intent,
    followup_mode: manifest.followup_mode,
    items: manifest.items,
  };
}

export function payloadSha256(manifest) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(payload(manifest))))
    .digest("hex");
}

export function createBatchManifest({ campaignId, report }) {
  const items = report.results
    .filter(item => item.status === "planned")
    .map(item => ({
      candidate_id: item.candidate_id,
      handle: item.handle,
      idempotency_key: item.idempotency_key,
      channel: item.channel,
      to: item.to,
      sender_account: item.sender_account,
      from: item.from,
      subject: item.subject || "",
      body: item.body,
      personalization: item.personalization,
      content_template_id: item.content_template_id || "step01-rate-inquiry",
      content_template_version: item.content_template_version || "step01-rate-inquiry-v1",
      content_template_sha256: item.content_template_sha256 || DEFAULT_CONTENT_TEMPLATE_SHA256,
      outreach_intent: item.outreach_intent || "rate_inquiry",
      followup_mode: item.followup_mode || "rate_inquiry_7d",
      personalization_evidence: item.personalization_evidence || [],
      personalization_traits: item.personalization_traits || [],
      review_warnings: item.review_warnings || [],
    }));
  const content = items[0] || {};
  return {
    schema_version: BATCH_SCHEMA,
    batch_id: randomUUID(),
    campaign_id: campaignId,
    template_id: "step01",
    template_version: "step01-first-contact-workflow-v2",
    content_template_id: content.content_template_id || "step01-rate-inquiry",
    content_template_version: content.content_template_version || "step01-rate-inquiry-v1",
    content_template_sha256: content.content_template_sha256 || "",
    outreach_intent: content.outreach_intent || "rate_inquiry",
    followup_mode: content.followup_mode || "rate_inquiry_7d",
    created_at: new Date().toISOString(),
    approval: { status: "pending", approved_by: "", approved_at: "", payload_sha256: "" },
    items,
  };
}

function manifestWarnings(manifest) {
  return [...new Set((manifest.items || []).flatMap(item => item.review_warnings || []).map(String).filter(Boolean))];
}

export function approveBatch(manifest, approvedBy, options = {}) {
  const actor = String(approvedBy || "").trim();
  if (!actor) throw new Error("--by is required to approve a batch");
  validateBatchShape(manifest);
  const warnings = manifestWarnings(manifest);
  if (warnings.length && options.acceptReviewWarnings !== true) {
    throw new Error(`batch has unresolved review warnings: ${warnings.join(", ")}; verify them or explicitly accept them`);
  }
  return {
    ...manifest,
    approval: {
      status: "approved",
      approved_by: actor,
      approved_at: new Date().toISOString(),
      payload_sha256: payloadSha256(manifest),
      review_warnings_accepted: warnings.length > 0,
    },
  };
}

function validateBatchShape(manifest) {
  if (!manifest || manifest.schema_version !== BATCH_SCHEMA) {
    throw new Error(`unsupported batch schema: ${manifest?.schema_version || "missing"}`);
  }
  if (!manifest.batch_id || !manifest.campaign_id) throw new Error("batch_id and campaign_id are required");
  if (manifest.template_id !== "step01") throw new Error("only step01 batches are supported");
  for (const field of ["content_template_id", "content_template_version", "content_template_sha256", "outreach_intent", "followup_mode"]) {
    if (!String(manifest[field] || "").trim()) throw new Error(`batch missing ${field}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.content_template_sha256)) {
    throw new Error("batch content_template_sha256 must be a SHA-256 hex digest");
  }
  if (!['rate_inquiry', 'fixed_offer'].includes(manifest.outreach_intent)) throw new Error("batch has invalid outreach_intent");
  if (!['rate_inquiry_7d', 'disabled'].includes(manifest.followup_mode)) throw new Error("batch has invalid followup_mode");
  if (manifest.outreach_intent === "fixed_offer" && manifest.followup_mode !== "disabled") {
    throw new Error("fixed_offer batch follow-up must be disabled");
  }
  if (!Array.isArray(manifest.items) || manifest.items.length === 0) throw new Error("batch has no items");

  const candidateIds = new Set();
  const keys = new Set();
  const recipientEndpoints = new Set();
  for (const [index, item] of manifest.items.entries()) {
    for (const field of ["candidate_id", "handle", "idempotency_key", "channel", "to", "sender_account", "from", "body"]) {
      if (!String(item?.[field] || "").trim()) throw new Error(`batch item ${index} missing ${field}`);
    }
    if (item.channel === "email" && !String(item.subject || "").trim()) {
      throw new Error(`batch item ${index} missing subject`);
    }
    if (item.channel === "email" && sanitizeSubject(item.subject, "") !== item.subject) {
      throw new Error(`batch item ${index} subject is not in canonical send form`);
    }
    if (!['email', 'tiktok_dm'].includes(item.channel)) throw new Error(`batch item ${index} has invalid channel`);
    const normalizedEndpoint = item.channel === "email"
      ? normalizeEmail(item.to)
      : normalizeHandle(item.to);
    const canonicalTo = item.channel === "email" ? normalizedEndpoint : `@${normalizedEndpoint}`;
    if (!normalizedEndpoint || item.to !== canonicalTo) {
      throw new Error(`batch item ${index} recipient endpoint is not canonical`);
    }
    for (const field of ["content_template_id", "content_template_version", "content_template_sha256", "outreach_intent", "followup_mode"]) {
      if (item[field] !== manifest[field]) throw new Error(`batch item ${index} ${field} does not match batch metadata`);
    }
    for (const field of ["personalization_evidence", "personalization_traits", "review_warnings"]) {
      if (!Array.isArray(item[field])) throw new Error(`batch item ${index} ${field} must be an array`);
    }
    if (candidateIds.has(item.candidate_id)) throw new Error(`duplicate candidate_id in batch: ${item.candidate_id}`);
    if (keys.has(item.idempotency_key)) throw new Error(`duplicate idempotency_key in batch: ${item.idempotency_key}`);
    const endpointKey = `${item.channel}:${normalizedEndpoint}`;
    if (recipientEndpoints.has(endpointKey)) throw new Error(`duplicate recipient endpoint in batch: ${canonicalTo}`);
    candidateIds.add(item.candidate_id);
    keys.add(item.idempotency_key);
    recipientEndpoints.add(endpointKey);
  }
  return manifest;
}

export function validateApprovedBatch(manifest, campaignId) {
  validateBatchShape(manifest);
  if (manifest.campaign_id !== campaignId) throw new Error("batch campaign_id does not match config.json");
  if (manifest.approval?.status !== "approved") throw new Error("batch is not approved");
  if (!manifest.approval?.approved_by || !manifest.approval?.approved_at) {
    throw new Error("batch approval metadata is incomplete");
  }
  if (manifestWarnings(manifest).length && manifest.approval?.review_warnings_accepted !== true) {
    throw new Error("batch review warnings were not explicitly accepted");
  }
  const actual = payloadSha256(manifest);
  if (manifest.approval?.payload_sha256 !== actual) {
    throw new Error("batch content changed after approval");
  }
  for (const item of manifest.items) {
    const expected = `${manifest.campaign_id}:${item.candidate_id}:step01`;
    if (item.idempotency_key !== expected) throw new Error(`invalid idempotency key for ${item.candidate_id}`);
  }
  return manifest;
}

export async function readBatch(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeBatch(filePath, manifest) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return filePath;
}
