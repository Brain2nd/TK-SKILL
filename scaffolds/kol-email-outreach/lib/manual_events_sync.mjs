/**
 * manual_events_sync — 把"运营手填事件表"应用到 creators 表
 *
 * 数据流：
 *   运营在 manual_events 表填一行 (Creator Handle / Event Type / Event At ...)
 *      ↓
 *   applyPending() 读所有 Synced=false 的行
 *      ↓
 *   按 Event Type 映射到 creators 表的 anchor 字段：
 *       QC通过       → QC Pass Date
 *       包裹送达     → Package Delivered Date
 *       预热视频上线 → Teaser Live At
 *       开箱视频上线 → Unboxing Live At
 *      ↓
 *   PUT 更新 creators 行 → 标记该 manual_events 行 Synced=true
 *      ↓
 *   deadline_engine 下次扫到 anchor 已有时间，开始算 deadline，按规则触发 nudge / red line
 *
 * 由 cron (auto_reply_monitor) 在每次跑时第 0 步调用，无需独立 cron。
 */

const EVENT_TYPE_TO_FIELD = {
  "QC通过":       "QC Pass Date",
  "包裹送达":     "Package Delivered Date",
  "预热视频上线": "Teaser Live At",
  "开箱视频上线": "Unboxing Live At",
};

async function tenantToken(env) {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  return r.tenant_access_token;
}

function val(rec, name) {
  const v = rec.fields?.[name];
  if (Array.isArray(v)) return v.map(x => (x?.text ?? x?.name ?? x ?? "")).join("");
  return v == null ? "" : v;
}

async function findCreatorRecordId(env, tok, handle) {
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_CREATORS}/records/search?page_size=1`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: { conjunction: "and", conditions: [{ field_name: "username", operator: "is", value: [handle] }] },
      }),
    }
  ).then(r => r.json());
  return r?.data?.items?.[0]?.record_id || null;
}

/**
 * 扫一遍 manual_events 表所有 Synced=false 的行，应用到 creators，标记已同步。
 * @param {object} env  { FEISHU_APP_ID, FEISHU_APP_SECRET, KOL_CRM_APP_TOKEN, KOL_TBL_CREATORS, KOL_TBL_MANUAL_EVENTS }
 * @returns {Promise<{processed, applied, skipped, errors}>}
 */
export async function applyPending(env) {
  const tok = await tenantToken(env);
  if (!env.KOL_TBL_MANUAL_EVENTS) {
    return { processed: 0, applied: 0, skipped: 0, errors: ["KOL_TBL_MANUAL_EVENTS not configured"] };
  }

  // 拉所有 Synced=false 的 events
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_MANUAL_EVENTS}/records/search?page_size=200`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          conjunction: "and",
          conditions: [{ field_name: "Synced", operator: "is", value: ["false"] }],
        },
      }),
    }
  ).then(r => r.json());
  const items = r?.data?.items || [];

  let applied = 0, skipped = 0;
  const errors = [];

  for (const ev of items) {
    const handle = val(ev, "Creator Handle").toString().trim();
    const eventType = val(ev, "Event Type").toString().trim();
    const eventAt = ev.fields?.["Event At"];
    const fieldName = EVENT_TYPE_TO_FIELD[eventType];

    if (!handle || !eventType || !eventAt || !fieldName) {
      skipped++;
      errors.push(`row ${ev.record_id}: missing one of [handle=${handle}, type=${eventType}, at=${eventAt}, mapped=${fieldName}]`);
      continue;
    }

    const creatorRecId = await findCreatorRecordId(env, tok, handle);
    if (!creatorRecId) {
      skipped++;
      errors.push(`row ${ev.record_id}: creator @${handle} not found in CRM`);
      continue;
    }

    // 1. PUT creators.<fieldName> = eventAt
    const upR = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_CREATORS}/records/${creatorRecId}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { [fieldName]: eventAt } }),
      }
    ).then(r => r.json());

    if (upR?.code !== 0) {
      errors.push(`row ${ev.record_id}: PUT creators failed code=${upR?.code} msg=${upR?.msg}`);
      continue;
    }

    // 2. PUT manual_events.Synced=true
    await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_MANUAL_EVENTS}/records/${ev.record_id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { "Synced": true, "Synced At": Date.now() } }),
      }
    );

    applied++;
  }

  return { processed: items.length, applied, skipped, errors };
}

/**
 * 把 deadline_engine 的某个 nudge/red-line 动作落到 creators 行的 Operation Alert 字段，让运营在 Bitable 看到红字。
 * 不发消息，纯字段标识。
 * @param {object} env  { FEISHU_APP_ID, FEISHU_APP_SECRET, KOL_CRM_APP_TOKEN, KOL_TBL_CREATORS }
 * @param {string} handle
 * @param {string} alertValue  "无" | "催草稿" | "🔴 暂停发货" | "🔴 升级评估" | "已处理"
 */
export async function setOperationAlert(env, handle, alertValue) {
  const tok = await tenantToken(env);
  const recId = await findCreatorRecordId(env, tok, handle);
  if (!recId) return false;
  const r = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_CREATORS}/records/${recId}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Operation Alert": alertValue } }),
    }
  ).then(r => r.json());
  return r?.code === 0;
}

/** deadline_engine action → Operation Alert 值的映射 */
export function actionToAlert(action) {
  switch (action) {
    case "nudge":         return "催草稿";
    case "stop_shipping": return "🔴 暂停发货";
    case "escalate":      return "🔴 升级评估";
    default:              return null; // drop / missing_anchor / 其他不写 alert
  }
}
