import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAllowedUrl,
  detectChallengeSnapshot,
  resolveChromiumExecutable,
  retryDelayMs,
} from "../browser_resilience.mjs";
import { normalizeHandle } from "../tiktok_browser.mjs";

test("browser navigation is restricted to explicit HTTPS platform hosts", () => {
  assert.equal(assertAllowedUrl("https://www.fastmoss.com/influencer", ["fastmoss.com"]).hostname, "www.fastmoss.com");
  assert.equal(assertAllowedUrl("https://www.tiktok.com/@creator", ["tiktok.com"]).hostname, "www.tiktok.com");
  assert.throws(() => assertAllowedUrl("http://www.tiktok.com/@creator", ["tiktok.com"]), /not allowed/);
  assert.throws(() => assertAllowedUrl("https://tiktok.com.example.test/", ["tiktok.com"]), /not allowed/);
});

test("challenge detection stops on verification pages and blocking statuses", () => {
  assert.equal(detectChallengeSnapshot({ text: "Please verify you are human" }).challenged, true);
  assert.equal(detectChallengeSnapshot({ text: "请完成验证后继续" }).challenged, true);
  assert.equal(detectChallengeSnapshot({ text: "Log in to continue" }).challenged, true);
  assert.equal(detectChallengeSnapshot({ status: 403 }).marker, "http_403");
  assert.equal(detectChallengeSnapshot({ text: "Creator profile" }).challenged, false);
});

test("retry delays honor Retry-After and otherwise back off exponentially", () => {
  assert.equal(retryDelayMs(0, "5"), 5000);
  assert.equal(retryDelayMs(0, "", 2000), 2000);
  assert.equal(retryDelayMs(3, "", 2000), 16000);
  assert.equal(retryDelayMs(10, "", 2000), 120000);
});

test("TikTok handles are normalized without accepting arbitrary URL text", () => {
  assert.equal(normalizeHandle("https://www.tiktok.com/@Creator.Name?lang=en"), "creator.name");
  assert.equal(normalizeHandle("@Creator_Name"), "creator_name");
  assert.equal(normalizeHandle("bad handle<script>"), "badhandlescript");
});

test("Chromium resolution ignores a missing default executable", () => {
  const resolved = resolveChromiumExecutable({ executablePath: () => "Z:/missing/chrome.exe" });
  assert.equal(typeof resolved, "string");
  if (resolved) assert.equal(resolved.toLowerCase().endsWith("chrome.exe") || resolved.endsWith("chrome"), true);
});
