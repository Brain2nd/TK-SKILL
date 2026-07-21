import { createHash } from "crypto";
import { readFile } from "fs/promises";

export const FIRST_CONTACT_TEMPLATE_SCHEMA = "first-contact-template.v1";

const ALLOWED_INTENTS = new Set(["rate_inquiry", "fixed_offer"]);
const ALLOWED_REQUIRED_REVIEWS = new Set([
  "tiktok_shop_product_link_capability",
  "stable_candidate_identity",
  "recipient_email",
]);
const ALLOWED_PLACEHOLDERS = new Set([
  "personalized_hook",
  "creator_name",
  "creator_handle",
  "sender_name",
  "brand_name",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}

function occurrences(text, needle) {
  return String(text || "").split(needle).length - 1;
}

function placeholders(text) {
  return [...String(text || "").matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi)].map(match => match[1]);
}

function canonicalTemplate(input) {
  return {
    schema_version: String(input?.schema_version || ""),
    content_template_id: String(input?.content_template_id || "").trim(),
    content_template_version: String(input?.content_template_version || "").trim(),
    intent: String(input?.intent || "").trim(),
    language: String(input?.language || "en").trim().toLowerCase(),
    subject: String(input?.subject || ""),
    body: String(input?.body || "").replace(/\r\n?/g, "\n"),
    locked_blocks: Array.isArray(input?.locked_blocks)
      ? input.locked_blocks.map(value => String(value).replace(/\r\n?/g, "\n"))
      : [],
    required_reviews: Array.isArray(input?.required_reviews)
      ? input.required_reviews.map(value => String(value).trim()).filter(Boolean)
      : [],
    followup: {
      mode: String(input?.followup?.mode || "disabled").trim().toLowerCase(),
    },
  };
}

export function validatePersonalizedHook(value) {
  const hook = String(value || "").trim();
  if (!hook) return { valid: true, hook: "", reason: "empty_hook" };
  if (hook.length > 240) return { valid: false, hook: "", reason: "hook_too_long" };
  if (/\r|\n/.test(hook)) return { valid: false, hook: "", reason: "hook_must_be_one_line" };
  if (/\{\{|https?:\/\/|www\.|[^\s@]+@[^\s@]+/i.test(hook)) {
    return { valid: false, hook: "", reason: "hook_contains_link_email_or_placeholder" };
  }
  if (/[€$£¥￥]|\b(?:USD|EUR|GBP|CNY|RMB)\b/i.test(hook)) {
    return { valid: false, hook: "", reason: "hook_contains_commercial_terms" };
  }
  if (/[.!?](?:\s+.+[.!?])/.test(hook)) {
    return { valid: false, hook: "", reason: "hook_must_be_one_sentence" };
  }
  return { valid: true, hook, reason: "valid" };
}

export function validateFirstContactTemplate(input) {
  const template = canonicalTemplate(input);
  if (template.schema_version !== FIRST_CONTACT_TEMPLATE_SCHEMA) {
    throw new Error(`unsupported first-contact template schema: ${template.schema_version || "missing"}`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,100}$/i.test(template.content_template_id)) {
    throw new Error("content_template_id must be a stable slug");
  }
  if (!template.content_template_version || template.content_template_version.length > 80) {
    throw new Error("content_template_version is required and must be <= 80 characters");
  }
  if (!ALLOWED_INTENTS.has(template.intent)) throw new Error(`unsupported outreach intent: ${template.intent || "missing"}`);
  if (!template.subject.trim() || /\r|\n/.test(template.subject)) throw new Error("template subject must be one non-empty line");
  if (!template.body.trim()) throw new Error("template body is required");

  const allPlaceholders = placeholders(`${template.subject}\n${template.body}`);
  const unknown = [...new Set(allPlaceholders.filter(name => !ALLOWED_PLACEHOLDERS.has(name)))];
  if (unknown.length) throw new Error(`unsupported template placeholder(s): ${unknown.join(", ")}`);
  if (occurrences(template.body, "{{personalized_hook}}") !== 1) {
    throw new Error("template body must contain exactly one {{personalized_hook}} slot");
  }
  const hookParagraph = template.body.split(/\n\n/).filter(paragraph => paragraph.trim() === "{{personalized_hook}}");
  if (hookParagraph.length !== 1) {
    throw new Error("{{personalized_hook}} must be its own paragraph");
  }

  if (template.locked_blocks.length === 0) throw new Error("locked_blocks must contain at least one protected paragraph");
  for (const [index, block] of template.locked_blocks.entries()) {
    if (!block.trim()) throw new Error(`locked_blocks[${index}] is empty`);
    if (/\{\{/.test(block)) throw new Error(`locked_blocks[${index}] cannot contain placeholders`);
    if (occurrences(template.body, block) !== 1) {
      throw new Error(`locked_blocks[${index}] must occur exactly once in the template body`);
    }
  }
  const unknownReviews = [...new Set(template.required_reviews.filter(value => !ALLOWED_REQUIRED_REVIEWS.has(value)))];
  if (unknownReviews.length) throw new Error(`unsupported required review(s): ${unknownReviews.join(", ")}`);
  if (new Set(template.required_reviews).size !== template.required_reviews.length) {
    throw new Error("required_reviews cannot contain duplicates");
  }
  if (!["disabled", "rate_inquiry_7d"].includes(template.followup.mode)) {
    throw new Error(`unsupported followup mode: ${template.followup.mode}`);
  }
  if (template.intent === "fixed_offer" && template.followup.mode !== "disabled") {
    throw new Error("fixed_offer templates must disable follow-up until a matching follow-up template is approved");
  }
  return template;
}

export function contentTemplateSha256(input) {
  const template = validateFirstContactTemplate(input);
  return createHash("sha256").update(JSON.stringify(stableValue(template))).digest("hex");
}

function replaceDeterministic(text, variables) {
  return text.replace(/\{\{\s*(creator_name|creator_handle|sender_name|brand_name)\s*\}\}/g, (whole, name) => {
    const value = String(variables[name] || "").trim();
    if (!value) throw new Error(`template requires a verified value for {{${name}}}`);
    if (/\r|\n|\{\{/.test(value)) throw new Error(`unsafe template value for {{${name}}}`);
    return value;
  });
}

export function renderFirstContactTemplate(input, variables = {}) {
  const template = validateFirstContactTemplate(input);
  const hookCheck = validatePersonalizedHook(variables.personalized_hook);
  if (!hookCheck.valid) throw new Error(hookCheck.reason);

  const paragraphs = template.body.split(/\n\n/);
  const bodyWithHook = paragraphs.flatMap(paragraph => {
    if (paragraph.trim() !== "{{personalized_hook}}") return [paragraph];
    return hookCheck.hook ? [hookCheck.hook] : [];
  }).join("\n\n");
  const body = replaceDeterministic(bodyWithHook, variables);
  const subject = replaceDeterministic(template.subject, variables);
  if (/\{\{[^}]+\}\}/.test(`${subject}\n${body}`)) throw new Error("unresolved template variable");
  for (const block of template.locked_blocks) {
    if (occurrences(body, block) !== 1) throw new Error("a locked template block changed during rendering");
  }
  return {
    subject,
    body,
    content_template_id: template.content_template_id,
    content_template_version: template.content_template_version,
    content_template_sha256: contentTemplateSha256(template),
    outreach_intent: template.intent,
    followup_mode: template.followup.mode,
  };
}

export async function loadFirstContactTemplate(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`invalid template JSON: ${error.message}`);
    throw error;
  }
  return validateFirstContactTemplate(parsed);
}
