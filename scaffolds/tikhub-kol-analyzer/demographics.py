"""
F criterion: Audience demographics analysis via comment data.
- Region  : from user.region field (100% coverage on TikHub)
- Gender  : Claude analysis of nicknames + bios (batch)
"""
import json
from collections import Counter
import anthropic
from models import Creator
from config import (
    CLAUDE_API_KEY, CLAUDE_MODEL, WESTERN_COUNTRIES,
    COMMENTS_PER_VIDEO, VIDEOS_FOR_DEMOGRAPHICS,
)
from tikhub_fetcher import fetch_video_comments


def _collect_comment_users(creator: Creator) -> list[dict]:
    """Fetch comments from the top-viewed N videos, return commenter user dicts."""
    videos = sorted(creator.videos, key=lambda v: v.views, reverse=True)
    target_videos = videos[:VIDEOS_FOR_DEMOGRAPHICS]
    all_users = []
    for v in target_videos:
        comments = fetch_video_comments(v.video_id, count=COMMENTS_PER_VIDEO)
        for c in comments:
            user = c.get("user", {})
            if user:
                all_users.append({
                    "region": user.get("region", ""),
                    "nickname": user.get("nickname", ""),
                    "bio": user.get("signature", "")[:100],
                    "language": user.get("language", ""),
                })
    return all_users


def _calc_western_ratio(users: list[dict]) -> float:
    if not users:
        return 0.0
    western = sum(1 for u in users if u.get("region", "") in WESTERN_COUNTRIES)
    return western / len(users)


def _calc_top_countries(users: list[dict], top_n: int = 5) -> list[tuple[str, int]]:
    """Return top N (country_code, count) tuples sorted by count desc, excluding empty."""
    regions = [u.get("region", "") for u in users if u.get("region", "")]
    counter = Counter(regions)
    return counter.most_common(top_n)


def _estimate_female_ratio(users: list[dict], client: anthropic.Anthropic) -> float:
    """
    Send a batch of nicknames + bios to Claude.
    Returns estimated female ratio (0.0–1.0).
    """
    if not users:
        return 0.0

    # Prepare compact sample (max 80 users to control cost)
    sample = users[:80]
    profiles = [
        {"nickname": u["nickname"], "bio": u["bio"]}
        for u in sample
        if u["nickname"]
    ]
    if not profiles:
        return 0.0

    prompt = f"""You are analyzing TikTok user profiles to estimate gender distribution.

Below are {len(profiles)} user profiles (nickname + bio) from people who commented on a jfashion (Japanese fashion) creator's videos.

Profiles:
{json.dumps(profiles, ensure_ascii=False)}

Task: Estimate what percentage of these users are female.

Base your judgment on:
- Feminine/masculine names and nicknames
- Pronouns in bios (she/her vs he/him)
- Gendered language in bios (girlfriend, wife, mom vs boyfriend, husband, dad)
- Emojis and aesthetic patterns common to female/male TikTok users
- Names that are clearly male or female in any language

Respond with a JSON object only:
{{
  "female_count": <integer>,
  "male_count": <integer>,
  "unknown_count": <integer>,
  "female_ratio": <float 0.0-1.0>,
  "reasoning": "<one sentence>"
}}"""

    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=400,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    # Extract just the JSON object in case of trailing text
    start = raw.find("{")
    end = raw.rfind("}") + 1
    if start >= 0 and end > start:
        raw = raw[start:end]
    parsed = json.loads(raw)
    return float(parsed["female_ratio"])


def compute_western_ratio_from_ids(video_ids: list[str], comments_per_video: int = 50) -> float:
    """
    Fetch comments for given video IDs and return western commenter ratio.
    Used by the new pipeline (Step 2) which works with feature dicts.
    """
    all_users = []
    for vid_id in video_ids:
        comments = fetch_video_comments(vid_id, count=comments_per_video)
        for c in comments:
            user = c.get("user", {})
            if user:
                all_users.append({"region": user.get("region", "")})
    return _calc_western_ratio(all_users)


def analyze_demographics(creator: Creator, api_key: str = None) -> None:
    """
    Mutates creator in-place:
      - audience_western_ratio
      - audience_female_ratio
      - comment_sample_size
    """
    print(f"    [Demographics] @{creator.username} — fetching comments...")
    users = _collect_comment_users(creator)

    if not users:
        print(f"    [Demographics] @{creator.username} — no comments found")
        creator.comment_sample_size = 0
        return

    creator.comment_sample_size = len(users)
    creator.audience_western_ratio = _calc_western_ratio(users)
    creator.audience_top_countries = _calc_top_countries(users)

    key = api_key or CLAUDE_API_KEY
    if key:
        try:
            client = anthropic.Anthropic(api_key=key)
            creator.audience_female_ratio = _estimate_female_ratio(users, client)
        except Exception as e:
            print(f"    [Demographics] gender estimate error: {e}")
            creator.audience_female_ratio = None
    else:
        creator.audience_female_ratio = None

    print(f"    [Demographics] @{creator.username} — "
          f"{len(users)} comments | "
          f"western:{creator.audience_western_ratio:.0%} | "
          f"female:{creator.audience_female_ratio:.0%}" if creator.audience_female_ratio is not None
          else f"    [Demographics] @{creator.username} — "
               f"{len(users)} comments | "
               f"western:{creator.audience_western_ratio:.0%} | female:N/A")
