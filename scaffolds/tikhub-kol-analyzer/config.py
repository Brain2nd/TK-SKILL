"""
Configuration — set API keys via environment variables before running.

  export ANTHROPIC_API_KEY="sk-ant-..."
  export TIKHUB_API_KEY="..."

Or create a .env file and load it with:  source .env
"""
import os

# === API Keys (read from environment — never hardcode here) ===
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", os.environ.get("CLAUDE_API_KEY", ""))
CLAUDE_API_KEY = ANTHROPIC_API_KEY   # backward-compat alias

TIKHUB_API_KEY = os.environ.get("TIKHUB_API_KEY", os.environ.get("TIKHUB_KEY", ""))
TIKHUB_KEY = TIKHUB_API_KEY          # backward-compat alias

TIKAPI_KEY = os.environ.get("TIKAPI_KEY", "")

# === Claude model ===
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

# === Search configuration ===
SEARCH_KEYWORD = "jfashion"          # legacy single-keyword mode
SEARCH_PAGES_PER_KEYWORD = 15        # pages per keyword (20 results/page, ~300 videos max)
                                     # TikTok typically exhausts at 5-15 pages depending on keyword
SEARCH_RESULTS_PER_PAGE = 20
VIDEOS_PER_USER = 20
VIDEOS_TO_ANALYZE = VIDEOS_PER_USER  # backward-compat alias
COMMENTS_PER_VIDEO = 50
COMMENT_SAMPLE_VIDEOS = 5            # top-viewed videos to sample for demographics
VIDEOS_FOR_DEMOGRAPHICS = COMMENT_SAMPLE_VIDEOS  # backward-compat alias

# === Western + Latin American countries (Dogegoo target markets) ===
WESTERN_COUNTRIES = {
    "US", "GB", "CA", "AU", "NZ",
    "DE", "FR", "IT", "ES", "NL", "BE", "SE", "NO", "DK", "FI",
    "AT", "CH", "PT", "IE", "PL", "CZ", "HU", "GR", "RO",
    "SK", "SI", "HR", "BG", "LT", "LV", "EE", "LU", "MT", "CY", "IS",
    # Latin America — Dogegoo ships here
    "BR", "MX", "CL", "AR", "CO",
}

# === Step 1: Hard elimination thresholds ===
# Calibrated from 36 known-good creators (output/creator_features_raw.csv, 2026-04-13):
#   days_since_last_post P90=13, max=33  → bumped to 35 to cover the one outlier at 33
#   followers            min=3765        → 1500 floor unchanged (well below min)
#   avg_views            min=2299        → 2000 floor unchanged (right at min)
#   max_views            min=3851        → was 10000; lowered to 3000
#     (several good creators max out below 10k — @dreamkoo avg 2.3k, max ~3.8k)
#   avg_duration         min=10.3s P10=13.3s → was 15s; lowered to 10s
#     (duration in seconds; TikHub ms value divided by 1000 in _parse_video)
#   content_vertical     min=0.00 P10=0.20   → was 0.30; lowered to 0.10
#     (our TARGET_HASHTAGS list doesn't cover all valid content styles)
THRESHOLD_DAYS_SINCE_LAST_POST = 35
THRESHOLD_FOLLOWERS_MIN        = 1500
THRESHOLD_AVG_VIEWS            = 2000
THRESHOLD_MAX_VIEWS            = 3000
THRESHOLD_AVG_DURATION_MIN     = 10   # seconds
THRESHOLD_CONTENT_VERTICAL     = 0.1

# === Step 2: Must-pass thresholds ===
# Calibrated from 36 known-good creators (output/creator_features_raw.csv, 2026-04-13):
#   viral_rate          min=0.00  P10=0.10 → was 0.10; lowered to 0.05
#     (P10 was exactly at old threshold; lowering to not cut bottom decile)
#   avg_comments        min=4.4           → was 5; lowered to 3
#     (min good creator at 4.4 — below old threshold of 5)
#   avg_comment_rate    min=0.0008 P25=0.0022 → was 0.002; lowered to 0.001
#     (old threshold cut 25% of known-good creators at P25)
#   view_follower_ratio min=0.024  P10=0.056  → was 0.05; lowered to 0.02
#     (min good creator at 0.024)
#   has_haul_content    median=0.00 → NOT a hard gate; scoring-only (see pipeline.py)
#     (majority of best creators have 0% haul keyword detection)
#   western_ratio / ai_relevance / fake: cannot calibrate without comments+Claude data
THRESHOLD_VIRAL_RATE            = 0.05   # scoring only — NOT a Step 2 hard gate (see pipeline.py)
THRESHOLD_AVG_COMMENTS          = 3
THRESHOLD_COMMENT_RATE          = 0.0005  # was 0.002 → 0.001 → 0.0005
                                          # high-view creators (1M+ avg) have low RATE but high
                                          # absolute counts; rely on avg_comments>=3 as the gate
THRESHOLD_AI_RELEVANCE          = 0.4
THRESHOLD_WESTERN_RATIO         = 0.30
THRESHOLD_HAS_HAUL              = 0.05   # in config but NOT a hard gate — see pipeline.py
THRESHOLD_VIEW_FOLLOWER_RATIO   = 0.02
THRESHOLD_FAKE_SCORE_MAX        = 60
THRESHOLD_TRUST_SCORE_MIN       = 50

# === Legacy FILTERS dict (used by filters.py / run_from_list.py) ===
FILTERS = {
    "max_days_since_last_post":     THRESHOLD_DAYS_SINCE_LAST_POST,
    "preferred_days_since_last_post": 7,
    "min_followers":                THRESHOLD_FOLLOWERS_MIN,
    "min_avg_views":                THRESHOLD_AVG_VIEWS,
    "viral_view_threshold":         THRESHOLD_MAX_VIEWS,
    "min_viral_rate":               THRESHOLD_VIRAL_RATE,
    "min_avg_comments":             THRESHOLD_AVG_COMMENTS,
    "min_comment_rate":             THRESHOLD_COMMENT_RATE,
    "min_ai_relevance_score":       THRESHOLD_AI_RELEVANCE,
    "min_female_ratio":             0.60,
    "min_western_ratio":            THRESHOLD_WESTERN_RATIO,
    "min_comment_samples":          20,
    "max_fake_score":               THRESHOLD_FAKE_SCORE_MAX,
    "min_trust_score":              THRESHOLD_TRUST_SCORE_MIN,
    "min_haul_content":             THRESHOLD_HAS_HAUL,
    "min_view_follower_ratio":      THRESHOLD_VIEW_FOLLOWER_RATIO,
}

# === Rate limiting ===
API_DELAY_SECONDS           = 0.5
DEEP_ANALYSIS_DELAY_SECONDS = 1.0

# === Output ===
OUTPUT_DIR        = "output"
OUTPUT_CSV        = "jfashion_creators.csv"    # legacy
OUTPUT_RAW_CSV    = "output/candidates_step1.csv"
OUTPUT_STEP2_CSV  = "output/candidates_step2.csv"
OUTPUT_FINAL_CSV  = "output/candidates_final.csv"
