#!/usr/bin/env python3
"""Email open tracking + click tracking server.

Critical fix: Gmail/Apple/Outlook all proxy-prefetch images at delivery.
A pixel GET from these proxies = delivered, NOT opened.
Classify events by User-Agent; only count real opens as engagement.
Click tracking provides true engagement (requires actual click-through).
"""
import http.server, json, os, re, time
from urllib.parse import urlparse, parse_qs, unquote

LOG_FILE = os.environ.get("TRACK_LOG", "/home/ec2-user/email_tracking.log")
PORT = int(os.environ.get("TRACK_PORT", "18791"))
GIF_1PX = bytes.fromhex("47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b")

# These UAs indicate email-client proxy prefetching (NOT real opens)
PROXY_PATTERNS = [
    r"GoogleImageProxy", r"ggpht\.com",           # Gmail
    r"YahooMailProxy",                            # Yahoo
    r"bingbot", r"Outlook-iOS",                   # Outlook
    r"Apple-Mail",                                # Apple Mail (often pre-caches)
    r"CloudFront", r"FeedFetcher", r"curl",       # Various bots
]
PROXY_RE = re.compile("|".join(PROXY_PATTERNS), re.IGNORECASE)

def classify(ua, template, creator, email_ts, now_ts):
    """Classify event as prefetch or open.
    - Non-proxy UA always = open (real browser)
    - Proxy UA:
        * First hit within 120s of delivery = prefetch (Gmail cache-warming)
        * Any later hit OR 2nd+ hit OR hit well after delivery = open
          (Gmail re-fetches images when user actually views the email
           because we set no-cache headers)
    """
    is_proxy = (not ua) or len(ua) < 20 or PROXY_RE.search(ua)
    if not is_proxy:
        return "open"

    # Count prior hits for same (template, creator) and find earliest
    prior_count = 0
    earliest_prior = None
    try:
        with open(LOG_FILE) as f:
            for line in f:
                try: e = json.loads(line)
                except: continue
                if e.get("event") != "pixel": continue
                if e.get("template") == template and e.get("creator") == creator:
                    prior_count += 1
                    if earliest_prior is None or e.get("ts", 0) < earliest_prior:
                        earliest_prior = e.get("ts", 0)
    except: pass

    # Parse email_ts (may be ms)
    try:
        ets_s = int(email_ts)
        if ets_s > 10_000_000_000: ets_s //= 1000
    except:
        ets_s = 0

    # 2nd+ hit = open (Gmail prefetch happens only once)
    if prior_count >= 1:
        return "open"

    # First hit: within 120s of delivery = prefetch; else = open
    if ets_s and (now_ts - ets_s) > 120:
        return "open"
    return "prefetch"

def log_entry(entry):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except: pass

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = urlparse(self.path)
        ua = self.headers.get("User-Agent", "")
        ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]
        q = parse_qs(p.query)

        if p.path == "/track/open":
            now = int(time.time())
            tmpl = q.get("t",[""])[0][:100]
            cname = q.get("c",[""])[0][:100]
            ets = q.get("ets",[""])[0][:20]
            entry = {
                "ts": now,
                "iso": time.strftime("%Y-%m-%d %H:%M:%S"),
                "event": "pixel",
                "type": classify(ua, tmpl, cname, ets, now),
                "template": tmpl,
                "creator": cname,
                "email_ts": ets,
                "ip": ip, "ua": ua[:200],
            }
            log_entry(entry)
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(GIF_1PX)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            self.end_headers()
            self.wfile.write(GIF_1PX)

        elif p.path == "/track/click":
            now = int(time.time())
            target = unquote(q.get("u",[""])[0])
            tmpl = q.get("t",[""])[0][:100]
            cname = q.get("c",[""])[0][:100]
            # Click from proxy (spam scanner) = prefetch; real browser = open/click
            is_proxy = (not ua) or len(ua) < 20 or PROXY_RE.search(ua)
            entry = {
                "ts": now,
                "iso": time.strftime("%Y-%m-%d %H:%M:%S"),
                "event": "click",
                "type": "prefetch" if is_proxy else "open",
                "template": tmpl,
                "creator": cname,
                "target": target[:500],
                "ip": ip, "ua": ua[:200],
            }
            log_entry(entry)
            if target.startswith("http://") or target.startswith("https://"):
                self.send_response(302); self.send_header("Location", target); self.end_headers()
            else:
                self.send_response(400); self.end_headers()

        elif p.path == "/track/list":
            try:
                with open(LOG_FILE) as f: lines = f.readlines()[-1000:]
            except: lines = []
            body = "".join(lines).encode()
            self.send_response(200); self.send_header("Content-Type", "application/x-ndjson"); self.end_headers(); self.wfile.write(body)

        elif p.path == "/track/summary":
            # Aggregated per creator: delivered (prefetch), opened (real), clicked
            try:
                with open(LOG_FILE) as f: lines = f.readlines()
            except: lines = []
            summary = {}
            for l in lines:
                try: e = json.loads(l)
                except: continue
                c = (e.get("creator") or "").lower()
                if not c: continue
                if c not in summary:
                    summary[c] = {"delivered": 0, "opened": 0, "clicked": 0, "last_open_ts": 0, "last_click_ts": 0}
                ev, tp = e.get("event"), e.get("type")
                if ev == "pixel":
                    if tp == "prefetch": summary[c]["delivered"] += 1
                    elif tp == "open":
                        summary[c]["opened"] += 1
                        summary[c]["last_open_ts"] = max(summary[c]["last_open_ts"], e.get("ts", 0))
                elif ev == "click":
                    summary[c]["clicked"] += 1
                    summary[c]["last_click_ts"] = max(summary[c]["last_click_ts"], e.get("ts", 0))
            body = json.dumps(summary, ensure_ascii=False, indent=2).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(body)

        else:
            self.send_response(404); self.end_headers()

    def log_message(self, *a): pass

if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), H)
    print(f"tracking server on :{PORT}, log={LOG_FILE}")
    srv.serve_forever()
