"""MCP server for the TikTok KOL discovery and qualification toolkit.

Run with ``python kol_mcp_server.py`` (stdio transport).  The server exposes
small inspection tools for agent workflows plus the two existing end-to-end
pipelines, so callers do not need to shell out to the project's scripts.
"""
from __future__ import annotations

import asyncio
import os
import csv
import importlib.util
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any

from mcp.server.fastmcp import FastMCP

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.env_loader import load_env_file
from shared.feishu_bitable import BitableConfig, sync_csv


load_env_file(Path(__file__).resolve().parent.parent / ".env")

from shared.contact_enrichment import enrich_contact
from fastmoss_pipeline.api_client import FastMossApiClient
from fastmoss_pipeline.scraper import (
    FastMossAuthRequired,
    FastMossBlocked,
    FastMossError,
    FastMossScraper,
    FastMossVerificationRequired,
    SearchCriteria,
    matches_criteria,
    normalize_record,
    write_result_csv,
)
from tikhub_pipeline.feature_engine import compute_basic_features
from shared.mcp_runtime import read_csv, run_project_script
from shared.models import Creator
from tikhub_pipeline.pipeline import calculate_scores, hard_filter, must_pass_filter
from tikhub_pipeline.social_fetcher import (
    get_instagram_user as tikhub_get_instagram_user,
    get_youtube_channel as tikhub_get_youtube_channel,
    search_instagram_users as tikhub_search_instagram_users,
    search_youtube_channels as tikhub_search_youtube_channels,
)
from tikhub_pipeline.tikhub_fetcher import (
    _parse_video,
    fetch_user_country,
    fetch_user_videos,
    search_creators_by_keyword,
)


PROJECT_DIR = Path(__file__).resolve().parent.parent

SPAIN_DISCOVERY_KEYWORDS = [
    "belleza", "maquillaje", "skincare", "moda", "hogar", "cocina",
    "limpieza", "fitness", "maternidad", "mascotas", "tecnología",
    "unboxing", "reseña producto", "productos virales", "ofertas",
    "tiktok shop españa",
]

mcp = FastMCP(
    "creator-search",
    instructions=(
        "Route creator searches exactly as the user requests. If the user did not "
        "name a source, ask them to choose TikHub or FastMoss before searching. "
        "For TikHub, ask for an API key only when no configured key exists, then "
        "call search_tikhub_creators_by_features. For FastMoss, call "
        "get_creator_search_access first; ask for username/password only when it "
        "reports auth_required, then call search_fastmoss_creators_by_features. "
        "Never log, echo, persist, or include credentials in results. Never call "
        "both sources unless the user explicitly requests a comparison."
    ),
)


def _clean_username(username: str) -> str:
    return username.strip().removeprefix("@").lower()


def _require_tikhub_key() -> None:
    if not (os.environ.get("TIKHUB_API_KEY") or os.environ.get("TIKHUB_KEY")):
        raise ValueError("TIKHUB_API_KEY (or TIKHUB_KEY) is required")


def _search_error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, FastMossError):
        return {"ok": False, "status": exc.code, "message": str(exc)}
    return {"ok": False, "status": "error", "message": str(exc)}


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


def _number(value: Any) -> float:
    try:
        return float(str(value or "0").replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


@mcp.tool()
def get_runtime_status() -> dict[str, Any]:
    """Report TikHub/LLM readiness for the non-TTS creator tools."""
    missing_python_modules = [
        name for name in ("anthropic", "requests", "dns", "mcp")
        if importlib.util.find_spec(name) is None
    ]
    return {
        "service": "creator-search",
        "python_supported": sys.version_info >= (3, 10),
        "missing_python_modules": missing_python_modules,
        "legacy_tikhub_key_configured": bool(
            os.environ.get("TIKHUB_API_KEY") or os.environ.get("TIKHUB_KEY")
        ),
        "agent_tikhub_credential_mode": "per_call",
        "platform_routes": {
            "tiktok_non_tts": {"source": "tikhub_api"},
            "instagram": {"source": "tikhub_api"},
            "youtube": {"source": "tikhub_api"},
            "tts": {"source": "fastmoss_browser", "available_here": True},
        },
        "fastmoss_session_configured": FastMossScraper().has_saved_session,
        "fastmoss_api_cookie_available": FastMossApiClient().has_cookies,
        "feishu_bitable_configured": BitableConfig.from_env(required=False) is not None,
    }


@mcp.tool()
def get_creator_search_access(source: str) -> dict[str, Any]:
    """Tell the agent which user credential, if any, must be requested next."""
    selected = source.strip().lower()
    if selected == "tikhub":
        return {
            "ok": True,
            "source": "tikhub",
            "status": "auth_required",
            "request_from_user": ["api_key"],
            "credential_policy": "use_for_current_call_only",
        }
    if selected == "fastmoss":
        configured = FastMossScraper().has_saved_session
        return {
            "ok": True,
            "source": "fastmoss",
            "status": "ready" if configured else "auth_required",
            "request_from_user": [] if configured else ["username", "password"],
            "credential_policy": "credentials_are_not_saved; only the website session is persisted",
        }
    return {
        "ok": False,
        "status": "source_required",
        "message": "Ask the user to choose exactly one source: tikhub or fastmoss",
    }


@mcp.tool()
def search_tikhub_creators_by_features(
    features: dict[str, Any],
    api_key: str = "",
    limit: int = 50,
) -> dict[str, Any]:
    """Search TikHub using user-supplied creator features and an in-memory API key."""
    try:
        criteria = SearchCriteria.from_dict(features)
        key = api_key.strip()
        if not key:
            return {
                "ok": False,
                "source": "tikhub",
                "status": "tikhub_auth_required",
                "request_from_user": ["api_key"],
            }
        if not criteria.keyword:
            raise ValueError("TikHub search requires features.keyword")
        if not 1 <= limit <= 1_000:
            raise ValueError("limit must be between 1 and 1000")
        raw_items = search_creators_by_keyword(
            criteria.keyword,
            max_creators=min(1_000, max(limit * 3, limit)),
            api_key=key,
        )
        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in raw_items:
            author = dict(item.get("author") or {})
            author["bio"] = author.get("signature") or item.get("desc") or ""
            author["avg_views"] = (item.get("statistics") or {}).get("play_count") or 0
            if criteria.countries and not (author.get("region") or author.get("country")):
                username = str(author.get("unique_id") or "")
                if username:
                    author["country"] = fetch_user_country(username, api_key=key)
            row = normalize_record(author)
            if not row or row["username"] in seen or not matches_criteria(row, criteria):
                continue
            row["source"] = "tikhub_api"
            row["avg_views_note"] = "discovery_video_views"
            results.append(row)
            seen.add(row["username"])
            if len(results) >= limit:
                break
        return {
            "ok": True,
            "status": "complete" if len(results) >= limit else "partial",
            "source": "tikhub",
            "count": len(results),
            "criteria": asdict(criteria),
            "results": results,
        }
    except Exception as exc:
        return {"ok": False, "source": "tikhub", "status": "error", "message": str(exc)}


@mcp.tool()
async def login_fastmoss(
    username: str,
    password: str,
    verification_timeout: int = 300,
) -> dict[str, Any]:
    """Create a local FastMoss browser session; never persist the supplied credentials."""
    try:
        return await asyncio.to_thread(
            FastMossScraper().login, username, password, verification_timeout
        )
    except Exception as exc:
        return _search_error(exc)


@mcp.tool()
async def search_fastmoss_creators_by_features(
    features: dict[str, Any],
    username: str = "",
    password: str = "",
    limit: int = 50,
    headed: bool = False,
    verification_timeout: int = 300,
) -> dict[str, Any]:
    """Search the FastMoss Creator UI and save a normalized local CSV audit."""
    try:
        result = await asyncio.to_thread(
            FastMossScraper().search,
            features,
            limit=limit,
            username=username,
            password=password,
            headed=headed,
            verification_timeout=verification_timeout,
        )
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        destination = PROJECT_DIR / "output" / "fastmoss" / f"creator-search-{stamp}.csv"
        result["output_file"] = str(write_result_csv(result, destination))
        return result
    except Exception as exc:
        return _search_error(exc)


# FastMoss contact API client, authenticated from the managed browser session.

_FASTMOSS_API_CLIENT: FastMossApiClient | None = None


def _get_api_client() -> FastMossApiClient:
    global _FASTMOSS_API_CLIENT
    if _FASTMOSS_API_CLIENT is None:
        _FASTMOSS_API_CLIENT = FastMossApiClient()
    return _FASTMOSS_API_CLIENT


@mcp.tool()
async def collect_fastmoss_candidates(
    features: dict[str, Any],
    limit: int = 5000,
    username: str = "",
    password: str = "",
    headed: bool = False,
    verification_timeout: int = 300,
    output_csv: str = "",
) -> dict[str, Any]:
    """Collect FastMoss creator candidates and save a resumable CSV artifact.

    Drive a managed Playwright browser, persist the website session, capture search
    responses, applies local filters, and preserves ``uid`` for subsequent
    ``harvest_fastmoss_emails`` calls. It never requires a copied Cookie header.

    Args:
        features: Creator filters accepted by ``SearchCriteria``.
        limit: Maximum rows to save.
        username: FastMoss account, required only for the first login.
        password: FastMoss password, required only for the first login.
        headed: Force a visible browser even when a saved session exists.
        verification_timeout: Seconds to allow for human verification.
        output_csv: Optional destination. Defaults to a timestamped file under
            ``output/fastmoss``.
    """
    try:
        result = await asyncio.to_thread(
            FastMossScraper().search,
            features,
            limit=limit,
            username=username,
            password=password,
            headed=headed,
            verification_timeout=verification_timeout,
        )
    except Exception as exc:
        return _search_error(exc)

    rows = result.get("results") or []

    if output_csv:
        destination = Path(output_csv).expanduser().resolve()
    else:
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        destination = PROJECT_DIR / "output" / "fastmoss" / f"browser-collect-{stamp}.csv"
    _write_csv(rows, destination)
    return {
        "ok": True,
        "status": result.get("status", "complete"),
        "count": len(rows),
        "warnings": result.get("warnings", []),
        "output_file": str(destination),
        "email_ready": all(bool(row.get("uid")) for row in rows),
    }


@mcp.tool()
def sync_candidate_csv_to_feishu_base(csv_file: str) -> dict[str, Any]:
    """Upsert a candidate CSV into the configured Feishu Base by username."""
    return sync_csv(csv_file, required=True)


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
        "tts_source": "unsupported",
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
    return run_project_script("tikhub_pipeline/main.py", args)


@mcp.tool()
def run_multi_round_search(
    keyword: str = "",
    keywords: list[str] | None = None,
    rounds: int = 3,
    interval_seconds: int = 0,
    pages: int | None = None,
    skip_fake_view_check: bool = False,
    api_key: str = "",
    output_dir: str = "output/multi-round",
) -> dict[str, Any]:
    """Run one or many keywords repeatedly, then the full qualification flow."""
    terms = list(dict.fromkeys(
        item.strip() for item in ([keyword] if keyword.strip() else []) + (keywords or [])
        if item.strip()
    ))
    if not terms or rounds < 1 or interval_seconds < 0:
        raise ValueError("keyword(s) required; rounds >= 1 and interval_seconds >= 0")
    key = api_key.strip() or os.environ.get("TIKHUB_API_KEY", "") or os.environ.get("TIKHUB_KEY", "")
    if not key:
        return {"ok": False, "source": "tikhub", "status": "tikhub_auth_required", "request_from_user": ["api_key"]}
    args = ["--keywords", *terms, "--runs", str(rounds), "--interval", str(interval_seconds), "--output-dir", output_dir]
    if pages is not None:
        args.extend(["--pages", str(pages)])
    if skip_fake_view_check:
        args.append("--no-fake")
    result = run_project_script(
        "tikhub_pipeline/main.py", args, env_overrides={"TIKHUB_API_KEY": key}
    )
    result.update({
        "source": "tikhub", "keywords": terms,
        "output_file": str((PROJECT_DIR / output_dir / "final.csv").resolve()),
    })
    return result


@mcp.tool()
async def discover_spain_creators_deep(
    fastmoss_username: str = "",
    fastmoss_password: str = "",
    tikhub_api_key: str = "",
    keywords: list[str] | None = None,
    limit: int = 500,
    max_followers: int = 10_000,
    rounds: int = 3,
    pages: int = 5,
    headed: bool = False,
) -> dict[str, Any]:
    """Run FastMoss keyword discovery and TikHub multi-round discovery in parallel for Spain."""
    terms = list(dict.fromkeys(item.strip() for item in (keywords or SPAIN_DISCOVERY_KEYWORDS) if item.strip()))
    if not terms:
        raise ValueError("provide at least one keyword")
    if not 1 <= limit <= 5_000 or max_followers < 0 or rounds < 1 or pages < 1:
        raise ValueError("invalid limit, max_followers, rounds, or pages")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    tikhub_dir = f"output/deep-spain/{stamp}/tikhub"

    async def fastmoss_branch() -> dict[str, Any]:
        try:
            result = await asyncio.to_thread(
                FastMossScraper().search,
                {"keywords": terms, "countries": ["ES"], "max_followers": max_followers},
                limit=limit, username=fastmoss_username, password=fastmoss_password,
                headed=headed,
            )
            destination = PROJECT_DIR / "output" / "deep-spain" / stamp / "fastmoss.csv"
            result["output_file"] = str(write_result_csv(result, destination))
            return result
        except Exception as exc:
            return _search_error(exc) | {"source": "fastmoss"}

    async def tikhub_branch() -> dict[str, Any]:
        return await asyncio.to_thread(
            run_multi_round_search,
            keywords=terms, rounds=rounds, interval_seconds=0, pages=pages,
            api_key=tikhub_api_key, output_dir=tikhub_dir,
        )

    fastmoss_result, tikhub_result = await asyncio.gather(fastmoss_branch(), tikhub_branch())
    return {
        "ok": bool(fastmoss_result.get("ok") or tikhub_result.get("ok")),
        "status": "complete" if fastmoss_result.get("ok") and tikhub_result.get("ok") else "partial",
        "country": "ES", "keywords": terms, "max_followers": max_followers,
        "sources": {"fastmoss": fastmoss_result, "tikhub": tikhub_result},
    }


@mcp.tool()
def extract_creator_feature_file(input_file: str, output_file: str = "output/creator_features_raw.csv") -> dict[str, Any]:
    """Compute the full existing feature dataset for usernames/URLs in a file."""
    if not input_file.strip():
        raise ValueError("input_file is required")
    return run_project_script(
        "tikhub_pipeline/fetch_creator_features.py", ["--file", input_file, "--output", output_file]
    )


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
    rows = read_csv(source, 1_000_000)
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
# ---------------------------------------------------------------------------
# FastMoss email harvesting & CSV merge
# ---------------------------------------------------------------------------


@mcp.tool()
async def harvest_fastmoss_emails(
    input_csv: str,
    output_csv: str = "",
    delay_ms: int = 400,
) -> dict[str, Any]:
    """Harvest creator emails from FastMoss detail pages via the authorContact API.

    Reads a candidate CSV (must have ``uid`` and ``unique_id`` columns), calls
    the internal ``/api/author/v3/detail/authorContact`` endpoint for each
    creator, and writes an enriched CSV with ``email`` and ``email_source``
    columns.

    Authentication cookies are extracted automatically from the persistent
    FastMoss browser session. No DevTools or manual cookie copying is needed.

    Stops early on ``MSG_SAFE_0001`` (rate-limit) and saves partial results.

    Args:
        input_csv: Path to a candidate CSV returned by `collect_fastmoss_candidates`.
        output_csv: Path for enriched CSV. Defaults to
            ``<input>_with_emails.csv``.
        delay_ms: Delay between API calls in milliseconds (default 400).
    """
    source = Path(input_csv).expanduser()
    if not source.exists():
        raise ValueError(f"input_csv not found: {source}")

    destination = Path(output_csv).expanduser() if output_csv else source.with_name(
        source.stem + "_with_emails" + source.suffix
    )

    rows = read_csv(source, 1_000_000)
    if not rows:
        return {"ok": False, "reason": "input CSV is empty"}

    client = _get_api_client()
    cookie_ready = client.has_cookies and await asyncio.to_thread(client._probe_auth)
    if not cookie_ready:
        try:
            await asyncio.to_thread(client.refresh_cookies_from_browser)
        except Exception as exc:
            return _search_error(exc)
    total = len(rows)
    success = 0
    rate_limited = 0
    errors = 0

    async def _batch() -> dict[str, Any]:
        nonlocal success, rate_limited, errors
        for i, row in enumerate(rows):
            uid = str(row.get("uid") or row.get("unique_id", ""))
            if not uid:
                errors += 1
                continue

            # Skip rows that already have a valid email
            if row.get("email") and row["email"].strip():
                continue

            result = await asyncio.to_thread(client.get_author_contact, uid)
            err = result.get("error")
            if err:
                if "MSG_SAFE_0001" in str(err):
                    rate_limited += 1
                    # Save partial results
                    _write_csv(rows, destination)
                    return {
                        "ok": True,
                        "status": "rate_limited",
                        "total": total,
                        "processed": i,
                        "with_email": sum(1 for r in rows if r.get("email", "").strip()),
                        "errors": errors,
                        "rate_limited_at": i,
                        "output_file": str(destination),
                        "hint": "Wait a few minutes then re-run to resume from where it stopped.",
                    }
                errors += 1
            elif result.get("has_email"):
                row["email"] = result["email"]
                row["email_source"] = "detail_api"
                success += 1

            await asyncio.sleep(delay_ms / 1000)

        _write_csv(rows, destination)
        return {
            "ok": True,
            "status": "complete",
            "total": total,
            "with_email": sum(1 for r in rows if r.get("email", "").strip()),
            "new_emails": success,
            "errors": errors,
            "rate_limited": rate_limited,
            "output_file": str(destination),
        }

    return await _batch()


@mcp.tool()
def merge_fastmoss_csvs(
    csv1: str,
    csv2: str,
    output_csv: str = "",
) -> dict[str, Any]:
    """Merge two FastMoss candidate CSVs, deduplicating by username.

    When a creator appears in both files, the row with a non-empty email is
    kept.  Suitable for combining multiple collection rounds (e.g. batch-1
    vs batch-2) into a single deduplicated file.

    Args:
        csv1: First candidate CSV.
        csv2: Second candidate CSV.
        output_csv: Path for merged CSV. Default: ``merged_deduped.csv`` in
            the same directory as ``csv1``.
    """
    p1 = Path(csv1).expanduser()
    p2 = Path(csv2).expanduser()
    if not p1.exists():
        raise ValueError(f"csv1 not found: {p1}")
    if not p2.exists():
        raise ValueError(f"csv2 not found: {p2}")

    dest = Path(output_csv).expanduser() if output_csv else p1.parent / "merged_deduped.csv"

    rows1 = read_csv(p1, 1_000_000)
    rows2 = read_csv(p2, 1_000_000)

    merged: dict[str, dict[str, Any]] = {}
    for row in rows1 + rows2:
        key = str(row.get("unique_id") or row.get("username", "")).strip().lower()
        if not key:
            continue
        if key not in merged:
            merged[key] = row
        else:
            # Prefer row with email
            existing_email = merged[key].get("email", "").strip()
            new_email = row.get("email", "").strip()
            if new_email and not existing_email:
                merged[key] = row

    dest.parent.mkdir(parents=True, exist_ok=True)
    fields = list(merged[list(merged.keys())[0]].keys()) if merged else []
    with dest.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(merged.values())

    with_email = sum(1 for r in merged.values() if r.get("email", "").strip())
    return {
        "ok": True,
        "csv1_rows": len(rows1),
        "csv2_rows": len(rows2),
        "deduped": len(merged),
        "overlap": len(rows1) + len(rows2) - len(merged),
        "with_email": with_email,
        "output_file": str(dest),
    }


def _write_csv(rows: list[dict[str, Any]], destination: Path) -> None:
    """Write a list of dict rows to a CSV file, normalising field names."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Collect all field names, with email/email_source at end
    seen_fields: dict[str, bool] = {}
    all_fields: list[str] = []
    for row in rows:
        for k in row:
            if k not in seen_fields:
                seen_fields[k] = True
                all_fields.append(k)
    # Reorder: email + email_source at end
    extra = ["email", "email_source"]
    ordered = [f for f in all_fields if f not in extra] + [f for f in extra if f in seen_fields]
    with destination.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ordered, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    mcp.run(transport="stdio")
