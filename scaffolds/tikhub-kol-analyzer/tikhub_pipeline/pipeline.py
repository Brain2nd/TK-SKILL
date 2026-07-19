"""
Three-layer funnel pipeline — Dogegoo KOL filter.

Layer 1 — hard_filter()        : instant disqualification (no extra API cost)
Layer 2 — must_pass_filter()   : stricter checks after deep-analysis APIs
Layer 3 — calculate_score()    : weighted scoring of surviving candidates
"""
from tikhub_pipeline.config import (
    THRESHOLD_DAYS_SINCE_LAST_POST, THRESHOLD_FOLLOWERS_MIN,
    THRESHOLD_AVG_VIEWS, THRESHOLD_MAX_VIEWS, THRESHOLD_AVG_DURATION_MIN,
    THRESHOLD_CONTENT_VERTICAL, THRESHOLD_AVG_COMMENTS,
    THRESHOLD_COMMENT_RATE, THRESHOLD_AI_RELEVANCE, THRESHOLD_WESTERN_RATIO,
    THRESHOLD_VIEW_FOLLOWER_RATIO,
    THRESHOLD_FAKE_SCORE_MAX, THRESHOLD_TRUST_SCORE_MIN,
)


# ── Layer 1: Hard elimination ────────────────────────────────────────────────

def hard_filter(features: dict) -> tuple[bool, str]:
    """
    Returns (passed: bool, reason: str).
    Any single failure eliminates the creator immediately.
    Only uses data from fetch_user_post_videos — no extra API calls.
    """
    checks = [
        (features["days_since_last_post"] <= THRESHOLD_DAYS_SINCE_LAST_POST,
         f"days_since_last_post={features['days_since_last_post']} > {THRESHOLD_DAYS_SINCE_LAST_POST}"),
        (features["followers"] >= THRESHOLD_FOLLOWERS_MIN,
         f"followers={features['followers']} < {THRESHOLD_FOLLOWERS_MIN}"),
        (features["avg_views"] >= THRESHOLD_AVG_VIEWS,
         f"avg_views={features['avg_views']:.0f} < {THRESHOLD_AVG_VIEWS}"),
        (features["max_views"] >= THRESHOLD_MAX_VIEWS,
         f"max_views={features['max_views']} < {THRESHOLD_MAX_VIEWS}"),
        (features["avg_duration"] >= THRESHOLD_AVG_DURATION_MIN,
         f"avg_duration={features['avg_duration']:.1f}s < {THRESHOLD_AVG_DURATION_MIN}s"),
        (features["content_vertical_score"] >= THRESHOLD_CONTENT_VERTICAL,
         f"content_vertical_score={features['content_vertical_score']:.2f} < {THRESHOLD_CONTENT_VERTICAL}"),
    ]
    for passed, reason in checks:
        if not passed:
            return False, reason
    return True, "ok"


# ── Layer 2: Must-pass checks (after deep-analysis APIs) ─────────────────────

def must_pass_filter(features: dict) -> tuple[bool, str]:
    """
    Returns (passed: bool, reason: str).
    Called after comments, Claude, and fake-detection data have been filled in.
    """
    # NOTE — two metrics intentionally excluded from hard gates here:
    #
    # has_haul_content: median=0% for known-good creators — many excellent
    #   cosplay/vertical creators never use haul-style captions. Scoring-only (15% weight).
    #
    # viral_rate: Step 1 already requires max_views >= 3000. Viral rate is a
    #   better signal for ranking than for gating. Scoring-only (7% weight).
    #   High-view creators (1M+ avg) with low comment RATE still have high absolute
    #   comment counts — rate alone is a poor gate for them.
    # Golf content is more specialized; use lower thresholds so golf creators can pass
    _cat = (features.get("primary_category") or "").lower()
    is_golf = "golf" in _cat or "高尔夫" in _cat
    ai_thresh = 0.3 if is_golf else THRESHOLD_AI_RELEVANCE
    comment_rate_thresh = 0.0003 if is_golf else THRESHOLD_COMMENT_RATE
    checks = [
        (features["avg_comments"] >= THRESHOLD_AVG_COMMENTS,
         f"avg_comments={features['avg_comments']:.1f} < {THRESHOLD_AVG_COMMENTS}"),
        (features["avg_comment_rate"] >= comment_rate_thresh,
         f"avg_comment_rate={features['avg_comment_rate']:.4f} < {comment_rate_thresh}"),
        ((features["ai_relevance_score"] or 0) >= ai_thresh,
         f"ai_relevance_score={features['ai_relevance_score']} < {ai_thresh}"),
        ((features["western_ratio"] or 0) >= THRESHOLD_WESTERN_RATIO,
         f"western_ratio={features['western_ratio']} < {THRESHOLD_WESTERN_RATIO}"),
        (features["view_follower_ratio"] >= THRESHOLD_VIEW_FOLLOWER_RATIO,
         f"view_follower_ratio={features['view_follower_ratio']:.3f} < {THRESHOLD_VIEW_FOLLOWER_RATIO}"),
        ((features["fake_score"] is None or features["fake_score"] <= THRESHOLD_FAKE_SCORE_MAX),
         f"fake_score={features['fake_score']} > {THRESHOLD_FAKE_SCORE_MAX}"),
        ((features["trust_score"] is None or features["trust_score"] >= THRESHOLD_TRUST_SCORE_MIN),
         f"trust_score={features['trust_score']} < {THRESHOLD_TRUST_SCORE_MIN}"),
    ]
    for passed, reason in checks:
        if not passed:
            return False, reason
    return True, "ok"


# ── Layer 3: Weighted scoring ────────────────────────────────────────────────

WEIGHTS = {
    # Conversion potential — 40%
    "has_haul_content":             0.15,
    "shopping_vocabulary_density":  0.10,
    "cta_ratio":                    0.08,
    "has_china_shopping":           0.07,

    # Traffic quality — 25%
    "view_follower_ratio":          0.08,
    "viral_rate":                   0.07,
    "views_growth_trend":           0.05,
    "avg_views_k":                  0.05,

    # Audience loyalty — 20%
    "avg_comment_rate":             0.06,
    "share_to_view_ratio":          0.05,
    "engage_consistency_inv":       0.05,
    "western_ratio":                0.04,

    # Content match — 10%
    "ai_relevance_score":           0.06,
    "ip_depth_score":               0.04,

    # Collaboration readiness — 5%
    "bio_has_contact":              0.03,
    "days_recency_score":           0.02,
}


def _normalize(values: list[float]) -> list[float]:
    """Min-max normalise to [0, 1]. Returns [0.5, …] if all values are equal."""
    min_v = min(values)
    max_v = max(values)
    if max_v == min_v:
        return [0.5] * len(values)
    return [(v - min_v) / (max_v - min_v) for v in values]


def calculate_scores(candidates: list[dict]) -> None:
    """
    Compute final_score for every candidate in-place.
    Normalisation is done across the whole candidate pool.
    """
    if not candidates:
        return

    # The function is intentionally safe to call again after a checkpoint reload.
    # Without this reset, a second call would add weights to an existing score.
    for candidate in candidates:
        candidate["final_score"] = 0.0

    for feature_name, weight in WEIGHTS.items():
        raw_values = []
        for c in candidates:
            val = c.get(feature_name)
            raw_values.append(float(val) if val is not None else 0.0)

        normed = _normalize(raw_values)
        for c, nv in zip(candidates, normed):
            c["final_score"] += weight * nv
