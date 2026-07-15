/**
 * feishu_notify — 通用飞书通知发送（双客户共用）
 *
 * env 配置（cron docker exec -e 或 openclaw.json mcp env）：
 *   FEISHU_APP_ID            必填，bot app id
 *   FEISHU_APP_SECRET        必填
 *   NOTIFY_RECEIVE_ID        必填，用户 open_id / chat_id 等
 *   NOTIFY_RECEIVE_ID_TYPE   可选，默认 open_id（其他: user_id / union_id / email / chat_id）
 *
 * 三个 env 任一缺失 → silent skip（不报错，返回 { ok:false, skipped:true }）
 *
 * 用法：
 *   import { notifyClient } from "./lib/feishu_notify.mjs";
 *   await notifyClient(`📨 自动建联完成\n发送 5 封 step01\n@a @b @c @d @e`);
 *
 * 失败不抛异常 — 通知失败不应该阻断主流程。
 */

import cfg from "./config.mjs";

let _tok = null, _tokExp = 0;
async function tenantTok(appId, appSecret) {
  if (_tok && Date.now() < _tokExp - 60000) return _tok;
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }).then(r => r.json());
  if (!r?.tenant_access_token) return null;
  _tok = r.tenant_access_token;
  _tokExp = Date.now() + (r.expire || 7200) * 1000;
  return _tok;
}

/**
 * 发送 text 通知。失败/缺 env → 不抛异常，silent。
 * @param {string} text — 消息正文（飞书会自动 \n 换行）
 * @param {object} [opts] — 可覆盖 env 的字段
 * @param {string} [opts.receiveId] — 默认 process.env.NOTIFY_RECEIVE_ID
 * @param {string} [opts.receiveIdType] — 默认 process.env.NOTIFY_RECEIVE_ID_TYPE 或 "open_id"
 * @param {string} [opts.appId] — 默认 process.env.FEISHU_APP_ID
 * @param {string} [opts.appSecret] — 默认 process.env.FEISHU_APP_SECRET
 * @returns {Promise<{ ok: boolean, skipped?: boolean, code?: number, msg?: string, error?: string }>}
 */
export async function notifyClient(text, opts = {}) {
  try {
    const appId = opts.appId || cfg.feishu_app_id;
    const appSecret = opts.appSecret || cfg.feishu_app_secret;
    const receiveId = opts.receiveId || cfg.notify_receive_id;
    const receiveIdType = opts.receiveIdType || cfg.notify_receive_id_type || "open_id";

    if (!appId || !appSecret || !receiveId) {
      return { ok: false, skipped: true, reason: "no FEISHU_APP_ID / FEISHU_APP_SECRET / NOTIFY_RECEIVE_ID env" };
    }

    const tok = await tenantTok(appId, appSecret);
    if (!tok) return { ok: false, error: "tenant_access_token failed" };

    const r = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: "text",
          content: JSON.stringify({ text }),
        }),
      }
    ).then(r => r.json());

    return { ok: r?.code === 0, code: r?.code, msg: r?.msg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
