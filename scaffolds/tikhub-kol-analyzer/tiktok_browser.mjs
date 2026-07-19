#!/usr/bin/env node
/** Public TikTok profile collector using bounded, auditable page extraction.
 *
 * It does not bypass login, CAPTCHA, rate limits or access controls. A detected
 * challenge stops the run and writes a small diagnostic for manual review.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  HumanChallengeError,
  captureDiagnostic,
  createPacer,
  resolveChromiumExecutable,
  runInjectedExtractor,
  safeNavigate,
  waitForStableDom,
} from "./browser_resilience.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const argv = process.argv.slice(2);
const value = (name, fallback = "") => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const values = name => argv.flatMap((arg, index) => arg === name && argv[index + 1] ? [argv[index + 1]] : []);
const has = name => argv.includes(name);
const output = path.resolve(value("--output", "output/tiktok_public_profiles.csv"));
const checkpointPath = output.replace(/\.csv$/i, "") + ".checkpoint.json";
const diagnosticsDir = path.resolve(value("--diagnostics-dir", path.join(path.dirname(output), "browser_diagnostics")));
const limit = Math.min(100, Math.max(1, Number(value("--limit", "100"))));
const minDelayMs = Number(value("--min-delay-ms", process.env.BROWSER_MIN_DELAY_MS || "4000"));
const maxDelayMs = Number(value("--max-delay-ms", process.env.BROWSER_MAX_DELAY_MS || "9000"));
const maxAttempts = Number(value("--max-attempts", "3"));
const allowedHosts = ["tiktok.com"];
const pacer = createPacer({ minDelayMs, maxDelayMs });

export function normalizeHandle(value) {
  const text = String(value || "").trim();
  const match = text.match(/tiktok\.com\/@([^/?#]+)/i);
  return decodeURIComponent(match?.[1] || text).replace(/^@/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function inputHandles() {
  const direct = [...values("--username"), ...String(value("--usernames", "")).split(",")];
  const input = value("--input", "");
  if (input) {
    const text = fs.readFileSync(path.resolve(input), "utf8");
    direct.push(...text.split(/[\r\n,]+/));
  }
  return [...new Set(direct.map(normalizeHandle).filter(Boolean))].slice(0, limit);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(rows) {
  const fields = [
    "username", "status", "reason", "source", "country", "followers", "following",
    "bio", "email", "email_source", "email_verified", "profile_url", "avg_views_10",
    "engagement_rate", "recent_videos_json", "collected_at",
  ];
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const lines = [fields.join(","), ...rows.map(row => fields.map(field => csvCell(row[field])).join(","))];
  fs.writeFileSync(output, `\uFEFF${lines.join("\n")}\n`);
}

function loadCheckpoint() {
  if (!has("--resume") || !fs.existsSync(checkpointPath)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  return new Map((parsed.rows || []).map(row => [row.username, row]));
}

function saveCheckpoint(rows) {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ updated_at: new Date().toISOString(), rows: [...rows.values()] }, null, 2));
  fs.renameSync(temporary, checkpointPath);
  writeCsv([...rows.values()]);
}

async function extractProfile(page, username) {
  return runInjectedExtractor(page, (fallback) => {
    const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
    const number = value => {
      const parsed = Number(String(value ?? "").replace(/,/g, ""));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const scripts = [...document.querySelectorAll('script[type="application/json"], script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script#SIGI_STATE')];
    const roots = [];
    for (const script of scripts) {
      try { roots.push(JSON.parse(script.textContent || "{}")); } catch {}
    }
    let user = null;
    let stats = null;
    const videos = [];
    const seen = new WeakSet();
    const queue = roots.map(value => ({ value, depth: 0 }));
    let visited = 0;
    while (queue.length && visited < 30000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value); visited += 1;
      const uniqueId = normalize(value.uniqueId || value.unique_id || value.author?.uniqueId || "").toLowerCase();
      if (!user && uniqueId === fallback.toLowerCase()) user = value.user || value.author || value;
      if (uniqueId === fallback.toLowerCase() && (value.followerCount != null || value.stats?.followerCount != null)) {
        stats = value.stats || value;
      }
      const authorId = normalize(value.author?.uniqueId || value.authorMeta?.name || "").toLowerCase();
      const videoId = normalize(value.id || value.aweme_id || value.itemId || "");
      const videoStats = value.stats || value.statistics || {};
      if (videoId && authorId === fallback.toLowerCase() && videos.length < 10) {
        videos.push({
          id: videoId,
          description: normalize(value.desc || value.description || value.text || "").slice(0, 300),
          views: number(videoStats.playCount || videoStats.play_count),
          likes: number(videoStats.diggCount || videoStats.likeCount || videoStats.digg_count),
          comments: number(videoStats.commentCount || videoStats.comment_count),
          shares: number(videoStats.shareCount || videoStats.share_count),
        });
      }
      if (depth < 12) {
        for (const child of Object.values(value)) if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
      }
    }
    const metaDescription = document.querySelector('meta[name="description"]')?.content || "";
    const body = normalize(document.querySelector("main")?.innerText || document.body?.innerText || "").slice(0, 12000);
    const bio = normalize(user?.signature || user?.bio || user?.desc || metaDescription).slice(0, 1000);
    const email = `${bio} ${body}`.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() || "";
    const domVideos = [...document.querySelectorAll('a[href*="/video/"]')].slice(0, 10).map(link => ({
      id: link.href.match(/\/video\/(\d+)/)?.[1] || "",
      description: normalize(link.getAttribute("aria-label") || link.innerText || "").slice(0, 300),
      url: link.href,
    }));
    const mergedVideos = videos.length ? videos : domVideos;
    const views = mergedVideos.map(video => number(video.views)).filter(value => value > 0);
    const engagement = mergedVideos.filter(video => number(video.views) > 0).map(video =>
      (number(video.likes) + number(video.comments) + number(video.shares)) / Math.max(1, number(video.views))
    );
    return {
      username: normalize(user?.uniqueId || user?.unique_id || fallback).replace(/^@/, "").toLowerCase(),
      country: normalize(user?.region || user?.country || "").toUpperCase(),
      followers: number(stats?.followerCount || stats?.follower_count || user?.stats?.followerCount),
      following: number(stats?.followingCount || stats?.following_count || user?.stats?.followingCount),
      bio, email,
      recent_videos: mergedVideos,
      avg_views_10: views.length ? Math.round(views.reduce((sum, item) => sum + item, 0) / views.length) : 0,
      engagement_rate: engagement.length ? Number((engagement.reduce((sum, item) => sum + item, 0) / engagement.length).toFixed(4)) : 0,
    };
  }, username, { allowedHosts });
}

async function main() {
  const usernames = inputHandles();
  if (!usernames.length) throw new Error("provide --username, --usernames or --input");
  const rows = loadCheckpoint();
  const bundledChromium = resolveChromiumExecutable(chromium);
  const browser = await chromium.launch({
    headless: !has("--headed"),
    ...(fs.existsSync(bundledChromium) ? { executablePath: bundledChromium } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  try {
    for (const username of usernames) {
      if (rows.has(username)) continue;
      try {
        const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
        await safeNavigate(page, profileUrl, {
          allowedHosts, platform: "tiktok", pacer, diagnosticsDir, attempts: maxAttempts,
        });
        await waitForStableDom(page, ["main", 'script[type="application/json"]'], { timeoutMs: 30000, settleMs: 1000 });
        const profile = await extractProfile(page, username);
        rows.set(username, {
          ...profile,
          status: profile.bio || profile.followers ? "collected" : "review_required",
          reason: profile.bio || profile.followers ? "" : "public_profile_fields_missing",
          source: "tiktok_public_page",
          email_source: profile.email ? "public_profile_page" : "",
          email_verified: "false",
          profile_url: page.url(),
          recent_videos_json: JSON.stringify(profile.recent_videos || []),
          collected_at: new Date().toISOString(),
        });
        if (rows.get(username).status === "review_required") {
          await captureDiagnostic(page, diagnosticsDir, `tiktok-missing-${username}`, {
            reason: "public_profile_fields_missing",
          });
        }
        saveCheckpoint(rows);
        console.error(`[tiktok-browser] @${username} ${rows.get(username).status}`);
      } catch (error) {
        if (error instanceof HumanChallengeError) throw error;
        rows.set(username, {
          username, status: "error", reason: String(error?.message || error).slice(0, 240),
          source: "tiktok_public_page", profile_url: `https://www.tiktok.com/@${username}`,
          collected_at: new Date().toISOString(),
        });
        saveCheckpoint(rows);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  writeCsv([...rows.values()]);
  console.error(`[tiktok-browser] wrote ${rows.size} rows to ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`[tiktok-browser] ${error?.message || error}`);
    process.exitCode = error instanceof HumanChallengeError ? 3 : 1;
  });
}
