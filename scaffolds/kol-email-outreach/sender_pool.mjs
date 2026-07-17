// Shared sender pool: lowest-count selection across configured accounts.
// Persists daily counts to sender_state.json and rolls over in the configured timezone.
// 邮箱池支持 N 个发件邮箱（round-robin + 每号每日 50 封上限）。从 config.json 读取。
// Usage:
//   import { pickSender, reserveSend, getPoolStatus, getAllInboxAccounts } from "./sender_pool.mjs";
//   const acct = pickSender();
//   if (!acct) { /* pool exhausted, skip / defer */ }
//   else { reserveSend(acct.name); await sendViaMcp(acct.env, ...); }

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cfg from "./lib/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "sender_state.json");
export const PER_DAY_CAP = Number.isInteger(cfg.sender_daily_cap) && cfg.sender_daily_cap > 0
  ? cfg.sender_daily_cap
  : 50;
const TIME_ZONE = cfg.outreach_timezone || "Asia/Shanghai";

// IMAP/SMTP host（从 config.json 读取）
const IMAP_HOST = cfg.imap_host;
const SMTP_HOST = cfg.smtp_host;
const IMAP_PORT = cfg.imap_port;
const SMTP_PORT = cfg.smtp_port;
const IMAP_TLS_REJECT_UNAUTHORIZED = cfg.imap_tls_reject_unauthorized !== false;
const envFor = (user, pass) => ({
  IMAP_HOST, IMAP_PORT, SMTP_HOST, SMTP_PORT, IMAP_TLS_REJECT_UNAUTHORIZED,
  IMAP_USER: user, IMAP_PASSWORD: pass,
});

// Pool — 从 config.json sender_accounts 读取：[{name,user,pass}, ...]
export const ACCOUNTS = (() => {
  const arr = cfg.sender_accounts;
  if (!Array.isArray(arr) || arr.length === 0) {
    return [];
  }
  return arr.map(a => ({ name: a.name, user: a.user, env: envFor(a.user, a.pass) }));
})();

function todayKey() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { date: todayKey(), counts: {} };
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (s.date !== todayKey()) return { date: todayKey(), counts: {} };
  if (!s.counts || typeof s.counts !== "object" || Array.isArray(s.counts)) {
    throw new Error(`invalid sender state: ${STATE_FILE}`);
  }
  for (const [name, count] of Object.entries(s.counts)) {
    if (!Number.isInteger(count) || count < 0) throw new Error(`invalid sender count for ${name}`);
  }
  return s;
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8"); }

function countFor(state, sender) {
  const emailKey = String(sender.user || "").trim().toLowerCase();
  const nameKey = String(sender.name || "").trim();
  const emailCount = Number(state.counts[emailKey] || 0);
  const legacyNameCount = nameKey && nameKey !== emailKey ? Number(state.counts[nameKey] || 0) : 0;
  return emailCount + legacyNameCount;
}

/** Pick the account with the lowest send count today that is still under the cap. */
export function pickSender() {
  const s = loadState();
  const avail = ACCOUNTS
    .map(a => ({ a, c: countFor(s, a) }))
    .filter(x => x.c < PER_DAY_CAP)
    .sort((x, y) => x.c - y.c);
  return avail.length ? avail[0].a : null;
}

/** Called after a successful send to tick the counter. */
export function incrementSend(name) {
  reserveSend(name);
}

/** Reserve one daily slot before the provider call. */
export function reserveSend(name) {
  const s = loadState();
  const sender = getSender(name);
  if (!sender) throw new Error(`unknown sender account: ${name}`);
  if (countFor(s, sender) >= PER_DAY_CAP) throw new Error(`daily sender cap reached: ${sender.name}`);
  const key = String(sender.user || sender.name).trim().toLowerCase();
  s.counts[key] = (s.counts[key] || 0) + 1;
  s.last_update = new Date().toISOString();
  saveState(s);
}

/** Release a reserved slot only after a provider explicitly confirms no send occurred. */
export function releaseSend(name) {
  const s = loadState();
  const sender = getSender(name);
  if (!sender) throw new Error(`unknown sender account: ${name}`);
  const emailKey = String(sender.user || sender.name).trim().toLowerCase();
  const legacyKey = String(sender.name || "").trim();
  if ((s.counts[emailKey] || 0) > 0) s.counts[emailKey] -= 1;
  else if (legacyKey && (s.counts[legacyKey] || 0) > 0) s.counts[legacyKey] -= 1;
  else throw new Error(`cannot release unreserved sender slot: ${sender.name}`);
  s.last_update = new Date().toISOString();
  saveState(s);
}

/** Diagnostics. */
export function getPoolStatus() {
  const s = loadState();
  const per = ACCOUNTS.map(a => {
    const sent = countFor(s, a);
    return { name: a.name, sent, remaining: Math.max(0, PER_DAY_CAP - sent) };
  });
  const totalRemaining = per.reduce((n, x) => n + x.remaining, 0);
  return { date: s.date, per_account: per, total_remaining_today: totalRemaining, cap_per_account: PER_DAY_CAP };
}

/** For the reply monitor — scan all configured inboxes regardless of send cap. */
export function getAllInboxAccounts() { return ACCOUNTS; }

/** Keep follow-ups on the same sender identity whenever possible. */
export function getSender(name) {
  return ACCOUNTS.find(account => account.name === name || account.user === name) || null;
}

/** Check the current persisted cap immediately before a real send. */
export function canSend(name) {
  const sender = getSender(name);
  if (!sender) return false;
  const state = loadState();
  return countFor(state, sender) < PER_DAY_CAP;
}
