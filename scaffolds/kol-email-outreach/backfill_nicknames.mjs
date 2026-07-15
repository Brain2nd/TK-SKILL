/**
 * 回填 tiktok_nickname：访问每个 DM 达人的 TikTok 主页，抓 display name 存回 CRM
 */
import cfg from "./lib/config.mjs";
import { btListRecords, btUpdateRecord } from "./lib/kol_crm.mjs";

const CDP_PORT = cfg.cdp_port || 18800;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchDmCreators() {
  const fieldNames = ["username", "email", "Pipeline Stage", "tiktok_nickname"];
  let pt = "", results = [];
  do {
    const { items, pageToken } = await btListRecords(cfg.kol_tbl_creators, {
      pageSize: 500, fieldNames, ...(pt ? { pageToken: pt } : {}),
    });
    for (const it of items) {
      const f = it.fields || {};
      const stage = f["Pipeline Stage"];
      if (!stage || ["00_Discovered", "XX_Dropped", "09_Completed"].includes(stage)) continue;
      const email = typeof f["email"] === "string" ? f["email"] : "";
      if (email.includes("@")) continue;
      let h = f["username"];
      if (Array.isArray(h)) h = h.map(x => x.text || x).join("");
      if (!h || h.length < 3) continue;
      const nick = typeof f["tiktok_nickname"] === "string" ? f["tiktok_nickname"] : "";
      if (nick) continue;
      results.push({ handle: h, record_id: it.record_id });
    }
    pt = pageToken || "";
  } while (pt);
  return results;
}

async function cdpConnect() {
  const CDP = `http://127.0.0.1:${CDP_PORT}`;
  const targets = await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  const tab = targets.find(t => t.url?.includes("tiktok.com") && t.type === "page");
  if (!tab) throw new Error("No TikTok tab found");

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; setTimeout(() => fail(new Error("ws timeout")), 8000); });
  let cmdId = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++cmdId; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("cdp timeout: " + method)); } }, 30000);
  });
  const ev = expr => cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
  return { cdp, ev, close: () => ws.close() };
}

async function fetchDisplayName(c, handle) {
  await c.cdp("Page.navigate", { url: `https://www.tiktok.com/@${handle}` });
  await sleep(5000);
  const nick = await c.ev(
    `(document.querySelector('[data-e2e="user-title"]') || document.querySelector('h1[data-e2e="user-subtitle"]') || document.querySelector('h1'))?.innerText?.trim() || ""`
  );
  return nick.result?.value || "";
}

async function main() {
  const creators = await fetchDmCreators();
  console.log(`需要回填 ${creators.length} 个达人`);
  if (!creators.length) { console.log("全部已填，无需操作"); return; }

  const c = await cdpConnect();
  try {
    for (let i = 0; i < creators.length; i++) {
      const { handle, record_id } = creators[i];
      try {
        const nickname = await fetchDisplayName(c, handle);
        if (nickname) {
          await btUpdateRecord(cfg.kol_tbl_creators, record_id, { "tiktok_nickname": nickname });
          console.log(`[${i+1}/${creators.length}] @${handle} → "${nickname}" ✅`);
        } else {
          console.log(`[${i+1}/${creators.length}] @${handle} → nickname 未抓到 ⏭️`);
        }
      } catch (e) {
        console.log(`[${i+1}/${creators.length}] @${handle} ❌ ${e.message}`);
      }
      await sleep(2000);
    }
  } finally {
    c.close();
  }
  console.log("回填完成");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
