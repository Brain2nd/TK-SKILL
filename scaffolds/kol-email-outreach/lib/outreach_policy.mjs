const HANDLE_RE = /^[a-z0-9._-]{2,100}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scalar(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join("");
  if (typeof value === "object") return scalar(value.text || value.name || value.link || value.value);
  return String(value).trim();
}

export function firstField(fields, names) {
  for (const name of names) {
    const value = scalar(fields?.[name]);
    if (value) return value;
  }
  return "";
}

export function normalizeHandle(value) {
  let handle = scalar(value);
  if (!handle) return "";
  try {
    if (/^https?:\/\//i.test(handle)) {
      const pathname = new URL(handle).pathname;
      const match = pathname.match(/\/@([^/?#]+)/);
      handle = match?.[1] || pathname.split("/").filter(Boolean).at(-1) || "";
    }
  } catch {
    return "";
  }
  handle = handle.replace(/^@+/, "").trim().toLowerCase();
  return HANDLE_RE.test(handle) ? handle : "";
}

export function normalizeEmail(value) {
  const email = scalar(value).toLowerCase();
  if (!email || email.includes("\r") || email.includes("\n") || email.length > 254) return "";
  return EMAIL_RE.test(email) ? email : "";
}

function enabled(value) {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes", "y", "approved", "allow", "allowed"].includes(scalar(value).toLowerCase());
}

function suppressed(fields) {
  const directFlags = ["Do Not Contact", "do_not_contact", "Opt Out", "opt_out", "Suppressed", "suppressed"];
  if (directFlags.some(name => enabled(fields?.[name]))) return true;
  const status = firstField(fields, ["Email Status", "email_status", "Contact Status", "contact_status"]).toLowerCase();
  return ["unsubscribed", "complaint", "bounced", "blocked", "suppressed", "do_not_contact"].includes(status);
}

function approved(fields) {
  const decision = firstField(fields, [
    "Screening Decision", "screening_decision", "Outreach Approved", "outreach_approved",
  ]).toLowerCase();
  return ["approved", "pass", "passed", "true", "yes", "1"].includes(decision);
}

export function candidateFromRecord(record) {
  const fields = record?.fields || {};
  const handle = normalizeHandle(firstField(fields, ["username", "Creator Username", "handle"]));
  const platform = firstField(fields, ["platform", "Platform"]) || "tiktok";
  const candidateId = firstField(fields, ["candidate_id", "Candidate ID", "user_id", "User ID"])
    || (handle ? `${platform.toLowerCase()}:${handle}` : "");
  const allowedRaw = firstField(fields, ["Allowed Channels", "allowed_channels"]);
  const allowedChannels = allowedRaw
    ? allowedRaw.toLowerCase().split(/[,;\s]+/).filter(Boolean)
    : ["email", "tiktok_dm"];
  return {
    recordId: record?.record_id || record?.recordId || "",
    candidateId,
    handle,
    stage: firstField(fields, ["Pipeline Stage", "pipeline_stage"]),
    email: normalizeEmail(firstField(fields, ["email", "Email", "Contact Email"])),
    displayName: firstField(fields, [
      "display_name", "Display Name", "nickname", "tiktok_nickname", "username", "Creator Username",
    ]) || handle,
    platform: platform.toLowerCase(),
    allowedChannels,
    profileSnapshotId: firstField(fields, ["profile_snapshot_id", "Profile Snapshot ID"]),
    screeningRunId: firstField(fields, ["screening_run_id", "Screening Run ID"]),
    approved: approved(fields),
    suppressed: suppressed(fields),
    fields,
  };
}

export function evaluateCandidate(record, options = {}) {
  const candidate = candidateFromRecord(record);
  const requiredStage = options.requiredStage || "00_Discovered";
  if (!candidate.handle) return { eligible: false, reason: "invalid_handle", candidate };
  if (candidate.stage !== requiredStage) return { eligible: false, reason: "stage_changed", candidate };
  if (candidate.suppressed) return { eligible: false, reason: "suppressed", candidate };
  if (options.requireApproval && !candidate.approved) {
    return { eligible: false, reason: "screening_not_approved", candidate };
  }
  if (candidate.email && candidate.allowedChannels.includes("email")) {
    return { eligible: true, reason: "eligible", candidate: { ...candidate, outreachChannel: "email" } };
  }
  if (options.allowDmFallback && candidate.allowedChannels.includes("tiktok_dm")) {
    return { eligible: true, reason: "eligible", candidate: { ...candidate, outreachChannel: "tiktok_dm" } };
  }
  const reason = candidate.email ? "contact_channel_not_allowed" : "missing_valid_email";
  return { eligible: false, reason, candidate };
}

export function sanitizeSubject(value, fallback = "Paid collaboration inquiry") {
  const subject = scalar(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return (subject || fallback).slice(0, 180);
}

export function validateMessage({ subject, body, channel }) {
  const cleanBody = scalar(body);
  if (!cleanBody) return { valid: false, reason: "empty_body" };
  if (/\{\{[^}]+\}\}/.test(`${subject || ""}\n${cleanBody}`)) {
    return { valid: false, reason: "unresolved_template_variable" };
  }
  if (channel === "email" && !sanitizeSubject(subject, "")) return { valid: false, reason: "empty_subject" };
  return { valid: true, reason: "valid" };
}
