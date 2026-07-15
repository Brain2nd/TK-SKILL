/**
 * Business Config Helper —— mcp 启动时优先从 Bitable business_config 表读
 * 配置项；本地 5 min cache；找不到回退到 env。
 *
 * 调用方：tikhub-mcp / kol-crm-mcp 启动时 `import { loadBusinessConfig } from '...'; const cfg = await loadBusinessConfig();`
 *
 * 写：kol-crm-mcp 暴露 `kol_business_config_*` 工具调用 setBusinessConfig() 写 Bitable + 删本地 cache。
 */
import fs from "fs";
import path from "path";
import cfg from "./config.mjs";

const CACHE_PATH = "/tmp/.business_config_cache.json";
const CACHE_TTL_MS = 5 * 60 * 1000;

const FEISHU_APP_ID = cfg.feishu_app_id;
const FEISHU_APP_SECRET = cfg.feishu_app_secret;
const APP_TOKEN = cfg.kol_crm_app_token;
const TBL_BUSINESS_CONFIG = cfg.kol_tbl_business_config;

const flat = v => Array.isArray(v) ? v.map(x => x?.text || x?.name || x).join("") : v;

async function getToken() {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }),
  }).then(r => r.json());
  return r.tenant_access_token;
}

async function fetchAllFromBitable() {
  if (!FEISHU_APP_ID || !APP_TOKEN || !TBL_BUSINESS_CONFIG) {
    return null; // env 没配齐，直接走 fallback
  }
  const tk = await getToken();
  let all = {};
  let pt = "";
  do {
    const r = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TBL_BUSINESS_CONFIG}/records/search?page_size=100${pt ? '&page_token=' + pt : ''}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then(r => r.json());
    if (r.code !== 0) throw new Error(`Bitable read failed: ${r.msg}`);
    for (const it of r.data?.items || []) {
      const k = flat(it.fields.Key);
      const v = flat(it.fields.Value);
      const updatedAt = it.fields["Updated At"] || 0;
      const updatedBy = flat(it.fields["Updated By"]) || "";
      const notes = flat(it.fields.Notes) || "";
      const type = flat(it.fields.Type) || "text";
      if (k) all[k] = { value: v ?? "", type, notes, updatedAt, updatedBy, recordId: it.record_id };
    }
    pt = r.data?.page_token || "";
  } while (pt);
  return all;
}

function readCacheSync() {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (cache && cache.fetched_at && (Date.now() - cache.fetched_at) < CACHE_TTL_MS) {
      return cache.config;
    }
  } catch {}
  return null;
}

function writeCacheSync(config) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetched_at: Date.now(), config }), { mode: 0o600 });
  } catch {}
}

export function invalidateCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

/**
 * 主入口。返回扁平的 { KEY: value } 形式（兼容现有 env 用法）。
 * 顺序：本地 cache (5min TTL) → Bitable → env fallback。
 * Bitable 不可达时静默回退 env。
 */
export async function loadBusinessConfig(envFallbackKeys = []) {
  // 1. 本地 cache
  let cfgFromCache = readCacheSync();
  if (cfgFromCache) {
    return flatten(cfgFromCache, envFallbackKeys);
  }
  // 2. Bitable
  let cfgFromBitable = null;
  try {
    cfgFromBitable = await fetchAllFromBitable();
    if (cfgFromBitable) writeCacheSync(cfgFromBitable);
  } catch (e) {
    process.stderr.write(`[business_config] Bitable read failed: ${e.message}, falling back to env\n`);
  }
  return flatten(cfgFromBitable, envFallbackKeys);
}

function flatten(richConfig, envFallbackKeys) {
  const out = {};
  for (const k of envFallbackKeys) {
    const fromConfig = richConfig?.[k]?.value;
    out[k] = (fromConfig != null && fromConfig !== "") ? fromConfig : "";
  }
  return out;
}

/**
 * 写：用于 kol_business_config_set 工具
 * @returns {recordId, action: "created"|"updated"}
 */
export async function setBusinessConfig({ key, value, type = "text", notes = "", updatedBy = "agent" }) {
  if (!FEISHU_APP_ID || !APP_TOKEN || !TBL_BUSINESS_CONFIG) {
    throw new Error("business_config Bitable env 没配齐 (KOL_TBL_BUSINESS_CONFIG / FEISHU_APP_ID / KOL_CRM_APP_TOKEN)");
  }
  const tk = await getToken();
  // 找现有 record
  const sr = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TBL_BUSINESS_CONFIG}/records/search?page_size=100`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { conjunction: "and", conditions: [{ field_name: "Key", operator: "is", value: [key] }] } }),
  }).then(r => r.json());
  const exist = sr.data?.items?.[0];
  const fields = { Key: key, Value: value, Type: type, Notes: notes, "Updated At": Date.now(), "Updated By": updatedBy };
  if (exist) {
    const r = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TBL_BUSINESS_CONFIG}/records/${exist.record_id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }).then(r => r.json());
    if (r.code !== 0) throw new Error(`update failed: ${r.msg}`);
    invalidateCache();
    return { recordId: exist.record_id, action: "updated" };
  } else {
    const r = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${TBL_BUSINESS_CONFIG}/records`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }).then(r => r.json());
    if (r.code !== 0) throw new Error(`create failed: ${r.msg}`);
    invalidateCache();
    return { recordId: r.data?.record?.record_id, action: "created" };
  }
}

/**
 * 列全部配置（含 metadata）— 给 kol_business_config_list 用
 */
export async function listBusinessConfig() {
  invalidateCache();
  const all = await fetchAllFromBitable();
  return all || {};
}
