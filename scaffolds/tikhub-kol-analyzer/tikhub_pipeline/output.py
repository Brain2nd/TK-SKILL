"""
Export scored pipeline results to CSV.
"""
import csv
import os

from shared.feishu_bitable import auto_sync_csv

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
    sync = auto_sync_csv(path)
    if sync.get("configured"):
        print(f"[Feishu Base] {sync}")


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
