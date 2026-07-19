import fs from "node:fs";
import path from "node:path";

export class HumanChallengeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HumanChallengeError";
    this.details = details;
  }
}

export function resolveChromiumExecutable(chromium) {
  const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromium?.executablePath?.()];
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "");
  if (cacheRoot && fs.existsSync(cacheRoot)) {
    for (const directory of fs.readdirSync(cacheRoot).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(
        path.join(cacheRoot, directory, "chrome-win64", "chrome.exe"),
        path.join(cacheRoot, directory, "chrome-linux", "chrome"),
        path.join(cacheRoot, directory, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      );
    }
  }
  candidates.push(
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
  );
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || "";
}

export function assertAllowedUrl(value, allowedHosts) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(`browser navigation is not allowed for ${url.hostname}`);
  }
  return url;
}

export function detectChallengeSnapshot({ url = "", title = "", text = "", status = 0 } = {}) {
  const haystack = `${url}\n${title}\n${text}`.toLowerCase();
  const markers = [
    "captcha", "verify you are human", "verify to continue", "security verification",
    "log in to continue", "sign in to continue", "登录以继续", "登录后继续",
    "unusual traffic", "too many requests", "access denied", "访问过于频繁",
    "安全验证", "请完成验证", "滑动验证", "操作频繁", "验证后继续",
  ];
  const marker = markers.find(value => haystack.includes(value)) || "";
  const blockedStatus = [401, 403, 429].includes(Number(status));
  return {
    challenged: Boolean(marker || blockedStatus),
    marker: marker || (blockedStatus ? `http_${status}` : ""),
    status: Number(status || 0),
  };
}

export function retryDelayMs(attempt, retryAfter = "", baseMs = 2000, capMs = 120000) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(capMs, seconds * 1000);
  const parsedDate = Date.parse(retryAfter);
  if (Number.isFinite(parsedDate)) return Math.min(capMs, Math.max(0, parsedDate - Date.now()));
  return Math.min(capMs, baseMs * (2 ** Math.max(0, attempt)));
}

export function createPacer({ minDelayMs = 2500, maxDelayMs = 6000 } = {}) {
  if (!(minDelayMs >= 0) || maxDelayMs < minDelayMs) throw new Error("invalid browser pacing range");
  let lastStartedAt = 0;
  return {
    async wait(page) {
      const desired = minDelayMs + Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1));
      const remaining = Math.max(0, lastStartedAt + desired - Date.now());
      if (remaining) await page.waitForTimeout(remaining);
      lastStartedAt = Date.now();
    },
  };
}

async function challengeSnapshot(page, status = 0) {
  const snapshot = await page.evaluate(() => ({
    title: document.title || "",
    text: (document.body?.innerText || "").slice(0, 4000),
  })).catch(() => ({ title: "", text: "" }));
  return { ...snapshot, url: page.url(), status };
}

export async function captureDiagnostic(page, directory, label, details = {}) {
  if (!directory) return "";
  fs.mkdirSync(directory, { recursive: true });
  const safe = String(label || "browser").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(directory, `${stamp}-${safe}`);
  await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
  fs.writeFileSync(`${base}.json`, JSON.stringify({
    captured_at: new Date().toISOString(), url: page.url(), ...details,
  }, null, 2));
  return base;
}

export async function safeNavigate(page, value, {
  allowedHosts,
  platform,
  pacer,
  diagnosticsDir = "",
  attempts = 3,
  timeoutMs = 60000,
} = {}) {
  const url = assertAllowedUrl(value, allowedHosts);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await pacer?.wait(page);
    try {
      const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const status = response?.status() || 0;
      const snapshot = await challengeSnapshot(page, status);
      const pageChallenge = detectChallengeSnapshot({ ...snapshot, status: 0 });
      if (pageChallenge.challenged || [401, 403].includes(status)) {
        const challenge = pageChallenge.challenged
          ? pageChallenge
          : { challenged: true, marker: `http_${status}`, status };
        await captureDiagnostic(page, diagnosticsDir, `${platform}-challenge`, challenge);
        throw new HumanChallengeError(
          `${platform} requires human verification (${challenge.marker}); collection paused`,
          challenge,
        );
      }
      if (status === 429) {
        if (attempt >= attempts - 1) {
          const challenge = { challenged: true, marker: "http_429", status };
          await captureDiagnostic(page, diagnosticsDir, `${platform}-rate-limited`, challenge);
          throw new HumanChallengeError(`${platform} remains rate limited; collection paused`, challenge);
        }
        const retryAfter = (await response.allHeaders())["retry-after"] || "";
        await page.waitForTimeout(retryDelayMs(attempt, retryAfter));
        continue;
      }
      if (status >= 500) throw new Error(`${platform} HTTP ${status}`);
      return response;
    } catch (error) {
      if (error instanceof HumanChallengeError) throw error;
      lastError = error;
      if (attempt >= attempts - 1) break;
      const delay = retryDelayMs(attempt);
      await page.waitForTimeout(delay + Math.floor(Math.random() * 1000));
    }
  }
  await captureDiagnostic(page, diagnosticsDir, `${platform}-navigation-error`, { error: String(lastError?.message || lastError) });
  throw lastError || new Error(`${platform} navigation failed`);
}

export async function waitForStableDom(page, selectors, { timeoutMs = 30000, settleMs = 900 } = {}) {
  const selector = selectors.join(", ");
  await page.waitForSelector(selector, { state: "attached", timeout: timeoutMs });
  let previous = -1;
  let stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.locator(selector).count();
    stable = count === previous ? stable + 1 : 0;
    if (count > 0 && stable >= 2) return count;
    previous = count;
    await page.waitForTimeout(settleMs);
  }
  throw new Error(`DOM did not stabilize for selectors: ${selector}`);
}

export async function runInjectedExtractor(page, extractor, argument, { allowedHosts, maxBytes = 2_000_000 } = {}) {
  assertAllowedUrl(page.url(), allowedHosts);
  if (typeof extractor !== "function") throw new Error("extractor must be a compiled function");
  const result = await page.evaluate(extractor, argument);
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("injected extractor returned too much data");
  return result;
}
