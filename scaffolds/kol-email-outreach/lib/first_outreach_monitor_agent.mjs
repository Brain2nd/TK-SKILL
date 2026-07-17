import { candidateFromRecord } from "./outreach_policy.mjs";
import { deliveryCircuitFrom, dispatchBlockedFrom } from "./outreach_journal.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function messageId(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\r\n]/.test(raw)) return "";
  const startsWrapped = raw.startsWith("<");
  const endsWrapped = raw.endsWith(">");
  if (startsWrapped !== endsWrapped) return "";
  const unwrapped = startsWrapped ? raw.slice(1, -1) : raw;
  if (!unwrapped || /[\s<>]/.test(unwrapped)) return "";
  return unwrapped.toLowerCase();
}

function replyKey(reply) {
  return `reply:${messageId(reply.messageId) || `${reply.inbox}:${reply.uid}`}`;
}

function normalizedSubject(value) {
  return String(value || "").trim().replace(/^\s*(?:(?:re|fw|fwd|aw|sv)\s*:\s*)+/i, "").toLowerCase();
}

function eventTime(value, fallback = Number.NEGATIVE_INFINITY) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function result(handle, action, status, reason, extra = {}) {
  return { handle, action, status, reason, ...extra };
}

function circuitForReservation(reservation, reason) {
  return {
    open: true,
    reason,
    unresolved_count: 1,
    opened_at: new Date().toISOString(),
    campaign_id: reservation?.campaign_id || "",
    candidate_id: reservation?.candidate_id || "",
    outreach_attempt_id: reservation?.outreach_attempt_id || "",
    idempotency_key: reservation?.idempotency_key || "",
    template_id: reservation?.template_id || "",
  };
}

function latestByCandidate(events, templateId) {
  const map = new Map();
  for (const event of events) {
    if (event.event !== "sent" || event.template_id !== templateId) continue;
    const old = map.get(event.candidate_id);
    if (!old || Date.parse(event.event_at) >= Date.parse(old.event_at)) map.set(event.candidate_id, event);
  }
  return map;
}

export async function runFirstOutreachMonitor(options, deps) {
  const settings = {
    execute: false,
    campaignId: "",
    followupDays: 7,
    now: new Date(),
    followupEnabled: true,
    delayMs: 5000,
    minExecuteDelayMs: 1000,
    ...options,
  };
  if (!settings.campaignId) throw new Error("campaignId is required");
  if (settings.execute && settings.delayMs < settings.minExecuteDelayMs) {
    throw new Error(`execute delayMs must be at least ${settings.minExecuteDelayMs}`);
  }

  const records = await deps.listCandidates();
  const candidates = records.map(candidateFromRecord).filter(candidate => candidate.candidateId);
  const candidateById = new Map(candidates.map(candidate => [candidate.candidateId, candidate]));
  const emailCandidates = new Map();
  for (const candidate of candidates) {
    if (!candidate.email) continue;
    const list = emailCandidates.get(candidate.email) || [];
    list.push(candidate);
    emailCandidates.set(candidate.email, list);
  }

  const allEvents = await deps.listEvents();
  const events = allEvents.filter(event => event.campaign_id === settings.campaignId);
  const initialSent = latestByCandidate(events, "step01");
  const outboundByMessageId = new Map();
  for (const event of events) {
    if (event.event !== "sent" || !event.provider_message_id) continue;
    outboundByMessageId.set(messageId(event.provider_message_id), event);
  }
  const receivedReplies = new Set(
    events.filter(event => event.event === "reply_received")
      .map(event => event.reply_key).filter(Boolean),
  );
  const processedReplies = new Set(
    events.filter(event => event.event === "reply_synced")
      .map(event => event.reply_key).filter(Boolean),
  );
  const latestReceivedByCandidate = new Map();
  for (const event of events) {
    if (event.event === "reply_received" && event.candidate_id && event.reply_key) {
      const previous = latestReceivedByCandidate.get(event.candidate_id);
      if (!previous || eventTime(event.event_at) >= eventTime(previous.event_at)) {
        latestReceivedByCandidate.set(event.candidate_id, event);
      }
    }
  }
  const repliedCandidates = new Set(
    events.filter(event => event.event === "reply_received").map(event => event.candidate_id),
  );
  const followupBlocked = new Set(candidates
    .filter(candidate => dispatchBlockedFrom(
      events,
      `${settings.campaignId}:${candidate.candidateId}:step01_followup`,
    ))
    .map(candidate => candidate.candidateId));

  const report = {
    mode: settings.execute ? "execute" : "dry-run",
    campaign_id: settings.campaignId,
    replies_found: 0,
    replies_processed: 0,
    handoffs: 0,
    followups_due: 0,
    followups_sent: 0,
    pending_sync: 0,
    skipped: 0,
    failed: 0,
    delivery_circuit: deliveryCircuitFrom(allEvents, ""),
    results: [],
  };
  let deliveryCircuit = report.delivery_circuit;

  const replies = [...await deps.listReplies()].sort((left, right) => {
    const leftTime = Date.parse(left.date) || Number.MAX_SAFE_INTEGER;
    const rightTime = Date.parse(right.date) || Number.MAX_SAFE_INTEGER;
    return leftTime - rightTime;
  });
  for (const reply of replies) {
    const key = replyKey(reply);
    if (processedReplies.has(key)) continue;
    const wasAlreadyReceived = receivedReplies.has(key);
    report.replies_found++;

    const threadIds = [reply.inReplyTo, ...(reply.references || [])].map(messageId).filter(Boolean);
    let sentEvent = threadIds.map(id => outboundByMessageId.get(id)).find(Boolean);
    let matchMethod = sentEvent ? "thread" : "";
    if (!sentEvent && reply.fromAddress) {
      const possible = emailCandidates.get(String(reply.fromAddress).toLowerCase()) || [];
      if (possible.length === 1) {
        const fallback = initialSent.get(possible[0].candidateId);
        const replyAt = Date.parse(reply.date);
        const sentAt = Date.parse(fallback?.event_at);
        const subjectMatches = normalizedSubject(reply.subject) &&
          normalizedSubject(reply.subject) === normalizedSubject(fallback?.subject);
        if (fallback && Number.isFinite(replyAt) && Number.isFinite(sentAt) && replyAt >= sentAt && subjectMatches) {
          sentEvent = fallback;
          matchMethod = "email_subject_fallback";
        }
      }
    }
    const candidate = sentEvent ? candidateById.get(sentEvent.candidate_id) : null;
    if (!candidate) {
      report.skipped++;
      report.results.push(result("", "reply", "skipped", "unmatched_reply", { reply_key: key }));
      continue;
    }

    const detected = await deps.classifyReply(reply);
    const classification = matchMethod === "thread"
      ? detected
      : { ...detected, detected_outcome: detected.outcome, outcome: "needs_review", confidence: Math.min(detected.confidence || 0, 0.5) };
    repliedCandidates.add(candidate.candidateId);
    report.replies_processed++;
    if (["rate_quote", "interested"].includes(classification.outcome)) report.handoffs++;
    const preview = {
      reply_key: key,
      candidate_id: candidate.candidateId,
      outcome: classification.outcome,
      confidence: classification.confidence,
      quotes: classification.quotes,
      usage_rights: classification.usage_rights,
      media_kit_urls: classification.media_kit_urls,
      media_kit_files: classification.media_kit_files,
      matched_by: matchMethod,
      detected_outcome: classification.detected_outcome || classification.outcome,
    };
    if (!settings.execute) {
      report.results.push(result(candidate.handle, "reply", "planned", "dry_run", preview));
      continue;
    }

    try {
      if (!receivedReplies.has(key)) {
        await deps.recordReply({ candidate, reply, classification, replyKey: key, sentEvent, matchMethod });
        receivedReplies.add(key);
        const parsedReplyAt = eventTime(reply.date, settings.now.getTime());
        const currentEvent = {
          event: "reply_received",
          event_at: new Date(parsedReplyAt).toISOString(),
          campaign_id: settings.campaignId,
          candidate_id: candidate.candidateId,
          record_id: candidate.recordId,
          handle: candidate.handle,
          reply_key: key,
          reply_message_id: reply.messageId || "",
          outcome: classification.outcome,
          detected_outcome: classification.detected_outcome || classification.outcome,
          confidence: classification.confidence,
          quotes: classification.quotes,
          usage_rights: classification.usage_rights,
          media_kit_urls: classification.media_kit_urls,
          media_kit_files: classification.media_kit_files,
        };
        const latest = latestReceivedByCandidate.get(candidate.candidateId);
        if (!latest || parsedReplyAt > eventTime(latest.event_at)) {
          latestReceivedByCandidate.set(candidate.candidateId, currentEvent);
        }
      }
      if (!deps.ensureReplyLog || !deps.applyReplyState || !deps.applyReplyEventState) {
        throw new Error("reply sync dependencies are incomplete");
      }
      await deps.ensureReplyLog({ candidate, reply, classification, replyKey: key });
      const latestKnownReply = latestReceivedByCandidate.get(candidate.candidateId);
      const currentReplyAt = eventTime(reply.date, settings.now.getTime());
      const latestKnownWins = latestKnownReply && (
        wasAlreadyReceived || (
          latestKnownReply.reply_key !== key &&
          eventTime(latestKnownReply.event_at) >= currentReplyAt
        )
      );
      if (latestKnownWins) {
        await deps.applyReplyEventState({ candidate, event: latestKnownReply });
      } else {
        await deps.applyReplyState({ candidate, reply, classification, replyKey: key });
      }
      await deps.recordReplySynced({ candidate, replyKey: key, classification });
      processedReplies.add(key);
      report.results.push(result(candidate.handle, "reply", "processed", classification.outcome, preview));
    } catch (error) {
      report.pending_sync++;
      report.results.push(result(candidate.handle, "reply", "pending_sync", error.message, preview));
    }
  }

  if (!settings.followupEnabled) return report;
  for (const [candidateId, sentEvent] of initialSent) {
    let candidate = candidateById.get(candidateId);
    if (!candidate || candidate.stage !== "01_FirstOutreach" || candidate.suppressed || !candidate.email) continue;
    if (repliedCandidates.has(candidateId) || followupBlocked.has(candidateId)) continue;
    const sentAt = Date.parse(sentEvent.event_at);
    if (!Number.isFinite(sentAt) || settings.now.getTime() - sentAt < settings.followupDays * DAY_MS) continue;
    if (sentEvent.followup_mode === "disabled") {
      report.skipped++;
      report.results.push(result(candidate.handle, "followup", "skipped", "followup_disabled_for_content_template"));
      continue;
    }
    if (sentEvent.channel !== "email") {
      report.skipped++;
      report.results.push(result(candidate.handle, "followup", "skipped", "non_email_initial_contact"));
      continue;
    }
    if (!candidate.allowedChannels.includes("email")) {
      report.skipped++;
      report.results.push(result(candidate.handle, "followup", "skipped", "email_channel_no_longer_allowed"));
      continue;
    }
    report.followups_due++;
    if (deliveryCircuit.open) {
      report.skipped++;
      report.results.push(result(candidate.handle, "followup", "deferred", "delivery_circuit_open", {
        candidate_id: candidate.candidateId,
        circuit_reason: deliveryCircuit.reason,
        circuit_attempt_id: deliveryCircuit.outreach_attempt_id,
      }));
      continue;
    }
    if (!messageId(sentEvent.provider_message_id)) {
      report.failed++;
      report.results.push(result(candidate.handle, "followup", "failed", "missing_original_message_id"));
      continue;
    }

    const sender = deps.getSender(sentEvent.sender);
    if (!sender) {
      report.failed++;
      report.results.push(result(candidate.handle, "followup", "failed", "original_sender_unavailable"));
      continue;
    }
    if (settings.execute && deps.refreshCandidate) {
      const fresh = await deps.refreshCandidate(candidate);
      const unchanged = fresh && fresh.candidateId === candidate.candidateId &&
        fresh.stage === "01_FirstOutreach" && !fresh.suppressed &&
        fresh.email === candidate.email && fresh.allowedChannels.includes("email");
      if (!unchanged) {
        report.skipped++;
        report.results.push(result(candidate.handle, "followup", "skipped", "candidate_changed_before_followup"));
        continue;
      }
      candidate = fresh;
    }
    try {
      const message = await deps.buildFollowup(candidate, sender);
      const preview = {
        candidate_id: candidate.candidateId,
        channel: "email",
        to: candidate.email,
        from: sender.user,
        sender_account: sender.name,
        subject: message.subject,
        body: message.body,
      };
      if (!settings.execute) {
        report.results.push(result(candidate.handle, "followup", "planned", "dry_run", preview));
        continue;
      }
      if (await deps.hasReply(candidate)) {
        report.skipped++;
        report.results.push(result(candidate.handle, "followup", "skipped", "reply_arrived_before_send"));
        continue;
      }
      if (deps.hasLiveReply && await deps.hasLiveReply(candidate, sentEvent)) {
        report.skipped++;
        report.results.push(result(candidate.handle, "followup", "skipped", "reply_arrived_during_send_barrier"));
        continue;
      }
      if (await deps.hasFollowup(candidate)) {
        report.skipped++;
        report.results.push(result(candidate.handle, "followup", "skipped", "followup_already_recorded"));
        continue;
      }
      const reservation = await deps.reserveFollowup({ candidate, sender, message, sentEvent });
      const markDeliveryUnknown = async (error, reason = "delivery_result_unknown") => {
        deliveryCircuit = circuitForReservation(reservation, reason);
        report.delivery_circuit = deliveryCircuit;
        let journalError = null;
        try {
          await deps.recordFollowupUnknown({ candidate, reservation, error });
        } catch (recordError) {
          journalError = recordError;
        }
        report.failed++;
        report.results.push(result(candidate.handle, "followup", "needs_reconciliation", reason, {
          ...preview,
          expected_message_id: reservation.provider_message_id || "",
          journal_error: journalError?.message || "",
        }));
      };
      let delivery;
      try {
        delivery = await deps.sendFollowup({ candidate, sender, message, sentEvent, reservation });
      } catch (error) {
        await markDeliveryUnknown(error);
        continue;
      }
      if (delivery?.uncertain) {
        await markDeliveryUnknown(new Error(delivery.error || "provider delivery result unknown"));
        continue;
      }
      if (!delivery?.ok) {
        try {
          await deps.recordFollowupFailure({ candidate, reservation, delivery });
        } catch (error) {
          deliveryCircuit = circuitForReservation(reservation, "delivery_failure_not_durably_recorded");
          report.delivery_circuit = deliveryCircuit;
          report.failed++;
          report.results.push(result(candidate.handle, "followup", "needs_reconciliation", "delivery_failure_not_durably_recorded", {
            ...preview,
            expected_message_id: reservation.provider_message_id || "",
            journal_error: error?.message || String(error),
          }));
          continue;
        }
        report.failed++;
        report.results.push(result(candidate.handle, "followup", "failed", delivery?.error || "delivery_failed", preview));
        continue;
      }
      try {
        await deps.recordFollowupSent({ candidate, sender, reservation, delivery, message });
      } catch (error) {
        deliveryCircuit = circuitForReservation(reservation, "confirmed_delivery_not_durably_recorded");
        report.delivery_circuit = deliveryCircuit;
        report.followups_sent++;
        report.pending_sync++;
        report.results.push(result(candidate.handle, "followup", "sent_pending_sync", "confirmed_delivery_not_durably_recorded", {
          ...preview,
          message_id: delivery.messageId || reservation.provider_message_id || "",
          journal_error: error?.message || String(error),
        }));
        continue;
      }
      report.followups_sent++;
      try {
        await deps.syncFollowup({ candidate, sender, message, delivery });
      } catch (error) {
        report.pending_sync++;
        report.results.push(result(candidate.handle, "followup", "sent_pending_sync", error.message, {
          ...preview, message_id: delivery.messageId || "",
        }));
        if (settings.delayMs > 0) await (deps.sleep || wait)(settings.delayMs);
        continue;
      }
      report.results.push(result(candidate.handle, "followup", "sent", "delivered", {
        ...preview, message_id: delivery.messageId || "",
      }));
      if (settings.delayMs > 0) await (deps.sleep || wait)(settings.delayMs);
    } catch (error) {
      report.failed++;
      report.results.push(result(candidate.handle, "followup", "failed", error.message));
    }
  }
  return report;
}
