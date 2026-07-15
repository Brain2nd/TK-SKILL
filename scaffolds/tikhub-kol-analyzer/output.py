"""
Export results to CSV — two modes:

export_csv(creators, path)          — legacy Creator-object export (run_from_list.py)
export_scored_csv(candidates, path) — new pipeline dict export (main.py)
"""
import csv
import os
from models import Creator

# ── Legacy columns (Creator objects) ────────────────────────────────────────
LEGACY_COLUMNS = [
    "rank", "overall_pass",
    "username", "nickname", "followers", "country", "bio",
    "days_since_last_post", "preferred_recency",
    "avg_views", "max_views", "viral_rate",
    "avg_comments", "avg_comment_rate",
    "ai_relevance_score", "ai_relevance_reason", "primary_category",
    "audience_western_ratio", "audience_female_ratio", "comment_samples",
    "top_country_1", "top_country_2", "top_country_3", "top_country_4", "top_country_5",
    "fake_score", "trust_score", "fake_suspicious",
    "A_recency", "B_followers", "C_views", "D_engagement",
    "E_relevance", "F_demographics", "G_fake_views",
    "all_hashtags",
]

# ── Scored pipeline columns (feature dicts) ──────────────────────────────────
SCORED_COLUMNS = [
    "rank", "username", "final_score", "primary_category",
    "followers", "avg_views", "median_views", "viral_rate", "max_views",
    "view_follower_ratio", "views_growth_trend",
    "avg_engagement_rate", "avg_comment_rate", "share_to_view_ratio",
    "has_haul_content", "shopping_vocabulary_density", "cta_ratio", "has_china_shopping",
    "ai_relevance_score", "ai_reasoning",
    "western_ratio",
    "fake_score", "trust_score",
    "days_since_last_post", "avg_duration",
    "bio_has_contact", "collab_signal",
    "content_vertical_score", "ip_depth_score",
    "bio", "country",
    "profile_url",
    "email", "instagram", "bio_url",
]


def export_csv(creators: list[Creator], path: str) -> None:
    """Legacy export — works with Creator objects. Used by run_from_list.py."""
    _ensure_dir(path)
    rows = []
    for c in creators:
        r = apply_all_filters(c)
        rows.append({
            "rank": "",
            "overall_pass": "✅ PASS" if r["overall_pass"] else "❌ FAIL",
            "username":  c.username,
            "nickname":  c.nickname,
            "followers": c.followers,
            "country":   c.country or "N/A",
            "bio":       c.bio.replace("\n", " "),
            "days_since_last_post": c.days_since_last_post,
            "preferred_recency": "⭐" if r["preferred_recency"] else "",
            "avg_views":  f"{c.avg_views:,.0f}",
            "max_views":  f"{c.max_views:,}",
            "viral_rate": f"{c.viral_rate:.0%}",
            "avg_comments":    f"{c.avg_comments:.1f}",
            "avg_comment_rate": f"{c.avg_comment_rate:.3%}",
            "ai_relevance_score":  f"{c.ai_relevance_score:.2f}" if c.ai_relevance_score is not None else "N/A",
            "ai_relevance_reason": c.ai_relevance_reason or "",
            "primary_category":    c.ai_primary_category or "",
            "audience_western_ratio": f"{c.audience_western_ratio:.0%}" if c.audience_western_ratio is not None else "N/A",
            "audience_female_ratio":  f"{c.audience_female_ratio:.0%}"  if c.audience_female_ratio  is not None else "N/A",
            "comment_samples": c.comment_sample_size,
            **{f"top_country_{i+1}": (
                f"{c.audience_top_countries[i][0]}({c.audience_top_countries[i][1]})"
                if i < len(c.audience_top_countries) else "")
               for i in range(5)},
            "fake_score":      f"{c.fake_score:.1f}"  if c.fake_score  is not None else "N/A",
            "trust_score":     f"{c.trust_score}"     if c.trust_score is not None else "N/A",
            "fake_suspicious": "⚠️" if c.fake_suspicious else "",
            "A_recency":    "✅" if r["A_recency"]["passed"]    else "❌",
            "B_followers":  "✅" if r["B_followers"]["passed"]  else "❌",
            "C_views":      "✅" if r["C_views"]["passed"]      else "❌",
            "D_engagement": "✅" if r["D_engagement"]["passed"] else "❌",
            "E_relevance":  ("✅" if r["E_relevance"]["passed"] else
                             "⏳" if r["E_relevance"]["passed"] is None else "❌"),
            "F_demographics": ("⏭️" if r["F_demographics"].get("skipped") else
                               "✅" if r["F_demographics"]["passed"] else "❌"),
            "G_fake_views": ("⏭️" if r["G_fake_views"].get("skipped") else
                             "✅" if r["G_fake_views"]["passed"] else "❌"),
            "all_hashtags": " ".join(f"#{t}" for t in c.all_hashtags[:20]),
        })

    rows.sort(key=lambda r: (0 if "PASS" in r["overall_pass"] else 1, -int(r["followers"])))
    for i, row in enumerate(rows, 1):
        row["rank"] = i

    _write_csv(rows, LEGACY_COLUMNS, path)
    passed = sum(1 for row in rows if "PASS" in row["overall_pass"])
    print(f"\n[Output] {passed} PASSED / {len(rows) - passed} FAILED → {path}")


def export_scored_csv(candidates: list[dict], path: str) -> None:
    """New pipeline export — works with feature dicts produced by main.py."""
    _ensure_dir(path)
    rows = []
    for i, c in enumerate(candidates, 1):
        row = {col: c.get(col, "") for col in SCORED_COLUMNS}
        row["rank"]        = i
        row["profile_url"] = f"https://www.tiktok.com/@{c.get('username', '')}"

        # Format floats for readability
        for col in ["final_score", "ai_relevance_score", "viral_rate",
                    "avg_comment_rate", "share_to_view_ratio", "western_ratio",
                    "has_haul_content", "shopping_vocabulary_density", "cta_ratio",
                    "content_vertical_score", "ip_depth_score",
                    "view_follower_ratio", "views_growth_trend", "avg_engagement_rate"]:
            v = row.get(col)
            if isinstance(v, float):
                row[col] = f"{v:.4f}"

        for col in ["avg_views", "median_views"]:
            v = row.get(col)
            if isinstance(v, (int, float)):
                row[col] = f"{v:,.0f}"

        rows.append(row)

    _write_csv(rows, SCORED_COLUMNS, path)
    print(f"[Output] {len(rows)} candidates → {path}")


# ── Helpers ──────────────────────────────────────────────────────────────────

def _ensure_dir(path: str) -> None:
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)


def _write_csv(rows: list[dict], columns: list[str], path: str) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
