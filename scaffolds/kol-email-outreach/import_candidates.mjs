/**
 * Safe compatibility adapter from the persona/screening output into the outreach CRM.
 *
 * Default is dry-run. Accepted input: canonical JSON array/object, JSONL, or the
 * legacy analyzer CSV. This adapter never computes or changes persona scores.
 */
import { readFile } from "fs/promises";
import { extname, resolve } from "path";
import { pathToFileURL } from "url";
import cfg from "./lib/config.mjs";
import { btCreateRecord, btListRecords, btUpdateRecord } from "./lib/kol_crm.mjs";
import { normalizeEmail, normalizeHandle } from "./lib/outreach_policy.mjs";

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));

function parseArgs(argv) {
  const args = { file: "", execute: false, approveLegacy: false, bindLegacyHandles: false, screeningRunId: "" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--file") args.file = argv[++index] || "";
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--approve-legacy-final-csv") args.approveLegacy = true;
    else if (arg === "--bind-legacy-handles") args.bindLegacyHandles = true;
    else if (arg === "--screening-run-id") args.screeningRunId = argv[++index] || "";
    else if (!arg.startsWith("-") && !args.file) args.file = arg;
  }
  if (!args.file) throw new Error("--file <candidates.json|jsonl|csv> is required");
  return args;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); field = "";
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(value => value.replace(/^\uFEFF/, "").trim());
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()])));
}

async function loadInput(filePath) {
  const text = await readFile(filePath, "utf8");
  if (extname(filePath).toLowerCase() === ".csv") return { rows: parseCsv(text), legacyCsv: true };
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.candidates || parsed.items || [parsed];
    return { rows, legacyCsv: false };
  } catch {
    const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`invalid JSONL at line ${index + 1}`); }
    });
    return { rows, legacyCsv: false };
  }
}

function firstValidEmail(candidate) {
  const contacts = candidate.contacts?.emails;
  if (Array.isArray(contacts)) {
    for (const entry of contacts) {
      if (entry?.status && !["valid", "verified", "unknown"].includes(String(entry.status).toLowerCase())) continue;
      const email = normalizeEmail(entry?.address);
      if (email) return email;
    }
  }
  return normalizeEmail(candidate.email);
}

function emailMetadata(candidate) {
  const entries = Array.isArray(candidate.contacts?.emails) ? candidate.contacts.emails : [];
  const selected = entries.find(entry => normalizeEmail(entry?.address)) || {};
  const rawVerified = candidate.email_verified;
  const status = String(selected.status || "").toLowerCase();
  return {
    source: textValue(selected.source || candidate.email_source),
    verified: rawVerified === true || String(rawVerified || "").toLowerCase() === "true"
      || ["valid", "verified"].includes(status),
  };
}

function numberValue(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value) {
  return value == null ? "" : String(value).trim();
}

export function canonicalize(raw, options = {}) {
  const profile = raw.profile || {};
  const screening = raw.screening || {};
  const policy = raw.contact_policy || {};
  const handle = normalizeHandle(raw.handle || raw.username || raw.profile_url);
  const platform = textValue(raw.platform || "tiktok").toLowerCase();
  const screeningDecision = textValue(
    screening.decision || raw.screening_decision || (options.approveLegacy ? "approved" : ""),
  ).toLowerCase();
  const userId = textValue(raw.candidate_id || raw.user_id);
  const recentVideos = profile.recent_videos || raw.recent_videos || raw.video_descriptions || [];
  const emailMeta = emailMetadata(raw);
  return {
    handle,
    stableIdProvided: Boolean(userId),
    fields: {
      username: handle,
      candidate_id: userId || (handle ? `${platform}:${handle}` : ""),
      display_name: textValue(raw.display_name || raw.nickname || handle),
      platform,
      profile_snapshot_id: textValue(raw.profile_snapshot_id),
      screening_run_id: textValue(raw.screening_run_id || options.screeningRunId),
      screening_decision: screeningDecision,
      "Do Not Contact": policy.do_not_contact === true || raw.do_not_contact === true,
      "Allowed Channels": (Array.isArray(policy.allowed_channels || raw.allowed_channels)
        ? (policy.allowed_channels || raw.allowed_channels)
        : ["email"]
      ).map(value => String(value).toLowerCase()).join(","),
      "Pipeline Stage": "00_Discovered",
      email: firstValidEmail(raw),
      email_source: emailMeta.source,
      email_verified: emailMeta.verified,
      profile_url: raw.profile_url
        ? { link: textValue(raw.profile_url), text: textValue(raw.profile_url) }
        : (handle ? { link: `https://www.tiktok.com/@${handle}`, text: `https://www.tiktok.com/@${handle}` } : null),
      bio: textValue(profile.bio || raw.bio),
      country: textValue(profile.country || raw.country),
      primary_category: textValue(profile.primary_category || raw.primary_category),
      followers: numberValue(profile.followers ?? raw.followers),
      avg_views: textValue(profile.avg_views ?? raw.avg_views ?? raw.avg_views_10),
      engagement_rate: numberValue(profile.engagement_rate ?? raw.engagement_rate),
      shop_signals: numberValue(profile.shop_signals ?? raw.shop_signals),
      final_score: numberValue(screening.final_score ?? raw.final_score),
      ai_relevance_score: numberValue(raw.ai_relevance_score),
      ai_reasoning: textValue(raw.ai_reasoning),
      "Recent Videos JSON": recentVideos?.length ? JSON.stringify(recentVideos) : "",
    },
  };
}

function cleanFields(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== "" && value !== null));
}

function recordText(value) {
  if (Array.isArray(value)) return value.map(item => item?.text || item?.name || item || "").join("").trim();
  if (value && typeof value === "object") return String(value.text || value.name || value.value || "").trim();
  return String(value || "").trim();
}

async function loadExisting() {
  const byId = new Map();
  const byHandle = new Map();
  let pageToken = "";
  do {
    const response = await btListRecords(cfg.kol_tbl_creators, {
      pageSize: 500,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const record of response.items) {
      const handle = normalizeHandle(record.fields?.username);
      const candidateId = recordText(record.fields?.candidate_id);
      if (candidateId) {
        if (byId.has(candidateId)) throw new Error(`duplicate candidate_id in CRM: ${candidateId}`);
        byId.set(candidateId, record);
      }
      if (handle) {
        if (byHandle.has(handle)) throw new Error(`duplicate username in CRM: ${handle}`);
        byHandle.set(handle, record);
      }
    }
    pageToken = response.pageToken || "";
  } while (pageToken);
  return { byId, byHandle };
}

function outreachUpdates(existing, incoming) {
  const fillOnly = [
    "candidate_id", "profile_url", "Recent Videos JSON",
  ];
  const updates = Object.fromEntries(fillOnly.flatMap(field => {
    const oldValue = existing.fields?.[field];
    const isMissing = oldValue == null || oldValue === "" || (Array.isArray(oldValue) && oldValue.length === 0);
    return isMissing && incoming[field] != null && incoming[field] !== "" ? [[field, incoming[field]]] : [];
  }));
  for (const field of [
    "username", "display_name", "platform", "profile_snapshot_id", "screening_run_id",
    "screening_decision", "Allowed Channels",
  ]) {
    if (incoming[field] != null && incoming[field] !== "" && recordText(incoming[field]) !== recordText(existing.fields?.[field])) {
      updates[field] = incoming[field];
    }
  }
  if (existing.fields?.["Pipeline Stage"] === "00_Discovered" && incoming.email &&
      normalizeEmail(incoming.email) !== normalizeEmail(existing.fields?.email)) {
    updates.email = incoming.email;
  }
  // A persona import may add suppression, but must never clear a prior unsubscribe/bounce.
  if (incoming["Do Not Contact"] === true && existing.fields?.["Do Not Contact"] !== true) {
    updates["Do Not Contact"] = true;
  }
  return updates;
}

export function planCandidateImport(candidate, existing, options = {}) {
  const fields = cleanFields(candidate.fields);
  const candidateId = fields.candidate_id;
  const byId = existing.byId.get(candidateId);
  const byHandle = existing.byHandle.get(candidate.handle);
  let current = byId || null;
  if (byId && byHandle && byId.record_id !== byHandle.record_id) {
    return { action: "reject", reason: "handle_owned_by_another_candidate" };
  }
  if (!current && byHandle) {
    const storedId = recordText(byHandle.fields?.candidate_id);
    if (storedId && storedId !== candidateId) {
      return { action: "reject", reason: "handle_identity_conflict_in_crm" };
    }
    if (!storedId && !options.bindLegacyHandles) {
      return { action: "reject", reason: "legacy_handle_requires_explicit_binding" };
    }
    current = byHandle;
  }
  if (!current) return { action: "create", fields };
  const fieldsToUpdate = outreachUpdates(current, fields);
  return Object.keys(fieldsToUpdate).length
    ? { action: "update", recordId: current.record_id, fields: fieldsToUpdate }
    : { action: "unchanged" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["feishu_app_id", "feishu_app_secret", "kol_crm_app_token", "kol_tbl_creators"]) {
    if (!cfg[key] || String(cfg[key]).startsWith("YOUR_")) throw new Error(`config.json missing ${key}`);
  }
  const inputPath = resolve(args.file);
  const { rows, legacyCsv } = await loadInput(inputPath);
  if (legacyCsv && args.approveLegacy && !args.screeningRunId) {
    throw new Error("--approve-legacy-final-csv also requires --screening-run-id for traceability");
  }

  const unique = new Map();
  const inputHandles = new Map();
  const rejected = [];
  for (const [index, row] of rows.entries()) {
    if (row.schema_version && row.schema_version !== "outreach-candidate.v1") {
      rejected.push({ row: index + 1, reason: `unsupported_schema:${row.schema_version}` });
      continue;
    }
    const candidate = canonicalize(row, args);
    if (!candidate.handle) { rejected.push({ row: index + 1, reason: "invalid_handle" }); continue; }
    if (!legacyCsv && !candidate.stableIdProvided) {
      rejected.push({ row: index + 1, handle: candidate.handle, reason: "missing_stable_candidate_id" });
      continue;
    }
    const candidateId = candidate.fields.candidate_id;
    if (unique.has(candidateId)) { rejected.push({ row: index + 1, candidate_id: candidateId, reason: "duplicate_candidate_id" }); continue; }
    const priorId = inputHandles.get(candidate.handle);
    if (priorId && priorId !== candidateId) {
      rejected.push({ row: index + 1, handle: candidate.handle, reason: "handle_identity_conflict_in_input" });
      continue;
    }
    inputHandles.set(candidate.handle, candidateId);
    unique.set(candidateId, candidate);
  }

  const existing = await loadExisting();
  const creates = [], updates = [], unchanged = [];
  for (const candidate of unique.values()) {
    const candidateId = candidate.fields.candidate_id;
    const plan = planCandidateImport(candidate, existing, args);
    if (plan.action === "create") creates.push({ handle: candidate.handle, candidate_id: candidateId, fields: plan.fields });
    else if (plan.action === "update") updates.push({ handle: candidate.handle, candidate_id: candidateId, recordId: plan.recordId, fields: plan.fields });
    else if (plan.action === "unchanged") unchanged.push(candidate.handle);
    else rejected.push({ handle: candidate.handle, candidate_id: candidateId, reason: plan.reason });
  }

  const report = {
    mode: args.execute ? "execute" : "dry-run",
    source: inputPath,
    source_format: legacyCsv ? "legacy_csv" : "canonical_json",
    input: rows.length,
    valid_unique: unique.size,
    create: creates.length,
    update: updates.length,
    unchanged: unchanged.length,
    rejected,
    approval_warning: legacyCsv && !args.approveLegacy
      ? "legacy CSV rows remain unapproved; rerun with --approve-legacy-final-csv and --screening-run-id only after human review"
      : "",
    preview: [...creates, ...updates].slice(0, 20),
    failed: [],
  };
  if (!args.execute) { console.log(JSON.stringify(report, null, 2)); return; }

  for (const item of creates) {
    try { await btCreateRecord(cfg.kol_tbl_creators, item.fields); }
    catch (error) { report.failed.push({ handle: item.handle, action: "create", error: error.message }); }
    await sleep(300);
  }
  for (const item of updates) {
    try { await btUpdateRecord(cfg.kol_tbl_creators, item.recordId, item.fields); }
    catch (error) { report.failed.push({ handle: item.handle, action: "update", error: error.message }); }
    await sleep(300);
  }
  delete report.preview;
  console.log(JSON.stringify(report, null, 2));
  if (report.failed.length) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Import failed: ${error.message}`);
    process.exit(1);
  });
}
