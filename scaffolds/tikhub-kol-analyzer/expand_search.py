"""Expanded multi-keyword search for EU TikTok Shop creators.

Runs TikHub REST search for many country-specific keywords, deduplicates,
then inspects each creator. Designed to find 300+ qualified candidates so
we can filter to 100 with emails.
"""
import argparse
import csv
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import mean

from tikhub_fetcher import _get, _parse_video

# Country-specific keyword blocks designed to find UGC + TikTok Shop creators
KEYWORDS = {
    "ES": [
        "ugc creator españa", "creadora ugc españa", "creador ugc españa",
        "tiktok shop españa", "ugc tiktok shop españa",
        "tiktok affiliate españa", "creadora de contenido españa",
        "ugc beauty españa", "ugc moda españa", "ugc skincare españa",
        "contenido ugc", "creadora ugc barcelona", "creadora ugc madrid",
        "tiktok shop creator españa", "embajadora tiktok shop",
    ],
    "FR": [
        "ugc france", "créateur ugc france", "créatrice ugc france",
        "tiktok shop france", "ugc tiktok shop france",
        "tiktok affiliate france", "créatrice contenu france",
        "ugc beauté france", "ugc mode france",
        "tiktok shop creator france", "créateur tiktok shop france",
    ],
    "DE": [
        "ugc deutschland", "ugc creator deutschland", "ugc ersteller deutschland",
        "tiktok shop deutschland", "ugc tiktok shop deutschland",
        "tiktok affiliate deutschland",
        "tiktok shop creator deutschland", "tiktok shop deutsch",
    ],
    "IT": [
        "ugc italia", "creator ugc italia", "creatrice ugc italia",
        "tiktok shop italia", "ugc tiktok shop italia",
        "tiktok affiliate italia", "creatrice contenuti italia",
        "tiktok shop creator italia",
    ],
    "GB": [
        "ugc creator uk", "ugc tiktok shop uk",
        "tiktok shop uk", "tiktok affiliate uk",
        "tiktok shop creator uk", "ugc content creator uk",
        "ugc beauty uk", "small creator tiktok shop uk",
        "tiktok shop finds uk",
    ],
}


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
    handles = set()
    offset = 0
    page_size = min(20, per_keyword)
    while len(handles) < per_keyword:
        try:
            data = _get("/api/v1/tiktok/app/v3/fetch_video_search_result", {
                "keyword": keyword, "count": page_size, "offset": offset,
            })["data"]
        except Exception as e:
            print(f"    [search] error '{keyword}' offset={offset}: {e}")
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
        time.sleep(0.25)
    return handles


def inspect(username: str, countries: set, max_followers: int, videos: int) -> dict | None:
    try:
        data = _get("/api/v1/tiktok/app/v3/fetch_user_post_videos", {
            "unique_id": username, "count": videos,
        })["data"]
        raw_videos = data.get("aweme_list", [])
    except Exception as e:
        print(f"    [videos] error @{username}: {e}")
        return None

    if len(raw_videos) < 5:
        return None

    author = raw_videos[0].get("author", {})
    followers = int(author.get("follower_count") or 0)
    if not 0 < followers < max_followers:
        return None

    try:
        country_data = _get("/api/v1/tiktok/app/v3/fetch_user_country_by_username", {
            "username": username,
        })["data"]
        country = country_data.get("country", "")
    except Exception:
        country = ""

    if country not in countries:
        return None

    videos_list = [_parse_video(v) for v in raw_videos]
    avg_views = mean(v.views for v in videos_list)
    engagement = mean(
        (v.likes + v.comments + v.shares) / max(v.views, 1) for v in videos_list
    )
    text = " ".join(
        [author.get("signature", "")] + [v.description for v in videos_list]
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
    parser.add_argument("--countries", nargs="+", default=["ES", "FR", "DE", "IT", "GB"])
    parser.add_argument("--max-followers", type=int, default=10_000)
    parser.add_argument("--per-keyword", type=int, default=30)
    parser.add_argument("--videos", type=int, default=10)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output-dir", default="output/tts_l1_eu")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()

    countries_set = set(args.countries)
    raw_path = os.path.join(args.output_dir, "raw_candidates_v2.csv")
    checked_path = os.path.join(args.output_dir, "checked_candidates_v2.csv")

    # Phase 1: Search all keywords
    handles = set()
    total_kw = sum(len(v) for v in KEYWORDS.values())
    done = 0
    for country in args.countries:
        for kw in KEYWORDS.get(country, []):
            done += 1
            print(f"[search {done}/{total_kw}] [{country}] {kw}")
            found = search_handles(kw, args.per_keyword)
            new = found - handles
            handles |= found
            print(f"  -> +{len(new)} new, total unique: {len(handles)}")

    # Phase 2: Inspect
    checked = {row["username"] for row in _rows(checked_path)} if args.resume else set()
    rows = _rows(checked_path) if args.resume else []
    todo = sorted(handles - checked)

    _write_rows(raw_path, [{"username": h} for h in sorted(handles)], ["username"])

    print(f"\n[inspect] {len(todo)} creators ({args.workers} workers)...")
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(inspect, u, countries_set, args.max_followers, args.videos)
                   for u in todo]
        for i, future in enumerate(as_completed(futures), 1):
            row = future.result()
            if row:
                rows.append(row)
                _write_rows(checked_path, rows, list(row))
                print(f"  [{i}/{len(todo)}] @{row['username']} | {row['country']} | "
                      f"{row['followers']:,} followers | signals={row['shop_signals']}")

    print(f"\nQualified: {len(rows)} (from {len(handles)} unique handles)")
    print(f"Output: {checked_path}")


if __name__ == "__main__":
    main()
