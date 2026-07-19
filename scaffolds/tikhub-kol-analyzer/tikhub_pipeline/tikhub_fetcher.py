"""
TikHub data fetcher — primary backend.
Endpoints used:
  - fetch_video_search_result  : discover creators by keyword
  - fetch_user_post_videos     : get creator's video history
  - fetch_user_country_by_username : get creator's country
  - fetch_video_comments       : get commenters with region data
  - detect_fake_views          : fake view analysis
"""
import random
import time
import requests
from datetime import datetime
from shared.models import Creator, Video
from tikhub_pipeline.config import TIKHUB_KEY, SEARCH_KEYWORD, VIDEOS_TO_ANALYZE

BASE = "https://api.tikhub.io"
_RETRY_STATUSES = {401, 429, 500, 502, 503, 504}


def _get(
    endpoint: str,
    params: dict,
    timeout: int = 20,
    max_retries: int = 3,
    api_key: str = "",
) -> dict:
    key = (api_key or TIKHUB_KEY).strip()
    if not key:
        raise ValueError("TikHub API key is required")
    headers = {"Authorization": f"Bearer {key}"}
    last_exc = None
    for attempt in range(max_retries):
        try:
            r = requests.get(f"{BASE}{endpoint}", headers=headers, params=params, timeout=timeout)
            r.raise_for_status()
            return r.json()
        except requests.HTTPError as e:
            last_exc = e
            status = e.response.status_code if e.response is not None else 0
            if status in _RETRY_STATUSES and attempt < max_retries - 1:
                time.sleep((2 ** attempt) + random.random())
                continue
            raise
        except (requests.ConnectionError, requests.Timeout) as e:
            last_exc = e
            if attempt < max_retries - 1:
                time.sleep((2 ** attempt) + random.random())
                continue
            raise
    raise last_exc


# ── Creator discovery ──────────────────────────────────────────────────────────

def search_creators_by_keyword(
    keyword: str,
    max_creators: int = 50,
    api_key: str = "",
) -> list[dict]:
    """
    Search videos by keyword, deduplicate by creator unique_id.
    Returns list of raw aweme_info dicts (each contains author + stats).
    """
    seen: dict[str, dict] = {}
    offset = 0
    page_size = 20

    while len(seen) < max_creators:
        try:
            data = _get("/api/v1/tiktok/app/v3/fetch_video_search_result", {
                "keyword": keyword,
                "count": page_size,
                "offset": offset,
            }, api_key=api_key)["data"]
        except Exception as e:
            print(f"  [TikHub] search error at offset {offset}: {e}")
            break

        items = data.get("search_item_list", [])
        if not items:
            break

        for item in items:
            aweme = item.get("aweme_info", {})
            author = aweme.get("author", {})
            uid = author.get("unique_id", "")
            if uid and uid not in seen:
                seen[uid] = aweme

        if not data.get("has_more") or not items:
            break

        offset += page_size
        time.sleep(0.3)

    return list(seen.values())


# ── Per-creator data ───────────────────────────────────────────────────────────

def fetch_user_videos(
    username: str,
    count: int = VIDEOS_TO_ANALYZE,
    api_key: str = "",
) -> list[dict]:
    try:
        data = _get("/api/v1/tiktok/app/v3/fetch_user_post_videos", {
            "unique_id": username,
            "count": count,
        }, api_key=api_key)["data"]
        return data.get("aweme_list", [])
    except Exception as e:
        print(f"    [TikHub] videos error for @{username}: {e}")
        return []


def fetch_user_country(username: str, api_key: str = "") -> str:
    try:
        data = _get("/api/v1/tiktok/app/v3/fetch_user_country_by_username", {
            "username": username,
        }, api_key=api_key)["data"]
        return data.get("country", "")
    except Exception:
        return ""


def fetch_video_comments(video_id: str, count: int = 50, api_key: str = "") -> list[dict]:
    try:
        data = _get("/api/v1/tiktok/app/v3/fetch_video_comments", {
            "aweme_id": video_id,
            "count": count,
        }, api_key=api_key)["data"]
        return data.get("comments", [])
    except Exception as e:
        print(f"    [TikHub] comments error for video {video_id}: {e}")
        return []


def fetch_bio_url(username: str, api_key: str = "") -> str:
    """获取用户 profile 里的 bio 外链（linktr.ee 等）"""
    try:
        data = _get("/api/v1/tiktok/app/v3/handler_user_profile", {
            "unique_id": username,
        }, api_key=api_key)["data"]
        user = data.get("user", {})
        return user.get("bio_url", {}).get("link_url", "") or ""
    except Exception:
        return ""


def detect_fake_views(video_id: str, api_key: str = "") -> dict:
    try:
        data = _get("/api/v1/tiktok/analytics/detect_fake_views", {
            "item_id": video_id,
        }, api_key=api_key)["data"]
        analysis = data.get("fake_view_analysis", {})
        creator = data.get("creator_metrics", {})
        return {
            "fake_score": analysis.get("fake_score"),
            "trust_score": creator.get("trust_score"),
            "is_suspicious": analysis.get("is_suspicious", False),
            "reason": analysis.get("main_detection_reason", ""),
        }
    except Exception as e:
        print(f"    [TikHub] fake_view error for {video_id}: {e}")
        return {}


# ── Parser ─────────────────────────────────────────────────────────────────────

def _parse_video(raw: dict) -> Video:
    stats = raw.get("statistics", {})
    desc = raw.get("desc", "")
    challenges = raw.get("text_extra", raw.get("challenges", []))
    hashtags = []
    for tag in challenges:
        name = tag.get("hashtag_name", tag.get("title", ""))
        if name:
            hashtags.append(name.lower())
    for word in desc.split():
        if word.startswith("#"):
            hashtags.append(word[1:].lower())

    return Video(
        video_id=raw.get("aweme_id", raw.get("id", "")),
        description=desc,
        hashtags=list(set(hashtags)),
        views=stats.get("play_count", 0),
        likes=stats.get("digg_count", 0),
        comments=stats.get("comment_count", 0),
        shares=stats.get("share_count", 0),
        created_at=datetime.fromtimestamp(raw.get("create_time", 0)),
        # TikHub returns duration in milliseconds; convert to seconds
        duration=raw.get("video", {}).get("duration", 0) // 1000,
    )


def _parse_creator(aweme: dict, video_raws: list[dict]) -> Creator:
    author = aweme.get("author", {})
    return creator_from_video_rows(author.get("unique_id", ""), video_raws)


def creator_from_video_rows(username: str, video_raws: list[dict]) -> Creator:
    """Build one Creator consistently from TikHub post rows."""
    author = video_raws[0].get("author", {}) if video_raws else {}
    videos = [_parse_video(v) for v in video_raws]
    return Creator(
        user_id=author.get("uid", author.get("id", "")),
        username=author.get("unique_id") or username,
        nickname=author.get("nickname") or username,
        followers=author.get("follower_count", 0),
        following=author.get("following_count", 0),
        bio=author.get("signature", ""),
        videos=videos,
    )


# ── Main entry ─────────────────────────────────────────────────────────────────

def search_unique_usernames(
    keywords: dict[str, list[str]],
    pages_per_keyword: int = 2,
    results_per_page: int = 20,
) -> set[str]:
    """
    Iterate over a tiered keyword dict, search TikHub for each keyword,
    and return a deduplicated set of creator unique_ids.

    keywords format: {"tier1": [...], "tier2": [...], ...}
    """
    seen: set[str] = set()
    total_kw = sum(len(v) for v in keywords.values())
    done = 0

    for tier_name, kw_list in keywords.items():
        for keyword in kw_list:
            done += 1
            print(f"  [{done}/{total_kw}] [{tier_name}] {keyword}")
            offset = 0
            for _ in range(pages_per_keyword):
                try:
                    data = _get("/api/v1/tiktok/app/v3/fetch_video_search_result", {
                        "keyword": keyword,
                        "count":   results_per_page,
                        "offset":  offset,
                    })["data"]
                    items = data.get("search_item_list", [])
                    for item in items:
                        aweme  = item.get("aweme_info", {})
                        author = aweme.get("author", {})
                        uid = author.get("unique_id", "")
                        if uid:
                            seen.add(uid)
                    # Stop only when TikHub explicitly says no more, or nothing returned.
                    # Do NOT stop on len(items) < page_size — TikHub sometimes returns
                    # 19 items mid-stream while has_more is still True.
                    if not data.get("has_more") or not items:
                        break
                    offset += results_per_page
                except Exception as e:
                    print(f"    [TikHub] search error ({keyword}, offset={offset}): {e}")
                    break
                time.sleep(0.5)

    return seen


def fetch_creators(keyword: str = SEARCH_KEYWORD, max_creators: int = 50) -> list[Creator]:
    if not TIKHUB_KEY:
        raise ValueError("TIKHUB_KEY not set in config.py")

    print(f"[TikHub] Searching videos for '{keyword}'...")
    raw_awemes = search_creators_by_keyword(keyword, max_creators=max_creators)
    print(f"[TikHub] {len(raw_awemes)} unique creators found, fetching video history...")

    creators = []
    for i, aweme in enumerate(raw_awemes, 1):
        username = aweme.get("author", {}).get("unique_id", "unknown")
        try:
            video_raws = fetch_user_videos(username)
            creator = _parse_creator(aweme, video_raws)

            # Enrich with country
            creator.country = fetch_user_country(username)

            creators.append(creator)
            print(f"  [{i}/{len(raw_awemes)}] @{username} | "
                  f"{creator.followers:,} followers | "
                  f"{len(video_raws)} videos | "
                  f"country:{creator.country or '?'}")
            time.sleep(0.3)
        except Exception as e:
            print(f"  [{i}/{len(raw_awemes)}] @{username} — ERROR: {e}")

    return creators
