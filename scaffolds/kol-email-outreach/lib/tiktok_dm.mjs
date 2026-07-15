/**
 * tiktok_dm — TikTok DM send/receive via Chrome DevTools Protocol (plain module, no MCP)
 */
import cfg from "./config.mjs";

const CDP_PORT = cfg.cdp_port || 18800;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function cdpConnect() {
  const CDP = `http://127.0.0.1:${CDP_PORT}`;

  let targets;
  try {
    targets = await (await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(3000) })).json();
  } catch {
    throw new Error("Browser not running (CDP not reachable)");
  }

  let tab = targets.find(t => t.url?.includes("tiktok.com") && t.type === "page");

  if (!tab) {
    let newTabRes = await fetch(`${CDP}/json/new?url=about:blank`, { method: "PUT" });
    if (!newTabRes.ok) newTabRes = await fetch(`${CDP}/json/new?url=about:blank`);
    const newTab = await newTabRes.json();
    if (!newTab?.webSocketDebuggerUrl) throw new Error("Failed to create new tab");

    const tmpWs = new WebSocket(newTab.webSocketDebuggerUrl);
    await new Promise((ok, fail) => {
      tmpWs.onopen = ok; tmpWs.onerror = fail;
      setTimeout(() => fail(new Error("ws")), 8000);
    });
    let tmpId = 0; const tmpPending = new Map();
    tmpWs.onmessage = e => {
      const m = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
      if (m.id != null && tmpPending.has(m.id)) { tmpPending.get(m.id).resolve(m.result); tmpPending.delete(m.id); }
    };
    const tmpCdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++tmpId; tmpPending.set(id, { resolve, reject });
      tmpWs.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (tmpPending.has(id)) { tmpPending.delete(id); reject(new Error("timeout")); } }, 30000);
    });

    await tmpCdp("Page.enable");
    await tmpCdp("Page.navigate", { url: "https://www.tiktok.com/foryou" });
    tmpWs.close();

    for (let wait = 0; wait < 6; wait++) {
      await sleep(5000);
      targets = await (await fetch(`${CDP}/json`)).json();
      tab = targets.find(t => t.url?.includes("tiktok.com") && t.type === "page");
      if (tab) break;
    }
    if (!tab) throw new Error("TikTok tab failed to load after 30s");
  }

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok; ws.onerror = fail;
    setTimeout(() => fail(new Error("ws timeout")), 8000);
  });

  let cmdId = 0;
  const pending = new Map();
  ws.onmessage = e => {
    const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++cmdId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("cdp timeout: " + method)); }
    }, 30000);
  });
  const ev = expr => cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
  return { ws, cdp, ev, close: () => ws.close() };
}

/**
 * Send a TikTok DM via CDP browser automation.
 * @param {object} opts
 * @param {string} opts.username - TikTok username (without @)
 * @param {string} opts.message - Message text to send
 * @returns {Promise<{success: boolean, username: string, message: string}>}
 */
export async function sendDM({ username, message }) {
  const c = await cdpConnect();
  try {
    await c.cdp("Page.navigate", { url: `https://www.tiktok.com/@${username}` });
    await sleep(6000);
    const title = await c.ev("document.title");
    if (!title.result?.value?.toLowerCase().includes(username.toLowerCase())) {
      throw new Error("Profile not loaded: " + title.result?.value);
    }

    // Capture display name from profile page
    const nickRes = await c.ev(
      `(document.querySelector('[data-e2e="user-title"]') || document.querySelector('h1[data-e2e="user-subtitle"]') || document.querySelector('h1'))?.innerText?.trim() || ""`
    );
    const displayName = nickRes.result?.value || "";

    const clicked = await c.ev(
      `(()=>{ const b = document.querySelector('[data-e2e="message-button"]'); if(b){b.click();return true} return false })()`
    );
    if (!clicked.result?.value) throw new Error("message-button not found on profile");

    let chatReady = false;
    for (let i = 0; i < 5; i++) {
      await sleep(4000);
      const check = await c.ev(
        `(()=>{ const el = document.querySelector('[contenteditable="true"]'); return el && el.offsetParent !== null && el.getBoundingClientRect().height > 0; })()`
      );
      if (check.result?.value) { chatReady = true; break; }
      await c.cdp("Page.navigate", { url: `https://www.tiktok.com/@${username}` });
      await sleep(5000);
      await c.ev(`(()=>{const b=document.querySelector('[data-e2e="message-button"]');if(b)b.click()})()`);
    }
    if (!chatReady) throw new Error("Chat input never loaded after 5 retries");

    const box = await c.ev(
      `(()=>{ const el = document.querySelector('[contenteditable="true"]'); const r = el.getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`
    );
    const { x, y } = box.result.value;
    await c.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await c.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(300);

    await c.cdp("Input.insertText", { text: message });
    await sleep(500);
    const typed = await c.ev(`(document.querySelector('[contenteditable="true"]')?.innerText || '').trim()`);
    if (!typed.result?.value) throw new Error("Text not entered into input");

    await c.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await c.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(1500);

    const cleared = await c.ev(`(document.querySelector('[contenteditable="true"]')?.innerText || '').trim() === ''`);
    if (!cleared.result?.value) throw new Error("Input not cleared after Enter — message may not have sent");

    const urlRes = await c.ev("document.URL");
    const profileUrl = urlRes.result?.value || `https://www.tiktok.com/@${username}`;

    return { success: true, username, message, displayName, profileUrl };
  } finally {
    c.close();
  }
}

/**
 * Check TikTok DM replies for a list of creators.
 * @param {Array<string|{handle:string,nickname?:string}>} watchList - handles or {handle, nickname} objects
 * @returns {Promise<{conversations: number, replies: Array<{handle, displayName, preview, date}>}>}
 */
export async function checkReplies(watchList) {
  const c = await cdpConnect();
  try {
    await c.cdp("Page.navigate", { url: "https://www.tiktok.com/messages" });
    await sleep(6000);

    const pageText = await c.ev(`document.body?.innerText`);
    const text = pageText.result?.value || "";

    // Matches: "5/6/2026", "10:30 AM", "9:45 PM", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Yesterday"
    const dateRe = /^(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2}\s*[AP]M|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Yesterday)$/i;
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const convos = [];
    for (let i = 0; i < lines.length; i++) {
      if (dateRe.test(lines[i]) && i >= 2) {
        const date = lines[i];
        const preview = lines[i - 1] || "";
        const name = lines[i - 2] || "";
        if (["For You", "Shop", "Explore", "Following", "Friends", "LIVE", "Messages", "Activity", "Upload", "Profile", "More"].includes(name)) continue;
        convos.push({ displayName: name, preview, date });
      }
    }

    // Normalize watchList to [{handle, nickname}]
    const watchEntries = watchList.map(e =>
      typeof e === "string" ? { handle: e.toLowerCase(), nickname: "" } : { handle: e.handle.toLowerCase(), nickname: (e.nickname || "").trim() }
    );
    const watchSet = new Set(watchEntries.map(e => e.handle));
    // nickname → handle map (exact, for stored nicknames)
    const nicknameToHandle = {};
    for (const e of watchEntries) {
      if (e.nickname) nicknameToHandle[e.nickname.toLowerCase()] = e.handle;
    }

    const brandName = cfg.our_brand_name || cfg.your_brand || "brand";
    const ourPattern = new RegExp(`^Hi (.+?)! I'm .+ from ${brandName}`, "i");

    const nameToHandle = {};
    for (const conv of convos) {
      // Strategy 0: exact stored nickname match (most reliable)
      const dnLow = conv.displayName.toLowerCase();
      if (nicknameToHandle[dnLow]) { nameToHandle[conv.displayName] = nicknameToHandle[dnLow]; continue; }

      // Strategy 1: our outreach message pattern in preview
      const m = ourPattern.exec(conv.preview);
      if (m) {
        const handle = m[1].toLowerCase();
        if (watchSet.has(handle)) { nameToHandle[conv.displayName] = handle; continue; }
      }
      // Strategy 2: handle substring in preview
      const previewLower = conv.preview.toLowerCase();
      let matched = false;
      for (const h of watchSet) {
        if (previewLower.includes(h)) { nameToHandle[conv.displayName] = h; matched = true; break; }
      }
      if (matched) continue;
      // Strategy 3: fuzzy — strip emojis/punctuation, prefix overlap
      const dnClean = conv.displayName.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const h of watchSet) {
        const hClean = h.replace(/[^a-z0-9]/g, "");
        if (dnClean === hClean) { nameToHandle[conv.displayName] = h; break; }
        if (hClean.length > 5 && dnClean.includes(hClean)) { nameToHandle[conv.displayName] = h; break; }
        if (dnClean.length > 5 && hClean.includes(dnClean)) { nameToHandle[conv.displayName] = h; break; }
        const prefix = hClean.substring(0, 6);
        if (prefix.length >= 6 && dnClean.includes(prefix)) { nameToHandle[conv.displayName] = h; break; }
      }
    }

    const replies = [];
    for (const conv of convos) {
      const isOurMsg = ourPattern.test(conv.preview);
      if (isOurMsg) continue;
      const handle = nameToHandle[conv.displayName];
      if (handle) {
        replies.push({ handle, displayName: conv.displayName, preview: conv.preview, date: conv.date });
      }
    }

    return { conversations: convos.length, replies };
  } finally {
    c.close();
  }
}
