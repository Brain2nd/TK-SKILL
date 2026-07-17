/**
 * First-contact reply + one-time 7-day follow-up loop.
 * Safe default: inspect and preview only. Add --execute for CRM writes/sends.
 */
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import cfg from "./lib/config.mjs";
import {
  btUpdateRecord, findCreatorByIdentity, hasLoggedMessage, logEmailSent, renderTemplateForCreator, searchCreators,
} from "./lib/kol_crm.mjs";
import { createOutreachJournal, dispatchKey, providerMessageIdForAttempt } from "./lib/outreach_journal.mjs";
import { classifyFirstReply } from "./lib/first_reply_classifier.mjs";
import { runFirstOutreachMonitor } from "./lib/first_outreach_monitor_agent.mjs";
import {
  applyFirstReplyStateToCrm, ensureFirstReplyLog, replySyncArgsFromEvent,
} from "./lib/first_reply_sync.mjs";
import { getEmail, listEmails } from "./lib/imap_email.mjs";
import { sendThreaded } from "./lib/email_thread_builder.mjs";
import { candidateFromRecord } from "./lib/outreach_policy.mjs";
import { canSend, getAllInboxAccounts, getSender, releaseSend, reserveSend } from "./sender_pool.mjs";
import { withRunLock } from "./lib/run_lock.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const journal = createOutreachJournal(join(root, "outreach_journal.jsonl"));
const lockPath = join(root, "outreach_run.lock");

function parseArgs(argv) {
  const args = {
    execute: false,
    followupEnabled: true,
    followupDays: Number(cfg.first_followup_days || 7),
    scanDays: Number(cfg.first_reply_scan_days || 30),
    inboxLimit: Number(cfg.first_reply_inbox_limit || 250),
    delayMs: Number(cfg.outreach_delay_ms || 5000),
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--execute") args.execute = true;
    else if (argv[index] === "--dry-run") args.execute = false;
    else if (argv[index] === "--no-followup") args.followupEnabled = false;
    else if (argv[index] === "--followup-days") args.followupDays = Number(argv[++index]);
    else if (argv[index] === "--scan-days") args.scanDays = Number(argv[++index]);
    else if (argv[index] === "--inbox-limit") args.inboxLimit = Number(argv[++index]);
    else if (argv[index] === "--delay-ms") args.delayMs = Number(argv[++index]);
  }
  if (!Number.isInteger(args.followupDays) || args.followupDays < 1) throw new Error("--followup-days must be a positive integer");
  if (!Number.isInteger(args.scanDays) || args.scanDays < 1) throw new Error("--scan-days must be a positive integer");
  if (!Number.isInteger(args.inboxLimit) || args.inboxLimit < 1 || args.inboxLimit > 5000) {
    throw new Error("--inbox-limit must be between 1 and 5000");
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error("--delay-ms must be >= 0");
  return args;
}

function validateConfig(options) {
  const required = [
    "feishu_app_id", "feishu_app_secret", "kol_crm_app_token", "kol_tbl_creators",
    "kol_tbl_email_log", "campaign_id",
    "our_brand_name", "default_requested_deliverable",
  ];
  const missing = required.filter(key => !cfg[key] || String(cfg[key]).startsWith("YOUR_"));
  if (missing.length) throw new Error(`config.json missing: ${missing.join(", ")}`);
  if (options.execute && cfg.enable_first_outreach_monitor !== true) {
    throw new Error("set enable_first_outreach_monitor=true before using --execute");
  }
}

function extractAddress(value) {
  const text = String(value || "").trim();
  const bracketed = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const plain = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return String(bracketed?.[1] || plain?.[0] || "").toLowerCase();
}

function normalizedMessageId(value) {
  return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function normalizedSubject(value) {
  return String(value || "").trim().replace(/^\s*(?:(?:re|fw|fwd|aw|sv)\s*:\s*)+/i, "").toLowerCase();
}

function smtpFor(sender) {
  const port = Number(sender.env.SMTP_PORT);
  return {
    host: sender.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: sender.env.IMAP_USER, pass: sender.env.IMAP_PASSWORD },
  };
}

function senderDisplay(sender) {
  const name = String(sender.name || cfg.default_sender_name || "Partnerships");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function crmEnv() {
  return {
    FEISHU_APP_ID: cfg.feishu_app_id,
    FEISHU_APP_SECRET: cfg.feishu_app_secret,
    KOL_CRM_APP_TOKEN: cfg.kol_crm_app_token,
    KOL_TBL_EMAIL_LOG: cfg.kol_tbl_email_log,
  };
}

function dependencies(options) {
  return {
    async listCandidates() {
      return (await searchCreators({ stage: "01_FirstOutreach" })).items;
    },
    async listEvents() { return journal.entries(); },
    async listReplies() {
      const since = new Date(Date.now() - options.scanDays * 86400000);
      const replies = [];
      for (const account of getAllInboxAccounts()) {
        const headers = await listEmails(account.env, {
          sinceDate: since,
          limit: options.inboxLimit,
        });
        for (const header of headers) {
          const email = await getEmail(account.env, { uid: header.uid });
          if (!email) continue;
          replies.push({
            ...email,
            inbox: account.name,
            fromAddress: extractAddress(email.from),
          });
        }
      }
      return replies;
    },
    async classifyReply(reply) {
      return classifyFirstReply(reply);
    },
    async recordReply({ candidate, reply, classification, replyKey, sentEvent, matchMethod }) {
      await journal.append({
        event_version: "outreach-event.v1",
        event: "reply_received",
        event_at: new Date(reply.date || Date.now()).toISOString(),
        outreach_attempt_id: sentEvent.outreach_attempt_id,
        idempotency_key: sentEvent.idempotency_key,
        campaign_id: cfg.campaign_id,
        candidate_id: candidate.candidateId,
        record_id: candidate.recordId,
        handle: candidate.handle,
        template_id: sentEvent.template_id,
        reply_key: replyKey,
        reply_message_id: reply.messageId || "",
        reply_to_message_id: reply.inReplyTo || "",
        outcome: classification.outcome,
        detected_outcome: classification.detected_outcome || classification.outcome,
        matched_by: matchMethod,
        confidence: classification.confidence,
        quotes: classification.quotes,
        usage_rights: classification.usage_rights,
        media_kit_urls: classification.media_kit_urls,
        media_kit_files: classification.media_kit_files,
        body_preview: classification.body_preview,
        reply_subject: reply.subject || "",
        reply_from: reply.fromAddress || reply.from || "",
        reply_body: reply.text || "",
      });
    },
    async ensureReplyLog({ candidate, reply, classification, replyKey }) {
      await ensureFirstReplyLog({
        candidate,
        reply,
        classification,
        replyKey,
      }, {
        findCreatorByIdentity,
        hasLoggedMessage,
        logEmailSent,
      });
    },
    async applyReplyState({ candidate, reply, classification, replyKey }) {
      await applyFirstReplyStateToCrm({
        candidate,
        reply,
        classification,
        replyKey,
        creatorsTable: cfg.kol_tbl_creators,
      }, { findCreatorByIdentity, updateCreator: btUpdateRecord });
    },
    async applyReplyEventState({ event }) {
      await applyFirstReplyStateToCrm(
        replySyncArgsFromEvent(event, cfg.kol_tbl_creators),
        { findCreatorByIdentity, updateCreator: btUpdateRecord },
      );
    },
    async recordReplySynced({ candidate, replyKey, classification }) {
      await journal.append({
        event_version: "outreach-event.v1",
        event: "reply_synced",
        event_at: new Date().toISOString(),
        campaign_id: cfg.campaign_id,
        candidate_id: candidate.candidateId,
        handle: candidate.handle,
        reply_key: replyKey,
        outcome: classification.outcome,
      });
    },
    getSender(identity) {
      const sender = getSender(identity);
      return sender && canSend(sender.name) ? sender : null;
    },
    async buildFollowup(candidate, sender) {
      const creator = await findCreatorByIdentity(candidate);
      if (!creator) throw new Error(`candidate ${candidate.candidateId} not found before follow-up`);
      return renderTemplateForCreator({
        creator_handle: candidate.handle,
        creator_record: creator,
        step: 1,
        variant: "followup",
        sender_override: sender.name,
        custom_vars: {
          creator_name: candidate.displayName,
          requested_deliverable: cfg.default_requested_deliverable || "TikTok short-form video",
          brand_name: cfg.our_brand_name || cfg.your_brand || "Brand",
          your_name: senderDisplay(sender),
        },
      });
    },
    async hasReply(candidate) {
      return (await journal.entries()).some(event =>
        event.campaign_id === cfg.campaign_id && event.candidate_id === candidate.candidateId && event.event === "reply_received"
      );
    },
    async hasLiveReply(candidate, sentEvent) {
      const account = getSender(sentEvent.sender);
      if (!account) throw new Error("original sender unavailable for final reply barrier");
      const sentAt = new Date(sentEvent.event_at);
      const headers = await listEmails(account.env, {
        sinceDate: sentAt,
        limit: Math.min(options.inboxLimit, 100),
      });
      const rootMessageId = normalizedMessageId(sentEvent.provider_message_id);
      for (const header of headers) {
        if (extractAddress(header.from) !== candidate.email) continue;
        const email = await getEmail(account.env, { uid: header.uid });
        if (!email) continue;
        const threadIds = [email.inReplyTo, ...(email.references || [])].map(normalizedMessageId).filter(Boolean);
        if (rootMessageId && threadIds.includes(rootMessageId)) return true;
        const replyAt = Date.parse(email.date);
        if (Number.isFinite(replyAt) && replyAt >= sentAt.getTime() &&
            normalizedSubject(email.subject) === normalizedSubject(sentEvent.subject)) return true;
      }
      return false;
    },
    async refreshCandidate(candidate) {
      const creator = await findCreatorByIdentity(candidate);
      return creator ? candidateFromRecord(creator) : null;
    },
    async hasFollowup(candidate) {
      const key = dispatchKey({
        campaignId: cfg.campaign_id,
        candidateId: candidate.candidateId,
        templateId: "step01_followup",
      });
      return journal.blocks(key);
    },
    async reserveFollowup({ candidate, sender, message }) {
      const outreachAttemptId = randomUUID();
      const reservation = {
        outreach_attempt_id: outreachAttemptId,
        idempotency_key: dispatchKey({
          campaignId: cfg.campaign_id,
          candidateId: candidate.candidateId,
          templateId: "step01_followup",
        }),
        campaign_id: cfg.campaign_id,
        candidate_id: candidate.candidateId,
        record_id: candidate.recordId,
        handle: candidate.handle,
        template_id: "step01_followup",
        channel: "email",
        sender: sender.user,
        recipient_endpoint: `email:${candidate.email}`,
        provider_message_id: providerMessageIdForAttempt(outreachAttemptId, sender.user),
        subject: message.subject,
        body: message.body,
      };
      reserveSend(sender.name);
      try {
        await journal.append({
          event_version: "outreach-event.v1", event: "sending", event_at: new Date().toISOString(), ...reservation,
        });
      } catch (error) {
        releaseSend(sender.name);
        throw error;
      }
      return reservation;
    },
    async sendFollowup({ candidate, sender, message, sentEvent, reservation }) {
      const response = await sendThreaded({
        creatorHandle: candidate.handle,
        env: crmEnv(),
        smtp: smtpFor(sender),
        from: `${senderDisplay(sender)} <${sender.user}>`,
        to: candidate.email,
        subject: message.subject,
        body: message.body,
        html: message.bodyHtml,
        messageId: reservation?.provider_message_id,
        threadMode: "reply",
        replyToMessageId: sentEvent.provider_message_id,
        outboundChain: [{
          messageId: sentEvent.provider_message_id,
          subject: sentEvent.subject || message.subject,
          bodyFull: sentEvent.body || "",
          sentAt: Date.parse(sentEvent.event_at) || Date.now(),
          sender: sentEvent.sender || "",
          templateId: sentEvent.template_id || "step01",
        }],
      });
      if (response.uncertain) throw new Error(response.error || "SMTP result unknown");
      return response;
    },
    async recordFollowupUnknown({ reservation, error }) {
      await journal.append({
        event_version: "outreach-event.v1", event: "delivery_unknown", event_at: new Date().toISOString(),
        ...reservation, error: error.message,
      });
    },
    async recordFollowupFailure({ reservation, delivery }) {
      try {
        await journal.append({
          event_version: "outreach-event.v1", event: "failed", event_at: new Date().toISOString(),
          ...reservation, error: delivery?.error || "delivery_failed",
        });
      } finally {
        const sender = getSender(reservation.sender);
        if (sender) releaseSend(sender.name);
      }
    },
    async recordFollowupSent({ sender, reservation, delivery, message }) {
      await journal.append({
        event_version: "outreach-event.v1", event: "sent", event_at: new Date().toISOString(),
        ...reservation, provider_message_id: delivery.messageId || "",
        subject: delivery.subject || message.subject,
        body: message.body,
      });
    },
    async syncFollowup({ candidate, sender, message, delivery }) {
      if (!await hasLoggedMessage(delivery.messageId)) {
        await logEmailSent({
          handle: candidate.handle,
          direction: "outbound",
          templateId: "step01_followup",
          subject: delivery.subject || message.subject,
          body: message.body,
          sender: sender.user,
          messageId: delivery.messageId || "",
          status: "sent",
        });
      }
      await journal.append({
        event_version: "outreach-event.v1", event: "crm_synced", event_at: new Date().toISOString(),
        idempotency_key: dispatchKey({ campaignId: cfg.campaign_id, candidateId: candidate.candidateId, templateId: "step01_followup" }),
        campaign_id: cfg.campaign_id, candidate_id: candidate.candidateId, handle: candidate.handle,
        template_id: "step01_followup", channel: "email", sender: sender.user,
        provider_message_id: delivery.messageId || "",
      });
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateConfig(options);
  const report = await withRunLock(
    lockPath,
    () => runFirstOutreachMonitor({
      ...options,
      campaignId: cfg.campaign_id,
      followupEnabled: options.followupEnabled,
    }, dependencies(options)),
    { staleMs: Number(cfg.outreach_lock_stale_minutes || 120) * 60000 },
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.failed || report.pending_sync) process.exitCode = 2;
}

main().catch(error => {
  console.error(`First-outreach monitor failed: ${error.message}`);
  process.exit(1);
});
