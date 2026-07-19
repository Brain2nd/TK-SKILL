"""TikHub-backed Instagram and YouTube data access."""
from __future__ import annotations

from typing import Any

import requests

from tikhub_pipeline.config import TIKHUB_API_KEY


BASE_URL = "https://api.tikhub.io"


def _get(endpoint: str, params: dict[str, Any]) -> dict[str, Any]:
    if not TIKHUB_API_KEY:
        raise ValueError("TIKHUB_API_KEY is required for Instagram/YouTube")
    response = requests.get(
        f"{BASE_URL}{endpoint}",
        headers={"Authorization": f"Bearer {TIKHUB_API_KEY}"},
        params={key: value for key, value in params.items() if value not in (None, "")},
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def search_instagram_users(query: str) -> dict[str, Any]:
    """Search Instagram users through TikHub Instagram V1."""
    return _get(
        "/api/v1/instagram/v1/fetch_search",
        {"query": query, "select": "users"},
    )


def get_instagram_user(username: str) -> dict[str, Any]:
    """Fetch one Instagram user profile through TikHub Instagram V1."""
    return _get(
        "/api/v1/instagram/v1/fetch_user_info_by_username",
        {"username": username.lstrip("@")},
    )


def search_youtube_channels(
    keyword: str,
    continuation_token: str = "",
) -> dict[str, Any]:
    """Search YouTube channels through TikHub YouTube Web V2."""
    return _get(
        "/api/v1/youtube/web_v2/get_general_search_v2",
        {
            "keyword": keyword if not continuation_token else "",
            "continuation_token": continuation_token,
            "type": "channel",
        },
    )


def get_youtube_channel(
    channel_id: str,
    continuation_token: str = "",
) -> dict[str, Any]:
    """Fetch YouTube channel description/social links through TikHub Web V2."""
    return _get(
        "/api/v1/youtube/web_v2/get_channel_description",
        {
            "channel_id": channel_id if not continuation_token else "",
            "continuation_token": continuation_token,
            "need_format": "true",
        },
    )
