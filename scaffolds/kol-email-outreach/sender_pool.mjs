// Shared sender pool: round-robin across configured accounts, 50/day/account cap.
// Persists daily counts to sender_state.json in project root (rolls over at UTC 00:00).
// 邮箱池支持 N 个发件邮箱（round-robin + 每号每日 50 封上限）。从 config.json 读取。
// Usage:
//   import { pickSender, incrementSend, getPoolStatus, getAllInboxAccounts } from "./sender_pool.mjs";
//   const acct = pickSender();
//   if (!acct) { /* pool exhausted, skip / defer */ }
//   else { await sendViaMcp(acct.env, ...); incrementSend(acct.name); }

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import cfg from "./lib/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "sender_state.json");
export const PER_DAY_CAP = 100;

// IMAP/SMTP host（从 config.json 读取）
const IMAP_HOST = cfg.imap_host;
const SMTP_HOST = cfg.smtp_host;
const IMAP_PORT = cfg.imap_port;
const SMTP_PORT = cfg.smtp_port;
const envFor = (user, pass) => ({
  IMAP_HOST, IMAP_PORT, SMTP_HOST, SMTP_PORT, IMAP_USER: user, IMAP_PASSWORD: pass,
});

// Pool — 从 config.json sender_accounts 读取：[{name,user,pass}, ...]
export const ACCOUNTS = (() => {
  const arr = cfg.sender_accounts;
  if (!Array.isArray(arr) || arr.length === 0) {
    console.error("[sender_pool] sender_accounts in config.json is empty");
    return [];
  }
  return arr.map(a => ({ name: a.name, user: a.user, env: envFor(a.user, a.pass) }));
})();

function todayKey() { return new Date().toISOString().substring(0, 10); }

function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return { date: todayKey(), counts: {} };
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (s.date !== todayKey()) return { date: todayKey(), counts: {} };
    return s;
  } catch { return { date: todayKey(), counts: {} }; }
}
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

/** Pick the account with the lowest send count today that is still under the cap. */
export function pickSender() {
  const s = loadState();
  const avail = ACCOUNTS
    .map(a => ({ a, c: s.counts[a.name] || 0 }))
    .filter(x => x.c < PER_DAY_CAP)
    .sort((x, y) => x.c - y.c);
  return avail.length ? avail[0].a : null;
}

/** Called after a successful send to tick the counter. */
export function incrementSend(name) {
  const s = loadState();
  s.counts[name] = (s.counts[name] || 0) + 1;
  s.last_update = new Date().toISOString();
  saveState(s);
}

/** Diagnostics. */
export function getPoolStatus() {
  const s = loadState();
  const per = ACCOUNTS.map(a => ({ name: a.name, sent: s.counts[a.name] || 0, remaining: Math.max(0, PER_DAY_CAP - (s.counts[a.name] || 0)) }));
  const totalRemaining = per.reduce((n, x) => n + x.remaining, 0);
  return { date: s.date, per_account: per, total_remaining_today: totalRemaining, cap_per_account: PER_DAY_CAP };
}

/** For the reply monitor — scan all configured inboxes regardless of send cap. */
export function getAllInboxAccounts() { return ACCOUNTS; }
