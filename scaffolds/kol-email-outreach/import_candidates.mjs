/**
 * 导入 CSV 候选达人到 CRM：
 * - 新达人：批量创建，Pipeline Stage = 00_Discovered
 * - 已存在达人（00_Discovered 阶段）：补充缺失字段（email、bio 等）
 * - 已在流程中的达人（01+）：只补 email（如缺失）
 */
import { createReadStream } from "fs";
import { createInterface } from "readline";
import cfg from "./lib/config.mjs";
import { btListRecords, btCreateRecord, btUpdateRecord } from "./lib/kol_crm.mjs";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    const rl = createInterface({ input: createReadStream(filePath) });
    let buf = "";
    rl.on("line", raw => {
      // 简单 CSV 解析（字段可含换行的 bio 用 buf 处理）
      buf += (buf ? "\n" : "") + raw;
      const fields = [];
      let cur = "", inQ = false;
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i];
        if (c === '"') { inQ = !inQ; }
        else if (c === "," && !inQ) { fields.push(cur); cur = ""; }
        else cur += c;
      }
      if (inQ) return; // 引号未闭合，等下一行
      fields.push(cur);
      buf = "";
      if (!headers) {
        headers = fields.map(h => h.replace(/^\uFEFF/, "").trim());
      } else {
        const row = {};
        headers.forEach((h, i) => row[h] = (fields[i] || "").trim());
        rows.push(row);
      }
    });
    rl.on("close", () => resolve(rows));
    rl.on("error", reject);
  });
}

// CSV 列 → CRM 字段映射
// 数值字段传 number 类型，文本字段传 string
function csvToFields(row, stage) {
  const num = (v) => {
    const s = (v || "").toString().replace(/,/g, "");
    const f = parseFloat(s);
    return isNaN(f) ? null : f;
  };
  const str = (v) => (v || "").trim();

  const fields = {
    "username":                    str(row.username),
    "Pipeline Stage":              stage,
    "rank":                        num(row.rank),
    "final_score":                 num(row.final_score),
    "primary_category":            str(row.primary_category),
    "followers":                   num(row.followers),
    "avg_views":                   str(row.avg_views),
    "median_views":                str(row.median_views),
    "viral_rate":                  num(row.viral_rate),
    "max_views":                   num(row.max_views),
    "view_follower_ratio":         num(row.view_follower_ratio),
    "avg_engagement_rate":         num(row.avg_engagement_rate),
    "avg_comment_rate":            num(row.avg_comment_rate),
    "has_haul_content":            num(row.has_haul_content),
    "shopping_vocabulary_density": num(row.shopping_vocabulary_density),
    "cta_ratio":                   num(row.cta_ratio),
    "has_china_shopping":          num(row.has_china_shopping),
    "ai_relevance_score":          num(row.ai_relevance_score),
    "ai_reasoning":                str(row.ai_reasoning),
    "western_ratio":               num(row.western_ratio),
    "fake_score":                  str(row.fake_score),
    "trust_score":                 str(row.trust_score),
    "days_since_last_post":        num(row.days_since_last_post),
    "avg_duration":                num(row.avg_duration),
    "bio_has_contact":             num(row.bio_has_contact),
    "collab_signal":               num(row.collab_signal),
    "content_vertical_score":      num(row.content_vertical_score),
    "bio":                         str(row.bio),
    "country":                     str(row.country),
    "profile_url":                 str(row.profile_url) ? { link: str(row.profile_url), text: str(row.profile_url) } : null,
    "email":                       str(row.email),
  };
  // 去掉 null / 空字符串
  return Object.fromEntries(Object.entries(fields).filter(([,v]) => v !== null && v !== ""));
}

async function main() {
  const CSV_PATH = "/home/ubuntu/.cc-connect/attachments/joyagoo_candidates_with_email.csv";
  console.log("读取 CSV...");
  const rows = await parseCSV(CSV_PATH);
  console.log(`CSV 行数: ${rows.length}`);

  // 加载 CRM 现有达人（handle → {record_id, stage, hasEmail}）
  console.log("加载 CRM 现有达人...");
  const existing = new Map(); // handle → {record_id, stage, email}
  let pt = "";
  do {
    const { items, pageToken } = await btListRecords(cfg.kol_tbl_creators, {
      pageSize: 500, fieldNames: ["username", "Pipeline Stage", "email"],
      ...(pt ? { pageToken: pt } : {})
    });
    for (const it of items) {
      let h = it.fields?.["username"];
      if (Array.isArray(h)) h = h.map(x => x.text || x).join("");
      if (!h) continue;
      existing.set(h.toLowerCase(), {
        record_id: it.record_id,
        stage: it.fields?.["Pipeline Stage"] || "",
        email: typeof it.fields?.["email"] === "string" ? it.fields["email"] : "",
      });
    }
    pt = pageToken || "";
  } while (pt);
  console.log(`CRM 现有达人: ${existing.size}`);

  const toCreate = [];
  const toUpdate = []; // {record_id, fields, handle, reason}

  for (const row of rows) {
    const handle = (row.username || "").toLowerCase();
    if (!handle) continue;

    if (!existing.has(handle)) {
      // 新达人 → 创建
      toCreate.push(row);
    } else {
      const rec = existing.get(handle);
      const updateFields = {};

      // 补 email（所有阶段都补）
      if (!rec.email && row.email) updateFields["email"] = row.email;

      // 00_Discovered 阶段：补充其他缺失信息
      if (rec.stage === "00_Discovered") {
        const fieldsToFill = ["bio", "primary_category", "followers", "avg_views",
          "final_score", "ai_relevance_score", "ai_reasoning", "country",
          "profile_url", "trust_score", "fake_score", "western_ratio",
          "content_vertical_score", "collab_signal", "bio_has_contact"];
        // 只在字段真的为空时补充（这里简单做：任何更新都尝试写入最新数据）
        const fresh = csvToFields(row, rec.stage);
        for (const f of fieldsToFill) {
          if (fresh[f]) updateFields[f] = fresh[f];
        }
      }

      if (Object.keys(updateFields).length > 0) {
        toUpdate.push({ record_id: rec.record_id, fields: updateFields, handle });
      }
    }
  }

  console.log(`\n新达人: ${toCreate.length} | 需更新: ${toUpdate.length} | 无变化: ${rows.length - toCreate.length - toUpdate.length}`);

  // ── 批量创建新达人（每批 200 条）──────────────────────────────────────
  if (toCreate.length) {
    console.log(`\n批量创建 ${toCreate.length} 个新达人...`);
    let created = 0, failed = 0;
    for (let i = 0; i < toCreate.length; i++) {
      const row = toCreate[i];
      try {
        const fields = csvToFields(row, "00_Discovered");
        await btCreateRecord(cfg.kol_tbl_creators, fields);
        created++;
        if (created % 20 === 0) console.log(`  创建进度: ${created}/${toCreate.length}`);
      } catch (e) {
        failed++;
        console.log(`  创建失败 @${row.username}: ${e.message?.substring(0, 60)}`);
      }
      await sleep(300); // 限速
    }
    console.log(`创建完成: ${created} 成功, ${failed} 失败`);
  }

  // ── 更新已有达人缺失字段 ──────────────────────────────────────────────
  if (toUpdate.length) {
    console.log(`\n更新 ${toUpdate.length} 个已有达人...`);
    let updated = 0, failed = 0;
    for (const { record_id, fields, handle } of toUpdate) {
      try {
        await btUpdateRecord(cfg.kol_tbl_creators, record_id, fields);
        updated++;
        const keys = Object.keys(fields).join(", ");
        console.log(`  @${handle}: 补充 [${keys}]`);
      } catch (e) {
        failed++;
        console.log(`  更新失败 @${handle}: ${e.message?.substring(0, 60)}`);
      }
      await sleep(300);
    }
    console.log(`更新完成: ${updated} 成功, ${failed} 失败`);
  }

  console.log("\n✅ 导入完成");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
