import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  contentTemplateSha256,
  loadFirstContactTemplate,
  renderFirstContactTemplate,
  validateFirstContactTemplate,
} from "../lib/first_contact_template.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(root, "outreach_templates/spain-tiktok-shop-eur20.json");
const originalClientBody = `Hi!

We have a paid TikTok Shop short-form video posting opportunity.

We will provide the video for you, and you only need to post it on your TikTok account and add the TikTok Shop product link. You will receive €20 for the post.

Here is a sample video for reference: https://vm.tiktok.com/ZNRoT8PuT/

Would you be interested in collaborating with us?

If you'd prefer not to hear from us again, just reply No and we won't contact you again.

Vira`;

test("an empty hook reproduces the client's original body exactly", async () => {
  const template = await loadFirstContactTemplate(templatePath);
  const rendered = renderFirstContactTemplate(template, { personalized_hook: "", sender_name: "Vira" });
  assert.equal(rendered.body, originalClientBody);
  assert.equal(rendered.followup_mode, "disabled");
  assert.match(rendered.content_template_sha256, /^[a-f0-9]{64}$/);
});

test("a creator hook cannot change the locked offer or subject", async () => {
  const template = await loadFirstContactTemplate(templatePath);
  const rendered = renderFirstContactTemplate(template, {
    personalized_hook: "Your beauty-focused UGC content looks especially relevant to this opportunity.",
    sender_name: "Vira",
  });
  assert.match(rendered.body, /beauty-focused UGC/);
  assert.match(rendered.body, /You will receive €20 for the post\./);
  assert.match(rendered.body, /Here is a sample video for reference: https:\/\/vm\.tiktok\.com\/ZNRoT8PuT\//);
  assert.match(rendered.body, /reply No and we won't contact you again/);
  assert.match(rendered.body, /only need to post it on your TikTok account and add the TikTok Shop product link/);
  assert.equal(rendered.subject, "Paid TikTok Shop short-form video opportunity");
});

test("unsafe hooks and malformed templates fail closed", async () => {
  const template = await loadFirstContactTemplate(templatePath);
  assert.throws(
    () => renderFirstContactTemplate(template, { personalized_hook: "We can offer €50 instead.", sender_name: "Vira" }),
    /commercial_terms/,
  );
  assert.throws(
    () => renderFirstContactTemplate(template, { personalized_hook: "See https://example.com", sender_name: "Vira" }),
    /link_email_or_placeholder/,
  );
  assert.throws(
    () => validateFirstContactTemplate({ ...template, body: template.body.replace("{{sender_name}}", "{{unknown}}") }),
    /unsupported template placeholder/,
  );
  assert.throws(
    () => validateFirstContactTemplate({ ...template, body: `${template.body}\n\n{{personalized_hook}}` }),
    /exactly one/,
  );
  assert.throws(
    () => validateFirstContactTemplate({ ...template, required_reviews: ["misspelled_gate"] }),
    /unsupported required review/,
  );
});

test("the selected verified sender controls the visible signature", async () => {
  const template = await loadFirstContactTemplate(templatePath);
  const rendered = renderFirstContactTemplate(template, { personalized_hook: "", sender_name: "Nora" });
  assert.match(rendered.body, /\n\nNora$/);
  assert.doesNotMatch(rendered.body, /\n\nVira$/);
});

test("template identity changes when protected content changes", async () => {
  const template = await loadFirstContactTemplate(templatePath);
  const changed = {
    ...template,
    body: template.body.replace("€20", "€25"),
    locked_blocks: template.locked_blocks.map(block => block.replace("€20", "€25")),
  };
  assert.notEqual(contentTemplateSha256(template), contentTemplateSha256(changed));
});
