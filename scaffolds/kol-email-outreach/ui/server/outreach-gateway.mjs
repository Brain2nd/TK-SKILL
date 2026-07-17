import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOutreachJournal,
  deliveryCircuitFrom,
  dispatchKey,
  providerMessageIdForAttempt,
  recipientBlockedFrom,
  unresolvedDeliveryEventsFrom,
} from "../../lib/outreach_journal.mjs";
import { withRunLock } from "../../lib/run_lock.mjs";
import { normalizeEmail, sanitizeSubject, validateMessage } from "../../lib/outreach_policy.mjs";
import { sendThreaded } from "../../lib/email_thread_builder.mjs";
import { personalizeHook } from "../../lib/claude_personalizer.mjs";
import { canonicalBatchSnapshot, canonicalItemPayload } from "../lib/outreach-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, "..");
const coreRoot = resolve(siteRoot, "..");
const dataRoot = resolve(process.env.LOOP_GATEWAY_DATA_ROOT || resolve(siteRoot, "server-data"));
const stateFile = resolve(process.env.LOOP_SENDER_STATE || resolve(coreRoot, "sender_state.json"));
const jobsFile = resolve(dataRoot, "send-jobs.json");
const journal = createOutreachJournal(resolve(process.env.LOOP_OUTREACH_JOURNAL || resolve(coreRoot, "outreach_journal.jsonl")));
const lockPath = resolve(process.env.LOOP_OUTREACH_LOCK || resolve(coreRoot, "outreach_run.lock"));
const requireFromCore = createRequire(resolve(coreRoot, "package.json"));
const nodemailer = requireFromCore("nodemailer");

const accounts = new Map();
const aiProfiles = new Map();
const personalizationCache = new Map();
const jobs = new Map();
let queueTail = Promise.resolve();
let ledgerTail = Promise.resolve();
let jobsLoaded = false;

function isLoopback(address = "") {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicAccount(account) {
  return {
    id: account.id,
    label: account.label,
    from_name: account.fromName,
    from_email: account.email,
    reply_to_email: account.replyTo,
    smtp_host: account.smtpHost,
    smtp_port: account.smtpPort,
    secure: account.secure,
    daily_cap: account.dailyCap,
    configured: Boolean(account.password),
    verified: account.verified === true,
    last_verified_at: account.lastVerifiedAt || "",
  };
}

function accountKey(ownerKey, senderId) {
  return `${ownerKey}:${senderId}`;
}

function publicAiProfile(profile) {
  return profile ? {
    provider: profile.provider,
    model: profile.model,
    configured: Boolean(profile.apiKey),
    configured_at: profile.configuredAt,
  } : {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    configured: false,
    configured_at: "",
  };
}

export function validateAiProfile(input) {
  const ownerKey = String(input.owner_key || "").trim().toLowerCase();
  const provider = String(input.provider || "anthropic").trim().toLowerCase();
  const model = String(input.model || "claude-sonnet-4-6").trim();
  const apiKey = String(input.api_key || "").trim();
  if (!/^[a-f0-9]{16}$/.test(ownerKey)) throw new Error("invalid AI owner scope");
  if (provider !== "anthropic") throw new Error("only Anthropic is supported by this local gateway");
  if (!/^[a-z0-9._:-]{3,120}$/i.test(model)) throw new Error("invalid AI model name");
  if (apiKey.length < 20 || apiKey.length > 500) throw new Error("a valid write-only AI API key is required");
  return { ownerKey, provider, model, apiKey, configuredAt: new Date().toISOString() };
}

function validatePersonalizationRequest(input) {
  const ownerKey = String(input.owner_key || "").trim().toLowerCase();
  const snapshotHash = String(input.snapshot_hash || "").trim().toLowerCase();
  const project = input.project && typeof input.project === "object" ? input.project : {};
  const recipients = Array.isArray(input.recipients) ? input.recipients : [];
  if (!/^[a-f0-9]{16}$/.test(ownerKey)) throw new Error("invalid AI owner scope");
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error("valid personalization snapshot hash is required");
  if (!recipients.length || recipients.length > 100) throw new Error("personalization batch must contain 1..100 recipients");
  if (!String(project.subject || "").trim() || !String(project.body || "").trim()) throw new Error("project template is required");
  const recipientIds = new Set();
  for (const recipient of recipients) {
    const recipientId = String(recipient.recipient_id || "").trim();
    if (!recipientId || recipientIds.has(recipientId)) throw new Error("duplicate or missing personalization recipient id");
    recipientIds.add(recipientId);
  }
  return { ownerKey, snapshotHash, project, recipients };
}

async function personalizeBatch(input) {
  const request = validatePersonalizationRequest(input);
  const profile = aiProfiles.get(request.ownerKey);
  if (!profile?.apiKey) throw new Error("AI API key is not configured in this local gateway session");
  const cacheKey = `${request.ownerKey}:${profile.configuredAt}:${request.snapshotHash}`;
  if (personalizationCache.has(cacheKey)) return personalizationCache.get(cacheKey);
  const results = [];
  for (const recipient of request.recipients) {
    const personalized = await personalizeHook({
      api_key: profile.apiKey,
      model: profile.model,
      base_hook: String(recipient.base_hook || ""),
      evidence_ids: Array.isArray(recipient.base_evidence_ids) ? recipient.base_evidence_ids : [],
      creator_context: {
        handle: String(recipient.handle || ""),
        bio: String(recipient.bio || ""),
        style_summary: String(recipient.style_summary || ""),
        recent_videos: Array.isArray(recipient.recent_videos) ? recipient.recent_videos.slice(0, 5) : [],
      },
      template_context: {
        subject: String(request.project.subject || ""),
        body: String(request.project.body || ""),
        brand_name: String(request.project.brand_name || ""),
      },
    });
    let hook = String(personalized.hook || "").trim();
    let fallbackReason = String(personalized.fallback_reason || "").trim();
    if (hook.length > 240 || /[\r\n]|https?:\/\//i.test(hook)) {
      hook = String(recipient.base_hook || "").trim().slice(0, 240);
      fallbackReason = "AI output failed the local hook safety check";
    }
    results.push({
      recipient_id: String(recipient.recipient_id),
      hook,
      evidence_ids: Array.isArray(personalized.evidence_ids) ? personalized.evidence_ids.map(String) : [],
      method: fallbackReason ? "deterministic_fallback" : "ai",
      fallback_reason: fallbackReason,
    });
  }
  const response = {
    snapshot_hash: request.snapshotHash,
    provider: profile.provider,
    model: profile.model,
    results,
  };
  personalizationCache.set(cacheKey, response);
  if (personalizationCache.size > 50) personalizationCache.delete(personalizationCache.keys().next().value);
  return response;
}

export function validateSenderInput(input) {
  const senderId = String(input.id || `sender_${randomUUID()}`).trim();
  const ownerKey = String(input.owner_key || "").trim().toLowerCase();
  const email = normalizeEmail(input.from_email);
  const replyTo = input.reply_to_email ? normalizeEmail(input.reply_to_email) : "";
  const smtpHost = String(input.smtp_host || "").trim().toLowerCase();
  const smtpPort = Number(input.smtp_port || 0);
  const password = String(input.password || "");
  const fromName = String(input.from_name || "").trim();
  const dailyCap = Number(input.daily_cap ?? 50);
  if (!/^[a-f0-9]{16}$/.test(ownerKey)) throw new Error("invalid sender owner scope");
  if (!/^[a-z0-9._-]{1,120}$/i.test(senderId)) throw new Error("invalid sender id");
  if (!email) throw new Error("invalid sender email");
  if (input.reply_to_email && !replyTo) throw new Error("invalid reply-to email");
  if (!/^[a-z0-9.-]+$/i.test(smtpHost) || !smtpHost.includes(".")) throw new Error("invalid SMTP host");
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error("invalid SMTP port");
  if (!password || password.length > 500) throw new Error("SMTP app password is required");
  if (!fromName || fromName.length > 80 || /\r|\n/.test(fromName)) throw new Error("invalid sender name");
  if (!Number.isInteger(dailyCap) || dailyCap < 1 || dailyCap > 500) throw new Error("invalid daily sender cap");
  return {
    id: senderId,
    ownerKey,
    label: String(input.label || fromName).trim().slice(0, 80),
    fromName,
    email,
    replyTo,
    smtpHost,
    smtpPort,
    secure: input.secure !== false,
    dailyCap,
    password,
    verified: false,
    lastVerifiedAt: "",
  };
}

function smtpFor(account) {
  return {
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.secure,
    auth: { user: account.email, pass: account.password },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  };
}

async function readSenderState() {
  try {
    const value = JSON.parse(await readFile(stateFile, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.counts !== "object") throw new Error("invalid sender state");
    for (const count of Object.values(value.counts)) {
      if (!Number.isInteger(count) || count < 0) throw new Error("invalid sender counter in shared state");
    }
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return value.date === date ? value : { date, counts: {} };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    return { date, counts: {} };
  }
}

async function writeSenderState(value) {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function reserveSender(account) {
  const state = await readSenderState();
  const count = Number(state.counts[account.email] || 0);
  if (!Number.isInteger(count) || count < 0) throw new Error("invalid sender counter");
  if (count >= account.dailyCap) throw new Error(`daily sender cap reached for ${account.email}`);
  state.counts[account.email] = count + 1;
  await writeSenderState(state);
}

async function releaseSender(account) {
  const state = await readSenderState();
  const count = Number(state.counts[account.email] || 0);
  if (count > 0) state.counts[account.email] = count - 1;
  await writeSenderState(state);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function validateExecutionPayload(payload) {
  const runId = String(payload.run_id || "").trim();
  const batchId = String(payload.batch_id || "").trim();
  const campaignId = String(payload.campaign_id || "").trim();
  const projectId = String(payload.project_id || "").trim();
  const approvedHash = String(payload.approved_hash || "").trim().toLowerCase();
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!runId || !batchId || !campaignId || !projectId) throw new Error("run, batch, campaign and project ids are required");
  const tenantKey = campaignId.split(":", 1)[0].toLowerCase();
  if (!/^[a-f0-9]{16}$/.test(tenantKey)) throw new Error("campaign owner scope is invalid");
  if (!/^[a-f0-9]{64}$/.test(approvedHash)) throw new Error("approved batch hash is required");
  if (!items.length || items.length > 500) throw new Error("batch must contain 1..500 items");
  const itemIds = new Set();
  const keys = new Set();
  const endpoints = new Set();
  for (const item of items) {
    if (!item.id || itemIds.has(item.id)) throw new Error("duplicate or missing item id");
    itemIds.add(item.id);
    if (item.project_id !== projectId) throw new Error("item project mismatch");
    const recipient = normalizeEmail(item.recipient_email);
    const sender = normalizeEmail(item.from_email);
    if (!recipient || recipient !== item.recipient_email || !sender || sender !== item.from_email) throw new Error("item email is not canonical");
    if (!item.sender_id || !item.candidate_id || !item.handle) throw new Error("item identity is incomplete");
    const expectedKey = dispatchKey({ campaignId, candidateId: item.candidate_id, templateId: "step01" });
    if (item.idempotency_key !== expectedKey || keys.has(expectedKey)) throw new Error("invalid or duplicate idempotency key");
    keys.add(expectedKey);
    if (endpoints.has(recipient)) throw new Error("duplicate recipient in batch");
    endpoints.add(recipient);
    const checked = validateMessage({ subject: item.subject, body: item.body, channel: "email" });
    if (!checked.valid || sanitizeSubject(item.subject, "") !== item.subject) throw new Error(`invalid message for @${item.handle}`);
    if (item.payload_hash !== sha256(canonicalItemPayload(item))) throw new Error(`payload hash mismatch for @${item.handle}`);
  }
  const expectedApprovedHash = sha256(canonicalBatchSnapshot({
    batch_id: batchId, project_id: projectId, campaign_id: campaignId, items,
  }));
  if (approvedHash !== expectedApprovedHash) throw new Error("approved batch hash mismatch");
  return {
    runId, batchId, campaignId, projectId, tenantKey, approvedHash, items,
    delayMs: Math.min(60000, Math.max(1000, Number(payload.delay_ms ?? 5000))),
  };
}

function snapshotJob(job) {
  return {
    id: job.id,
    batch_id: job.batchId,
    project_id: job.projectId,
    status: job.status,
    counts: { ...job.counts },
    results: job.results.map((result) => ({ ...result })),
    error: job.error || "",
    created_at: job.createdAt,
    started_at: job.startedAt || "",
    finished_at: job.finishedAt || "",
    pause_requested: job.pauseRequested === true,
    revision: Number(job.revision || 0),
  };
}

function ledgerRecord(job) {
  return {
    ...snapshotJob(job),
    campaign_id: job.campaignId,
    approved_hash: job.approvedHash,
    delay_ms: job.delayMs,
    items: job.items,
  };
}

async function persistJobs() {
  const snapshot = `${JSON.stringify([...jobs.values()].map(ledgerRecord), null, 2)}\n`;
  const writeSnapshot = async () => {
    await mkdir(dataRoot, { recursive: true });
    const temporary = `${jobsFile}.${process.pid}.tmp`;
    await writeFile(temporary, snapshot, "utf8");
    await rename(temporary, jobsFile);
  };
  ledgerTail = ledgerTail.then(writeSnapshot, writeSnapshot);
  return ledgerTail;
}

async function persistJobChange(job) {
  job.revision = Number(job.revision || 0) + 1;
  await persistJobs();
}

function setResult(job, result) {
  const index = job.results.findIndex((entry) => entry.item_id === result.item_id);
  if (index >= 0) job.results[index] = result;
  else job.results.push(result);
  job.counts = { sent: 0, failed: 0, delivery_unknown: 0, skipped_existing: 0 };
  for (const entry of job.results) {
    if (Object.hasOwn(job.counts, entry.status)) job.counts[entry.status] += 1;
  }
}

function journalResultForItem(job, item, events, unresolvedKeys) {
  const matching = events.filter((event) => event?.idempotency_key === item.idempotency_key);
  const sent = [...matching].reverse().find((event) => ["sent", "crm_synced"].includes(event.event));
  if (sent) return {
    item_id: item.id, status: "sent", message_id: sent.provider_message_id || "",
    error: "", sent_at: sent.event_at || "",
  };
  const unresolved = unresolvedKeys.get(item.idempotency_key);
  if (unresolved) return {
    item_id: item.id, status: "delivery_unknown", message_id: unresolved.provider_message_id || "",
    error: unresolved.error || "投递结果需要人工核对", sent_at: "",
  };
  const latest = matching.at(-1);
  if (["failed", "delivery_not_sent"].includes(latest?.event)) return {
    item_id: item.id, status: "failed", message_id: latest.provider_message_id || "",
    error: latest.error || "邮件服务商明确未发送", sent_at: "",
  };
  return null;
}

async function loadJobs() {
  if (jobsLoaded) return;
  let records = [];
  try {
    const parsed = JSON.parse(await readFile(jobsFile, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("send job ledger must be an array");
    records = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`cannot load send job ledger: ${error?.message || String(error)}`);
  }
  for (const record of records) {
    const parsed = validateExecutionPayload({
      run_id: record.id, batch_id: record.batch_id, project_id: record.project_id,
      campaign_id: record.campaign_id, approved_hash: record.approved_hash,
      delay_ms: record.delay_ms, items: record.items,
    });
    jobs.set(parsed.runId, {
      id: parsed.runId, batchId: parsed.batchId, projectId: parsed.projectId,
      campaignId: parsed.campaignId, tenantKey: parsed.tenantKey, approvedHash: parsed.approvedHash, items: parsed.items,
      delayMs: parsed.delayMs, status: String(record.status || "paused"),
      counts: record.counts || { sent: 0, failed: 0, delivery_unknown: 0, skipped_existing: 0 },
      results: Array.isArray(record.results) ? record.results : [], error: String(record.error || ""),
      createdAt: String(record.created_at || new Date().toISOString()), startedAt: String(record.started_at || ""),
      finishedAt: String(record.finished_at || ""), pauseRequested: record.pause_requested === true,
      revision: Math.max(1, Number(record.revision || 1)),
    });
  }
  const events = await journal.entries();
  const unresolvedKeys = new Map(unresolvedDeliveryEventsFrom(events, "").map((event) => [event.idempotency_key, event]));
  let changed = false;
  for (const job of jobs.values()) {
    for (const item of job.items) {
      const recovered = journalResultForItem(job, item, events, unresolvedKeys);
      if (recovered) setResult(job, recovered);
    }
    const unknown = job.results.some((result) => result.status === "delivery_unknown");
    const allResolved = job.results.length >= job.items.length;
    if (unknown && job.status !== "delivery_unknown") {
      job.status = "delivery_unknown";
      job.error = "网关重启恢复到未决投递；禁止自动重试";
      job.pauseRequested = true;
      job.finishedAt = new Date().toISOString();
      job.revision += 1;
      changed = true;
    } else if (allResolved && !unknown && ["queued", "sending", "delivery_unknown"].includes(job.status)) {
      job.status = "completed";
      job.error = "";
      job.finishedAt = job.finishedAt || new Date().toISOString();
      job.revision += 1;
      changed = true;
    } else if (["queued", "sending"].includes(job.status) && !allResolved) {
      job.status = "paused";
      job.error = "发送网关曾重启；已保守暂停，需重新配置发件账户后人工处理";
      job.pauseRequested = true;
      job.finishedAt = new Date().toISOString();
      job.revision += 1;
      changed = true;
    }
  }
  jobsLoaded = true;
  if (changed) await persistJobs();
}

async function sleep(ms) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function executeJob(job) {
  if (job.pauseRequested) return;
  job.status = "sending";
  job.startedAt = new Date().toISOString();
  await persistJobChange(job);
  try {
    await withRunLock(lockPath, async () => {
      for (let index = 0; index < job.items.length; index++) {
        const item = job.items[index];
        if (job.results.some((result) => result.item_id === item.id)) continue;
        if (job.pauseRequested) {
          job.status = "paused";
          job.error = job.error || "操作人已请求暂停";
          await persistJobChange(job);
          break;
        }
        const events = await journal.entries();
        const circuit = deliveryCircuitFrom(events, "");
        if (circuit.open) {
          job.status = "delivery_unknown";
          job.error = `global delivery circuit is open: ${circuit.reason}`;
          job.pauseRequested = true;
          await persistJobChange(job);
          break;
        }
        const key = item.idempotency_key;
        if (await journal.blocks(key)) {
          const unresolvedKeys = new Map(unresolvedDeliveryEventsFrom(events, "").map((event) => [event.idempotency_key, event]));
          const recovered = journalResultForItem(job, item, events, unresolvedKeys);
          if (recovered) {
            setResult(job, recovered);
            if (recovered.status === "delivery_unknown") {
              job.status = "delivery_unknown";
              job.error = "已发现该邮件的未决投递记录；禁止自动重试";
              job.pauseRequested = true;
            }
          } else {
            setResult(job, { item_id: item.id, status: "skipped_existing", message_id: "", error: "already sent or unresolved", sent_at: "" });
          }
          await persistJobChange(job);
          if (job.status === "delivery_unknown") break;
          continue;
        }
        if (recipientBlockedFrom(events, job.campaignId, item.recipient_email, "step01")) {
          setResult(job, { item_id: item.id, status: "skipped_existing", message_id: "", error: "recipient already contacted in this campaign", sent_at: "" });
          await persistJobChange(job);
          continue;
        }
        const account = accounts.get(accountKey(job.tenantKey, item.sender_id));
        if (!account || !account.verified) {
          setResult(job, { item_id: item.id, status: "failed", message_id: "", error: "sender is not verified", sent_at: "" });
          job.status = "paused";
          job.error = `sender ${item.from_email} is not verified`;
          job.pauseRequested = true;
          await persistJobChange(job);
          break;
        }
        if (account.email !== item.from_email || account.fromName !== item.from_name || account.replyTo !== (item.reply_to_email || "")) {
          setResult(job, { item_id: item.id, status: "failed", message_id: "", error: "sender snapshot mismatch", sent_at: "" });
          job.status = "paused";
          job.error = "sender snapshot changed after approval";
          job.pauseRequested = true;
          await persistJobChange(job);
          break;
        }
        const attemptId = randomUUID();
        const messageId = providerMessageIdForAttempt(attemptId, account.email);
        const reservation = {
          event_version: "outreach-event.v1", outreach_attempt_id: attemptId, idempotency_key: key,
          campaign_id: job.campaignId, project_id: job.projectId, batch_id: job.batchId, item_id: item.id,
          candidate_id: item.candidate_id, handle: item.handle, template_id: "step01", channel: "email",
          sender: account.email, recipient_endpoint: item.recipient_email, provider_message_id: messageId,
          subject: item.subject, body: item.body,
        };
        await reserveSender(account);
        try {
          await journal.append({ event: "sending", event_at: new Date().toISOString(), ...reservation });
        } catch (error) {
          await releaseSender(account);
          throw error;
        }

        let delivery;
        try {
          delivery = await sendThreaded({
            creatorHandle: item.handle, smtp: smtpFor(account), from: `${account.fromName} <${account.email}>`,
            replyTo: item.reply_to_email || undefined, to: item.recipient_email, subject: item.subject,
            body: item.body, messageId, threadMode: "new",
          });
        } catch (error) {
          delivery = { ok: false, uncertain: true, error: error?.message || String(error) };
        }

        if (delivery.ok === true) {
          const sentAt = new Date().toISOString();
          try {
            await journal.append({ event: "sent", event_at: sentAt, ...reservation, provider_message_id: delivery.messageId || messageId });
            setResult(job, { item_id: item.id, status: "sent", message_id: delivery.messageId || messageId, error: "", sent_at: sentAt });
          } catch (error) {
            setResult(job, { item_id: item.id, status: "delivery_unknown", message_id: messageId, error: `SMTP accepted but sent journal failed: ${error?.message || String(error)}`, sent_at: "" });
            job.status = "delivery_unknown";
            job.error = "SMTP 已返回成功，但本地确认落盘失败；必须人工核对，禁止重试";
            job.pauseRequested = true;
          }
        } else if (delivery.uncertain === true) {
          try {
            await journal.append({ event: "delivery_unknown", event_at: new Date().toISOString(), ...reservation, error: delivery.error || "SMTP result unknown" });
          } catch {}
          setResult(job, { item_id: item.id, status: "delivery_unknown", message_id: messageId, error: delivery.error || "SMTP result unknown", sent_at: "" });
          job.status = "delivery_unknown";
          job.error = "投递结果未知；已暂停全部后续发送，请核对 Sent/服务商记录";
          job.pauseRequested = true;
        } else {
          try {
            await journal.append({ event: "failed", event_at: new Date().toISOString(), ...reservation, error: delivery.error || "delivery failed" });
            await releaseSender(account);
            setResult(job, { item_id: item.id, status: "failed", message_id: "", error: delivery.error || "delivery failed", sent_at: "" });
          } catch (error) {
            setResult(job, { item_id: item.id, status: "delivery_unknown", message_id: messageId, error: `delivery record failed: ${error?.message || String(error)}`, sent_at: "" });
            job.status = "delivery_unknown";
            job.error = "邮件结果无法可靠落盘；已按投递未知处理并停止全部后续发送";
            job.pauseRequested = true;
          }
          if (delivery.errorCode === "EAUTH" && job.status !== "delivery_unknown") {
            account.verified = false;
            job.status = "paused";
            job.error = "发件账号认证失败；已暂停后续发送";
            job.pauseRequested = true;
          }
        }
        await persistJobChange(job);
        if (["paused", "delivery_unknown"].includes(job.status)) break;
        if (index < job.items.length - 1) await sleep(job.delayMs);
      }
    }, { staleMs: 2 * 60 * 60 * 1000 });
  } catch (error) {
    if (job.status === "sending") {
      job.status = "paused";
      job.error = `发送任务运行或落盘异常，已安全暂停且不会自动重试：${error?.message || String(error)}`;
      job.pauseRequested = true;
    }
  }
  if (job.status === "sending") job.status = "completed";
  job.finishedAt = new Date().toISOString();
  await persistJobChange(job);
}

async function enqueue(payload) {
  const parsed = validateExecutionPayload(payload);
  const existing = jobs.get(parsed.runId);
  if (existing) {
    if (existing.batchId !== parsed.batchId || existing.projectId !== parsed.projectId ||
      existing.campaignId !== parsed.campaignId || existing.approvedHash !== parsed.approvedHash) {
      throw new Error("run id is already bound to another approved batch snapshot");
    }
    return existing;
  }
  const job = {
    id: parsed.runId,
    batchId: parsed.batchId,
    projectId: parsed.projectId,
    campaignId: parsed.campaignId,
    tenantKey: parsed.tenantKey,
    approvedHash: parsed.approvedHash,
    items: parsed.items,
    delayMs: parsed.delayMs,
    status: "queued",
    counts: { sent: 0, failed: 0, delivery_unknown: 0, skipped_existing: 0 },
    results: [],
    error: "",
    createdAt: new Date().toISOString(),
    startedAt: "",
    finishedAt: "",
    pauseRequested: false,
    revision: 1,
  };
  jobs.set(job.id, job);
  await persistJobs();
  queueTail = queueTail.catch(() => {}).then(() => executeJob(job)).catch(async (error) => {
    job.status = "paused";
    job.error = `任务执行器异常，已暂停且不会自动重试：${error?.message || String(error)}`;
    job.pauseRequested = true;
    job.finishedAt = new Date().toISOString();
    await persistJobChange(job);
  });
  return job;
}

async function route(req, res) {
  if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { ok: false, error: "loopback only" });
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    const circuit = deliveryCircuitFrom(await journal.entries(), "");
    return json(res, 200, { ok: true, service: "loop-outreach-gateway", circuit });
  }
  if (req.method === "GET" && url.pathname === "/ai") {
    const ownerKey = String(url.searchParams.get("owner_key") || "").toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(ownerKey)) return json(res, 400, { ok: false, error: "valid owner_key is required" });
    return json(res, 200, { ok: true, ai: publicAiProfile(aiProfiles.get(ownerKey)) });
  }
  if (req.method === "POST" && url.pathname === "/ai/configure") {
    const profile = validateAiProfile(await bodyJson(req));
    aiProfiles.set(profile.ownerKey, profile);
    for (const key of personalizationCache.keys()) {
      if (key.startsWith(`${profile.ownerKey}:`)) personalizationCache.delete(key);
    }
    return json(res, 201, { ok: true, ai: publicAiProfile(profile) });
  }
  if (req.method === "POST" && url.pathname === "/personalize-batch") {
    const result = await personalizeBatch(await bodyJson(req));
    return json(res, 200, { ok: true, personalization: result });
  }
  if (req.method === "GET" && url.pathname === "/senders") {
    const ownerKey = String(url.searchParams.get("owner_key") || "").toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(ownerKey)) return json(res, 400, { ok: false, error: "valid owner_key is required" });
    const state = await readSenderState();
    return json(res, 200, {
      ok: true,
      senders: [...accounts.values()].filter((account) => account.ownerKey === ownerKey)
        .map((account) => ({ ...publicAccount(account), sent_today: Number(state.counts[account.email] || 0) })),
    });
  }
  if (req.method === "POST" && url.pathname === "/senders") {
    const account = validateSenderInput(await bodyJson(req));
    accounts.set(accountKey(account.ownerKey, account.id), account);
    return json(res, 201, { ok: true, sender: publicAccount(account) });
  }
  const verifyMatch = url.pathname.match(/^\/senders\/([^/]+)\/verify$/);
  if (req.method === "POST" && verifyMatch) {
    const ownerKey = String(url.searchParams.get("owner_key") || "").toLowerCase();
    const account = accounts.get(accountKey(ownerKey, decodeURIComponent(verifyMatch[1])));
    if (!account) return json(res, 404, { ok: false, error: "sender not configured in this gateway session" });
    try {
      const transporter = nodemailer.createTransport(smtpFor(account));
      await transporter.verify();
      account.verified = true;
      account.lastVerifiedAt = new Date().toISOString();
      return json(res, 200, { ok: true, sender: publicAccount(account) });
    } catch (error) {
      account.verified = false;
      return json(res, 400, { ok: false, error: `SMTP verification failed: ${error?.message || String(error)}` });
    }
  }
  if (req.method === "POST" && url.pathname === "/execute") {
    const job = await enqueue(await bodyJson(req));
    return json(res, 202, { ok: true, job: snapshotJob(job) });
  }
  const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    return job ? json(res, 200, { ok: true, job: snapshotJob(job) }) : json(res, 404, { ok: false, error: "job not found" });
  }
  const pauseMatch = url.pathname.match(/^\/jobs\/([^/]+)\/pause$/);
  if (req.method === "POST" && pauseMatch) {
    const job = jobs.get(decodeURIComponent(pauseMatch[1]));
    if (!job) return json(res, 404, { ok: false, error: "job not found" });
    job.pauseRequested = true;
    if (job.status === "queued") {
      job.status = "paused";
      job.error = "操作人已在任务开始前暂停";
      job.finishedAt = new Date().toISOString();
    }
    await persistJobChange(job);
    return json(res, 200, { ok: true, job: snapshotJob(job) });
  }
  return json(res, 404, { ok: false, error: "not found" });
}

export async function startGateway({ host = "127.0.0.1", port = 8878 } = {}) {
  await loadJobs();
  const server = createServer((req, res) => {
    route(req, res).catch((error) => json(res, 500, { ok: false, error: error?.message || String(error) }));
  });
  server.listen(port, host);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.LOOP_GATEWAY_PORT || 8878);
  const server = await startGateway({ port });
  server.on("listening", () => console.log(`LOOP outreach gateway listening on http://127.0.0.1:${port}`));
}
