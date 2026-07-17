/**
 * The legacy step02-step09 monitor must never own first-outreach records.
 * Stage 01 is exclusively handled by first_outreach_monitor.mjs, which reads
 * intent-aware journal metadata such as followup_mode=disabled.
 */
export const LEGACY_ACTIVE_STAGES = new Set([
  "02_CollabOffer",
  "03_Agreed",
  "04_ContractSigned",
  "05_TeaserDraftDue",
  "06_PackageShipped",
  "07_PackageDelivered",
  "08_TryOnVideo",
  "09_Completed",
]);

export function legacyMonitorMayActOnStage(stage) {
  return LEGACY_ACTIVE_STAGES.has(String(stage || ""));
}
