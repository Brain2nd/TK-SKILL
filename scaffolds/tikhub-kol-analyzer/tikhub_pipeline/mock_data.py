"""Deterministic offline fixtures for exercising the full pipeline.

The fixtures deliberately include one strong candidate and one candidate that
fails Step 1 so ``python main.py --mock`` validates both funnel branches
without using TikHub, Claude, or the public internet.
"""
from datetime import datetime, timedelta

from shared.models import Creator, Video


def _videos(prefix: str, views: list[int], *, relevant: bool) -> list[Video]:
    now = datetime.now()
    videos = []
    for i, view_count in enumerate(views):
        caption = (
            "Taobao anime merch haul — use my code, link in bio #anime #taobao #haul"
            if relevant else "A quiet day at home #lifestyle"
        )
        videos.append(Video(
            video_id=f"{prefix}-{i}", description=caption,
            hashtags=["anime", "taobao", "haul"] if relevant else ["lifestyle"],
            views=view_count, likes=int(view_count * 0.12),
            comments=max(8, int(view_count * 0.004)), shares=int(view_count * 0.015),
            created_at=now - timedelta(days=i * 2), duration=28,
        ))
    return videos


MOCK_CREATORS = [
    Creator(
        user_id="mock-1", username="mock_anime_haul", nickname="Mock Anime Haul",
        followers=24_000, following=410,
        bio="Business: hello@mockcreator.test | IG: mock.creator | linktr.ee/mockcreator",
        country="US", videos=_videos("good", [42000, 36000, 31000, 28000, 25000, 22000], relevant=True),
    ),
    Creator(
        user_id="mock-2", username="mock_inactive", nickname="Mock Inactive",
        followers=900, following=800, bio="Personal account", country="US",
        videos=[Video(
            video_id="inactive-1", description="Old post #lifestyle", hashtags=["lifestyle"],
            views=500, likes=20, comments=1, shares=1,
            created_at=datetime.now() - timedelta(days=90), duration=8,
        )],
    ),
]


MOCK_DEEP_ANALYSIS = {
    "mock_anime_haul": {
        "western_ratio": 0.78,
        "ai_relevance_score": 0.91,
        "primary_category": "anime merchandise and Taobao haul",
        "ai_reasoning": "Consistent anime merchandise and Taobao shopping content.",
        "fake_score": 12,
        "trust_score": 88,
        "fake_suspicious": False,
        "bio_url": "https://linktr.ee/mockcreator",
        "email": "hello@mockcreator.test",
        "instagram": "mock.creator",
    },
}
