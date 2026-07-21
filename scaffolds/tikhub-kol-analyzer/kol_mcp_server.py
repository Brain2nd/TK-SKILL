"""MCP server for the TikTok KOL discovery and qualification toolkit.

Run with ``python kol_mcp_server.py`` (stdio transport).  The server exposes
small inspection tools for agent workflows plus the two existing end-to-end
pipelines, so callers do not need to shell out to the project's scripts.
"""
from __future__ import annotations

import os
import csv
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path
from statistics import mean
from typing import Any

from mcp.server.fastmcp import FastMCP

from env_loader import load_env_file


load_env_file(Path(__file__).with_name(".env"))

from contact_enrichment import enrich_contact
from feature_engine import compute_basic_features
from mass_discovery import SHOP_PROOF_VERIFIED
from models import Creator
from pipeline import calculate_scores, hard_filter, must_pass_filter
from social_fetcher import (
    get_instagram_user as tikhub_get_instagram_user,
    get_youtube_channel as tikhub_get_youtube_channel,
    search_instagram_users as tikhub_search_instagram_users,
    search_youtube_channels as tikhub_search_youtube_channels,
)
from tikhub_fetcher import (
    _parse_video,
    fetch_user_country,
    fetch_user_videos,
    search_creators_by_keyword,
)


PROJECT_DIR = Path(__file__).resolve().parent
EU5 = {"ES", "FR", "DE", "IT", "GB"}
mcp = FastMCP(
    "tiktok-kol-analyzer",
    instructions=(
        "Use FastMoss exclusively for TikTok Shop (TTS) creator discovery. "
        "Use TikHub for Instagram and YouTube data. inspect_creator covers "
        "general, non-TTS TikTok public-profile analysis only. Batch tools "
        "write their CSV results under output/."
    ),
)


def _clean_username(username: str) -> str:
    return username.strip().removeprefix("@").lower()


def _require_tikhub_key() -> None:
    if not (os.environ.get("TIKHUB_API_KEY") or os.environ.get("TIKHUB_KEY")):
        raise ValueError("TIKHUB_API_KEY (or TIKHUB_KEY) is required")


def _creator_from_videos(username: str, raw_videos: list[dict]) -> Creator:
    author = raw_videos[0].get("author", {})
    return Creator(
        user_id=author.get("uid", author.get("id", "")),
        username=author.get("unique_id", username),
        nickname=author.get("nickname", username),
        followers=int(author.get("follower_count") or 0),
        following=int(author.get("following_count") or 0),
        bio=author.get("signature", ""),
        videos=[_parse_video(video) for video in raw_videos],
    )


def _run_script(script: str, arguments: list[str]) -> dict[str, Any]:
    """Run one maintained CLI workflow and return bounded diagnostic output."""
    completed = subprocess.run(
        [sys.executable, script, *arguments], cwd=PROJECT_DIR, text=True,
        capture_output=True, timeout=60 * 60,
    )
    return {
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
        "stdout": completed.stdout[-12_000:],
        "stderr": completed.stderr[-4_000:],
    }


def _read_csv(path: Path, limit: int = 100) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))[:limit]


def _number(value: Any) -> float:
    try:
        return float(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


@mcp.tool()
def get_runtime_status() -> dict[str, Any]:
    """Report platform routing and whether each source is ready; no secrets."""
    profile = Path(os.environ.get(
        "FASTMOSS_BROWSER_PROFILE",
        PROJECT_DIR / "output" / ".fastmoss-browser-profile",
    ))
    ready = profile / "ready.json"
    missing_python_modules = [
        name for name in ("anthropic", "requests", "openpyxl", "dns", "mcp")
        if importlib.util.find_spec(name) is None
    ]
    node = os.environ.get("CODEX_NODE_BIN") or shutil.which("node")
    return {
        "python_supported": sys.version_info >= (3, 10),
        "missing_python_modules": missing_python_modules,
        "node_available": bool(node),
        "playwright_installed": (PROJECT_DIR / "node_modules" / "playwright").is_dir(),
        "tikhub_key_configured": bool(
            os.environ.get("TIKHUB_API_KEY") or os.environ.get("TIKHUB_KEY")
        ),
        "fastmoss_collection_mode": "website_only",
        "fastmoss_browser_session_ready": ready.exists(),
        "fastmoss_setup_command": str(PROJECT_DIR / "fastmoss_browser_setup.sh"),
        "doctor_command": f"{sys.executable} {PROJECT_DIR / 'doctor.py'}",
        "supported_countries": ["ES", "FR", "DE", "IT", "GB"],
        "platform_routes": {
            "tts": {"source": "fastmoss_web", "tikhub_allowed": False},
            "instagram": {"source": "tikhub_api"},
            "youtube": {"source": "tikhub_api"},
        },
    }


@mcp.tool()
def read_discovery_results(output_dir: str, limit: int = 100) -> dict[str, Any]:
    """Read structured rows and summary from a completed discovery output folder."""
    if not 1 <= limit <= 1000:
        raise ValueError("limit must be between 1 and 1000")
    out = Path(output_dir).expanduser()
    final_path = out / "final.csv"
    if not final_path.exists():
        final_path = out / "final_top1000.csv"
    summary_path = out / "summary.json"
    summary = {}
    if summary_path.exists():
        import json
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
    return {"output_dir": str(out), "summary": summary, "rows": _read_csv(final_path, limit)}


@mcp.tool()
def validate_discovery_output(output_dir: str, expected_rows: int = 10) -> dict[str, Any]:
    """Audit final output against EU5, follower, shop and verified-email rules."""
    out = Path(output_dir).expanduser()
    path = out / "final.csv"
    if not path.exists():
        path = out / "final_top1000.csv"
    rows = _read_csv(path, max(expected_rows, 1000))
    violations: list[dict[str, Any]] = []
    seen_non_es = False
    for index, row in enumerate(rows, 1):
        country = str(row.get("country") or "").upper()
        try:
            followers = int(float(row.get("followers") or 0))
        except (TypeError, ValueError):
            followers = 0
        reasons = []
        if country not in EU5:
            reasons.append("country_not_eu5")
        if not 0 < followers < 10_000:
            reasons.append("followers_not_under_10000")
        if str(row.get("shop_valid") or "").lower() != "true":
            reasons.append("shop_not_verified")
        if row.get("shop_proof") != SHOP_PROOF_VERIFIED:
            reasons.append("shop_proof_not_normalized")
        if not row.get("shop_proof_method"):
            reasons.append("shop_proof_method_missing")
        if not str(row.get("source") or "").lower().startswith("fastmoss"):
            reasons.append("tts_source_not_fastmoss")
        if not row.get("email"):
            reasons.append("email_empty")
        if str(row.get("email_verified") or "").lower() != "true":
            reasons.append("email_not_verified")
        if country != "ES":
            seen_non_es = True
        elif seen_non_es:
            reasons.append("spain_not_prioritized")
        if reasons:
            violations.append({"rank": index, "username": row.get("username"), "reasons": reasons})
    return {
        "valid": len(rows) == expected_rows and not violations,
        "row_count": len(rows),
        "expected_rows": expected_rows,
        "violations": violations,
        "file": str(path),
    }


@mcp.tool()
def search_creators(keyword: str, limit: int = 50) -> list[dict[str, Any]]:
    """Search TikTok videos and return distinct creator accounts for a keyword."""
    _require_tikhub_key()
    if not keyword.strip():
        raise ValueError("keyword must not be empty")
    if not 1 <= limit <= 200:
        raise ValueError("limit must be between 1 and 200")
    results = search_creators_by_keyword(keyword.strip(), max_creators=limit)
    return [
        {
            "username": item.get("author", {}).get("unique_id", ""),
            "nickname": item.get("author", {}).get("nickname", ""),
            "followers": item.get("author", {}).get("follower_count", 0),
            "description": item.get("desc", ""),
        }
        for item in results
    ]


@mcp.tool()
def inspect_creator(
    username: str,
    recent_videos: int = 10,
    verify_email_dns: bool = True,
    scrape_bio_link: bool = True,
) -> dict[str, Any]:
    """Inspect a general TikTok profile; this tool does not determine TTS status."""
    _require_tikhub_key()
    username = _clean_username(username)
    if not username:
        raise ValueError("username must not be empty")
    if not 1 <= recent_videos <= 30:
        raise ValueError("recent_videos must be between 1 and 30")

    raw_videos = fetch_user_videos(username, count=recent_videos)
    if not raw_videos:
        return {"username": username, "found": False, "reason": "no_videos"}
    creator = _creator_from_videos(username, raw_videos)
    videos = creator.videos
    row: dict[str, Any] = {
        "username": creator.username,
        "found": True,
        "platform": "tiktok",
        "data_scope": "public_profile_non_tts",
        "tts_source": "fastmoss_only",
        "country": fetch_user_country(username),
        "followers": creator.followers,
        "following": creator.following,
        "bio": creator.bio.replace("\n", " "),
        "profile_url": f"https://www.tiktok.com/@{creator.username}",
        "video_count": len(videos),
        "avg_views": round(mean(video.views for video in videos)),
        "engagement_rate": round(mean(
            (video.likes + video.comments + video.shares) / max(video.views, 1)
            for video in videos
        ), 4),
    }
    return enrich_contact(
        row, profile_payload={"aweme_list": raw_videos},
        verify_dns=verify_email_dns, scrape_link=scrape_bio_link,
    )


@mcp.tool()
def analyze_creator_features(username: str, recent_videos: int = 10) -> dict[str, Any]:
    """Compute the existing Step-1 feature set and its hard-filter decision."""
    _require_tikhub_key()
    username = _clean_username(username)
    raw_videos = fetch_user_videos(username, count=recent_videos)
    if not raw_videos:
        return {"username": username, "found": False, "reason": "no_videos"}
    features = compute_basic_features(_creator_from_videos(username, raw_videos))
    passed, reason = hard_filter(features)
    return {**features, "hard_filter_passed": passed, "hard_filter_reason": reason}


@mcp.tool()
def search_instagram_creators(query: str) -> dict[str, Any]:
    """Search Instagram creator accounts through TikHub Instagram V1."""
    _require_tikhub_key()
    if not query.strip():
        raise ValueError("query must not be empty")
    return {
        "platform": "instagram",
        "source": "tikhub",
        "response": tikhub_search_instagram_users(query.strip()),
    }


@mcp.tool()
def get_instagram_creator(username: str) -> dict[str, Any]:
    """Fetch one Instagram creator profile through TikHub Instagram V1."""
    _require_tikhub_key()
    username = username.strip().removeprefix("@")
    if not username:
        raise ValueError("username must not be empty")
    return {
        "platform": "instagram",
        "source": "tikhub",
        "response": tikhub_get_instagram_user(username),
    }


@mcp.tool()
def search_youtube_creators(
    keyword: str,
    continuation_token: str = "",
) -> dict[str, Any]:
    """Search YouTube channels through TikHub YouTube Web V2."""
    _require_tikhub_key()
    if not keyword.strip() and not continuation_token.strip():
        raise ValueError("keyword or continuation_token is required")
    return {
        "platform": "youtube",
        "source": "tikhub",
        "response": tikhub_search_youtube_channels(
            keyword.strip(), continuation_token.strip()
        ),
    }


@mcp.tool()
def get_youtube_creator(
    channel_id: str,
    continuation_token: str = "",
) -> dict[str, Any]:
    """Fetch one YouTube channel and public links through TikHub Web V2."""
    _require_tikhub_key()
    if not channel_id.strip() and not continuation_token.strip():
        raise ValueError("channel_id or continuation_token is required")
    return {
        "platform": "youtube",
        "source": "tikhub",
        "response": tikhub_get_youtube_channel(
            channel_id.strip(), continuation_token.strip()
        ),
    }


@mcp.tool()
def enrich_contact_info(
    bio: str,
    bio_url: str = "",
    verify_email_dns: bool = True,
    scrape_bio_link: bool = True,
) -> dict[str, Any]:
    """Extract and conservatively validate publicly listed creator contact data."""
    return enrich_contact(
        {"bio": bio, "bio_url": bio_url}, verify_dns=verify_email_dns,
        scrape_link=scrape_bio_link,
    )


@mcp.tool()
def score_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply the existing Step-2 gate and weighted ranking to supplied features."""
    rows = [dict(candidate) for candidate in candidates]
    for row in rows:
        passed, reason = must_pass_filter(row)
        row["must_pass"] = passed
        row["must_pass_reason"] = reason
    qualified = [row for row in rows if row["must_pass"]]
    calculate_scores(qualified)
    qualified.sort(key=lambda row: row.get("final_score") or 0, reverse=True)
    return qualified


@mcp.tool()
def run_kol_filter(
    keywords: list[str],
    output_dir: str = "output/mcp_kol_filter",
    max_creators: int = 0,
    skip_fake_view_check: bool = False,
) -> dict[str, Any]:
    """Run the existing full Dogegoo discovery/filter/ranking workflow."""
    if not keywords:
        raise ValueError("provide at least one keyword")
    args = ["--keywords", *keywords, "--output-dir", output_dir]
    if max_creators:
        args.extend(["--max", str(max_creators)])
    if skip_fake_view_check:
        args.append("--no-fake")
    return _run_script("main.py", args)


@mcp.tool()
def run_multi_round_search(
    keyword: str,
    rounds: int = 3,
    interval_seconds: int = 86_400,
    pages: int | None = None,
    skip_fake_view_check: bool = False,
) -> dict[str, Any]:
    """Run repeated keyword discovery, then the existing full qualification flow."""
    if not keyword.strip() or rounds < 1 or interval_seconds < 0:
        raise ValueError("keyword is required; rounds >= 1 and interval_seconds >= 0")
    args = ["--keyword", keyword, "--runs", str(rounds), "--interval", str(interval_seconds)]
    if pages is not None:
        args.extend(["--pages", str(pages)])
    if skip_fake_view_check:
        args.append("--no-fake")
    return _run_script("main.py", args)


@mcp.tool()
def extract_creator_feature_file(input_file: str, output_file: str = "output/creator_features_raw.csv") -> dict[str, Any]:
    """Compute the full existing feature dataset for usernames/URLs in a file."""
    if not input_file.strip():
        raise ValueError("input_file is required")
    return _run_script("fetch_creator_features.py", ["--file", input_file, "--output", output_file])


@mcp.tool()
def enrich_and_rank_candidate_file(
    input_csv: str,
    output_csv: str = "output/mcp_ranked_candidates.csv",
    target: int = 100,
) -> dict[str, Any]:
    """Extract public emails and rank an existing candidate CSV without TikHub calls."""
    if not input_csv.strip() or target < 1:
        raise ValueError("input_csv is required and target must be at least 1")
    source = Path(input_csv).expanduser()
    if not source.exists():
        raise ValueError(f"input CSV does not exist: {source}")
    rows = _read_csv(source, 1_000_000)
    enriched = [enrich_contact(row) for row in rows]
    eligible = [row for row in enriched if row.get("email")]
    eligible.sort(key=lambda row: (
        str(row.get("country") or "").upper() == "ES",
        _number(row.get("avg_views_10") or row.get("avg_views")),
        _number(row.get("followers")),
    ), reverse=True)
    selected = eligible[:target]
    for rank, row in enumerate(selected, 1):
        row["rank"] = rank
    destination = Path(output_csv).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    fields = list(dict.fromkeys(
        ["rank"] + list(rows[0].keys() if rows else [])
        + ["email", "email_source", "email_verified", "bio_url"]
    ))
    with destination.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(selected)
    return {
        "ok": True, "input_rows": len(rows), "email_rows": len(eligible),
        "output_rows": len(selected), "output_file": str(destination),
    }


@mcp.tool()
def run_shop_discovery(
    output_dir: str = "output/mcp_tts_fastmoss",
    target: int = 100,
    countries: list[str] | None = None,
    fastmoss_exports: list[str] | None = None,
    max_followers: int = 10_000,
    pool_multiplier: float = 4.0,
    inspect_workers: int = 30,
    browser_enabled: bool = True,
    headed: bool = False,
    resume: bool = False,
    verify_email_dns: bool = True,
    early_stop: bool = True,
) -> dict[str, Any]:
    """Run TikTok Shop creator discovery exclusively through FastMoss."""
    if target < 1 or max_followers < 1 or pool_multiplier < 1 or inspect_workers < 1:
        raise ValueError("target, max_followers, pool_multiplier and workers must be positive")
    args = [
        "--target", str(target),
        "--max-followers", str(max_followers),
        "--pool-multiplier", str(pool_multiplier),
        "--inspect-workers", str(inspect_workers),
        "--output-dir", output_dir,
    ]
    if countries:
        args.extend(["--countries", *countries])
    for path in fastmoss_exports or []:
        args.extend(["--fastmoss-export", path])
    if not browser_enabled:
        args.append("--no-fastmoss-browser")
    if headed:
        args.append("--fastmoss-headed")
    if resume:
        args.append("--resume")
    if not verify_email_dns:
        args.append("--skip-email-dns")
    if not early_stop:
        args.append("--no-early-stop")
    result = _run_script("mass_discovery.py", args)
    return {
        **result,
        "platform": "tts",
        "source": "fastmoss",
        "tikhub_requests": 0,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
