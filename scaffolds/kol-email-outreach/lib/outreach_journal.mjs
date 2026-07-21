import { mkdir, open, readFile } from "fs/promises";
import { dirname } from "path";

const DELIVERY_LIFECYCLE_EVENTS = new Set([
  "sending",
  "delivery_unknown",
  "delivery_not_sent",
  "failed",
  "sent",
  "crm_synced",
]);

export function dispatchKey({ campaignId, candidateId, templateId = "step01" }) {
  return `${campaignId}:${candidateId}:${templateId}`;
}

/** Allocate the RFC Message-ID before SMTP so an ambiguous send can be checked in Sent mail. */
export function providerMessageIdForAttempt(attemptId, senderEmail) {
  const token = String(attemptId || "").trim().replace(/[^a-z0-9.-]/gi, "");
  const domain = String(senderEmail || "").trim().toLowerCase().split("@").at(-1) || "";
  if (!token || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new Error("cannot allocate provider Message-ID from attempt and sender");
  }
  return `<outreach.${token}@${domain}>`;
}

function deliveryAttemptGroups(events) {
  const groups = new Map();
  for (const [index, event] of (events || []).entries()) {
    if (!event?.idempotency_key || !DELIVERY_LIFECYCLE_EVENTS.has(event.event)) continue;
    const attemptKey = event.outreach_attempt_id || `legacy:${event.idempotency_key}:${index}`;
    const list = groups.get(attemptKey) || [];
    list.push(event);
    groups.set(attemptKey, list);
  }
  return [...groups.values()];
}

function unresolvedAttemptEvent(attempt) {
  const lastUnknown = attempt.findLastIndex?.(event => event.event === "delivery_unknown")
    ?? (() => {
      for (let index = attempt.length - 1; index >= 0; index--) {
        if (attempt[index].event === "delivery_unknown") return index;
      }
      return -1;
    })();
  if (lastUnknown >= 0) {
    const explicitlyResolved = attempt.slice(lastUnknown + 1).some(event =>
      ["sent", "crm_synced", "delivery_not_sent"].includes(event.event)
    );
    if (!explicitlyResolved) return attempt[lastUnknown];
  }
  const latest = attempt.at(-1);
  return latest?.event === "sending" ? latest : null;
}

/** A success is sticky; a later failed racing attempt can never reopen the same dispatch key. */
export function dispatchBlockedFrom(events, idempotencyKey) {
  const matching = (events || []).filter(event => event?.idempotency_key === idempotencyKey);
  if (matching.some(event => event.event === "sent" || event.event === "crm_synced")) return true;
  return deliveryAttemptGroups(matching).some(attempt => Boolean(unresolvedAttemptEvent(attempt)));
}

export function recipientBlockedFrom(events, campaignId, recipientEndpoint, templateId = "step01") {
  const keys = new Set((events || [])
    .filter(event => event?.campaign_id === campaignId && event?.template_id === templateId &&
      event?.recipient_endpoint === recipientEndpoint && event?.idempotency_key)
    .map(event => event.idempotency_key));
  return [...keys].some(key => dispatchBlockedFrom(events, key));
}

/**
 * Return the latest unresolved provider outcomes for a campaign.
 * Journal append order is authoritative: timestamps can be supplied by external systems and drift.
 */
export function unresolvedDeliveryEventsFrom(events, campaignId, templateIds = ["step01", "step01_followup"]) {
  const templates = new Set(templateIds);
  const matching = (events || []).filter(event =>
    (!campaignId || event?.campaign_id === campaignId) && templates.has(event?.template_id)
  );
  return deliveryAttemptGroups(matching).map(unresolvedAttemptEvent).filter(Boolean);
}

export function deliveryCircuitFrom(events, campaignId, templateIds) {
  const unresolved = unresolvedDeliveryEventsFrom(events, campaignId, templateIds);
  if (!unresolved.length) return { open: false, unresolved_count: 0 };
  const trigger = unresolved[0];
  return {
    open: true,
    reason: `unresolved_${trigger.event}`,
    unresolved_count: unresolved.length,
    opened_at: trigger.event_at || "",
    campaign_id: trigger.campaign_id || campaignId,
    candidate_id: trigger.candidate_id || "",
    outreach_attempt_id: trigger.outreach_attempt_id || "",
    idempotency_key: trigger.idempotency_key || "",
    template_id: trigger.template_id || "",
  };
}

export function createOutreachJournal(filePath) {
  async function entries() {
    try {
      const content = await readFile(filePath, "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); }
        catch { throw new Error(`corrupt outreach journal at line ${index + 1}`); }
      });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  return {
    async find(key) {
      const list = await entries();
      return list.findLast?.(entry => entry.idempotency_key === key)
        || [...list].reverse().find(entry => entry.idempotency_key === key)
        || null;
    },
    async blocks(key) {
      return dispatchBlockedFrom(await entries(), key);
    },
    async append(event) {
      await mkdir(dirname(filePath), { recursive: true });
      const handle = await open(filePath, "a");
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return event;
    },
    entries,
  };
}
