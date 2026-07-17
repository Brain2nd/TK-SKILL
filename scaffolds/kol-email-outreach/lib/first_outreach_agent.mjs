import { evaluateCandidate, sanitizeSubject, validateMessage } from "./outreach_policy.mjs";
import { deliveryCircuitFrom } from "./outreach_journal.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function result(handle, status, reason, extra = {}) {
  return { handle, status, reason, ...extra };
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

export async function runFirstOutreach(options, deps) {
  const settings = {
    execute: false,
    limit: 25,
    delayMs: 0,
    minExecuteDelayMs: 1000,
    allowDmFallback: false,
    requireApproval: true,
    personalize: true,
    campaignId: "",
    approvedItems: null,
    ...options,
  };
  if (!settings.campaignId) throw new Error("campaignId is required");
  if (settings.execute && !settings.approvedItems) {
    throw new Error("execute mode requires an approved batch manifest");
  }
  if (settings.execute && settings.delayMs < settings.minExecuteDelayMs) {
    throw new Error(`execute delayMs must be at least ${settings.minExecuteDelayMs}`);
  }
  if (settings.execute && typeof deps.listEvents !== "function") {
    throw new Error("execute mode requires the durable delivery journal");
  }
  if (settings.execute && typeof deps.hasPriorRecipient !== "function") {
    throw new Error("execute mode requires recipient-endpoint idempotency");
  }

  const records = await deps.listCandidates();
  const report = {
    mode: settings.execute ? "execute" : "dry-run",
    campaign_id: settings.campaignId,
    discovered: records.length,
    planned: 0,
    sent: 0,
    pending_sync: 0,
    skipped: 0,
    failed: 0,
    delivery_circuit: { open: false, unresolved_count: 0 },
    results: [],
  };
  let deliveryCircuit = settings.execute
    ? deliveryCircuitFrom(await deps.listEvents(), "")
    : report.delivery_circuit;
  report.delivery_circuit = deliveryCircuit;
  const seen = new Set();
  const seenRecipients = new Set();
  const encountered = new Set();
  let eligibleCount = 0;

  for (const record of records) {
    const evaluated = evaluateCandidate(record, settings);
    const candidate = evaluated.candidate;
    if (candidate.candidateId) encountered.add(candidate.candidateId);
    if (!evaluated.eligible) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", evaluated.reason));
      continue;
    }
    if (seen.has(candidate.candidateId)) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", "duplicate_candidate"));
      continue;
    }
    seen.add(candidate.candidateId);
    const approvedItem = settings.approvedItems?.[candidate.candidateId] || null;
    if (settings.execute && !approvedItem) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", "not_in_approved_batch"));
      continue;
    }
    const plannedChannel = approvedItem?.channel || candidate.outreachChannel || (candidate.email ? "email" : "tiktok_dm");
    const recipientKey = plannedChannel === "email"
      ? `email:${candidate.email}`
      : `tiktok_dm:${candidate.handle}`;
    if (seenRecipients.has(recipientKey)) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", "duplicate_recipient_endpoint", {
        candidate_id: candidate.candidateId,
        recipient_endpoint: recipientKey,
      }));
      continue;
    }
    seenRecipients.add(recipientKey);
    const idempotencyKey = deps.idempotencyKey(candidate, settings.campaignId);
    if (deliveryCircuit.open) {
      report.skipped++;
      report.results.push(result(candidate.handle, "deferred", "delivery_circuit_open", {
        candidate_id: candidate.candidateId,
        idempotency_key: idempotencyKey,
        circuit_reason: deliveryCircuit.reason,
        circuit_attempt_id: deliveryCircuit.outreach_attempt_id,
      }));
      continue;
    }
    if (await deps.hasPriorRecipient?.({
      campaignId: settings.campaignId,
      recipientEndpoint: recipientKey,
      templateId: "step01",
    })) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", "recipient_already_contacted", {
        candidate_id: candidate.candidateId,
        recipient_endpoint: recipientKey,
      }));
      continue;
    }
    if (await deps.hasPriorOutreach(candidate, idempotencyKey)) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", "already_sent", { idempotency_key: idempotencyKey }));
      continue;
    }
    if (eligibleCount >= settings.limit) {
      report.skipped++;
      report.results.push(result(candidate.handle, "skipped", "batch_limit"));
      continue;
    }

    const sender = approvedItem
      ? deps.getSender(approvedItem.sender_account)
      : deps.pickSender();
    if (!sender) {
      report.skipped++;
      report.results.push(result(
        candidate.handle,
        approvedItem ? "skipped" : "deferred",
        approvedItem ? "approved_sender_unavailable" : "sender_pool_exhausted",
      ));
      continue;
    }

    try {
      const rendered = approvedItem
        ? {
            subject: approvedItem.subject,
            body: approvedItem.body,
            dmBody: approvedItem.body,
            bodyHtml: "",
            content_template_id: approvedItem.content_template_id,
            content_template_version: approvedItem.content_template_version,
            content_template_sha256: approvedItem.content_template_sha256,
            outreach_intent: approvedItem.outreach_intent,
            followup_mode: approvedItem.followup_mode,
            personalization_evidence: approvedItem.personalization_evidence,
            personalization_traits: approvedItem.personalization_traits,
            review_warnings: approvedItem.review_warnings,
          }
        : await deps.buildOutreach(candidate, sender, { personalize: settings.personalize });
      const channel = plannedChannel;
      if (!candidate.allowedChannels.includes(channel)) {
        throw new Error(approvedItem ? "approved_channel_no_longer_allowed" : "contact_channel_not_allowed");
      }
      if (channel !== "email" && !settings.allowDmFallback) throw new Error("dm_fallback_not_enabled");
      let subject = rendered.subject || "";
      let body = channel === "email" ? rendered.body : rendered.dmBody;
      let personalization = approvedItem?.personalization || rendered.personalization || "template";
      let messageMeta = {
        content_template_id: rendered.content_template_id || "",
        content_template_version: rendered.content_template_version || "",
        content_template_sha256: rendered.content_template_sha256 || "",
        outreach_intent: rendered.outreach_intent || "rate_inquiry",
        followup_mode: rendered.followup_mode || "rate_inquiry_7d",
        personalization_evidence: rendered.personalization_evidence || [],
        personalization_traits: rendered.personalization_traits || [],
        review_warnings: rendered.review_warnings || [],
      };

      if (!approvedItem && settings.personalize && deps.personalize) {
        const personalized = await deps.personalize({ candidate, sender, channel, subject, body, rendered });
        subject = personalized.subject || subject;
        body = personalized.body || body;
        personalization = personalized.personalization
          || (personalized.fallback_reason ? `fallback:${personalized.fallback_reason}` : "ai");
        messageMeta = {
          ...messageMeta,
          personalization_evidence: personalized.personalization_evidence || messageMeta.personalization_evidence,
          personalization_traits: personalized.personalization_traits || messageMeta.personalization_traits,
          review_warnings: personalized.review_warnings || messageMeta.review_warnings,
        };
      }
      const canonicalSubject = sanitizeSubject(subject);
      if (approvedItem && canonicalSubject !== subject) {
        throw new Error("approved_batch_subject_not_canonical");
      }
      subject = canonicalSubject;
      const check = validateMessage({ subject, body, channel });
      if (!check.valid) throw new Error(check.reason);

      if (approvedItem) {
        const expectedTo = channel === "email" ? candidate.email : `@${candidate.handle}`;
        if (approvedItem.handle !== candidate.handle || approvedItem.to !== expectedTo) {
          throw new Error("approved_batch_candidate_mismatch");
        }
        if (approvedItem.idempotency_key !== idempotencyKey) throw new Error("approved_batch_idempotency_mismatch");
        if (approvedItem.from !== sender.user) throw new Error("approved_batch_sender_mismatch");
      }

      eligibleCount++;
      const preview = {
        candidate_id: candidate.candidateId,
        idempotency_key: idempotencyKey,
        channel,
        to: channel === "email" ? candidate.email : `@${candidate.handle}`,
        from: sender.user || sender.name,
        sender_account: sender.name,
        subject: channel === "email" ? subject : undefined,
        body,
        personalization,
        ...messageMeta,
      };
      report.planned++;
      if (!settings.execute) {
        report.results.push(result(candidate.handle, "planned", "dry_run", preview));
        continue;
      }

      const currentStage = await deps.getCurrentStage(candidate);
      if (currentStage !== "00_Discovered") {
        report.skipped++;
        report.results.push(result(candidate.handle, "skipped", "stage_changed_before_send", { current_stage: currentStage }));
        continue;
      }
      if (await deps.hasPriorOutreach(candidate, idempotencyKey)) {
        report.skipped++;
        report.results.push(result(candidate.handle, "skipped", "already_sent_before_send"));
        continue;
      }
      if (await deps.hasPriorRecipient({
        campaignId: settings.campaignId,
        recipientEndpoint: recipientKey,
        templateId: "step01",
      })) {
        report.skipped++;
        report.results.push(result(candidate.handle, "skipped", "recipient_already_contacted_before_send"));
        continue;
      }

      const reservation = await deps.reserveDelivery({
        candidate, sender, channel, subject, body, idempotencyKey,
        campaignId: settings.campaignId, templateId: "step01", recipientEndpoint: recipientKey, messageMeta,
      });
      const markDeliveryUnknown = async (error, reason = "delivery_result_unknown") => {
        deliveryCircuit = circuitForReservation(reservation, reason);
        report.delivery_circuit = deliveryCircuit;
        let journalError = null;
        try {
          await deps.recordDeliveryUnknown?.({ reservation, candidate, error });
        } catch (recordError) {
          journalError = recordError;
        }
        report.failed++;
        report.results.push(result(candidate.handle, "needs_reconciliation", reason, {
          ...preview,
          expected_message_id: reservation.provider_message_id || "",
          journal_error: journalError?.message || "",
        }));
      };
      let delivery;
      try {
        delivery = channel === "email"
          ? await deps.sendEmail({ candidate, sender, subject, body, sourceHtml: rendered.bodyHtml, reservation })
          : await deps.sendDm({ candidate, sender, body, reservation });
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
          await deps.recordDeliveryFailure?.({ reservation, candidate, delivery });
        } catch (error) {
          deliveryCircuit = circuitForReservation(reservation, "delivery_failure_not_durably_recorded");
          report.delivery_circuit = deliveryCircuit;
          report.failed++;
          report.results.push(result(candidate.handle, "needs_reconciliation", "delivery_failure_not_durably_recorded", {
            ...preview,
            expected_message_id: reservation.provider_message_id || "",
            journal_error: error?.message || String(error),
          }));
          continue;
        }
        report.failed++;
        report.results.push(result(candidate.handle, "failed", delivery?.error || "delivery_failed", preview));
        continue;
      }

      try {
        await deps.recordDelivery({
          reservation, candidate, sender, channel, subject, body, delivery, idempotencyKey,
          campaignId: settings.campaignId, templateId: "step01",
        });
      } catch (error) {
        deliveryCircuit = circuitForReservation(reservation, "confirmed_delivery_not_durably_recorded");
        report.delivery_circuit = deliveryCircuit;
        report.sent++;
        report.pending_sync++;
        report.results.push(result(candidate.handle, "sent_pending_sync", "confirmed_delivery_not_durably_recorded", {
          ...preview,
          message_id: delivery.messageId || reservation.provider_message_id || "",
          journal_error: error?.message || String(error),
        }));
        continue;
      }
      try {
        await deps.syncDelivery?.({ candidate, sender, channel, subject, body, delivery });
        await deps.advance(candidate);
        await deps.recordSynced?.({ reservation, candidate, delivery });
      } catch (error) {
        report.sent++;
        report.pending_sync++;
        report.results.push(result(candidate.handle, "sent_pending_sync", error?.message || "crm_sync_failed", {
          ...preview,
          message_id: delivery.messageId || "",
        }));
        if (settings.delayMs > 0) await (deps.sleep || wait)(settings.delayMs);
        continue;
      }
      report.sent++;
      report.results.push(result(candidate.handle, "sent", "delivered", {
        ...preview,
        message_id: delivery.messageId || "",
      }));
      if (settings.delayMs > 0) await (deps.sleep || wait)(settings.delayMs);
    } catch (error) {
      report.failed++;
      report.results.push(result(candidate.handle, "failed", error?.message || String(error)));
    }
  }

  if (settings.execute && settings.approvedItems) {
    for (const [candidateId, item] of Object.entries(settings.approvedItems)) {
      if (encountered.has(candidateId)) continue;
      report.skipped++;
      report.results.push(result(item.handle || "", "skipped", "approved_candidate_not_found", {
        candidate_id: candidateId,
      }));
    }
  }

  return report;
}
