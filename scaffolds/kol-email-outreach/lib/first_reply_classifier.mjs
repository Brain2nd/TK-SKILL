const CURRENCY = {
  "$": "USD", "US$": "USD", USD: "USD",
  "€": "EUR", EUR: "EUR",
  "£": "GBP", GBP: "GBP",
  "¥": "CNY", CNY: "CNY", RMB: "CNY",
  CAD: "CAD", AUD: "AUD",
};

function normalizedText(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .split(/\n(?:On .+ wrote:|From:|Sent:|>)/i)[0]
    .trim();
}

function amount(value) {
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function inferDeliverable(context) {
  if (/youtube\s+short/i.test(context)) return "YouTube Shorts";
  if (/youtube|dedicated|integration/i.test(context)) return "YouTube";
  if (/instagram|\big\b|\breel/i.test(context)) return "Instagram Reel/Post";
  if (/live(stream)?|直播/i.test(context)) return "Livestream";
  if (/tiktok|\btt\b/i.test(context)) return "TikTok short-form video";
  return "unspecified";
}

export function extractRateQuotes(value) {
  const text = normalizedText(value);
  const quotes = [];
  const seen = new Set();
  const patterns = [
    { regex: /\b(USD|EUR|GBP|CNY|RMB|CAD|AUD|US\$)\s*([0-9][0-9,.]*)\b/gi, currency: 1, amount: 2 },
    { regex: /(^|\s)([$€£¥])\s*([0-9][0-9,.]*)\b/g, currency: 2, amount: 3 },
    { regex: /\b([0-9][0-9,.]*)\s*(USD|EUR|GBP|CNY|RMB|CAD|AUD)\b/gi, currency: 2, amount: 1 },
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const currencyRaw = match[pattern.currency];
      const amountRaw = match[pattern.amount];
      const numeric = amount(amountRaw);
      const currency = CURRENCY[String(currencyRaw || "").toUpperCase()] || CURRENCY[currencyRaw];
      if (numeric == null || !currency) continue;
      const key = `${currency}:${numeric}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const context = text.slice(Math.max(0, (match.index || 0) - 80), match.index || 0);
      quotes.push({ amount: numeric, currency, deliverable: inferDeliverable(context), raw: match[0].trim() });
    }
  }
  return quotes;
}

function sentenceContaining(text, pattern) {
  return normalizedText(text).split(/(?<=[.!?])\s+|\n+/).find(sentence => pattern.test(sentence)) || "";
}

export function classifyFirstReply({ text, subject = "", attachments = [] } = {}) {
  const body = normalizedText(text);
  const combined = `${subject}\n${body}`;
  const lower = combined.toLowerCase();
  const quotes = extractRateQuotes(body);
  const mediaKitUrls = body.match(/https?:\/\/[^\s<>"']+/g) || [];
  const mediaKitFiles = attachments
    .map(item => item?.filename || "")
    .filter(name => /(media.?kit|rate.?card)/i.test(name));
  const usageRights = sentenceContaining(body, /usage|whitelisting|spark ads?|paid ads?|licen[cs]e|exclusiv/i);

  let outcome = "needs_review";
  let confidence = 0.55;
  if (/unsubscribe|remove me|do not contact|stop emailing|opt.?out/.test(lower)) {
    outcome = "unsubscribe"; confidence = 0.99;
  } else if (/delivery status notification|mail delivery subsystem|undeliverable|address rejected|mailbox unavailable/.test(lower)) {
    outcome = "bounce"; confidence = 0.98;
  } else if (/out of (the )?office|automatic reply|auto.?reply|away from (the )?office/.test(lower)) {
    outcome = "out_of_office"; confidence = 0.95;
  } else if (/not interested|no thank|pass on this|not a fit|decline/.test(lower)) {
    outcome = "declined"; confidence = 0.95;
  } else if (quotes.length) {
    outcome = "rate_quote"; confidence = 0.95;
  } else if (/interested|sounds good|would love|happy to|let'?s discuss|send (me )?(the )?details/.test(lower)) {
    outcome = "interested"; confidence = 0.85;
  }

  return {
    outcome,
    confidence,
    quotes,
    usage_rights: usageRights,
    media_kit_urls: mediaKitUrls,
    media_kit_files: mediaKitFiles,
    body_preview: body.slice(0, 500),
  };
}
