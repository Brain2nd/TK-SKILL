const MAX_ROWS = 1000;

function text(value) {
  return String(value ?? "").trim();
}

function first(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && text(value) !== "") return value;
  }
  return "";
}

function numberValue(value) {
  const input = text(value).replaceAll(",", "").toLowerCase();
  const percentage = input.endsWith("%");
  const raw = percentage ? input.slice(0, -1).trim() : input;
  if (!raw) return 0;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)\s*([kmb])?$/);
  if (!match) return Number.isFinite(Number(raw)) ? Number(raw) : 0;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
  const result = Number(match[1]) * multiplier;
  return percentage ? result / 100 : result;
}

function listValue(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => typeof item === "string" ? text(item) : text(item?.name || item?.title || item?.label)).filter(Boolean);
  } catch {}
  return raw.split(/[;,|]/).map(text).filter(Boolean);
}

function objectList(value) {
  if (Array.isArray(value)) return value;
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return raw.split(/[;|]/).map((title, index) => ({ id: `video-${index + 1}`, title: text(title) })).filter((item) => item.title);
  }
}

function normalizeEvidence(row) {
  const raw = objectList(first(row, ["recent_videos", "videos", "content_evidence", "evidence"]));
  const titles = listValue(first(row, ["recent_video_titles", "video_titles", "top_video_titles"]));
  const combined = raw.length ? raw : titles.map((title, index) => ({ id: `video-${index + 1}`, title }));
  const fallbackTitle = text(first(row, ["latest_video_title", "recent_video_1", "content_sample"]));
  if (!combined.length && fallbackTitle) combined.push({ id: "video-1", title: fallbackTitle });
  return combined.slice(0, 20).map((item, index) => {
    const value = typeof item === "string" ? { title: item } : item || {};
    return {
      id: text(value.id || value.video_id || value.aweme_id || `video-${index + 1}`).slice(0, 120),
      title: text(value.title || value.desc || value.description || value.caption).replace(/[\r\n]+/g, " ").slice(0, 300),
      url: text(value.url || value.video_url || value.share_url).slice(0, 500),
      views: Math.max(0, Math.round(numberValue(value.views || value.play_count))),
      published_at: text(value.published_at || value.create_time || value.date).slice(0, 40),
    };
  }).filter((item) => item.title || item.url);
}

function handleFrom(row) {
  const direct = text(first(row, ["username", "handle", "unique_id", "uniqueId", "author_unique_id"])).replace(/^@/, "");
  if (direct) return direct;
  const profileUrl = text(first(row, ["profile_url", "homepage", "profile", "url"]));
  const match = profileUrl.match(/(?:tiktok\.com\/@|instagram\.com\/|youtube\.com\/@)([^/?#]+)/i);
  return text(match?.[1]).replace(/^@/, "");
}

function normalizeEmail(value) {
  const email = text(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : "";
}

function normalizePlatform(value) {
  const platform = text(value).toLowerCase();
  if (["ig", "instagram"].includes(platform)) return "instagram";
  if (["yt", "ytb", "youtube"].includes(platform)) return "youtube";
  return "tiktok";
}

function normalizeRow(row, index, source) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("不是有效的达人记录");
  const platform = normalizePlatform(first(row, ["platform", "source_platform"]));
  const handle = handleFrom(row).toLowerCase();
  if (!/^[a-z0-9._-]{2,80}$/i.test(handle)) throw new Error("缺少有效的达人账号 ID");
  const email = normalizeEmail(first(row, ["email", "contact_email", "business_email", "public_email"]));
  if (!email) throw new Error("缺少有效的联系邮箱");
  const externalId = text(first(row, ["candidate_id", "creator_id", "stable_id", "sec_uid", "id"]));
  const id = (externalId || `${platform}:${handle}`).replace(/[\r\n\t]/g, "").slice(0, 180);
  const traits = [...new Set([
    ...listValue(first(row, ["personalization_traits", "traits", "tags", "labels"])),
    ...listValue(first(row, ["category", "categories", "content_category"])),
  ])].slice(0, 30);
  const evidence = normalizeEvidence(row);
  const bio = text(first(row, ["bio", "signature", "description", "profile_bio"])).replace(/[\r\n]+/g, " ").slice(0, 1000);
  const warnings = listValue(first(row, ["review_warnings", "warnings", "risk_flags"]));
  if (!bio && !traits.length && !evidence.length) warnings.push("missing_public_content_evidence");
  return {
    id,
    platform,
    handle,
    display_name: text(first(row, ["display_name", "nickname", "name"]) || `@${handle}`).slice(0, 160),
    profile_url: text(first(row, ["profile_url", "homepage", "profile", "url"]) || (
      platform === "tiktok" ? `https://www.tiktok.com/@${handle}` : ""
    )).slice(0, 500),
    contact_email: email,
    country: text(first(row, ["country", "region", "market"])).toUpperCase().slice(0, 60),
    city: text(first(row, ["city", "location"])).slice(0, 100),
    followers: Math.max(0, Math.round(numberValue(first(row, ["followers", "follower_count", "fans"])) || 0)),
    avg_views: Math.max(0, Math.round(numberValue(first(row, ["avg_views", "avg_views_10", "video_avg_views", "average_views"])) || 0)),
    engagement_rate: Math.max(0, numberValue(first(row, ["engagement_rate", "engagement", "er"])) || 0),
    traits,
    review_warnings: [...new Set(warnings)].slice(0, 30),
    bio,
    default_hook: text(first(row, ["personalized_hook", "default_hook", "outreach_hook"])).replace(/[\r\n]+/g, " ").slice(0, 240),
    evidence,
    source: text(first(row, ["source", "data_source"]) || source || "manual_import").slice(0, 100),
    source_updated_at: text(first(row, ["source_updated_at", "updated_at", "collected_at"]) || new Date().toISOString()).slice(0, 40),
    row_number: index + 1,
  };
}

export function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(input || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new Error("CSV 引号没有闭合");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const nonEmpty = rows.filter((values) => values.some((value) => text(value)));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((value) => text(value));
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) throw new Error("CSV 表头为空或重复");
  return nonEmpty.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function parseCandidateDocument(document, filename = "candidates.json") {
  const input = String(document || "").trim();
  if (!input) throw new Error("达人文件为空");
  if (input.length > 5_000_000) throw new Error("达人文件不能超过 5 MB");
  const lower = String(filename || "").toLowerCase();
  let rows;
  if (lower.endsWith(".csv") || (!input.startsWith("[") && !input.startsWith("{") && input.split("\n", 1)[0].includes(","))) {
    rows = parseCsv(input);
  } else {
    try {
      const parsed = JSON.parse(input);
      rows = Array.isArray(parsed) ? parsed : parsed.rows || parsed.creators || parsed.candidates || parsed.results || parsed.data || parsed.items || (
        parsed && typeof parsed === "object" && (parsed.username || parsed.handle || parsed.profile_url) ? [parsed] : undefined
      );
    } catch {
      rows = input.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
        try { return JSON.parse(line); }
        catch { throw new Error(`JSONL 第 ${index + 1} 行无法解析`); }
      });
    }
  }
  if (!Array.isArray(rows)) throw new Error("文件中没有找到达人列表");
  if (!rows.length) throw new Error("文件中没有达人记录");
  if (rows.length > MAX_ROWS) throw new Error(`单次最多导入 ${MAX_ROWS.toLocaleString("en-US")} 位达人`);
  return rows;
}

export function normalizeCreatorRows(rows, options = {}) {
  const accepted = [];
  const rejected = [];
  const seenIds = new Set();
  const seenAccounts = new Set();
  const seenEmails = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    try {
      const creator = normalizeRow(rows[index], index, options.source);
      const accountKey = `${creator.platform}:${creator.handle}`;
      if (seenIds.has(creator.id) || seenAccounts.has(accountKey)) throw new Error("文件内达人账号重复");
      if (seenEmails.has(creator.contact_email)) throw new Error("文件内联系邮箱重复");
      seenIds.add(creator.id); seenAccounts.add(accountKey); seenEmails.add(creator.contact_email);
      accepted.push(creator);
    } catch (error) {
      rejected.push({ row_number: index + 1, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { contract_version: "outreach-candidate.v1", accepted, rejected, total: rows.length };
}
