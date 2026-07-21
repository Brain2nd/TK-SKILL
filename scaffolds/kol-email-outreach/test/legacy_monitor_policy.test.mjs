import test from "node:test";
import assert from "node:assert/strict";
import { LEGACY_ACTIVE_STAGES, legacyMonitorMayActOnStage } from "../lib/legacy_monitor_policy.mjs";

test("the legacy monitor cannot act on first-outreach records", () => {
  assert.equal(LEGACY_ACTIVE_STAGES.has("01_FirstOutreach"), false);
  assert.equal(legacyMonitorMayActOnStage("01_FirstOutreach"), false);
  assert.equal(legacyMonitorMayActOnStage("02_CollabOffer"), true);
});
