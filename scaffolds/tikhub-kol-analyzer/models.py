"""
Data models for creators and videos.
"""
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime


@dataclass
class Video:
    video_id: str
    description: str
    hashtags: list[str]
    views: int
    likes: int
    comments: int
    shares: int
    created_at: datetime
    duration: int = 0   # seconds

    @property
    def comment_rate(self) -> float:
        if self.views == 0:
            return 0.0
        return self.comments / self.views

    @property
    def is_viral(self) -> bool:
        from config import FILTERS
        return self.views >= FILTERS["viral_view_threshold"]


@dataclass
class Creator:
    user_id: str
    username: str
    nickname: str
    followers: int
    following: int
    bio: str
    country: Optional[str] = None

    videos: list[Video] = field(default_factory=list)

    # F: Demographics (from comment analysis)
    audience_female_ratio: Optional[float] = None
    audience_western_ratio: Optional[float] = None
    audience_top_countries: list[tuple[str, int]] = field(default_factory=list)
    comment_sample_size: int = 0

    # G: Fake view detection
    fake_score: Optional[float] = None
    trust_score: Optional[float] = None
    fake_suspicious: Optional[bool] = None

    # E: AI content relevance (Dogegoo)
    ai_relevance_score: Optional[float] = None
    ai_relevance_reason: Optional[str] = None
    ai_primary_category: Optional[str] = None

    # Final weighted score (Step 3)
    final_score: Optional[float] = None

    # ── Computed properties ──────────────────────────────────────────────────

    @property
    def avg_views(self) -> float:
        if not self.videos:
            return 0.0
        return sum(v.views for v in self.videos) / len(self.videos)

    @property
    def median_views(self) -> float:
        if not self.videos:
            return 0.0
        sorted_views = sorted(v.views for v in self.videos)
        n = len(sorted_views)
        mid = n // 2
        return (sorted_views[mid] if n % 2 else (sorted_views[mid - 1] + sorted_views[mid]) / 2)

    @property
    def avg_comments(self) -> float:
        if not self.videos:
            return 0.0
        return sum(v.comments for v in self.videos) / len(self.videos)

    @property
    def avg_comment_rate(self) -> float:
        if not self.videos:
            return 0.0
        rates = [v.comment_rate for v in self.videos if v.views > 0]
        return sum(rates) / len(rates) if rates else 0.0

    @property
    def viral_rate(self) -> float:
        if not self.videos:
            return 0.0
        return sum(1 for v in self.videos if v.is_viral) / len(self.videos)

    @property
    def max_views(self) -> int:
        if not self.videos:
            return 0
        return max(v.views for v in self.videos)

    @property
    def days_since_last_post(self) -> int:
        if not self.videos:
            return 9999
        latest = max(v.created_at for v in self.videos)
        return (datetime.now() - latest).days

    @property
    def all_hashtags(self) -> list[str]:
        tags = []
        for v in self.videos:
            tags.extend(v.hashtags)
        return list(set(tags))
