import { resolve } from "path";
import { approveBatch, readBatch, writeBatch } from "./lib/outreach_batch.mjs";

function parseArgs(argv) {
  const result = { batch: "", by: "", confirm: false, acceptReviewWarnings: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--batch") result.batch = argv[++index] || "";
    else if (argv[index] === "--by") result.by = argv[++index] || "";
    else if (argv[index] === "--confirm") result.confirm = true;
    else if (argv[index] === "--accept-review-warnings") result.acceptReviewWarnings = true;
  }
  if (!result.batch) throw new Error("--batch <path> is required");
  if (!result.by) throw new Error("--by <reviewer> is required");
  if (!result.confirm) throw new Error("review the batch, then add --confirm to approve it");
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filePath = resolve(args.batch);
  const manifest = await readBatch(filePath);
  const approved = approveBatch(manifest, args.by, { acceptReviewWarnings: args.acceptReviewWarnings });
  await writeBatch(filePath, approved);
  console.log(JSON.stringify({
    batch_id: approved.batch_id,
    campaign_id: approved.campaign_id,
    approved_by: approved.approval.approved_by,
    approved_at: approved.approval.approved_at,
    payload_sha256: approved.approval.payload_sha256,
    review_warnings_accepted: approved.approval.review_warnings_accepted,
    recipients: approved.items.length,
    path: filePath,
  }, null, 2));
}

main().catch(error => {
  console.error(`Approval failed: ${error.message}`);
  process.exit(1);
});
