"""MCP-driven, resumable discovery for micro TikTok Shop creator prospects.

Run ``--list-tools`` once if TikHub changes a tool name.  The default tool
matching targets the same operations used by the old REST implementation.
"""
import argparse
import csv
import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import mean

from contact_enrichment import enrich_contact
from tikhub_fetcher import _parse_video
from tikhub_mcp import TikHubMCPClient


OUTPUT_FIELDS = [
    "rank", "username", "country", "followers", "avg_views_10",
    "engagement_rate", "shop_signals", "email", "email_source",
    "email_verified", "bio_url", "bio", "profile_url",
]


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


def _unwrap(payload):
    """Accept MCP tool JSON wrapped as data/result or returned directly."""
    if isinstance(payload, dict):
        return payload.get("data", payload.get("result", payload))
    return {}


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _finalize(rows, final_path, limit=10):
    """Require a public email, rank candidates, and write the final CSV."""
    eligible = [row for row in rows if row.get("email")]
    eligible.sort(key=lambda row: (
        row.get("country") == "ES",
        _number(row.get("shop_signals")),
        _number(row.get("avg_views_10")),
        _number(row.get("engagement_rate")),
    ), reverse=True)
    if limit > 0:
        eligible = eligible[:limit]
    for rank, row in enumerate(eligible, 1):
        row["rank"] = rank
    _write_rows(final_path, eligible, OUTPUT_FIELDS)
    return eligible


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keywords", nargs="*", default=[])
    parser.add_argument("--countries", nargs="+", default=["ES", "FR", "DE", "IT", "GB"])
    parser.add_argument("--max-followers", type=int, default=10_000)
    parser.add_argument("--per-keyword", type=int, default=20)
    parser.add_argument("--videos", type=int, default=10)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output-dir", default="output/tts_l1_eu")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--enrich-existing", action="store_true",
                        help="Backfill contact fields from an existing checked_candidates.csv")
    parser.add_argument("--skip-email-dns", action="store_true",
                        help="Validate email syntax only instead of checking MX records")
    parser.add_argument("--no-scrape-links", action="store_true",
                        help="Do not fetch public bio/profile landing pages for email")
    parser.add_argument("--limit", type=int, default=10, help="Maximum final rows; 0 means unlimited")
    parser.add_argument("--list-tools", action="store_true")
    parser.add_argument("--search-tool")
    parser.add_argument("--videos-tool")
    parser.add_argument("--country-tool")
    parser.add_argument("--profile-tool")
    args = parser.parse_args()

    checked_path = os.path.join(args.output_dir, "checked_candidates.csv")
    final_path = os.path.join(args.output_dir, "final.csv")
    if args.enrich_existing:
        existing = _rows(checked_path)
        if not existing:
            parser.error(f"no rows found in {checked_path}")
        enriched = [enrich_contact(
            row,
            verify_dns=not args.skip_email_dns,
            scrape_link=not args.no_scrape_links,
        ) for row in existing]
        _write_rows(checked_path, enriched, OUTPUT_FIELDS[1:])
        final = _finalize(enriched, final_path, args.limit)
        print(f"{len(final)} email-qualified candidates written to {final_path}")
        return

    if not args.keywords and not args.list_tools:
        parser.error("--keywords is required unless --list-tools or --enrich-existing is used")

    with TikHubMCPClient() as mcp:
        tools = mcp.tools()
        if args.list_tools:
            for tool in tools:
                print(f"{tool['name']}\t{tool.get('description', '')}")
            return

        search_tool = args.search_tool or mcp.find_tool(tools, "video", "search")
        videos_tool = args.videos_tool or mcp.find_tool(tools, "user", "post", "video")
        country_tool = args.country_tool or mcp.find_tool(tools, "user", "country")
        profile_tool = args.profile_tool or mcp.find_tool(tools, "user", "profile")

        handles = set()
        for keyword in args.keywords:
            data = _unwrap(mcp.call_tool(search_tool, {"keyword": keyword, "count": args.per_keyword, "offset": 0}))
            for item in data.get("search_item_list", data.get("items", [])):
                author = item.get("aweme_info", item).get("author", {})
                if author.get("unique_id"):
                    handles.add(author["unique_id"])

        raw_path = os.path.join(args.output_dir, "raw_candidates.csv")
        checked = {row["username"] for row in _rows(checked_path)} if args.resume else set()
        rows = _rows(checked_path) if args.resume else []

        def inspect(username):
            with TikHubMCPClient() as worker:
                payload = _unwrap(worker.call_tool(videos_tool, {"unique_id": username, "count": args.videos}))
                raw_videos = payload.get("aweme_list", payload.get("videos", []))
                if len(raw_videos) < 5:
                    return None
                author = raw_videos[0].get("author", {})
                followers = int(author.get("follower_count") or 0)
                if not 0 < followers < args.max_followers:
                    return None
                country = _unwrap(worker.call_tool(country_tool, {"username": username})).get("country", "")
                if country not in args.countries:
                    return None
                videos = [_parse_video(video) for video in raw_videos]
                avg_views = mean(video.views for video in videos)
                engagement = mean((video.likes + video.comments + video.shares) / max(video.views, 1) for video in videos)
                text = " ".join([author.get("signature", "")] + [video.description for video in videos]).lower()
                signal_terms = ["tiktok shop", "affiliate", "showcase", "link in bio", "discount", "code", "ugc"]
                signals = sum(term in text for term in signal_terms)
                row = {"username": author.get("unique_id") or username, "country": country, "followers": followers,
                       "avg_views_10": round(avg_views), "engagement_rate": round(engagement, 4),
                       "shop_signals": signals, "bio": (author.get("signature") or "").replace("\n", " "),
                       "profile_url": f"https://www.tiktok.com/@{author.get('unique_id') or username}"}
                profile_payload = _unwrap(worker.call_tool(profile_tool, {"unique_id": username}))
                return enrich_contact(
                    row,
                    profile_payload=profile_payload,
                    verify_dns=not args.skip_email_dns,
                    scrape_link=not args.no_scrape_links,
                )

        _write_rows(raw_path, [{"username": handle} for handle in sorted(handles)], ["username"])
        todo = sorted(handles - checked)
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = [executor.submit(inspect, username) for username in todo]
            for future in as_completed(futures):
                row = future.result()
                if row:
                    rows.append(row)
                    _write_rows(checked_path, rows, OUTPUT_FIELDS[1:])

        final = _finalize(rows, final_path, args.limit)
        print(f"{len(final)} email-qualified candidates written to {final_path}")


if __name__ == "__main__":
    main()
