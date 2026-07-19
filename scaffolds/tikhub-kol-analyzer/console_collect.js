// === FastMoss ES Creator Collector v6 — localStorage resume ===
// 1. Open: https://www.fastmoss.com/zh/influencer/search?region=ES&follower=0,9999&shop_window=1&contact=3
// 2. Ensure logged in, results visible, NO captcha
// 3. Paste in Console, Enter

(async () => {
  const MAX_FOLLOWERS = 10000;
  const STORAGE_KEY = 'fm_collector_state';
  let state = { results: [], seen: [], pg: 1 };
  let capturedData = [];

  // Try resume from localStorage
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      state.results = parsed.results || [];
      state.seen = new Set(parsed.seen || []);
      state.pg = parsed.pg || 1;
      console.log('%c Resumed: ' + state.results.length + ' candidates, starting pg=' + state.pg, 'color:orange');
    }
  } catch(e) {}

  const seen = state.seen instanceof Set ? state.seen : new Set(state.seen || []);
  const results = state.results || [];
  let startPg = state.pg || 1;

  function saveState(pg) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        results: results,
        seen: Array.from(seen),
        pg: pg
      }));
    } catch(e) {}
  }

  // --- Intercept both fetch and XHR ---
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const resp = await origFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    if (url.includes('/api/author/search')) {
      try {
        const clone = resp.clone();
        const data = await clone.json();
        if (data.code === 200) capturedData.push(data);
      } catch(e) {}
    }
    return resp;
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    return origXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    const xhr = this;
    if (xhr._url && xhr._url.includes('/api/author/search')) {
      xhr.addEventListener('load', () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.code === 200) capturedData.push(data);
        } catch(e) {}
      });
    }
    return origXHRSend.apply(this, arguments);
  };

  console.log('%c Interceptors active', 'color:green');

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function drainResults() {
    let added = 0;
    while (capturedData.length) {
      const data = capturedData.shift();
      const authors = (data.data && data.data.author_list) || [];
      for (const a of authors) {
        const uid = a.unique_id || String(a.uid);
        if (seen.has(uid)) continue;
        seen.add(uid);
        if (a.is_ecommerce === 1 && (a.contact||[]).some(c=>c.code===3) && a.follower_count < MAX_FOLLOWERS && (a.sale_28d_count||0) < 50) {
          results.push(a); added++;
        }
      }
    }
    return added;
  }

  // --- Find Next.js router ---
  let router = window.__NEXT_ROUTER__;
  if (!router) {
    const nextRoot = document.getElementById('__next');
    if (nextRoot) {
      const fiberKey = Object.keys(nextRoot).find(k => k.startsWith('__reactFiber'));
      if (fiberKey) {
        let fiber = nextRoot[fiberKey];
        while (fiber) {
          try {
            if (fiber.memoizedState && fiber.memoizedState.queue && fiber.memoizedState.queue.last) {
              let cursor = fiber;
              for (let depth = 0; depth < 20; depth++) {
                if (cursor.queue && cursor.queue.last && cursor.queue.last.value) {
                  const ctx = cursor.queue.last.value;
                  if (ctx && ctx.router && typeof ctx.router.push === 'function') {
                    router = ctx.router;
                    break;
                  }
                }
                cursor = cursor.return || cursor.child;
                if (!cursor) break;
              }
            }
            if (router) break;
          } catch(e) {}
          fiber = fiber.return || fiber.sibling || fiber.child;
          if (!fiber) break;
        }
      }
    }
  }

  console.log('Router found:', !!router);

  function goToPage(pg) {
    if (router && typeof router.push === 'function') {
      const params = new URLSearchParams(window.location.search);
      params.set('page', String(pg));
      router.push(window.location.pathname + '?' + params.toString());
    } else {
      const url = new URL(window.location);
      url.searchParams.set('page', String(pg));
      window.history.pushState({}, '', url.toString());
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  // Only navigate to page 1 on fresh start
  if (startPg === 1) {
    goToPage(1);
    await sleep(2500);
    drainResults();
    console.log('Page 1: total=' + results.length);
    if (results.length === 0) {
      goToPage(2);
      await sleep(3000);
      drainResults();
      console.log('Page 2 attempt: total=' + results.length);
      if (results.length === 0) {
        console.warn('No data. Check URL or manually click a filter, then re-run.');
        window.fetch = origFetch;
        XMLHttpRequest.prototype.open = origXHROpen;
        XMLHttpRequest.prototype.send = origXHRSend;
        return;
      }
    }
    startPg = 2;
  }

  // --- Paginate ---
  let pg = startPg, staleCount = 0;
  while (pg <= 300 && staleCount < 6) {
    goToPage(pg);
    await sleep(2500 + Math.random() * 2000);
    const added = drainResults();
    console.log('p' + pg + ': +' + added + ' | total=' + results.length);
    staleCount = added === 0 ? staleCount + 1 : 0;
    saveState(pg + 1);
    pg++;
  }

  // Cleanup
  window.fetch = origFetch;
  XMLHttpRequest.prototype.open = origXHROpen;
  XMLHttpRequest.prototype.send = origXHRSend;
  localStorage.removeItem(STORAGE_KEY);

  console.log('\nDone: ' + results.length + ' candidates');

  // --- Download CSV ---
  const fields = ["unique_id","nickname","uid","region","follower_count",
    "is_ecommerce","sale_28d_count","sale_28d_amount",
    "video_90d_sale_gmv_amount","live_90d_sale_gmv_amount",
    "interact_rate","avg_28d_play_count","aweme_28d_count",
    "contact_names","profile_url"];
  let csv = '﻿' + fields.join(",") + "\n";
  for (const a of results) {
    csv += fields.map(f => {
      let v = "";
      if (f === "contact_names") v = (a.contact||[]).map(c=>c.name||"").join("|");
      else if (f === "profile_url") v = "https://www.tiktok.com/@" + (a.unique_id||"");
      else v = String(a[f]??"").replace(/,/g, " ");
      return v.includes(",") || v.includes('"') ? '"' + v.replace(/"/g,'""') + '"' : v;
    }).join(",") + "\n";
  }
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "fastmoss_es_candidates.csv"; a.click();
  console.log('%c Downloaded (' + results.length + ' rows)', 'color:green;font-weight:bold');
  window.__candidates = results;
})();
