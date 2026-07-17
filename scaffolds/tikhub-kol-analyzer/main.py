"""
Dogegoo TikTok KOL Filter — main entry point.

5-phase pipeline:
  Phase 1 — Multi-keyword search → unique creator pool
  Phase 2 — Fetch videos + compute basic features + Step 1 hard filter
  Phase 3 — Deep analysis (comments / Claude / fake detection) + Step 2 must-pass filter
  Phase 4 — Weighted scoring, ranking, CSV export
  Phase 5 — Contact extraction (email from bio, bio_url, linktr.ee scrape)

Usage:
  python main.py                          # full run (all tiers)
  python main.py --tiers tier1_highest    # single tier only
  python main.py --mock                   # mock data (no API calls)
  python main.py --no-fake                # skip fake-view detection
  python main.py --max 100                # cap candidate pool size
"""
import argparse
import csv
import logging
import os
import re
import time

from config import (
    LLM_API_KEY, TIKHUB_API_KEY,
    SEARCH_PAGES_PER_KEYWORD, SEARCH_RESULTS_PER_PAGE, VIDEOS_PER_USER,
    COMMENTS_PER_VIDEO,
    API_DELAY_SECONDS, DEEP_ANALYSIS_DELAY_SECONDS,
    OUTPUT_DIR,
)
from search_keywords import SEARCH_KEYWORDS
from tikhub_fetcher import (
    search_unique_usernames, fetch_user_videos,
    creator_from_video_rows, detect_fake_views, fetch_bio_url,
)
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
log = logging.getLogger("kol_filter")


# ── Checkpoint helpers ────────────────────────────────────────────────────────

def _load_checkpoint(path: str) -> set[str]:
    """Return set of already-processed usernames from a checkpoint CSV."""
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        return {row["username"] for row in reader if row.get("username")}


def _save_checkpoint(candidates: list[dict], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if not candidates:
        return
    fieldnames = list(candidates[0].keys())
    # Don't serialise the nested list fields to CSV
    skip = {"top5_video_ids", "video_descriptions"}
    flat_fields = [f for f in fieldnames if f not in skip]
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=flat_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(candidates)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mock",     action="store_true", help="Use mock data (no API)")
    parser.add_argument("--tiers",    nargs="+", default=list(SEARCH_KEYWORDS.keys()),
                        help="Keyword tiers to search (default: all)")
    parser.add_argument("--keywords", nargs="+", default=None,
                        help="Search specific keywords directly, e.g. --keywords 'taobao haul'")
    parser.add_argument("--keyword", default=None,
                        help="Search one keyword (shortcut for --keywords; output is grouped by keyword)")
    parser.add_argument("--output-dir", default=None,
                        help="Directory for step1.csv, step2.csv, and final.csv")
    parser.add_argument("--max",      type=int, default=0, help="Max creator pool size (0=unlimited)")
    parser.add_argument("--no-fake",  action="store_true", help="Skip fake-view detection")
    parser.add_argument("--resume",   action="store_true", help="Resume from checkpoint CSVs")
    parser.add_argument("--runs", type=int, default=1,
                        help="Repeat discovery and merge unique creators (default: 1)")
    parser.add_argument("--interval", type=int, default=86400,
                        help="Seconds between discovery rounds")
    parser.add_argument("--pages", type=int, default=SEARCH_PAGES_PER_KEYWORD,
                        help="Search pages per keyword and round")
    args = parser.parse_args()

    log.info("=== Dogegoo TikTok KOL Filter ===")

    if args.keyword and args.keywords:
        parser.error("use either --keyword or --keywords, not both")
    if args.runs < 1 or args.interval < 0 or args.pages < 1:
        parser.error("--runs and --pages must be >= 1; --interval must be >= 0")

    selected_keyword = args.keyword or (args.keywords[0] if args.keywords and len(args.keywords) == 1 else None)
    if args.output_dir:
        outdir = args.output_dir
    elif selected_keyword:
        outdir = os.path.join(OUTPUT_DIR, selected_keyword.replace(" ", "_").replace("/", "-"))
    else:
        outdir = OUTPUT_DIR
    output_raw_csv = os.path.join(outdir, "step1.csv")
    output_step2_csv = os.path.join(outdir, "step2.csv")
    output_final_csv = os.path.join(outdir, "final.csv")

    if not args.mock and not TIKHUB_API_KEY:
        parser.error("TIKHUB_API_KEY is required unless --mock is used")

    # ── Phase 1: Search ───────────────────────────────────────────────────────
    if args.mock:
        from mock_data import MOCK_CREATORS, MOCK_DEEP_ANALYSIS
        creator_objects = MOCK_CREATORS
        candidate_usernames = {c.username for c in creator_objects}
        log.info(f"Phase 1 (mock): {len(candidate_usernames)} creators loaded")
    else:
        log.info("Phase 1: Searching TikHub with keyword bank...")
        if args.keyword:
            selected_keywords = {"custom": [args.keyword]}
        elif args.keywords:
            selected_keywords = {"custom": args.keywords}
        else:
            selected_keywords = {k: v for k, v in SEARCH_KEYWORDS.items() if k in args.tiers}
        candidate_usernames = set()
        for run in range(1, args.runs + 1):
            found = search_unique_usernames(
                selected_keywords,
                pages_per_keyword=args.pages,
                results_per_page=SEARCH_RESULTS_PER_PAGE,
            )
            new = found - candidate_usernames
            candidate_usernames.update(found)
            log.info(
                "  Discovery round %s/%s: %s found, %s new, %s total",
                run, args.runs, len(found), len(new), len(candidate_usernames),
            )
            if run < args.runs:
                log.info("  Waiting %ss before next discovery round", args.interval)
                time.sleep(args.interval)
        if args.max and len(candidate_usernames) > args.max:
            candidate_usernames = set(list(candidate_usernames)[: args.max])
        log.info(f"Phase 1 complete: {len(candidate_usernames)} unique creators")

    # ── Phase 2: Fetch + basic features + hard filter ─────────────────────────
    log.info("Phase 2: Fetch videos + hard filter...")

    already_processed = _load_checkpoint(output_raw_csv) if args.resume else set()
    step1_passed: list[dict] = []

    if args.mock:
        for creator in creator_objects:
            features = compute_basic_features(creator)
            if not features:
                continue
            passed, reason = hard_filter(features)
            if passed:
                step1_passed.append(features)
                log.info(f"  ✅ @{creator.username} passed Step 1")
            else:
                log.info(f"  ❌ @{creator.username} failed Step 1: {reason}")
    else:
        total = len(candidate_usernames)
        for i, username in enumerate(candidate_usernames, 1):
            if username in already_processed:
                log.info(f"  [{i}/{total}] @{username} — skipped (checkpoint)")
                continue
            try:
                video_raws = fetch_user_videos(username, count=VIDEOS_PER_USER)
                if not video_raws or len(video_raws) < 5:
                    log.info(f"  [{i}/{total}] @{username} — insufficient videos ({len(video_raws)})")
                    time.sleep(API_DELAY_SECONDS)
                    continue

                creator = creator_from_video_rows(username, video_raws)

                features = compute_basic_features(creator)
                passed, reason = hard_filter(features)

                if passed:
                    step1_passed.append(features)
                    log.info(f"  [{i}/{total}] ✅ @{username} | "
                             f"followers={features['followers']:,} | "
                             f"avg_views={features['avg_views']:,.0f} | "
                             f"haul={features['has_haul_content']:.0%}")
                else:
                    log.info(f"  [{i}/{total}] ❌ @{username}: {reason}")

            except Exception as exc:
                log.warning(f"  [{i}/{total}] ⚠️ @{username}: {exc}")

            time.sleep(API_DELAY_SECONDS)

    log.info(f"Phase 2 complete: {len(step1_passed)} passed Step 1")
    _save_checkpoint(step1_passed, output_raw_csv)

    if not step1_passed:
        log.info("No candidates passed Step 1 — exiting.")
        return

    # ── Phase 3: Deep analysis + must-pass filter ─────────────────────────────
    log.info("Phase 3: Deep analysis (comments / Claude / fake detection)...")

    if args.mock:
        log.info("  Using offline deep-analysis fixtures")
        for c in step1_passed:
            c.update(MOCK_DEEP_ANALYSIS.get(c["username"], {}))
    else:
        # 3a. Western ratio from comments
        log.info("  3a. Computing audience western ratio from comments...")
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

        # 3b. Claude AI relevance scoring
        log.info("  3b. Claude AI relevance scoring...")
        if LLM_API_KEY:
            score_all_creators_dogegoo(step1_passed)
        else:
            log.warning("  No LLM API key — skipping AI relevance scoring")
            for c in step1_passed:
                c["ai_relevance_score"] = None
                c["primary_category"]   = "no-key"

    # 3c. Fake view detection
    if not args.mock and not args.no_fake:
        log.info("  3c. Fake view detection...")
        for c in step1_passed:
            vid_id = c.get("top_video_id", "")
            if not vid_id:
                continue
            try:
                result = detect_fake_views(vid_id)
                c["fake_score"]    = result.get("fake_score")
                c["trust_score"]   = result.get("trust_score")
                c["fake_suspicious"] = result.get("is_suspicious", False)
                log.info(f"    @{c['username']}: fake={c['fake_score']} trust={c['trust_score']}")
            except Exception as exc:
                log.warning(f"    @{c['username']} fake-view error: {exc}")
            time.sleep(API_DELAY_SECONDS)
    else:
        log.info("  3c. Fake view detection skipped (--no-fake)")

    # 3d. Apply must-pass filter
    step2_passed = []
    for c in step1_passed:
        passed, reason = must_pass_filter(c)
        if passed:
            step2_passed.append(c)
            log.info(f"  ✅ @{c['username']} passed Step 2 | "
                     f"AI={c.get('ai_relevance_score', 'N/A')} | "
                     f"west={c.get('western_ratio', 0):.0%}")
        else:
            log.info(f"  ❌ @{c['username']} failed Step 2: {reason}")

    log.info(f"Phase 3 complete: {len(step2_passed)} passed Step 2")
    _save_checkpoint(step2_passed, output_step2_csv)

    if not step2_passed:
        log.info("No candidates passed Step 2 — exiting.")
        return

    # ── Phase 4: Weighted scoring & export ────────────────────────────────────
    log.info("Phase 4: Scoring and ranking...")
    calculate_scores(step2_passed)
    step2_passed.sort(key=lambda c: c["final_score"] or 0, reverse=True)

    export_scored_csv(step2_passed, output_final_csv)

    # ── Phase 5: Contact extraction ───────────────────────────────────────────
    log.info("Phase 5: Extracting contact info (email / instagram / bio_url)...")
    _email_re    = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
    _ig_re       = re.compile(r"(?:instagram\.com/|ig[:\s@]+|insta[:\s@]+)([a-zA-Z0-9._]+)", re.I)

    import requests as _req

    def _scrape(url):
        try:
            return _req.get(url, timeout=5, headers={"User-Agent": "Mozilla/5.0"}).text[:5000]
        except Exception:
            return ""

    for c in step2_passed:
        bio = c.get("bio", "") or ""
        # email from bio
        m = _email_re.search(bio)
        c["email"] = m.group(0).lower() if m else ""
        # instagram from bio
        m = _ig_re.search(bio)
        c["instagram"] = m.group(1) if m else ""
        # bio_url from TikHub profile
        bio_url = c.get("bio_url", "") if args.mock else fetch_bio_url(c["username"])
        c["bio_url"] = bio_url
        # scrape bio_url page for email/ig
        if not args.mock and bio_url and (not c["email"] or not c["instagram"]):
            page = _scrape(bio_url)
            if not c["email"]:
                m = _email_re.search(page)
                c["email"] = m.group(0).lower() if m else ""
            if not c["instagram"]:
                m = _ig_re.search(page)
                c["instagram"] = m.group(1) if m else ""
        log.info(f"  @{c['username']}: email={c['email'] or '-'} ig={c['instagram'] or '-'} url={c['bio_url'] or '-'}")
        time.sleep(0.5)

    # Re-export with contact fields filled in
    export_scored_csv(step2_passed, output_final_csv)
    log.info("Phase 5 complete. Contact fields written to final CSV.")

    # Print top 20
    print("\n=== TOP 20 KOL CANDIDATES ===")
    for i, c in enumerate(step2_passed[:20], 1):
        print(f"{i:2d}. @{c['username']:<22} | score={c['final_score']:.3f} | "
              f"followers={c['followers']:,} | avg_views={c['avg_views']:,.0f} | "
              f"haul={c['has_haul_content']:.0%} | AI={c.get('ai_relevance_score') or 0:.2f} | "
              f"west={c.get('western_ratio') or 0:.0%} | {c.get('primary_category','')}")

    log.info(f"Done! {len(step2_passed)} final candidates → {output_final_csv}")


if __name__ == "__main__":
    main()
