"""
Feature computation — all metrics derived from a Creator's video list.

compute_basic_features() → requires only fetch_user_post_videos data (Step 1).
Features needing comments / Claude / fake-detection APIs are filled in later
(Step 2) and stored directly on the candidate dict.
"""
from statistics import mean, median, stdev
from datetime import datetime
from models import Creator, Video

# ── Content keyword lists ────────────────────────────────────────────────────

TARGET_HASHTAGS = [
    "cosplay", "cosplayhaul", "anime", "animemerch", "jfashion", "lolita",
    "kawaii", "genshin", "tgcf", "mdzs", "danmei", "itabag", "taobao",
    "unboxing", "haul", "cosplaytryout", "animeunboxing", "sweetlolita",
    "gothiclolita", "fairykei", "pastelgoth", "honkaistarrail", "jjk",
    "demonslayer", "bluelock", "spyxfamily", "frieren", "nezha",
    "svsss", "linkclick", "wangxian", "hualian",
]

HAUL_KEYWORDS = ["haul", "unboxing", "review", "try on", "tryon", "try-on", "opening"]

SHOPPING_KEYWORDS = [
    "price", "bought", "affordable", "budget", "shipping", "link",
    "code", "discount", "worth", "cheap", "save", "cost", "order",
]

CTA_KEYWORDS = [
    "link in bio", "check out", "use my code", "use code", "swipe up",
    "link below", "shop now", "grab yours",
]

CHINA_KEYWORDS = [
    "taobao", "china", "chinese", "from china", "代购", "alibaba",
    "1688", "shopping agent", "proxy", "forwarding",
]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _extract_text(video: Video) -> str:
    """Merge description + hashtags into a single lowercase string."""
    return video.description.lower() + " " + " ".join(video.hashtags)


def _safe_mean(vals: list) -> float:
    return mean(vals) if vals else 0.0


def _safe_stdev(vals: list) -> float:
    return stdev(vals) if len(vals) > 1 else 0.0


def _max_consecutive(seq: list, threshold: float) -> int:
    """Return the length of the longest run where each element >= threshold."""
    max_run = cur = 0
    for v in seq:
        if v >= threshold:
            cur += 1
            max_run = max(max_run, cur)
        else:
            cur = 0
    return max_run


# ── Main feature computation ─────────────────────────────────────────────────

def compute_basic_features(creator: Creator) -> dict:
    """
    Compute all features that can be derived from fetch_user_post_videos data.
    Returns a flat dict ready for hard_filter() and must_pass_filter().

    NOTE: videos are assumed to be in reverse-chronological order (newest first),
    which is how TikHub returns them.
    """
    videos = creator.videos
    if not videos:
        return {}

    now = datetime.now()

    # ── 3.1 Activity ────────────────────────────────────────────────────────
    days_since_last_post = (now - max(v.created_at for v in videos)).days
    post_freq_30d = sum(1 for v in videos if (now - v.created_at).days <= 30)

    # ── 3.2 Basic stats ──────────────────────────────────────────────────────
    followers  = creator.followers
    following  = creator.following
    total_fav  = sum(v.likes for v in videos)          # proxy for total_favorited
    follower_to_following  = followers / max(following, 1)
    likes_to_follower_total = total_fav / max(followers, 1)

    # ── 3.3 Views ────────────────────────────────────────────────────────────
    all_views   = [v.views for v in videos]
    avg_views   = _safe_mean(all_views)
    med_views   = median(all_views)
    max_views   = max(all_views)
    viral_rate  = sum(1 for v in all_views if v >= 10000) / len(all_views)
    view_follower_ratio = med_views / max(followers, 1)

    # newest 10 vs older 10 (list is newest-first)
    recent_views = all_views[:10]
    older_views  = all_views[10:] if len(all_views) > 10 else all_views
    views_growth_trend = _safe_mean(recent_views) / max(_safe_mean(older_views), 1)

    view_variance_coeff = _safe_stdev(all_views) / max(avg_views, 1)
    viral_floor  = min(all_views) / max(followers, 1)
    hit_rate     = sum(1 for v in all_views if v >= 3 * med_views) / len(all_views)
    consecutive_hits = _max_consecutive(all_views, 2 * med_views)

    # ── 3.4 Engagement ───────────────────────────────────────────────────────
    def _er(v: Video) -> float:
        return (v.likes + v.comments + v.shares) / max(v.views, 1)

    engagement_rates     = [_er(v) for v in videos]
    avg_engagement_rate  = _safe_mean(engagement_rates)
    engage_cv            = _safe_stdev(engagement_rates) / max(avg_engagement_rate, 0.001)
    engage_consistency_inv = 1 / (1 + engage_cv)

    avg_comments       = _safe_mean([v.comments for v in videos])
    avg_comment_rate   = _safe_mean([v.comments / max(v.views, 1) for v in videos])
    comment_to_like    = _safe_mean([v.comments / max(v.likes, 1) for v in videos])
    share_to_view_ratio = _safe_mean([v.shares / max(v.views, 1) for v in videos])
    deep_engage_rate   = _safe_mean([(v.comments + v.shares) / max(v.likes, 1) for v in videos])

    # ── 3.5 Duration ─────────────────────────────────────────────────────────
    avg_duration = _safe_mean([v.duration for v in videos])

    # ── 3.6 Content analysis ─────────────────────────────────────────────────
    texts = [_extract_text(v) for v in videos]

    content_vertical_score     = sum(1 for t in texts if any(tag in t for tag in TARGET_HASHTAGS)) / len(videos)
    has_haul_content           = sum(1 for t in texts if any(kw in t for kw in HAUL_KEYWORDS)) / len(videos)
    shopping_vocabulary_density = sum(1 for t in texts if any(kw in t for kw in SHOPPING_KEYWORDS)) / len(videos)
    cta_ratio                  = sum(1 for t in texts if any(kw in t for kw in CTA_KEYWORDS)) / len(videos)
    has_china_shopping         = sum(1 for t in texts if any(kw in t for kw in CHINA_KEYWORDS))

    # IP depth: share of videos dominated by a single target tag
    ip_counts = {}
    for tag in TARGET_HASHTAGS:
        cnt = sum(1 for t in texts if tag in t)
        if cnt:
            ip_counts[tag] = cnt
    ip_depth_score = max(ip_counts.values()) / len(videos) if ip_counts else 0.0

    # haul vs non-haul
    haul_idx     = [i for i, t in enumerate(texts) if any(kw in t for kw in HAUL_KEYWORDS)]
    non_haul_idx = [i for i in range(len(videos)) if i not in set(haul_idx)]
    haul_vs_nonhaul_views      = 1.0
    haul_vs_nonhaul_engagement = 1.0
    if haul_idx and non_haul_idx:
        haul_views     = _safe_mean([videos[i].views for i in haul_idx])
        non_haul_views = _safe_mean([videos[i].views for i in non_haul_idx])
        haul_vs_nonhaul_views = haul_views / max(non_haul_views, 1)
        haul_er     = _safe_mean([_er(videos[i]) for i in haul_idx])
        non_haul_er = _safe_mean([_er(videos[i]) for i in non_haul_idx])
        haul_vs_nonhaul_engagement = haul_er / max(non_haul_er, 0.001)

    # ── 3.7 Bio ──────────────────────────────────────────────────────────────
    bio = creator.bio.lower()
    bio_has_contact = int(any(kw in bio for kw in [
        "email", "business", "collab", "pr", "dm", "inquiry", "inquiries",
        "@gmail", "@yahoo", "@outlook", "linktr.ee", "beacons",
    ]))
    link_in_bio   = int(any(kw in bio for kw in ["linktr.ee", "beacons.ai", "bit.ly", "http", "www"]))
    collab_signal = int(any(kw in bio for kw in ["collab", "pr", "gifted", "sponsor", "partner", "brand"]))

    # ── Derived scores ───────────────────────────────────────────────────────
    days_recency_score = 1 / (1 + days_since_last_post)

    # ── Pointers for Step-2 API calls ────────────────────────────────────────
    sorted_by_views = sorted(videos, key=lambda v: v.views, reverse=True)
    top5_video_ids  = [v.video_id for v in sorted_by_views[:5]]
    top_video_id    = sorted_by_views[0].video_id if videos else ""

    video_descriptions = [
        {"desc": v.description[:150], "hashtags": v.hashtags}
        for v in videos[:10]
    ]

    return {
        # identifiers
        "username":           creator.username,
        "bio":                creator.bio,
        "country":            creator.country or "",

        # activity
        "days_since_last_post": days_since_last_post,
        "post_freq_30d":        post_freq_30d,

        # basic
        "followers":              followers,
        "following":              following,
        "follower_to_following":  follower_to_following,
        "likes_to_follower_total": likes_to_follower_total,

        # views
        "avg_views":           avg_views,
        "avg_views_k":         avg_views / 1000,
        "median_views":        med_views,
        "max_views":           max_views,
        "viral_rate":          viral_rate,
        "view_follower_ratio": view_follower_ratio,
        "views_growth_trend":  views_growth_trend,
        "view_variance_coeff": view_variance_coeff,
        "viral_floor":         viral_floor,
        "hit_rate":            hit_rate,
        "consecutive_hits":    consecutive_hits,

        # engagement
        "avg_engagement_rate":   avg_engagement_rate,
        "engage_consistency_inv": engage_consistency_inv,
        "avg_comments":          avg_comments,
        "avg_comment_rate":      avg_comment_rate,
        "comment_to_like_ratio": comment_to_like,
        "share_to_view_ratio":   share_to_view_ratio,
        "deep_engage_rate":      deep_engage_rate,

        # duration
        "avg_duration": avg_duration,

        # content
        "content_vertical_score":      content_vertical_score,
        "has_haul_content":            has_haul_content,
        "shopping_vocabulary_density": shopping_vocabulary_density,
        "cta_ratio":                   cta_ratio,
        "has_china_shopping":          has_china_shopping,
        "ip_depth_score":              ip_depth_score,
        "haul_vs_nonhaul_views":       haul_vs_nonhaul_views,
        "haul_vs_nonhaul_engagement":  haul_vs_nonhaul_engagement,

        # bio
        "bio_has_contact": bio_has_contact,
        "link_in_bio":     link_in_bio,
        "collab_signal":   collab_signal,

        # derived
        "days_recency_score": days_recency_score,

        # pointers for Step-2 API calls
        "top5_video_ids":    top5_video_ids,
        "top_video_id":      top_video_id,
        "video_descriptions": video_descriptions,

        # Step-2 fields (filled in later)
        "western_ratio":      None,
        "ai_relevance_score": None,
        "primary_category":   None,
        "ai_reasoning":       None,
        "fake_score":         None,
        "trust_score":        None,
        "fake_suspicious":    None,

        # final score (filled in Step 3)
        "final_score": None,
    }
