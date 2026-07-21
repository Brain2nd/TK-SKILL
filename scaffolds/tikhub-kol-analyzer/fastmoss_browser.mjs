#!/usr/bin/env node
/** FastMoss browser collector using a persistent, user-owned login session.
 *
 * Setup is intentionally interactive because FastMoss may show CAPTCHA. The
 * password is accepted only through environment variables and is never saved;
 * Chromium's session cookies are persisted for later unattended collection.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const argv = process.argv.slice(2);
const value = (name, fallback = "") => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const has = name => argv.includes(name);
const mode = has("--setup") ? "setup" : "collect";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectProfile = path.join(scriptDir, "output", ".fastmoss-browser-profile");
const profileDir = path.resolve(value(
  "--profile-dir",
  process.env.FASTMOSS_BROWSER_PROFILE || projectProfile,
));
const output = path.resolve(value("--output", "output/fastmoss_browser_candidates.csv"));
const target = Number(value("--target", "4000"));
const maxFollowers = Number(value("--max-followers", "10000"));
const setupTimeout = Number(value("--setup-timeout", "600")) * 1000;
const readyPath = path.join(profileDir, "ready.json");

fs.mkdirSync(profileDir, { recursive: true });

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(rows) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const fields = [
    "username", "country", "followers", "email", "units_sold", "gmv",
    "shop_valid", "shop_proof", "shop_proof_method", "bio", "profile_url", "source_url", "source",
  ];
  const lines = [fields.join(",")];
  for (const row of rows) lines.push(fields.map(field => csvCell(row[field])).join(","));
  fs.writeFileSync(output, `\uFEFF${lines.join("\n")}\n`);
}

async function visible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function attemptLogin(page) {
  const password = await visible(page.locator('input[type="password"]'));
  if (!password) return false;
  const username = process.env.FASTMOSS_USERNAME || "";
  const secret = process.env.FASTMOSS_PASSWORD || "";
  if (!username || !secret) {
    console.error("FastMoss login is required. Enter it in the opened browser; credentials were not supplied.");
    return true;
  }
  const account = await visible(page.locator(
    'input[type="text"], input[type="tel"], input[type="email"], input:not([type])',
  ));
  if (account) await account.fill(username);
  await password.fill(secret);
  const labels = ["登录", "Log in", "Login", "Sign in", "Iniciar sesión", "Connexion"];
  let submit = null;
  for (const label of labels) {
    submit = await visible(page.getByRole("button", { name: label, exact: false }));
    if (submit) break;
  }
  if (submit) await submit.click();
  return true;
}

async function looksLoggedIn(page) {
  const url = page.url().toLowerCase();
  if (url.includes("login") || url.includes("signin")) return false;
  return !(await visible(page.locator('input[type="password"]')));
}

async function setup(context) {
  const pages = context.pages();
  const page = pages[0] || await context.newPage();
  await page.goto("https://www.fastmoss.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await attemptLogin(page);
  console.error(
    "FastMoss setup: complete any CAPTCHA. Open one Creator-results tab with an EU5 multi-country filter, or five tabs (ES/FR/DE/IT/GB). In every tab set followers <10000 and active Shop/Showcase.",
  );
  if (process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    await prompt.question("When all filtered Creator result tabs are visible, press Enter here to save them: ");
    prompt.close();
    const creatorUrls = [];
    for (const candidate of context.pages()) {
      const current = candidate.url();
      const creatorPage = /creator|influencer|达人|kol/i.test(current + " " + await candidate.title().catch(() => ""));
      if (await looksLoggedIn(candidate) && creatorPage) creatorUrls.push(current);
    }
    if (!creatorUrls.length) throw new Error("No logged-in FastMoss Creator results tabs were found");
    fs.writeFileSync(readyPath, JSON.stringify({
      creator_urls: [...new Set(creatorUrls)],
      shop_filter_confirmed: true,
      configured_at: new Date().toISOString(),
    }, null, 2));
    console.error(`FastMoss browser session saved: ${readyPath}`);
    return;
  }
  const deadline = Date.now() + setupTimeout;
  let stableUrl = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const current = page.url();
    const creatorPage = /creator|influencer|达人|kol/i.test(current + " " + await page.title().catch(() => ""));
    if (await looksLoggedIn(page) && creatorPage) {
      if (current !== stableUrl) {
        stableUrl = current;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= 15000) {
        fs.writeFileSync(readyPath, JSON.stringify({
          creator_url: current,
          shop_filter_confirmed: true,
          configured_at: new Date().toISOString(),
        }, null, 2));
        console.error(`FastMoss browser session saved: ${readyPath}`);
        return;
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("FastMoss setup timed out before a stable Creator results page was detected");
}

async function extractRows(page, fallbackCountry = "") {
  return await page.evaluate((fallback) => {
    const containers = [
      ...document.querySelectorAll("table tbody tr, [role=row], .ant-table-row, .el-table__row"),
    ];
    const countries = ["ES", "FR", "DE", "IT", "GB"];
    const rows = [];
    for (const element of containers) {
      const text = (element.innerText || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const table = element.closest("table");
      const headers = table
        ? [...table.querySelectorAll("thead th")].map(cell => (cell.innerText || "").trim().toLowerCase())
        : [];
      const cells = [...element.querySelectorAll(":scope > td, :scope > [role=cell]")]
        .map(cell => (cell.innerText || "").replace(/\s+/g, " ").trim());
      const column = pattern => {
        const index = headers.findIndex(header => pattern.test(header));
        return index >= 0 ? cells[index] || "" : "";
      };
      const links = [...element.querySelectorAll("a[href]")].map(link => link.href);
      const tiktok = links.find(link => /tiktok\.com\/@/i.test(link)) || "";
      const fastmossDetail = links.find(link => /\/influencer\/detail\//i.test(link)) || "";
      const handleMatch = tiktok.match(/tiktok\.com\/@([^/?#]+)/i)
        || text.match(/(?:^|\s)@([A-Za-z0-9._-]{2,})/);
      if (!handleMatch) continue;
      const emailMatch = (column(/email|邮箱|联系/) || text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      const mediaText = [...element.querySelectorAll("img")]
        .map(image => `${image.alt || ""} ${image.title || ""}`).join(" ");
      const countryText = `${column(/country|region|国家|地区/)} ${text} ${mediaText}`;
      const country = countries.find(code => new RegExp(`(?:^|\\s)${code}(?:\\s|$)`).test(countryText)) || fallback;
      const followersMatch = column(/followers?|粉丝|fans?/).match(/([\d,.]+\s*[KkMm]?)/i)
        || text.match(/(?:followers?|粉丝)\s*[:：]?\s*([\d,.]+\s*[KkMm]?)/i)
        || text.match(/([\d,.]+\s*[KkMm]?)\s*(?:followers?|粉丝)/i);
      const salesMatch = column(/units sold|sales|销量|带货销量/).match(/([\d,.]+\s*[KkMm]?)/i)
        || text.match(/(?:units sold|sales|销量|带货销量)\s*[:：]?\s*([\d,.]+\s*[KkMm]?)/i);
      const gmvMatch = column(/gmv|销售额/).match(/[$€£]?\s*([\d,.]+\s*[KkMm]?)/i)
        || text.match(/(?:GMV|销售额)\s*[:：]?\s*[$€£]?\s*([\d,.]+\s*[KkMm]?)/i);
      rows.push({
        username: decodeURIComponent(handleMatch[1]).replace(/^@/, "").toLowerCase(),
        country,
        followers: followersMatch?.[1] || "",
        email: emailMatch?.[0]?.toLowerCase() || "",
        units_sold: salesMatch?.[1] || "",
        gmv: gmvMatch?.[1] || "",
        shop_valid: "true",
        shop_proof: "shop_showcase_verified",
        shop_proof_method: "fastmoss_filtered_web_page",
        bio: text,
        profile_url: tiktok,
        source_url: fastmossDetail,
        source: "fastmoss_browser",
      });
    }
    return rows;
  }, fallbackCountry);
}

function numberFromText(value) {
  const text = String(value || "").replaceAll(",", "").trim().toLowerCase();
  const match = text.match(/[\d.]+/);
  if (!match) return 0;
  let multiplier = 1;
  if (/[k千]$/.test(text)) multiplier = 1000;
  else if (/[m万]$/.test(text)) multiplier = text.endsWith("万") ? 10000 : 1000000;
  else if (text.endsWith("亿")) multiplier = 100000000;
  return Math.round(Number(match[0]) * multiplier);
}

async function enrichFromDetail(page, row) {
  if (!row.source_url) return null;
  await page.goto(row.source_url, { waitUntil: "domcontentloaded", timeout: 60000 });
  const detail = await page.evaluate(() => {
    const main = (document.querySelector("main")?.innerText || "").replace(/\s+/g, " ");
    const links = [...document.querySelectorAll("a[href]")].map(link => link.href);
    return {
      email: main.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "",
      followers: main.match(/粉丝数\s*([\d,.万亿]+)/)?.[1] || "",
      shop_valid: main.includes("已开通橱窗"),
      profile_url: links.find(link => /tiktok\.com\/@/i.test(link)) || "",
      bio: main.slice(0, 2000),
    };
  });
  const followers = numberFromText(detail.followers || row.followers);
  // FastMoss masks some contacts with "...". Only retain a complete address;
  // Python performs the final MX-domain verification before qualification.
  const completeEmail = detail.email && !detail.email.includes("...") ? detail.email.toLowerCase() : "";
  if (!completeEmail || !detail.shop_valid || !(followers > 0 && followers < maxFollowers)) return null;
  return {
    ...row,
    email: completeEmail,
    followers,
    shop_valid: "true",
    shop_proof: "shop_showcase_verified",
    shop_proof_method: "fastmoss_creator_showcase_open",
    profile_url: detail.profile_url || row.profile_url,
    bio: detail.bio,
  };
}

async function nextPage(page) {
  const selectors = [
    'button[aria-label="Next"]', 'button[aria-label="下一页"]',
    '.ant-pagination-next:not(.ant-pagination-disabled) button',
    '.el-pagination .btn-next:not([disabled])',
  ];
  for (const selector of selectors) {
    const button = await visible(page.locator(selector));
    if (button && await button.isEnabled().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(1200);
      return true;
    }
  }
  return false;
}

async function collect(context) {
  if (!fs.existsSync(readyPath)) {
    throw new Error("FastMoss browser session is not configured; run fastmoss_browser_setup.sh first");
  }
  const ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
  const urls = ready.creator_urls || (ready.creator_url ? [ready.creator_url] : []);
  if (!ready.shop_filter_confirmed || !urls.length) throw new Error("FastMoss saved search is incomplete");
  const page = context.pages()[0] || await context.newPage();
  const detailPage = await context.newPage();
  const found = new Map();
  for (const creatorUrl of urls) {
    const filteredUrl = new URL(creatorUrl);
    filteredUrl.searchParams.set("shop_window", "1");
    filteredUrl.searchParams.set("contact", "3");
    filteredUrl.searchParams.set("page", "1");
    await page.goto(filteredUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60000 });
    if (!await looksLoggedIn(page)) throw new Error("FastMoss session expired; run setup again");
    const countryMatch = creatorUrl.match(/(?:region|country)(?:=|%3D)(ES|FR|DE|IT|GB)/i);
    const fallbackCountry = countryMatch?.[1]?.toUpperCase() || "";
    let unchanged = 0;
    for (let pageNumber = 1; pageNumber <= 500 && found.size < target; pageNumber += 1) {
      const before = found.size;
      for (const row of await extractRows(page, fallbackCountry)) {
        if (found.has(row.username)) continue;
        const enriched = await enrichFromDetail(detailPage, row).catch(() => null);
        if (enriched) found.set(row.username, enriched);
        if (found.size >= target) break;
      }
      console.error(`[fastmoss-browser] search=${urls.indexOf(creatorUrl) + 1}/${urls.length} page=${pageNumber} unique=${found.size}`);
      unchanged = found.size === before ? unchanged + 1 : 0;
      if (unchanged >= 2 || !await nextPage(page)) break;
    }
    if (found.size >= target) break;
  }
  writeCsv([...found.values()]);
  console.error(`[fastmoss-browser] wrote ${found.size} rows to ${output}`);
}

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, {
    headless: mode === "collect" && !has("--headed"),
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
  });
  if (mode === "setup") await setup(context);
  else await collect(context);
} catch (error) {
  console.error(`[fastmoss-browser] ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
}
