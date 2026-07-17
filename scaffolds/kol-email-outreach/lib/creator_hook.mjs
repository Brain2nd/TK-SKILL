import { renderFirstContactTemplate } from "./first_contact_template.mjs";

function scalar(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join(" ");
  if (typeof value === "object") return scalar(value.text || value.name || value.value || value.link);
  return String(value).trim();
}

function truthy(value) {
  return value === true || value === 1 || ["true", "yes", "1", "verified"].includes(scalar(value).toLowerCase());
}

const TRAIT_RULES = [
  ["home_decor", /\b(?:home\s*decor|decor|deco|hogar|interior(?:es|ismo)?)\b/i, "home decor"],
  ["fashion", /\b(?:fashion|moda|outfit|ropa|style|estilo)\b/i, "fashion"],
  ["skincare", /\b(?:skincare|skin\s*care|piel|cosm[eé]tica)\b/i, "skincare"],
  ["beauty", /\b(?:beauty|belleza|makeup|maquillaje)\b/i, "beauty"],
  ["travel", /\b(?:travel|viaj(?:e|es|ar)|turismo)\b/i, "travel"],
  ["lifestyle", /\b(?:lifestyle|vida\s*real|daily\s*life)\b/i, "lifestyle"],
  ["food", /\b(?:food|recetas?|cocina|gastronom[ií]a)\b/i, "food"],
  ["fitness", /\b(?:fitness|gym|deporte|wellness)\b/i, "fitness"],
  ["tech", /\b(?:tech|technology|tecnolog[ií]a|gadgets?)\b/i, "tech"],
];

function joinEnglish(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function publicSources(pattern, bioText, categoryText) {
  return [
    ...(bioText && pattern.test(bioText) ? ["bio"] : []),
    ...(categoryText && pattern.test(categoryText) ? ["primary_category"] : []),
  ];
}

export function extractPublicCreatorTraits({ bio = "", primary_category = "", handle = "" } = {}) {
  const bioText = scalar(bio);
  const categoryText = scalar(primary_category);
  const handleText = scalar(handle);
  const categories = TRAIT_RULES.map(([id, pattern, label]) => ({
    id,
    label,
    evidence_ids: publicSources(pattern, bioText, categoryText),
  })).filter(item => item.evidence_ids.length);

  const ugcPattern = /\bugc\b/i;
  const ugcProfileEvidence = publicSources(ugcPattern, bioText, categoryText);
  const ugcFromHandle = /(?:^|[._-])ugc(?:$|[._-])|ugc$/i.test(handleText);
  const ugcEvidence = unique([...ugcProfileEvidence, ...(ugcFromHandle ? ["handle"] : [])]);
  const productReviewEvidence = publicSources(
    /\b(?:product\s*test|testing|reviews?|rese[nñ]as?|opiniones?|probar\s*productos?|lo\s+pruebo|lo\s+comparto|compartir)\b/i,
    bioText,
    categoryText,
  );
  const honestSkinEvidence = publicSources(/\b(?:real\s*skin|piel\s*real|sin\s*filtros?)\b/i, bioText, categoryText);
  const shopEvidence = publicSources(/\b(?:tiktok\s*shop|shop|showcase|escaparate|tienda)\b/i, bioText, categoryText);
  const versatileEvidence = publicSources(/\bversatil(?:idad|e)?\b/i, bioText, categoryText);
  const brandStoryEvidence = unique([
    ...publicSources(/\b(?:dar|dando)\s+vida\s+a\s+(?:las\s+)?marcas\b/i, bioText, categoryText),
    ...((/\bportfolio\b/i.test(bioText) && /\bmarcas\b/i.test(bioText)) ? ["bio"] : []),
    ...((/\bportfolio\b/i.test(categoryText) && /\bmarcas\b/i.test(categoryText)) ? ["primary_category"] : []),
  ]);
  const creatorEducationEvidence = publicSources(/\bconvi[eé]rtete\s+en\b/i, bioText, categoryText);
  const ugcManagerEvidence = publicSources(/\bugc\s+manager\b/i, bioText, categoryText);
  const cityEvidence = publicSources(/\bbarcelona\b/i, bioText, categoryText);

  return {
    categories,
    ugc: ugcEvidence.length > 0,
    product_reviews: productReviewEvidence.length > 0,
    honest_skin: honestSkinEvidence.length > 0,
    shop_bio_signal: shopEvidence.length > 0,
    versatile_brand_content: versatileEvidence.length > 0,
    brand_storytelling: brandStoryEvidence.length > 0,
    creator_education: creatorEducationEvidence.length > 0 && ugcEvidence.length > 0,
    ugc_manager: ugcManagerEvidence.length > 0,
    public_city: cityEvidence.length ? "Barcelona" : "",
    ugc_from_handle: ugcFromHandle && !ugcProfileEvidence.length,
    evidence: {
      ugc: ugcEvidence,
      product_reviews: productReviewEvidence,
      honest_skin: honestSkinEvidence,
      shop_bio_signal: shopEvidence,
      versatile_brand_content: versatileEvidence,
      brand_storytelling: brandStoryEvidence,
      creator_education: unique([...creatorEducationEvidence, ...ugcEvidence]),
      ugc_manager: ugcManagerEvidence,
      public_city: cityEvidence,
    },
  };
}

export function buildDeterministicHook(profile = {}) {
  const traits = extractPublicCreatorTraits(profile);
  const categoryItems = traits.categories.slice(0, 3);
  const labels = categoryItems.map(item => item.label);
  const categoryEvidence = unique(categoryItems.flatMap(item => item.evidence_ids));
  let hook = "";
  let evidenceIds = [];
  if (traits.honest_skin && labels.includes("skincare") && traits.ugc) {
    hook = "Your focus on honest skincare and real-skin UGC stood out as especially relevant to this opportunity.";
    evidenceIds = unique([...traits.evidence.honest_skin, ...categoryEvidence, ...traits.evidence.ugc]);
  } else if (traits.ugc_manager) {
    hook = "Your experience managing UGC creators stood out as especially relevant to this opportunity.";
    evidenceIds = traits.evidence.ugc_manager;
  } else if (traits.creator_education) {
    hook = "Your creator-education approach to UGC stood out as especially relevant to this opportunity.";
    evidenceIds = traits.evidence.creator_education;
  } else if (traits.versatile_brand_content) {
    hook = "Your emphasis on versatile content for brands stood out as especially relevant to this opportunity.";
    evidenceIds = traits.evidence.versatile_brand_content;
  } else if (traits.brand_storytelling) {
    hook = "Your focus on bringing brands to life through content stood out as especially relevant to this opportunity.";
    evidenceIds = traits.evidence.brand_storytelling;
  } else if (traits.product_reviews && labels.length) {
    hook = `Your product-review content around ${joinEnglish(labels)} stood out as a strong fit for this opportunity.`;
    evidenceIds = unique([...traits.evidence.product_reviews, ...categoryEvidence]);
  } else if (traits.product_reviews) {
    hook = "Your product-testing and review-focused content stood out as a strong fit for this opportunity.";
    evidenceIds = traits.evidence.product_reviews;
  } else if (traits.ugc && labels.length) {
    hook = `Your ${joinEnglish(labels)}-focused UGC content looks especially relevant to this opportunity.`;
    evidenceIds = unique([...traits.evidence.ugc, ...categoryEvidence]);
  } else if (traits.ugc && traits.public_city) {
    hook = `Your ${traits.public_city}-based UGC content looks especially relevant to this opportunity.`;
    evidenceIds = unique([...traits.evidence.ugc, ...traits.evidence.public_city]);
  } else if (traits.ugc) {
    const handleOnly = traits.evidence.ugc.length === 1 && traits.evidence.ugc[0] === "handle";
    hook = handleOnly
      ? "Your UGC-focused profile looks especially relevant to this opportunity."
      : "Your experience creating UGC content looks especially relevant to this opportunity.";
    evidenceIds = traits.evidence.ugc;
  } else if (labels.length) {
    hook = `Your content around ${joinEnglish(labels)} looks especially relevant to this opportunity.`;
    evidenceIds = categoryEvidence;
  }
  return {
    hook,
    evidence_ids: hook ? unique(evidenceIds) : [],
    trait_ids: [
      ...traits.categories.map(item => item.id),
      ...(traits.ugc ? ["ugc_creator"] : []),
      ...(traits.product_reviews ? ["product_reviews"] : []),
      ...(traits.honest_skin ? ["honest_skin"] : []),
      ...(traits.shop_bio_signal ? ["shop_bio_signal"] : []),
      ...(traits.versatile_brand_content ? ["versatile_brand_content"] : []),
      ...(traits.brand_storytelling ? ["brand_storytelling"] : []),
      ...(traits.creator_education ? ["creator_education"] : []),
      ...(traits.ugc_manager ? ["ugc_manager"] : []),
      ...(traits.public_city ? [`city:${traits.public_city.toLowerCase()}`] : []),
      ...(traits.ugc_from_handle ? ["ugc_from_handle"] : []),
    ],
    method: hook ? "deterministic_public_traits_v2" : "no_supported_trait",
  };
}

export function reviewWarningsForTemplate(template, candidate) {
  const fields = candidate?.fields || {};
  const warnings = [];
  for (const requirement of template.required_reviews || []) {
    if (requirement === "tiktok_shop_product_link_capability" && !truthy(fields.tiktok_shop_link_capability_verified)) {
      warnings.push("tiktok_shop_product_link_capability_unverified");
    }
    if (requirement === "stable_candidate_identity" && !candidate?.profileSnapshotId) {
      warnings.push("stable_candidate_identity_not_proven_by_snapshot");
    }
    if (requirement === "recipient_email" && !truthy(fields.email_verified)) {
      warnings.push("recipient_email_not_domain_verified");
    }
  }
  if (truthy(fields.email_verified)) warnings.push("email_domain_verified_not_mailbox_confirmed");
  return [...new Set(warnings)];
}

export function buildTemplatedFirstContact({ template, candidate, senderName, brandName = "" }) {
  const fields = candidate?.fields || {};
  const displayName = scalar(candidate.displayName);
  const verifiedDisplayName = displayName
    && displayName.toLowerCase().replace(/^@/, "") !== scalar(candidate.handle).toLowerCase().replace(/^@/, "")
    ? displayName
    : "";
  const traitResult = buildDeterministicHook({
    bio: scalar(fields.bio),
    primary_category: scalar(fields.primary_category),
    handle: candidate.handle,
  });
  const variables = {
    personalized_hook: traitResult.hook,
    creator_name: verifiedDisplayName,
    creator_handle: candidate.handle || "",
    sender_name: senderName || "",
    brand_name: brandName || "",
  };
  const rendered = renderFirstContactTemplate(template, variables);
  return {
    ...rendered,
    dmBody: rendered.body,
    personalization: traitResult.hook ? "traits:deterministic" : "template",
    personalization_hook: traitResult.hook,
    personalization_evidence: traitResult.evidence_ids,
    personalization_traits: traitResult.trait_ids,
    personalization_method: traitResult.method,
    review_warnings: reviewWarningsForTemplate(template, candidate),
    template_spec: template,
    template_variables: variables,
  };
}
