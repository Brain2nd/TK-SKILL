function firstReplyTimestamp(creator, reply) {
  const existing = Number(creator.fields?.["First Reply At"]);
  const parsedReceivedAt = new Date(reply.date || Date.now()).getTime();
  const receivedAt = Number.isFinite(parsedReceivedAt) ? parsedReceivedAt : Date.now();
  const safeExisting = Number.isFinite(existing) && existing > 0
    ? existing
    : Number.MAX_SAFE_INTEGER;
  return Math.min(safeExisting, receivedAt);
}

function textValue(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("");
  if (typeof value === "object") return textValue(value.text || value.name || value.value);
  return String(value).trim();
}

export function replyCrmFields(creator, reply, classification) {
  const fields = {
    "Contact Status": classification.outcome,
    "First Reply At": firstReplyTimestamp(creator, reply),
  };
  if (["rate_quote", "interested"].includes(classification.outcome)) fields["Outreach Pool"] = "Private";
  if (classification.outcome === "declined") fields["Outreach Pool"] = "Rejected";
  if (["unsubscribe", "bounce"].includes(classification.outcome)) {
    fields["Outreach Pool"] = "Suppressed";
    fields["Do Not Contact"] = true;
  }
  if (classification.outcome === "needs_review") fields["Outreach Pool"] = "Review";

  const firstQuote = classification.quotes?.[0];
  if (firstQuote) {
    fields["Quote Amount"] = firstQuote.amount;
    fields["Quote Currency"] = firstQuote.currency;
  }
  if (classification.quotes?.length) fields["Quote Details JSON"] = JSON.stringify(classification.quotes);
  if (classification.usage_rights) fields["Usage Rights"] = classification.usage_rights;
  const mediaKit = [
    ...(classification.media_kit_urls || []),
    ...(classification.media_kit_files || []),
  ].join("\n");
  if (mediaKit) fields["Media Kit"] = mediaKit;
  return fields;
}

export function replySyncArgsFromEvent(event, creatorsTable = "") {
  return {
    candidate: {
      recordId: event.record_id,
      candidateId: event.candidate_id,
      handle: event.handle,
    },
    reply: {
      messageId: event.reply_message_id || "",
      subject: event.reply_subject || "",
      text: event.reply_body || event.body_preview || "",
      fromAddress: event.reply_from || "",
      date: event.event_at,
    },
    classification: {
      outcome: event.outcome || "needs_review",
      detected_outcome: event.detected_outcome || event.outcome || "needs_review",
      confidence: event.confidence,
      quotes: Array.isArray(event.quotes) ? event.quotes : [],
      usage_rights: event.usage_rights || "",
      media_kit_urls: Array.isArray(event.media_kit_urls) ? event.media_kit_urls : [],
      media_kit_files: Array.isArray(event.media_kit_files) ? event.media_kit_files : [],
    },
    replyKey: event.reply_key,
    creatorsTable,
  };
}

async function resolveCreator(candidate, deps) {
  const creator = await deps.findCreatorByIdentity(candidate);
  if (!creator) throw new Error(`candidate ${candidate.candidateId} not found during reply sync`);
  return creator;
}

async function updateReplyState({ candidate, reply, classification, creatorsTable }, deps, creator) {
  await deps.updateCreator(
    creatorsTable,
    creator.record_id,
    replyCrmFields(creator, reply, classification),
  );
}

async function writeReplyLog({ candidate, reply, classification, replyKey }, deps, creator) {
  const durableMessageId = String(reply.messageId || replyKey || "").trim();
  if (!durableMessageId) throw new Error("reply sync requires a stable Message-ID or reply key");
  if (!await deps.hasLoggedMessage(durableMessageId)) {
    await deps.logEmailSent({
      handle: textValue(creator.fields?.username) || candidate.handle,
      direction: "inbound",
      templateId: "step01_reply",
      subject: reply.subject || "",
      body: reply.text || "",
      sender: reply.fromAddress || reply.from || "",
      messageId: durableMessageId,
      status: classification.outcome,
    });
  }
  return durableMessageId;
}

export async function applyFirstReplyStateToCrm(args, deps) {
  const creator = await resolveCreator(args.candidate, deps);
  await updateReplyState(args, deps, creator);
  return { creatorRecordId: creator.record_id };
}

export async function ensureFirstReplyLog(args, deps) {
  const creator = await resolveCreator(args.candidate, deps);
  const messageId = await writeReplyLog(args, deps, creator);
  return { creatorRecordId: creator.record_id, messageId };
}

/**
 * Idempotently apply one inbound first-contact reply to CRM.
 * The stable Message-ID/reply key is logged first. Only then is creator state
 * applied, so a log failure cannot overwrite a newer CRM outcome; retries remain idempotent.
 */
export async function syncFirstReplyToCrm({
  candidate, reply, classification, replyKey, creatorsTable,
}, deps) {
  const args = { candidate, reply, classification, replyKey, creatorsTable };
  const creator = await resolveCreator(candidate, deps);
  const durableMessageId = await writeReplyLog(args, deps, creator);
  await updateReplyState(args, deps, creator);
  return { creatorRecordId: creator.record_id, messageId: durableMessageId };
}
