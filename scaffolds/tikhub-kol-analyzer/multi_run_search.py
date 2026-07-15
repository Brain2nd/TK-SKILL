"""
Multi-run keyword search — runs TikHub search N times with a delay between each run,
accumulates unique creators across all runs, then runs the full filter pipeline once.

Usage:
  python multi_run_search.py --keyword "attack on titan haul" --runs 5 --interval 300
  python multi_run_search.py --keyword "cosplay haul" --runs 3 --interval 180 --no-fake
"""
import argparse
import csv
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import (
    ANTHROPIC_API_KEY, TIKHUB_API_KEY,
    SEARCH_PAGES_PER_KEYWORD, SEARCH_RESULTS_PER_PAGE, VIDEOS_PER_USER,
    COMMENTS_PER_VIDEO, API_DELAY_SECONDS, DEEP_ANALYSIS_DELAY_SECONDS,
    OUTPUT_DIR,
)
from tikhub_fetcher import (
    search_unique_usernames, fetch_user_videos, detect_fake_views, _parse_video,
)
from models import Creator
from feature_engine import compute_basic_features
from pipeline import hard_filter, must_pass_filter, calculate_scores
from demographics import compute_western_ratio_from_ids
from claude_client import score_all_creators_dogegoo
from output import export_scored_csv

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("multi_search")

PHASE2_CONCURRENCY = 5


def _slug(keyword: str) -> str:
    return keyword.replace(" ", "_").replace("/", "-")


def _load_processed(path: str) -> set[str]:
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8-sig") as f:
        return {r["username"] for r in csv.DictReader(f) if r.get("username")}


def _append_step1(candidates: list[dict], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if not candidates:
        return
    skip = {"top5_video_ids", "video_descriptions"}
    flat_fields = [f for f in candidates[0] if f not in skip]
    file_exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=flat_fields, extrasaction="ignore")
        if not file_exists:
            writer.writeheader()
        writer.writerows(candidates)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword",   required=True, help="Search keyword")
    parser.add_argument("--runs",      type=int, default=3,
                        help="Number of search rounds (TikTok pool refreshes slowly; "
                             "3 runs × 24h apart captures more than 5 runs × 5min apart)")
    parser.add_argument("--interval",  type=int, default=86400,
                        help="Seconds between rounds (default 86400 = 24h; "
                             "short intervals like 5min yield few new creators)")
    parser.add_argument("--no-fake",   action="store_true",   help="Skip fake-view detection")
    parser.add_argument("--pages",     type=int, default=SEARCH_PAGES_PER_KEYWORD)
    args = parser.parse_args()

    slug   = _slug(args.keyword)
    outdir = os.path.join(OUTPUT_DIR, slug)
    os.makedirs(outdir, exist_ok=True)

    step1_csv = os.path.join(outdir, "step1.csv")
    final_csv = os.path.join(outdir, "final.csv")

    log.info(f'=== Multi-run search: "{args.keyword}" × {args.runs} runs @ {args.interval}s interval ===')

    # ── Phase 1: Repeated search to collect unique usernames ─────────────────
    all_usernames: set[str] = set()

    for run in range(1, args.runs + 1):
        log.info(f"--- Search round {run}/{args.runs} ---")
        found = search_unique_usernames(
            {"keyword": [args.keyword]},
            pages_per_keyword=args.pages,
            results_per_page=SEARCH_RESULTS_PER_PAGE,
        )
        new = found - all_usernames
        all_usernames |= found
        log.info(f"  Round {run}: {len(found)} found, {len(new)} new, "
                 f"{len(all_usernames)} total unique")

        if run < args.runs:
            log.info(f"  Waiting {args.interval}s before next round...")
            time.sleep(args.interval)

    log.info(f"Phase 1 complete: {len(all_usernames)} unique creators across {args.runs} rounds")

    # ── Phase 2: Fetch videos + hard filter (parallel) ───────────────────────
    log.info("Phase 2: Fetch videos + hard filter...")
    already_done = _load_processed(step1_csv)
    todo = [u for u in all_usernames if u not in already_done]
    step1_passed: list[dict] = []
    total = len(todo)
    cached = len(all_usernames) - total
    if cached:
        log.info(f"  Skipping {cached} already-processed (from step1.csv)")

    def _process_user(username: str):
        try:
            video_raws = fetch_user_videos(username, count=VIDEOS_PER_USER)
            if not video_raws or len(video_raws) < 5:
                return ("skip", username, "insufficient videos")
            author = video_raws[0].get("author", {})
            videos = [_parse_video(v) for v in video_raws]
            creator = Creator(
                user_id=author.get("uid", ""),
                username=author.get("unique_id", username),
                nickname=author.get("nickname", username),
                followers=author.get("follower_count", 0),
                following=author.get("following_count", 0),
                bio=author.get("signature", ""),
                videos=videos,
            )
            features = compute_basic_features(creator)
            passed, reason = hard_filter(features)
            return ("pass", username, features) if passed else ("fail", username, reason)
        except Exception as exc:
            return ("error", username, exc)

    with ThreadPoolExecutor(max_workers=PHASE2_CONCURRENCY) as ex:
        futures = {ex.submit(_process_user, u): u for u in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            status, username, payload = fut.result()
            if status == "pass":
                step1_passed.append(payload)
                log.info(f"  [{i}/{total}] ✅ @{username} | "
                         f"followers={payload['followers']:,} | "
                         f"avg_views={payload['avg_views']:,.0f} | "
                         f"haul={payload['has_haul_content']:.0%}")
            elif status == "fail":
                log.info(f"  [{i}/{total}] ❌ @{username}: {payload}")
            elif status == "skip":
                log.info(f"  [{i}/{total}] @{username} — {payload}")
            else:
                log.warning(f"  [{i}/{total}] ⚠️ @{username}: {payload}")

    _append_step1(step1_passed, step1_csv)
    log.info(f"Phase 2 complete: {len(step1_passed)} new creators passed Step 1")

    if not step1_passed:
        log.info("No new candidates — exiting.")
        return

    # ── Phase 3: Deep analysis + must-pass filter ─────────────────────────────
    log.info("Phase 3: Deep analysis...")

    log.info("  3a. Western ratio from comments...")
    for c in step1_passed:
        try:
            c["western_ratio"] = compute_western_ratio_from_ids(
                c["top5_video_ids"], comments_per_video=COMMENTS_PER_VIDEO
            )
            log.info(f"    @{c['username']}: western={c['western_ratio']:.0%}")
        except Exception as exc:
            log.warning(f"    @{c['username']} comment error: {exc}")
            c["western_ratio"] = 0.0
        time.sleep(DEEP_ANALYSIS_DELAY_SECONDS)

    log.info("  3b. Claude AI relevance scoring...")
    if ANTHROPIC_API_KEY:
        score_all_creators_dogegoo(step1_passed)
    else:
        for c in step1_passed:
            c["ai_relevance_score"] = None
            c["primary_category"]   = "no-key"

    if not args.no_fake:
        log.info("  3c. Fake view detection...")
        for c in step1_passed:
            vid_id = c.get("top_video_id", "")
            if not vid_id:
                continue
            try:
                result = detect_fake_views(vid_id)
                c["fake_score"]      = result.get("fake_score")
                c["trust_score"]     = result.get("trust_score")
                c["fake_suspicious"] = result.get("is_suspicious", False)
                log.info(f"    @{c['username']}: fake={c['fake_score']} trust={c['trust_score']}")
            except Exception as exc:
                log.warning(f"    @{c['username']} fake error: {exc}")
            time.sleep(API_DELAY_SECONDS)
    else:
        log.info("  3c. Fake detection skipped (--no-fake)")

    step2_passed = []
    for c in step1_passed:
        passed, reason = must_pass_filter(c)
        if passed:
            step2_passed.append(c)
            log.info(f"  ✅ @{c['username']} | "
                     f"AI={c.get('ai_relevance_score') or 0:.2f} | "
                     f"west={c.get('western_ratio') or 0:.0%}")
        else:
            log.info(f"  ❌ @{c['username']}: {reason}")

    log.info(f"Phase 3 complete: {len(step2_passed)} passed Step 2")

    if not step2_passed:
        log.info("No candidates passed Step 2 — exiting.")
        return

    # ── Phase 4: Score + export ───────────────────────────────────────────────
    log.info("Phase 4: Scoring and ranking...")
    calculate_scores(step2_passed)
    step2_passed.sort(key=lambda c: c["final_score"] or 0, reverse=True)

    export_scored_csv(step2_passed, final_csv)

    print(f"\n=== TOP CANDIDATES — \"{args.keyword}\" ===")
    for i, c in enumerate(step2_passed, 1):
        print(f"{i:2d}. @{c['username']:<22} | score={c['final_score']:.3f} | "
              f"followers={c['followers']:,} | avg_views={c['avg_views']:,.0f} | "
              f"haul={c['has_haul_content']:.0%} | AI={c.get('ai_relevance_score') or 0:.2f} | "
              f"west={c.get('western_ratio') or 0:.0%} | {c.get('primary_category','')}")

    log.info(f"Done! {len(step2_passed)} candidates → {final_csv}")


if __name__ == "__main__":
    main()
