/**
 * auto_status_detector — 通过 tikhub 自动检测达人状态，回写 creators 表
 *
 * 解决"运营手填依赖症"：以下三类状态本来就能从 tikhub 公开数据看出来，
 * 不应该让运营手填——
 *
 *   1. Affiliate Link Status     ← tikhub_user_info bio + linktree HTML 扫 ${BRAND_DOMAIN}/register?ref
 *   2. Teaser Live At            ← tikhub_user_videos 扫最近 20 条，找首条含品牌字串的视频
 *   3. Unboxing Live At          ← 同上，第二条且带 unboxing/haul/try-on 关键词
 *   4. Brand Mentions (count)    ← 最近 20 条视频里有几条提到品牌
 *
 * 由 cron 每 30min（auto_reply_monitor 里）扫 stage 03-08 的 active 达人。
 * 只有 stage 03+ 的才需要这些信号（达人已同意合作开始挂链接 / 发视频）。
 */

import cfg from "./config.mjs";

const TIKHUB_BASE = "https://api.tikhub.io";
// 品牌字串与 affiliate URL 从 config.json 读取
const BRAND = (cfg.our_brand_name || "brand").toLowerCase();
const BRAND_DOMAIN = (cfg.brand_domain || `${BRAND}.com`).toLowerCase();
const BRAND_REGEX = new RegExp(`\\b(${BRAND}|#${BRAND})\\b`, "i");
const AFFIL_REGEX = new RegExp(`${BRAND_DOMAIN.replace(/\./g, "\\.")}\\/register\\?ref=`, "i");
const UNBOXING_KEYWORDS = ["unboxing", "haul", "try on", "try-on", "tryon", "opening", "arrived"];
const TEASER_KEYWORDS = ["teaser", "coming soon", "stay tuned", "preview", "next video"];

async function btToken(env) {
  const r = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then(r => r.json());
  return r.tenant_access_token;
}

async function thFetchVideos(handle, tikhubKey) {
  const u = `${TIKHUB_BASE}/api/v1/tiktok/app/v3/fetch_user_post_videos?unique_id=${encodeURIComponent(handle)}&count=20`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
      const r = await fetch(u, { headers: { Authorization: `Bearer ${tikhubKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) }).then(r => r.json());
      const videos = r?.data?.aweme_list || [];
      const author = videos[0]?.author || {};
      return { videos, author };
    } catch (e) {
      if (attempt === 2) return { videos: [], author: {}, error: e.message };
    }
  }
}

async function fetchBioLinktree(bioUrl) {
  if (!bioUrl) return "";
  if (!/^(linktr\.ee|beacons\.ai|lnk\.bio|bio\.fm)/i.test(bioUrl.replace(/^https?:\/\//, ""))) return "";
  try {
    const r = await fetch(bioUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      redirect: "follow", signal: AbortSignal.timeout(8000),
    });
    return await r.text();
  } catch { return ""; }
}

/**
 * 纯函数：从原始数据里跑检测逻辑。无网络、无副作用，可单测。
 * @param {object} input
 * @param {Array} input.videos    — tikhub aweme_list 数组（每条含 desc / text_extra / create_time）
 * @param {object} input.author   — tikhub author 对象（含 signature / bio_url）
 * @param {string} input.bioHtml  — linktree/beacons 抓回来的 HTML（无则空串）
 * @returns {object} { affiliate_link_status, teaser_live_at, unboxing_live_at, brand_mentions, debug }
 */
export function detectFromData({ videos = [], author = {}, bioHtml = "" } = {}) {
  const bio = author.signature || "";
  const bioUrl = author.bio_url || "";

  // —— 1. Affiliate Link Status ——
  // 优先级：bio 含 affiliate URL > linktree 抓到 affiliate URL > bio/linktree 提及品牌（弱信号）
  let affilStatus = "未挂";
  if (AFFIL_REGEX.test(bio)) affilStatus = "已挂";
  else if (AFFIL_REGEX.test(bioHtml)) affilStatus = "已挂";
  else if (BRAND_REGEX.test(bio) || BRAND_REGEX.test(bioHtml)) affilStatus = "已挂";

  // —— 2. 扫视频找品牌视频，按时间正序 ——
  const sortedAsc = [...videos].sort((a, b) => (a.create_time || 0) - (b.create_time || 0));
  const brandVideos = [];
  for (const v of sortedAsc) {
    const text = ((v.desc || "") + " " + (v.text_extra || []).map(t => t.hashtag_name || "").join(" ")).toLowerCase();
    if (BRAND_REGEX.test(text)) {
      brandVideos.push({
        create_time: v.create_time,
        desc: (v.desc || "").substring(0, 150),
        is_unboxing: UNBOXING_KEYWORDS.some(k => text.includes(k)),
        is_teaser: TEASER_KEYWORDS.some(k => text.includes(k)),
      });
    }
  }

  let teaserAt = null, unboxingAt = null;
  if (brandVideos.length) {
    if (brandVideos[0].is_unboxing) {
      unboxingAt = brandVideos[0].create_time * 1000;
    } else {
      teaserAt = brandVideos[0].create_time * 1000;
    }
    if (brandVideos.length >= 2 && !unboxingAt && brandVideos[1].is_unboxing) {
      unboxingAt = brandVideos[1].create_time * 1000;
    }
  }

  return {
    affiliate_link_status: affilStatus,
    teaser_live_at: teaserAt,
    unboxing_live_at: unboxingAt,
    brand_mentions: brandVideos.length,
    debug: { bio_len: bio.length, bio_url: bioUrl, brand_video_count: brandVideos.length },
  };
}

/**
 * 检测一个达人：拉 tikhub + linktree → 跑 detectFromData。
 * @returns {object} { affiliate_link_status, teaser_live_at?, unboxing_live_at?, brand_mentions, debug }
 */
export async function detectFor(handle, tikhubKey) {
  const { videos, author, error: vErr } = await thFetchVideos(handle, tikhubKey);
  if (vErr || !videos.length) {
    return { error: vErr || "no videos", brand_mentions: 0, affiliate_link_status: null };
  }
  const bioHtml = await fetchBioLinktree(author.bio_url || "");
  return detectFromData({ videos, author, bioHtml });
}

/**
 * 批量扫一组达人（cron 用）。只扫指定 stages，避免无谓 TikHub 配额消耗。
 * @param {Array<{record_id, fields}>} creators  — 已 filter 过的 active 达人
 * @param {object} env  — { FEISHU_APP_ID, FEISHU_APP_SECRET, KOL_CRM_APP_TOKEN, KOL_TBL_CREATORS, TIKHUB_API_KEY }
 * @param {Array<string>} [stages=["03_Agreed","04_ContractSigned","05_TeaserDraftDue","06_PackageShipped","07_PackageDelivered","08_TryOnVideo"]]
 * @returns {Promise<{scanned, updated, errors}>}
 */
export async function detectBatch(creators, env, stages = ["03_Agreed", "04_ContractSigned", "05_TeaserDraftDue", "06_PackageShipped", "07_PackageDelivered", "08_TryOnVideo"]) {
  const stageSet = new Set(stages);
  const tok = await btToken(env);
  let scanned = 0, updated = 0;
  const errors = [];

  for (const c of creators) {
    const stage = c.fields?.["Pipeline Stage"];
    const stageStr = Array.isArray(stage) ? (stage[0]?.text || "") : (stage || "");
    if (!stageSet.has(stageStr)) continue;
    const handle = c.fields?.["username"];
    if (!handle) continue;

    scanned++;
    const r = await detectFor(handle, env.TIKHUB_API_KEY);
    if (r.error) { errors.push(`${handle}: ${r.error}`); continue; }

    // 只更新有变化的字段（避免全表 PUT 噪音）
    const fieldsToUpdate = {};
    const cur = c.fields || {};

    if (r.affiliate_link_status && cur["Affiliate Link Status"] !== r.affiliate_link_status) {
      fieldsToUpdate["Affiliate Link Status"] = r.affiliate_link_status;
    }
    if (r.teaser_live_at && !cur["Teaser Live At"]) {
      fieldsToUpdate["Teaser Live At"] = r.teaser_live_at;
    }
    if (r.unboxing_live_at && !cur["Unboxing Live At"]) {
      fieldsToUpdate["Unboxing Live At"] = r.unboxing_live_at;
    }
    if (r.brand_mentions !== cur["Brand Mentions"]) {
      fieldsToUpdate["Brand Mentions"] = r.brand_mentions;
    }

    if (Object.keys(fieldsToUpdate).length === 0) continue;

    const upR = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.KOL_CRM_APP_TOKEN}/tables/${env.KOL_TBL_CREATORS}/records/${c.record_id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: fieldsToUpdate }),
      }
    ).then(r => r.json());
    if (upR?.code === 0) {
      updated++;
      process.stderr.write(`  [auto-detect] @${handle} ${stageStr} → ${JSON.stringify(fieldsToUpdate)}\n`);
    } else {
      errors.push(`${handle}: PUT failed ${upR?.msg}`);
    }

    await new Promise(r => setTimeout(r, 600)); // TikHub 限速
  }

  return { scanned, updated, errors };
}
