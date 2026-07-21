/**
 * First-outreach agent entrypoint.
 *
 * Safe default: `node auto_outreach.mjs` performs a dry-run and never sends.
 * Production send: `node auto_outreach.mjs --execute --batch approved.json`.
 */
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { randomUUID } from "crypto";
import cfg from "./lib/config.mjs";
import {
  advancePipeline, buildOutreach, findCreatorByIdentity, hasLoggedMessage, hasLoggedOutreach, logEmailSent,
  searchCreators, btUpdateRecord,
} from "./lib/kol_crm.mjs";
import { fetchPersonalizeContext, personalize, personalizeHook } from "./lib/claude_personalizer.mjs";
import { sendThreaded } from "./lib/email_thread_builder.mjs";
import { sendDM } from "./lib/tiktok_dm.mjs";
import { canSend, getPoolStatus, getSender, releaseSend, reserveSend } from "./sender_pool.mjs";
import {
  createOutreachJournal, dispatchKey, providerMessageIdForAttempt, recipientBlockedFrom,
} from "./lib/outreach_journal.mjs";
import { runFirstOutreach } from "./lib/first_outreach_agent.mjs";
import { withRunLock } from "./lib/run_lock.mjs";
import { candidateFromRecord, normalizeEmail } from "./lib/outreach_policy.mjs";
import {
  createBatchManifest, readBatch, validateApprovedBatch, writeBatch,
} from "./lib/outreach_batch.mjs";
import { loadFirstContactTemplate, renderFirstContactTemplate } from "./lib/first_contact_template.mjs";
import { buildTemplatedFirstContact } from "./lib/creator_hook.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const journal = createOutreachJournal(join(root, "outreach_journal.jsonl"));
const lockPath = join(root, "outreach_run.lock");
const timestamp = () => new Date().toLocaleString("zh-CN", {
  timeZone: cfg.outreach_timezone || "Asia/Shanghai", hour12: false,
});

const CRM_ENV = {
  FEISHU_APP_ID: cfg.feishu_app_id,
  FEISHU_APP_SECRET: cfg.feishu_app_secret,
  KOL_CRM_APP_TOKEN: cfg.kol_crm_app_token,
  KOL_TBL_CREATORS: cfg.kol_tbl_creators,
  KOL_TBL_PIPELINE_LOG: cfg.kol_tbl_pipeline_log,
  KOL_TBL_EMAIL_LOG: cfg.kol_tbl_email_log,
  KOL_TBL_DEADLINES: cfg.kol_tbl_deadlines,
};

function parseArgs(argv) {
  const args = {
    execute: false,
    limit: Number(cfg.outreach_batch_limit || 25),
    delayMs: Number(cfg.outreach_delay_ms || 5000),
    personalize: true,
    allowDmFallback: Boolean(cfg.allow_tiktok_dm_fallback),
    requireApproval: cfg.require_screening_approval !== false,
    batch: "",
    writeBatch: "",
    templateFile: cfg.first_outreach_template_file || "",
    templateSpecified: false,
    limitSpecified: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--execute") args.execute = true;
    if (arg === "--dry-run") args.execute = false;
    if (arg === "--no-personalize") args.personalize = false;
    if (arg === "--allow-dm") args.allowDmFallback = true;
    if (arg === "--limit") { args.limit = Number(argv[++index]); args.limitSpecified = true; }
    if (arg === "--delay-ms") args.delayMs = Number(argv[++index]);
    if (arg === "--batch") args.batch = argv[++index] || "";
    if (arg === "--write-batch") args.writeBatch = argv[++index] || "";
    if (arg === "--template" || arg === "--template-file") {
      args.templateFile = argv[++index] || "";
      args.templateSpecified = true;
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) throw new Error("--delay-ms must be >= 0");
  if (args.execute && !args.batch) throw new Error("--execute requires --batch <approved-manifest.json>");
  if (args.execute && args.writeBatch) throw new Error("--write-batch is only valid in dry-run mode");
  if (args.execute && args.templateSpecified) {
    throw new Error("--template is only valid in dry-run mode; execute sends the frozen approved batch body");
  }
  return args;
}

function validateConfig(options) {
  const required = [
    "feishu_app_id", "feishu_app_secret", "kol_crm_app_token", "kol_tbl_creators",
    "kol_tbl_pipeline_log", "kol_tbl_email_log", "kol_tbl_deadlines", "campaign_id",
  ];
  if (!options.contentTemplate && !options.execute) required.push("our_brand_name", "default_requested_deliverable");
  const missing = required.filter(key => !cfg[key] || String(cfg[key]).startsWith("YOUR_"));
  if (missing.length) throw new Error(`config.json missing: ${missing.join(", ")}`);
  if (!options.execute) return;
  if (!Array.isArray(cfg.sender_accounts) || cfg.sender_accounts.length === 0) {
    throw new Error("config.json sender_accounts is empty");
  }
  const identities = new Set();
  for (const account of cfg.sender_accounts) {
    if (!account.name || !account.user || !account.pass) throw new Error("each sender account needs name, user, pass");
    if (!normalizeEmail(account.user)) throw new Error(`invalid sender email: ${account.user}`);
    if (/\r|\n/.test(String(account.name)) || String(account.name).length > 80) {
      throw new Error(`invalid sender display name: ${account.name}`);
    }
    const key = String(account.name).toLowerCase();
    if (identities.has(key)) throw new Error(`duplicate sender name: ${account.name}`);
    identities.add(key);
  }
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

function planningSenderPicker() {
  const status = getPoolStatus();
  const counts = new Map(status.per_account.map(account => [account.name, account.sent]));
  return () => {
    const selected = status.per_account
      .filter(account => (counts.get(account.name) || 0) < status.cap_per_account)
      .sort((left, right) => (counts.get(left.name) || 0) - (counts.get(right.name) || 0))[0];
    if (!selected) return null;
    counts.set(selected.name, (counts.get(selected.name) || 0) + 1);
    return getSender(selected.name);
  };
}

async function setSender(candidate, sender) {
  const creator = await findCreatorByIdentity(candidate);
  if (!creator) throw new Error(`creator @${candidate.handle} disappeared before CRM sync`);
  await btUpdateRecord(cfg.kol_tbl_creators, creator.record_id, {
    "Assigned To": sender.name,
    "Last Contact Date": Date.now(),
  });
}

function dependencies(options = {}) {
  const pickPlanningSender = planningSenderPicker();
  return {
    async listEvents() { return journal.entries(); },
    async listCandidates() {
      if (options.execute && options.approvedItems) {
        const records = [];
        for (const item of Object.values(options.approvedItems)) {
          const { items } = await searchCreators({ candidate_id: item.candidate_id });
          if (items.length > 1) throw new Error(`duplicate candidate_id in CRM: ${item.candidate_id}`);
          if (items[0]) records.push(items[0]);
        }
        return records;
      }
      const { items } = await searchCreators({ stage: "00_Discovered" });
      return items;
    },
    idempotencyKey(candidate, campaignId) {
      return dispatchKey({ campaignId, candidateId: candidate.candidateId, templateId: "step01" });
    },
    async hasPriorOutreach(candidate, key) {
      if (await journal.blocks(key)) return true;
      return cfg.legacy_global_step01_dedupe !== false
        ? hasLoggedOutreach(candidate.handle, "step01")
        : false;
    },
    async hasPriorRecipient({ campaignId, recipientEndpoint, templateId }) {
      return recipientBlockedFrom(await journal.entries(), campaignId, recipientEndpoint, templateId);
    },
    pickSender: pickPlanningSender,
    getSender(name) {
      const sender = getSender(name);
      return sender && canSend(sender.name) ? sender : null;
    },
    async buildOutreach(candidate, sender) {
      if (options.contentTemplate) {
        return buildTemplatedFirstContact({
          template: options.contentTemplate,
          candidate,
          senderName: senderDisplay(sender),
          brandName: cfg.our_brand_name || cfg.your_brand || "",
        });
      }
      const creator = await findCreatorByIdentity(candidate);
      if (!creator) throw new Error(`candidate ${candidate.candidateId} disappeared before rendering`);
      const built = await buildOutreach({
        creator_handle: candidate.handle,
        creator_record: creator,
        step: 1,
        custom_vars: {
          your_name: senderDisplay(sender),
          creator_name: candidate.displayName,
          creator_platform: candidate.platform,
          requested_deliverable: cfg.default_requested_deliverable || "TikTok short-form video",
          brand_name: cfg.our_brand_name || cfg.your_brand || "Brand",
        },
      });
      return { ...built, dmBody: built.tkMsg };
    },
    async personalize({ candidate, sender, channel, subject, body, rendered }) {
      let context = null;
      try {
        context = await fetchPersonalizeContext(CRM_ENV, {
          candidateId: candidate.candidateId,
          handle: candidate.handle,
        });
      } catch {}
      if (rendered?.template_spec) {
        const personalized = await personalizeHook({
          base_hook: rendered.personalization_hook,
          evidence_ids: rendered.personalization_evidence,
          creator_context: context || {
            handle: candidate.handle,
            bio: candidate.fields?.bio || "",
            style_summary: candidate.fields?.primary_category || "",
            recent_videos: [],
          },
        });
        const finalMessage = renderFirstContactTemplate(rendered.template_spec, {
          ...rendered.template_variables,
          personalized_hook: personalized.hook,
        });
        return {
          subject: finalMessage.subject,
          body: finalMessage.body,
          personalization: personalized.fallback_reason
            ? rendered.personalization
            : "ai_hook",
          personalization_evidence: personalized.evidence_ids,
          personalization_traits: rendered.personalization_traits,
          review_warnings: rendered.review_warnings,
          fallback_reason: personalized.fallback_reason,
        };
      }
      return personalize({
        template_subject: subject,
        template_body: body,
        sender_name: senderDisplay(sender),
        creator_context: context,
        channel,
      });
    },
    async getCurrentStage(candidate) {
      const creator = await findCreatorByIdentity(candidate);
      return creator ? candidateFromRecord(creator).stage : "";
    },
    async sendEmail({ candidate, sender, subject, body, sourceHtml, reservation }) {
      const response = await sendThreaded({
        creatorHandle: candidate.handle,
        env: CRM_ENV,
        smtp: smtpFor(sender),
        from: `${senderDisplay(sender)} <${sender.user}>`,
        to: candidate.email,
        subject,
        body,
        html: sourceHtml,
        messageId: reservation?.provider_message_id,
        threadMode: "new",
      });
      if (response.uncertain) throw new Error(response.error || "SMTP result unknown");
      return { ...response, ok: response.ok === true };
    },
    async sendDm({ candidate, body }) {
      const response = await sendDM({ username: candidate.handle, message: body });
      if (response?.success !== true) throw new Error(response?.error || "TikTok DM result unknown");
      return {
        ok: response?.success === true,
        messageId: response?.messageId || "",
        error: response?.error || (response?.success ? "" : "TikTok DM failed"),
      };
    },
    async reserveDelivery({
      candidate, sender, channel, subject, body, idempotencyKey, campaignId, templateId,
      recipientEndpoint, messageMeta = {},
    }) {
      const outreachAttemptId = randomUUID();
      const reservation = {
        outreach_attempt_id: outreachAttemptId,
        idempotency_key: idempotencyKey,
        campaign_id: campaignId,
        candidate_id: candidate.candidateId,
        record_id: candidate.recordId,
        handle: candidate.handle,
        template_id: templateId,
        channel,
        sender: sender.user || sender.name,
        recipient_endpoint: recipientEndpoint,
        provider_message_id: channel === "email"
          ? providerMessageIdForAttempt(outreachAttemptId, sender.user)
          : "",
        subject,
        body,
        content_template_id: messageMeta.content_template_id || "step01-rate-inquiry",
        content_template_version: messageMeta.content_template_version || "step01-rate-inquiry-v1",
        content_template_sha256: messageMeta.content_template_sha256 || "",
        outreach_intent: messageMeta.outreach_intent || "rate_inquiry",
        followup_mode: messageMeta.followup_mode || "rate_inquiry_7d",
        personalization_evidence: messageMeta.personalization_evidence || [],
        personalization_traits: messageMeta.personalization_traits || [],
        review_warnings: messageMeta.review_warnings || [],
      };
      if (channel === "email") reserveSend(sender.name);
      try {
        await journal.append({
          event_version: "outreach-event.v1",
          event: "sending",
          event_at: new Date().toISOString(),
          ...reservation,
          profile_snapshot_id: candidate.profileSnapshotId || "",
          screening_run_id: candidate.screeningRunId || "",
          template_version: "step01-first-contact-workflow-v2",
        });
      } catch (error) {
        if (channel === "email") releaseSend(sender.name);
        throw error;
      }
      return reservation;
    },
    async recordDeliveryFailure({ reservation, candidate, delivery }) {
      try {
        await journal.append({
          event_version: "outreach-event.v1",
          event: "failed",
          event_at: new Date().toISOString(),
          ...reservation,
          error: delivery?.error || "delivery_failed",
        });
      } finally {
        if (reservation.channel === "email") {
          const sender = getSender(reservation.sender);
          if (sender) releaseSend(sender.name);
        }
      }
    },
    async recordDeliveryUnknown({ reservation, error }) {
      await journal.append({
        event_version: "outreach-event.v1",
        event: "delivery_unknown",
        event_at: new Date().toISOString(),
        ...reservation,
        error: error?.message || String(error),
      });
    },
    async recordDelivery({ reservation, candidate, sender, channel, subject, body, delivery }) {
      await journal.append({
        event_version: "outreach-event.v1",
        event: "sent",
        event_at: new Date().toISOString(),
        ...reservation,
        provider_message_id: delivery.messageId || "",
        subject,
        body,
      });
    },
    async syncDelivery({ candidate, sender, channel, subject, body, delivery }) {
      await setSender(candidate, sender);
      if (channel === "email") {
        if (!await hasLoggedMessage(delivery.messageId)) {
          await logEmailSent({
            handle: candidate.handle,
            direction: "outbound",
            templateId: "step01",
            subject: delivery.subject || subject,
            body,
            sender: sender.user,
            messageId: delivery.messageId,
            status: "sent",
          });
        }
      }
    },
    async advance(candidate) {
      await advancePipeline({
        creator_handle: candidate.handle,
        creator_record_id: candidate.recordId,
        candidate_id: candidate.candidateId,
        to_stage: "01_FirstOutreach",
        notes: `First outreach sent for campaign ${cfg.campaign_id}; awaiting response`,
      });
    },
    async recordSynced({ reservation, delivery }) {
      await journal.append({
        event_version: "outreach-event.v1",
        event: "crm_synced",
        event_at: new Date().toISOString(),
        ...reservation,
        provider_message_id: delivery.messageId || "",
      });
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.execute && options.templateFile) {
    options.contentTemplate = await loadFirstContactTemplate(resolve(options.templateFile));
  }
  validateConfig(options);
  let approvedBatch = null;
  if (options.execute) {
    approvedBatch = validateApprovedBatch(await readBatch(resolve(options.batch)), cfg.campaign_id);
    if (!options.limitSpecified) options.limit = approvedBatch.items.length;
    options.approvedItems = Object.fromEntries(
      approvedBatch.items.map(item => [item.candidate_id, item]),
    );
  }
  const pool = getPoolStatus();
  console.error(`[${timestamp()}] first-outreach ${options.execute ? "EXECUTE" : "DRY-RUN"}; pool remaining=${pool.total_remaining_today}`);
  const report = await withRunLock(
    lockPath,
    () => runFirstOutreach({ ...options, campaignId: cfg.campaign_id }, dependencies(options)),
    { staleMs: Number(cfg.outreach_lock_stale_minutes || 120) * 60 * 1000 },
  );
  if (!options.execute && options.writeBatch) {
    const manifest = createBatchManifest({ campaignId: cfg.campaign_id, report });
    const batchPath = resolve(options.writeBatch);
    await writeBatch(batchPath, manifest);
    report.batch = {
      batch_id: manifest.batch_id,
      status: "pending",
      recipients: manifest.items.length,
      path: batchPath,
    };
  }
  if (approvedBatch) report.batch_id = approvedBatch.batch_id;
  console.log(JSON.stringify(report, null, 2));
  if (report.failed > 0 || report.pending_sync > 0) process.exitCode = 2;
}

main().catch(error => {
  console.error(`[${timestamp()}] Fatal: ${error.message}`);
  process.exit(1);
});
