"""
Fetch and save all features for a list of known-good creators.
Used to reverse-engineer future filtering criteria.

Skips: comment demographics (western_ratio), Claude AI scoring, fake-view detection.
Outputs: output/creator_features_raw.csv — one row per creator, all feature columns.

Usage:
  python fetch_creator_features.py --file /path/to/creators.xlsx
  python fetch_creator_features.py --file list.xlsx --output output/my_analysis.csv
"""
import argparse
import csv
import os
import time
import openpyxl

from config import TIKHUB_API_KEY, VIDEOS_PER_USER, API_DELAY_SECONDS
from tikhub_fetcher import creator_from_video_rows, fetch_user_videos
from feature_engine import compute_basic_features


# ── Columns to export (all basic features, no Step-2 API fields) ─────────────
EXPORT_COLUMNS = [
    "username", "bio", "country",
    # activity
    "days_since_last_post", "post_freq_30d",
    # size
    "followers", "following", "follower_to_following", "likes_to_follower_total",
    # views
    "avg_views", "median_views", "max_views", "viral_rate",
    "view_follower_ratio", "views_growth_trend", "view_variance_coeff",
    "viral_floor", "hit_rate", "consecutive_hits",
    # engagement
    "avg_engagement_rate", "engage_consistency_inv",
    "avg_comments", "avg_comment_rate",
    "comment_to_like_ratio", "share_to_view_ratio", "deep_engage_rate",
    # content
    "avg_duration",
    "content_vertical_score", "has_haul_content",
    "shopping_vocabulary_density", "cta_ratio", "has_china_shopping",
    "ip_depth_score", "haul_vs_nonhaul_views", "haul_vs_nonhaul_engagement",
    # bio signals
    "bio_has_contact", "link_in_bio", "collab_signal",
    # derived
    "days_recency_score",
    # url
    "profile_url",
]


def load_usernames(filepath: str) -> list[str]:
    ext = os.path.splitext(filepath)[1].lower()
    raw = []

    if ext in (".xlsx", ".xls"):
        wb = openpyxl.load_workbook(filepath)
        for sheet in wb.worksheets:
            for row in sheet.iter_rows(values_only=True):
                for cell in row:
                    val = str(cell or "").strip()
                    raw.append(val)
    elif ext == ".csv":
        with open(filepath, encoding="utf-8") as f:
            for row in csv.reader(f):
                for cell in row:
                    raw.append(str(cell).strip())
    else:
        with open(filepath, encoding="utf-8") as f:
            for line in f:
                raw.append(line.strip())

    usernames = []
    seen = set()
    for val in raw:
        if "tiktok.com/@" in val:
            username = val.split("tiktok.com/@")[1].strip()
            username = username.split("?")[0].rstrip("/").strip()
        else:
            # Skip headers, labels, or anything that isn't a plain ASCII handle
            val = val.strip()
            if (not val
                    or val.startswith("http")
                    or val.startswith("#")
                    or any(ord(ch) > 127 for ch in val)):   # non-ASCII → not a username
                continue
            username = val
        username = username.strip()
        if username and username not in seen:
            seen.add(username)
            usernames.append(username)

    return usernames


def fetch_and_compute(username: str) -> dict | None:
    """Fetch videos for a username and return its feature dict, or None on failure."""
    video_raws = fetch_user_videos(username, count=VIDEOS_PER_USER)
    if not video_raws:
        return None

    creator = creator_from_video_rows(username, video_raws)

    features = compute_basic_features(creator)
    features["profile_url"] = f"https://www.tiktok.com/@{creator.username}"
    return features


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file",   required=True, help="Excel/CSV/TXT with TikTok creator URLs")
    parser.add_argument("--output", default="output/creator_features_raw.csv")
    args = parser.parse_args()

    if not TIKHUB_API_KEY:
        raise ValueError("TIKHUB_API_KEY not set in config.py")

    usernames = load_usernames(args.file)
    print(f"Loaded {len(usernames)} unique creators from {os.path.basename(args.file)}")

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    results = []
    failed  = []

    for i, username in enumerate(usernames, 1):
        print(f"[{i}/{len(usernames)}] Fetching @{username}...", end=" ", flush=True)
        try:
            features = fetch_and_compute(username)
            if features:
                results.append(features)
                print(f"✅  followers={features['followers']:,} | "
                      f"avg_views={features['avg_views']:,.0f} | "
                      f"haul={features['has_haul_content']:.0%} | "
                      f"vertical={features['content_vertical_score']:.0%}")
            else:
                failed.append(username)
                print("❌  no videos returned")
        except Exception as exc:
            failed.append(username)
            print(f"❌  {exc}")
        time.sleep(API_DELAY_SECONDS)

    # ── Save to CSV ────────────────────────────────────────────────────────────
    skip = {"top5_video_ids", "video_descriptions",
            "western_ratio", "ai_relevance_score", "primary_category",
            "ai_reasoning", "fake_score", "trust_score", "fake_suspicious", "final_score"}

    with open(args.output, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=EXPORT_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            clean = {k: (f"{v:.4f}" if isinstance(v, float) else v)
                     for k, v in row.items() if k not in skip}
            writer.writerow(clean)

    print(f"\n{'='*60}")
    print(f"Done: {len(results)} fetched, {len(failed)} failed")
    if failed:
        print(f"Failed: {failed}")
    print(f"Output: {args.output}")

    # ── Print a quick summary of key metrics ──────────────────────────────────
    if results:
        def _avg(key):
            vals = [float(r[key]) for r in results if r.get(key) is not None]
            return sum(vals) / len(vals) if vals else 0.0

        print(f"\n=== Summary stats for {len(results)} good creators ===")
        for label, key in [
            ("Avg followers",            "followers"),
            ("Avg avg_views",            "avg_views"),
            ("Avg viral_rate",           "viral_rate"),
            ("Avg view_follower_ratio",  "view_follower_ratio"),
            ("Avg has_haul_content",     "has_haul_content"),
            ("Avg content_vertical",     "content_vertical_score"),
            ("Avg avg_comment_rate",     "avg_comment_rate"),
            ("Avg shopping_vocab",       "shopping_vocabulary_density"),
            ("Avg days_since_last_post", "days_since_last_post"),
            ("Avg avg_duration (s)",     "avg_duration"),
        ]:
            print(f"  {label:<30}: {_avg(key):.3f}")


if __name__ == "__main__":
    main()
