/** Resolve an ambiguous provider outcome only after a human checks the provider/Sent mailbox. */
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createOutreachJournal, unresolvedDeliveryEventsFrom } from "./lib/outreach_journal.mjs";
import { withRunLock } from "./lib/run_lock.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const journal = createOutreachJournal(join(root, "outreach_journal.jsonl"));
const lockPath = join(root, "outreach_run.lock");

function normalizedMessageId(value) {
  return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function parseArgs(argv) {
  const args = { attemptId: "", resolution: "", messageId: "", note: "", confirm: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--attempt-id") args.attemptId = argv[++index] || "";
    else if (argv[index] === "--resolution") args.resolution = argv[++index] || "";
    else if (argv[index] === "--message-id") args.messageId = argv[++index] || "";
    else if (argv[index] === "--note") args.note = argv[++index] || "";
    else if (argv[index] === "--confirm") args.confirm = true;
  }
  if (!args.attemptId) throw new Error("--attempt-id is required");
  if (!["sent", "not-sent"].includes(args.resolution)) {
    throw new Error("--resolution must be sent or not-sent");
  }
  if (args.note.trim().length < 8) throw new Error("--note must describe the manual evidence checked");
  if (args.resolution === "sent" && !normalizedMessageId(args.messageId)) {
    throw new Error("--message-id is required when resolving as sent");
  }
  return args;
}

export function buildResolutionEvent(source, args) {
  if (!source || !["sending", "delivery_unknown"].includes(source.event)) {
    throw new Error("attempt is not awaiting delivery reconciliation");
  }
  const expected = normalizedMessageId(source.provider_message_id);
  const confirmed = normalizedMessageId(args.messageId);
  if (args.resolution === "sent" && expected && confirmed !== expected) {
    throw new Error("confirmed Message-ID does not match the preallocated outbound Message-ID");
  }
  return {
    ...source,
    event_version: "outreach-event.v1",
    event: args.resolution === "sent" ? "sent" : "delivery_not_sent",
    event_at: new Date().toISOString(),
    provider_message_id: args.resolution === "sent" ? args.messageId : source.provider_message_id || "",
    reconciliation: "manual_provider_check",
    reconciliation_note: args.note.trim(),
  };
}

async function unresolvedAttempt(attemptId) {
  const events = await journal.entries();
  return unresolvedDeliveryEventsFrom(events, "")
    .find(event => event.outreach_attempt_id === attemptId) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = await unresolvedAttempt(args.attemptId);
  if (!source) throw new Error(`attempt is not unresolved: ${args.attemptId}`);
  const proposed = buildResolutionEvent(source, args);
  const report = {
    mode: args.confirm ? "execute" : "dry-run",
    attempt_id: args.attemptId,
    resolution: proposed.event,
    campaign_id: proposed.campaign_id,
    candidate_id: proposed.candidate_id,
    recipient_endpoint: proposed.recipient_endpoint || "",
    provider_message_id: proposed.provider_message_id || "",
    note: proposed.reconciliation_note,
  };
  if (args.confirm) {
    await withRunLock(lockPath, async () => {
      const fresh = await unresolvedAttempt(args.attemptId);
      if (!fresh) throw new Error("attempt changed while waiting for the run lock");
      await journal.append(buildResolutionEvent(fresh, args));
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Delivery resolution failed: ${error.message}`);
    process.exit(1);
  });
}
