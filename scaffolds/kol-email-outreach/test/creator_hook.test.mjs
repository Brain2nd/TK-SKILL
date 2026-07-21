import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { buildDeterministicHook, buildTemplatedFirstContact } from "../lib/creator_hook.mjs";
import { validateFirstContactTemplate } from "../lib/first_contact_template.mjs";

const template = validateFirstContactTemplate(JSON.parse(
  await readFile(resolve("outreach_templates/spain-tiktok-shop-eur20.json"), "utf8"),
));

function candidate(handle, bio) {
  return {
    candidateId: `tiktok:${handle}`,
    handle,
    displayName: handle,
    fields: { bio, email_verified: true },
  };
}

test("different public profile terms produce different grounded hooks", () => {
  const decor = buildDeterministicHook({ bio: "UGC creator | deco, moda y belleza" });
  const skincare = buildDeterministicHook({ bio: "UGC opiniones | skincare | piel real" });
  assert.notEqual(decor.hook, skincare.hook);
  assert.deepEqual(decor.evidence_ids, ["bio"]);
  assert.match(decor.hook, /home decor/);
  assert.match(skincare.hook, /real-skin/);
});

test("hook provenance identifies category and handle sources precisely", () => {
  const categoryOnly = buildDeterministicHook({
    bio: "Contact: creator@example.com",
    primary_category: "fashion",
    handle: "plain_creator",
  });
  assert.deepEqual(categoryOnly.evidence_ids, ["primary_category"]);
  assert.match(categoryOnly.hook, /fashion/);

  const handleOnly = buildDeterministicHook({
    bio: "Contact: creator@example.com",
    handle: "creator_ugc_",
  });
  assert.deepEqual(handleOnly.evidence_ids, ["handle"]);
  assert.match(handleOnly.hook, /UGC-focused profile/);
  assert.doesNotMatch(handleOnly.hook, /experience creating/);
});

test("no supported public trait produces the exact unpersonalized template", () => {
  const built = buildTemplatedFirstContact({
    template,
    candidate: candidate("plain_creator", "contact: creator@example.com"),
    senderName: "Vira",
  });
  assert.equal(built.personalization, "template");
  assert.doesNotMatch(built.body, /especially relevant|stood out/);
  assert.equal(built.personalization_evidence.length, 0);
});

test("the Spain handoff remains gated on TikTok Shop link capability", () => {
  const built = buildTemplatedFirstContact({
    template,
    candidate: candidate("ugc_creator", "UGC beauty creator with products in my escaparate"),
    senderName: "Vira",
  });
  assert.equal(built.personalization_traits.includes("shop_bio_signal"), true);
  assert.equal(built.review_warnings.includes("tiktok_shop_product_link_capability_unverified"), true);
  assert.equal(built.review_warnings.includes("email_domain_verified_not_mailbox_confirmed"), true);
});
