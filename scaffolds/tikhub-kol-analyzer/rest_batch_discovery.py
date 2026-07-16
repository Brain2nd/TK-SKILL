"""REST-based batch discovery for micro TikTok Shop creator prospects.

Uses TikHub's REST API (api.tikhub.io) as a fallback when the MCP endpoint
is unreachable. Same output format as mcp_batch_discovery.py.
"""
import argparse
import csv
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import mean

from tikhub_fetcher import _get, _parse_video


def _rows(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _write_rows(path, rows, fields):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def search_handles(keyword: str, per_keyword: int) -> set[str]:
    """Search TikHub by keyword and return deduplicated creator handles."""
    handles = set()
    offset = 0
    page_size = min(20, per_keyword)
    while len(handles) < per_keyword:
        try:
            data = _get("/api/v1/tiktok/app/v3/fetch_video_search_result", {
                "keyword": keyword, "count": page_size, "offset": offset,
            })["data"]
        except Exception as e:
            print(f"  [search] error for '{keyword}' at offset {offset}: {e}")
            break
        items = data.get("search_item_list", [])
        if not items:
            break
        for item in items:
            author = item.get("aweme_info", item).get("author", {})
            uid = author.get("unique_id")
            if uid:
                handles.add(uid)
        if not data.get("has_more"):
            break
        offset += page_size
        time.sleep(0.3)
    return handles


def inspect(username: str, args) -> dict | None:
    """Fetch videos + country for a single creator. Returns row dict or None."""
    try:
        data = _get("/api/v1/tiktok/app/v3/fetch_user_post_videos", {
            "unique_id": username, "count": args.videos,
        })["data"]
        raw_videos = data.get("aweme_list", [])
    except Exception as e:
        print(f"  [videos] error for @{username}: {e}")
        return None

    if len(raw_videos) < 5:
        return None

    author = raw_videos[0].get("author", {})
    followers = int(author.get("follower_count") or 0)
    if not 0 < followers < args.max_followers:
        return None

    try:
        country_data = _get("/api/v1/tiktok/app/v3/fetch_user_country_by_username", {
            "username": username,
        })["data"]
        country = country_data.get("country", "")
    except Exception:
        country = ""

    if country not in args.countries:
        return None

    videos = [_parse_video(v) for v in raw_videos]
    avg_views = mean(v.views for v in videos)
    engagement = mean(
        (v.likes + v.comments + v.shares) / max(v.views, 1) for v in videos
    )
    text = " ".join(
        [author.get("signature", "")] + [v.description for v in videos]
    ).lower()
    signal_terms = [
        "tiktok shop", "affiliate", "showcase", "link in bio",
        "discount", "code", "ugc",
    ]
    signals = sum(term in text for term in signal_terms)

    return {
        "username": author.get("unique_id") or username,
        "country": country,
        "followers": followers,
        "avg_views_10": round(avg_views),
        "engagement_rate": round(engagement, 4),
        "shop_signals": signals,
        "bio": (author.get("signature") or "").replace("\n", " "),
        "profile_url": f"https://www.tiktok.com/@{author.get('unique_id') or username}",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keywords", nargs="+", required=True)
    parser.add_argument("--countries", nargs="+", default=["ES", "FR", "DE", "IT", "GB"])
    parser.add_argument("--max-followers", type=int, default=10_000)
    parser.add_argument("--per-keyword", type=int, default=20)
    parser.add_argument("--videos", type=int, default=10)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output-dir", default="output/tts_l1_eu")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    # --- Phase 1: Search ---
    handles = set()
    for kw in args.keywords:
        print(f"[search] '{kw}' ...")
        found = search_handles(kw, args.per_keyword)
        handles |= found
        print(f"  -> {len(found)} handles (total unique: {len(handles)})")

    # --- Phase 2: Inspect ---
    raw_path = os.path.join(args.output_dir, "raw_candidates.csv")
    checked_path = os.path.join(args.output_dir, "checked_candidates.csv")
    final_path = os.path.join(args.output_dir, "final.csv")

    checked = {row["username"] for row in _rows(checked_path)} if args.resume else set()
    rows = _rows(checked_path) if args.resume else []
    todo = sorted(handles - checked)

    _write_rows(raw_path, [{"username": h} for h in sorted(handles)], ["username"])

    print(f"\n[inspect] {len(todo)} creators to check ({args.workers} workers)...")
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(inspect, u, args) for u in todo]
        for future in as_completed(futures):
            row = future.result()
            if row:
                rows.append(row)
                _write_rows(checked_path, rows, list(row))
                print(f"  ✓ @{row['username']} | {row['country']} | {row['followers']:,} followers | signals={row['shop_signals']}")

    # --- Phase 3: Rank & output ---
    rows.sort(
        key=lambda r: (r["country"] == "ES", int(r["shop_signals"]), int(r["avg_views_10"]), float(r["engagement_rate"])),
        reverse=True,
    )
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank

    out_fields = ["rank", "username", "country", "followers", "avg_views_10",
                  "engagement_rate", "shop_signals", "bio", "profile_url"]
    _write_rows(final_path, rows, out_fields)
    print(f"\n{len(rows)} qualified candidates written to {final_path}")


if __name__ == "__main__":
    main()
