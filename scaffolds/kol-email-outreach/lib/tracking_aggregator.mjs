/**
 * tracking-aggregator — 单接口聚合多源跟踪数据
 *
 * 数据源：
 *   1. track_server.py /track/list ndjson  →  开信像素（prefetch + open 两种 type）
 *   2. Bitable email_log（Direction=outbound + Direction=inbound）→ 出/入站邮件历史
 *   3. (TODO) 品牌后台 API → 注册数 / 下单数 / GMV  ← 阻塞，外部源未接入
 *
 * 输出：statusOf(creatorHandle, env) 一次返回综合状态
 *   {
 *     handle, opens: [{ts, iso, type, template, ip, ua}], real_opens_count,
 *     last_real_open_at, prefetch_only,
 *     outbound_count, inbound_count, last_outbound_at, last_inbound_at,
 *     replies: [{from, ts, subject, snippet}],          // 当 inbound 已落库时填充
 *     registrations: null|N, orders: null|M, gmv: null|X,  // 品牌后台未接入则为 null
 *   }
 */

import cfg from "./config.mjs";

const TRACK_SERVER = cfg.email_track_base || "http://host.docker.internal:18791";

async function btToken(env) {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  return r?.tenant_access_token;
}

function val(rec, name) {
  const v = rec.fields?.[name];
  if (Array.isArray(v)) return v.map(x => (x?.text ?? x?.name ?? x ?? "")).join("");
  return v == null ? "" : String(v);
}

/** Pull all pixel events for a creator from track_server. Returns chronologically ascending. */
export async function fetchOpenEvents(creatorHandle) {
  let text = "";
  try {
    text = await fetch(`${TRACK_SERVER}/track/list`, { signal: AbortSignal.timeout(8000) }).then(r => r.text());
  } catch (e) {
    return { error: `track_server unreachable: ${e.message}`, events: [] };
  }
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.creator === creatorHandle) {
      events.push({
        ts: j.ts,
        iso: j.iso,
        type: j.type || "open",   // 老格式无 type 字段时当 open
        template: j.template || "",
        email_ts: j.email_ts || "",
        ip: j.ip || "",
        ua: j.ua || "",
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events };
}

/** Read outbound + inbound rows from email_log for a creator. */
export async function fetchEmailHistory(env, creatorHandle, limit = 50) {
  const tok = await btToken(env);
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_EMAIL_LOG}/records/search?page_size=${limit}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          conjunction: "and",
          conditions: [{ field_name: "Creator Username", operator: "is", value: [creatorHandle] }],
        },
        sort: [{ field_name: "Sent At", desc: false }],
      }),
    }
  ).then(r => r.json());
  const items = r?.data?.items || [];
  const out = [];
  for (const it of items) {
    out.push({
      direction: val(it, "Direction"),
      template_id: val(it, "Template ID"),
      subject: val(it, "Subject"),
      body_preview: val(it, "Body Preview"),
      sender: val(it, "Sender Account"),
      sent_at: it.fields?.["Sent At"] || 0,
      message_id: val(it, "Message ID"),
      status: val(it, "Status"),
      reply_detected_at: it.fields?.["Reply Detected At"] || 0,
    });
  }
  return out;
}

/**
 * (TODO 阻塞) 拉 品牌后台的注册 / 下单 / GMV 数据。
 * 目前后台 API 未接入，返回 nulls。一旦接入，把这一块替换为真实 fetch。
 */
async function fetchAffiliateStats(creatorHandle) {
  // STUB —— 等用户给后台 API 凭据 / 文档
  return { registrations: null, orders: null, gmv: null, gmv_currency: null, _stub: true };
}

/**
 * 综合状态查询。一次返回 creator 的全部跟踪数据。
 * @param {string} creatorHandle
 * @param {object} env  { FEISHU_APP_ID, FEISHU_APP_SECRET, KOL_CRM_APP_TOKEN, KOL_TBL_EMAIL_LOG }
 * @returns {Promise<object>}
 */
export async function statusOf(creatorHandle, env) {
  const [openR, emails, affiliate] = await Promise.all([
    fetchOpenEvents(creatorHandle),
    fetchEmailHistory(env, creatorHandle),
    fetchAffiliateStats(creatorHandle),
  ]);

  const opens = openR.events || [];
  const realOpens = opens.filter(e => e.type === "open");
  const prefetchOnly = opens.length > 0 && realOpens.length === 0;

  const outbound = emails.filter(e => e.direction === "outbound");
  const inbound = emails.filter(e => e.direction === "inbound");

  const replies = inbound.map(e => ({
    from: e.sender || "",                      // sender 字段在 inbound 行里需要 auto_reply_monitor 写入
    ts: e.sent_at,
    subject: e.subject,
    snippet: e.body_preview?.substring(0, 200) || "",
  }));

  return {
    handle: creatorHandle,

    // 开信像素
    opens,
    real_opens_count: realOpens.length,
    last_real_open_at: realOpens.length ? realOpens[realOpens.length - 1].ts * 1000 : null,
    prefetch_only: prefetchOnly,

    // 邮件历史
    outbound_count: outbound.length,
    inbound_count: inbound.length,
    last_outbound_at: outbound.length ? outbound[outbound.length - 1].sent_at : null,
    last_inbound_at: inbound.length ? inbound[inbound.length - 1].sent_at : null,
    replies,

    // 联盟链接（后端阻塞）
    registrations: affiliate.registrations,
    orders: affiliate.orders,
    gmv: affiliate.gmv,
    affiliate_stub: affiliate._stub === true,

    // 错误
    track_server_error: openR.error || null,
  };
}
