/** Repair CRM state from confirmed local sent events without sending any message. */
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import cfg from "./lib/config.mjs";
import {
  advancePipeline, btUpdateRecord, findCreatorByIdentity, hasLoggedMessage, logEmailSent,
  repairPipelineArtifacts,
} from "./lib/kol_crm.mjs";
import {
  applyFirstReplyStateToCrm, ensureFirstReplyLog, replySyncArgsFromEvent,
} from "./lib/first_reply_sync.mjs";
import { createOutreachJournal, unresolvedDeliveryEventsFrom } from "./lib/outreach_journal.mjs";
import { getSender } from "./sender_pool.mjs";
import { withRunLock } from "./lib/run_lock.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const journal = createOutreachJournal(join(root, "outreach_journal.jsonl"));
const lockPath = join(root, "outreach_run.lock");

function validateConfig(execute) {
  const required = [
    "feishu_app_id", "feishu_app_secret", "kol_crm_app_token", "kol_tbl_creators",
    "kol_tbl_pipeline_log", "kol_tbl_email_log", "kol_tbl_deadlines", "campaign_id",
  ];
  const missing = required.filter(key => !cfg[key] || String(cfg[key]).startsWith("YOUR_"));
  if (missing.length) throw new Error(`config.json missing: ${missing.join(", ")}`);
  if (execute && cfg.enable_outreach_reconciliation !== true) {
    throw new Error("set enable_outreach_reconciliation=true before using --execute");
  }
}

export function pendingSentEventsFrom(events, campaignId) {
  events = events.filter(event => event.campaign_id === campaignId);
  const synced = new Set(events.filter(event => event.event === "crm_synced").map(event => event.idempotency_key));
  const latestSent = new Map();
  for (const event of events) {
    if (event.event === "sent" && ["step01", "step01_followup"].includes(event.template_id)) {
      latestSent.set(event.idempotency_key, event);
    }
  }
  return [...latestSent.values()].filter(event => !synced.has(event.idempotency_key));
}

export function pendingReplyEventsFrom(events, campaignId) {
  return replyReconciliationGroupsFrom(events, campaignId).flatMap(group => group.pending);
}

export function replyReconciliationGroupsFrom(events, campaignId) {
  events = events.filter(event => event.campaign_id === campaignId);
  const synced = new Set(
    events.filter(event => event.event === "reply_synced")
      .map(event => event.reply_key).filter(Boolean),
  );
  const replies = new Map();
  for (const event of events) {
    if (event.event === "reply_received" && event.reply_key) replies.set(event.reply_key, event);
  }
  const ordered = [...replies.values()]
    .sort((left, right) => (Date.parse(left.event_at) || 0) - (Date.parse(right.event_at) || 0));
  const pending = ordered.filter(event => !synced.has(event.reply_key));
  const pendingCandidates = new Set(pending.map(event => event.candidate_id).filter(Boolean));
  const byCandidate = new Map();
  for (const event of ordered) {
    if (!pendingCandidates.has(event.candidate_id)) continue;
    const list = byCandidate.get(event.candidate_id) || [];
    list.push(event);
    byCandidate.set(event.candidate_id, list);
  }
  return [...byCandidate.entries()].map(([candidateId, received]) => ({
    candidateId,
    received,
    pending: received.filter(event => !synced.has(event.reply_key)),
    latest: received.at(-1),
  }));
}

export async function reconcileReplyGroup(group, deps) {
  for (const event of group.pending) await deps.ensureLog(event);
  await deps.applyState(group.latest);
  for (const event of group.pending) await deps.markSynced(event);
  return group.pending.length;
}

function fieldText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join("");
  if (typeof value === "object") return fieldText(value.text || value.name || value.value);
  return String(value).trim();
}

async function syncOutboundEvent(event) {
  const creator = await findCreatorByIdentity({
    recordId: event.record_id,
    candidateId: event.candidate_id,
    handle: event.handle,
  });
  if (!creator) throw new Error(`creator @${event.handle} no longer exists`);
  const currentHandle = fieldText(creator.fields?.username) || event.handle;
  const sender = getSender(event.sender);
  await btUpdateRecord(cfg.kol_tbl_creators, creator.record_id, {
    "Assigned To": sender?.name || event.sender || "system",
    "Last Contact Date": Date.parse(event.event_at) || Date.now(),
  });
  if (event.channel === "email" && !await hasLoggedMessage(event.provider_message_id)) {
    await logEmailSent({
      handle: currentHandle,
      direction: "outbound",
      templateId: event.template_id,
      subject: event.subject || "",
      body: event.body || "",
      sender: event.sender || "",
      messageId: event.provider_message_id || "",
      status: "sent",
    });
  }
  if (event.template_id === "step01") {
    const current = fieldText((await findCreatorByIdentity({
      recordId: creator.record_id,
      candidateId: event.candidate_id,
      handle: event.handle,
    }))?.fields?.["Pipeline Stage"]);
    const transitionNotes = `Reconciled first outreach for campaign ${cfg.campaign_id}`;
    if (current === "00_Discovered") {
      await advancePipeline({
        creator_handle: currentHandle,
        creator_record_id: creator.record_id,
        candidate_id: event.candidate_id,
        to_stage: "01_FirstOutreach",
        notes: transitionNotes,
      });
    } else if (current === "01_FirstOutreach") {
      await repairPipelineArtifacts({
        creator_handle: currentHandle,
        creator_record_id: creator.record_id,
        candidate_id: event.candidate_id,
        expected_from_stage: "00_Discovered",
        to_stage: "01_FirstOutreach",
        notes: transitionNotes,
      });
    } else {
      throw new Error(`unexpected stage ${current} for @${event.handle}`);
    }
  }
  await journal.append({
    event_version: "outreach-event.v1",
    event: "crm_synced",
    event_at: new Date().toISOString(),
    outreach_attempt_id: event.outreach_attempt_id,
    idempotency_key: event.idempotency_key,
    campaign_id: event.campaign_id,
    candidate_id: event.candidate_id,
    handle: event.handle,
    template_id: event.template_id,
    channel: event.channel,
    sender: event.sender,
    provider_message_id: event.provider_message_id || "",
    reconciled: true,
  });
}

function replySyncDependencies() {
  return {
    findCreatorByIdentity,
    updateCreator: btUpdateRecord,
    hasLoggedMessage,
    logEmailSent,
  };
}

async function ensureReplyEventLog(event) {
  await ensureFirstReplyLog(replySyncArgsFromEvent(event, cfg.kol_tbl_creators), replySyncDependencies());
}

async function applyReplyEventState(event) {
  await applyFirstReplyStateToCrm(replySyncArgsFromEvent(event, cfg.kol_tbl_creators), replySyncDependencies());
}

async function recordReplyEventSynced(event) {
  await journal.append({
    event_version: "outreach-event.v1",
    event: "reply_synced",
    event_at: new Date().toISOString(),
    outreach_attempt_id: event.outreach_attempt_id,
    idempotency_key: event.idempotency_key,
    campaign_id: event.campaign_id,
    candidate_id: event.candidate_id,
    record_id: event.record_id,
    handle: event.handle,
    reply_key: event.reply_key,
    outcome: event.outcome || "needs_review",
    reconciled: true,
  });
}

async function main() {
  const execute = process.argv.includes("--execute");
  validateConfig(execute);
  const journalEvents = await journal.entries();
  const allEvents = journalEvents.filter(event => event.campaign_id === cfg.campaign_id);
  const pending = pendingSentEventsFrom(allEvents, cfg.campaign_id);
  const ambiguous = unresolvedDeliveryEventsFrom(journalEvents, "");
  const replyGroups = replyReconciliationGroupsFrom(allEvents, cfg.campaign_id);
  const pendingReplies = replyGroups.flatMap(group => group.pending);
  const report = {
    mode: execute ? "execute" : "dry-run",
    campaign_id: cfg.campaign_id,
    pending: ambiguous.map(event => ({
      type: "delivery_unknown",
      handle: event.handle,
      template_id: event.template_id,
      attempt_id: event.outreach_attempt_id,
      expected_message_id: event.provider_message_id || "",
      recipient_endpoint: event.recipient_endpoint || "",
      action_required: "check provider/Sent mail; resolve explicitly; never auto-retry",
    })).concat(pending.map(event => ({
      type: "outbound",
      handle: event.handle,
      template_id: event.template_id,
      message_id: event.provider_message_id || "",
      idempotency_key: event.idempotency_key,
    }))).concat(pendingReplies.map(event => ({
      type: "reply",
      handle: event.handle,
      reply_key: event.reply_key,
      message_id: event.reply_message_id || "",
    }))),
    pending_outbound: pending.length,
    pending_delivery_unknown: ambiguous.length,
    pending_replies: pendingReplies.length,
    synced: 0,
    synced_outbound: 0,
    synced_replies: 0,
    failed: [],
  };
  if (!execute) { console.log(JSON.stringify(report, null, 2)); return; }
  await withRunLock(lockPath, async () => {
    for (const event of pending) {
      try {
        await syncOutboundEvent(event);
        report.synced++;
        report.synced_outbound++;
      } catch (error) {
        report.failed.push({ type: "outbound", handle: event.handle, error: error.message });
      }
    }
    for (const group of replyGroups) {
      try {
        const count = await reconcileReplyGroup(group, {
          ensureLog: ensureReplyEventLog,
          applyState: applyReplyEventState,
          markSynced: recordReplyEventSynced,
        });
        report.synced += count;
        report.synced_replies += count;
      } catch (error) {
        report.failed.push({
          type: "reply",
          handle: group.latest?.handle || "",
          candidate_id: group.candidateId,
          reply_keys: group.pending.map(event => event.reply_key),
          error: error.message,
        });
      }
    }
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.failed.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Reconciliation failed: ${error.message}`);
    process.exit(1);
  });
}
