/**
 * email-thread-builder — 出站邮件 thread 续接器
 *
 * 给定 creator handle，扫 Bitable.email_log 拿历史 outbound 链，把新邮件
 * 拼成 RFC 5322 合规的 reply：
 *   - In-Reply-To: 链上最近一条 Message-ID
 *   - References:  链上所有 Message-ID（oldest → newest space-separated）
 *   - Subject:     如未以 "Re:" 开头则加前缀
 *   - Body:        新内容 + 引用块（"On YYYY-MM-DD, we wrote: > ..."）
 *
 * 历史链中没有 Message-ID 的旧 draft 行（即 Step 1 修复前的 221 条遗留）会被跳过。
 * 历史为空 ⇒ 当作首封发出，无 thread 头。
 *
 * 用法：
 *   import { sendThreaded } from "./lib/email-thread-builder.mjs";
 *   const r = await sendThreaded({
 *     creatorHandle: "phoe4ter",
 *     env: { FEISHU_APP_ID, FEISHU_APP_SECRET, KOL_CRM_APP_TOKEN, KOL_TBL_EMAIL_LOG },
 *     smtp: { host:"smtp.example.com", port:465, secure:true, auth:{user: env.SMTP_USER, pass: env.SMTP_PASS} },
 *     to: "creator@example.com",
 *     subject: "<brand subject>",
 *     body:    "Hi Phoebe,\n\nThanks for your interest! ...",
 *   });
 *   // r => { ok:true, messageId:"<...>", isReply:true, chainLength:2, subject:"Re: ..." }
 */

import nodemailer from "nodemailer";
import cfg from "./config.mjs";

async function btToken(env) {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  if (!r?.tenant_access_token) throw new Error(`tenant_access_token failed: ${r?.msg || "?"}`);
  return r.tenant_access_token;
}

function val(rec, name) {
  const v = rec.fields?.[name];
  if (Array.isArray(v)) return v.map(x => (x?.text ?? x?.name ?? x ?? "")).join("");
  return v == null ? "" : String(v);
}

/** Read prior outbound chain for a creator (oldest → newest, only entries with Message-ID). */
export async function fetchOutboundChain(env, creatorHandle, limit = 50) {
  const tok = await btToken(env);
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_EMAIL_LOG}/records/search?page_size=${limit}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          conjunction: "and",
          conditions: [
            { field_name: "Creator Username", operator: "is", value: [creatorHandle] },
            { field_name: "Direction", operator: "is", value: ["outbound"] },
          ],
        },
        sort: [{ field_name: "Sent At", desc: false }], // oldest → newest
      }),
    }
  ).then(r => r.json());
  const items = r?.data?.items || [];
  const chain = [];
  for (const it of items) {
    const mid = val(it, "Message ID").trim();
    if (!mid) continue; // 旧 draft 行没 mid 的跳过
    chain.push({
      messageId: mid,
      subject: val(it, "Subject"),
      bodyFull: val(it, "Body Full") || val(it, "Body Preview"),
      sentAt: it.fields?.["Sent At"] || 0,
      sender: val(it, "From Email"),
      templateId: val(it, "Template ID"),
    });
  }
  return chain;
}

function ensureBracketed(mid) {
  if (!mid) return "";
  return mid.startsWith("<") ? mid : `<${mid}>`;
}

function makeReplySubject(prevSubject, fallbackSubject) {
  const s = (prevSubject || fallbackSubject || "").trim();
  if (/^re:\s/i.test(s)) return s;
  return `Re: ${s}`;
}

/**
 * 兜底规则筛：移除 body 末尾若干行里独立成行的邮箱地址。
 * 用户需求 2026-04-27：邮件最后一行不要带发件箱邮箱地址。
 *
 * 规则：从尾部往前扫最多 8 行，命中独立成行的邮箱（行内只有 a@b.c 或 "Email: a@b.c"
 * 这种纯联系方式行）就删除；签名行（如 "<昵称> | <品牌> Team"）保留。
 * 中段邮件正文里的邮箱不动（可能是达人自己的联系方式）。
 */
export function stripTrailingEmail(body) {
  if (!body) return body;
  const EMAIL_LINE = /^\s*(?:e-?mail\s*[:：]?\s*|联系\s*[:：]?\s*|contact\s*[:：]?\s*)?[\w._%+\-]+@[\w.\-]+\.[a-z]{2,}\s*$/i;
  const lines = body.split("\n");
  const TAIL = Math.min(lines.length, 8);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - TAIL); i--) {
    if (EMAIL_LINE.test(lines[i])) {
      lines.splice(i, 1);
    }
  }
  while (lines.length && /^\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

function quoteBlock(prev) {
  if (!prev?.bodyFull) return "";
  const date = prev.sentAt ? new Date(prev.sentAt).toISOString().substring(0, 10) : "previously";
  const brandDomain = (cfg.brand_domain || `${cfg.our_brand_name || "brand"}.com`).toLowerCase();
  const senderLabel = prev.sender ? `${prev.sender}@${brandDomain}` : "we";
  const quoted = prev.bodyFull.split("\n").map(l => `> ${l}`).join("\n");
  return `\n\n----\nOn ${date}, ${senderLabel} wrote:\n${quoted}`;
}

/**
 * Build mailOptions for nodemailer with thread headers + quote.
 * Returns an object with private fields (_isReply, _chain) for caller introspection.
 */
export async function buildEmail(args) {
  const { creatorHandle, env, to, subject, html, from } = args;
  const body = args.body || "";
  const chain = await fetchOutboundChain(env, creatorHandle);
  const isReply = chain.length > 0;
  const opts = { to, from, subject: subject || "", text: body, html };
  if (isReply) {
    const last = chain[chain.length - 1];
    opts.subject = makeReplySubject(last.subject, subject);
    opts.text = body + quoteBlock(last);
    // Regenerate HTML from current (personalized) body — using original bodyHtml causes
    // Gmail to collapse the reply as duplicate content since it's identical to the first email.
    const urlRegex = /(https?:\/\/[^\s<>"]+)/g;
    opts.html = body
      .replace(urlRegex, u => `<a href="${u}">${u}</a>`)
      .replace(/\n/g, "<br>");
    opts.headers = {
      "In-Reply-To": ensureBracketed(last.messageId),
      "References": chain.map(c => ensureBracketed(c.messageId)).join(" "),
    };
  }
  opts._isReply = isReply;
  opts._chain = chain;
  return opts;
}

/**
 * Send a threaded email via nodemailer. Always returns shape consistent with caller expectations
 * regardless of success/failure.
 */
export async function sendThreaded(args) {
  const { smtp, ...rest } = args;
  let opts;
  try {
    opts = await buildEmail(rest);
  } catch (e) {
    return { ok: false, error: `buildEmail failed: ${e.message}`, isReply: false, chainLength: 0 };
  }
  if (!opts.from) opts.from = smtp.auth?.user;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure !== false,
    auth: smtp.auth,
  });
  // Strip our private fields before passing to nodemailer
  const _isReply = opts._isReply;
  const _chain = opts._chain;
  delete opts._isReply;
  delete opts._chain;
  try {
    const info = await transporter.sendMail(opts);
    return {
      ok: true,
      messageId: info.messageId,
      isReply: _isReply,
      chainLength: _chain.length,
      subject: opts.subject,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      isReply: _isReply,
      chainLength: _chain?.length || 0,
    };
  }
}
