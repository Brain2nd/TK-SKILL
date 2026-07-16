"""Enrich candidates from checked_candidates.csv by extracting email from bio
and scoring TikTok Shop/Showcase signals. No API calls needed — regex on bio text.

Outputs a ranked top-N list with Spain priority.
"""
import csv
import os
import re
import sys
from collections import Counter

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')

# Strong Shopify/TikTok Shop indicators
SHOWCASE_TERMS = [
    "tiktok shop", "tiktokshop", "tik tok shop",
    "showcase", "shop now", "my shop", "shop creator",
    "tts ", " tts", "#tts",
    "tiktok affiliate", "shop affiliate",
    "tiktok shop creator",
]

# UGC + collab signals (weaker but relevant)
UGC_TERMS = [
    "ugc", "ugc creator", "ugc content",
    "collab", "collabs", "pr/", "for collab",
    "creadora ugc",
]

# Marketing/business signals
SHOP_TERMS_WEAK = [
    "shop", "store", "products", "deals", "finds",
    "affiliate", "escáparate", "escaparate",
    "vetrina", "vitrine", "produkte", "produits",
    "prodotti", "recommend", "best picks",
    "top 0.5%", "top 1%",
    "gmv", "umsatz",
]


def extract_email(bio: str) -> str:
    if not bio:
        return ""
    emails = EMAIL_RE.findall(bio)
    # Prefer gmail/outlook/professional-looking emails
    for e in emails:
        if any(d in e.lower() for d in ["gmail", "outlook", "yahoo", "proton", "icloud", "hotmail"]):
            return e
    return emails[0] if emails else ""


def has_showcase(bio: str) -> bool:
    if not bio:
        return False
    b = bio.lower()
    return any(t in b for t in SHOWCASE_TERMS)


def score_creator(bio: str, shop_signals: int = 0) -> dict:
    """Return a scores dict for a creator."""
    if not bio:
        bio = ""
    b = bio.lower()

    showcase = sum(1 for t in SHOWCASE_TERMS if t in b)
    ugc = sum(1 for t in UGC_TERMS if t in b)
    weak = sum(1 for t in SHOP_TERMS_WEAK if t in b)

    return {
        "showcase_hits": showcase,
        "ugc_hits": ugc,
        "shop_weak_hits": weak,
        "total_shop_score": showcase * 3 + ugc * 2 + weak + shop_signals,
    }


def main():
    input_csv = sys.argv[1] if len(sys.argv) > 1 else "output/tts_l1_eu/checked_candidates.csv"
    output_csv = sys.argv[2] if len(sys.argv) > 2 else "output/tts_l1_eu/top100.csv"
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 100

    with open(input_csv, encoding="utf-8-sig") as f:
        candidates = list(csv.DictReader(f))
    print(f"Loaded {len(candidates)} candidates from {input_csv}")

    # Enrich: extract email + score from existing bio text
    for c in candidates:
        bio = c.get("bio", "") or ""
        existing_email = c.get("email", "") or ""
        email = existing_email if existing_email else extract_email(bio)
        scores = score_creator(bio, int(c.get("shop_signals", 0)))

        c["email"] = email
        c["has_email"] = "Yes" if email else "No"
        c["has_showcase"] = "Yes" if has_showcase(bio) else "No"
        c["showcase_score"] = scores["total_shop_score"]
        c["showcase_hits"] = scores["showcase_hits"]
        c["ugc_hits"] = scores["ugc_hits"]

    # Stats
    email_yes = sum(1 for c in candidates if c["has_email"] == "Yes")
    showcase_yes = sum(1 for c in candidates if c["has_showcase"] == "Yes")
    both = sum(1 for c in candidates if c["has_email"] == "Yes" and c["has_showcase"] == "Yes")
    print(f"  Email found:    {email_yes}/{len(candidates)}")
    print(f"  Showcase found:  {showcase_yes}/{len(candidates)}")
    print(f"  Both (email+showcase): {both}/{len(candidates)}")

    # Filter step by step
    step1 = [c for c in candidates if c["has_email"] == "Yes"]
    print(f"\nStep 1 (has email): {len(step1)}")

    step2 = [c for c in step1 if c["has_showcase"] == "Yes"]
    print(f"Step 2 (has showcase): {len(step2)}")

    # If not enough with strict showcase, relax to include UGC/shop signals
    if len(step2) < target:
        relaxed = [c for c in step1 if int(c["showcase_score"]) >= 2]
        print(f"Step 2 relaxed (showcase_score >= 2): {len(relaxed)}")
        qualified = relaxed
    else:
        qualified = step2

    # If still not enough, take all with email sorted by shop_score
    if len(qualified) < target:
        qualified = sorted(step1, key=lambda r: (
            int(r.get("showcase_score", 0)),
            float(r.get("engagement_rate", 0)),
        ), reverse=True)
        print(f"Step 2 further relaxed (all email+, sorted by shop_score): {len(qualified)}")

    # Sort: ES first, then shop score, then engagement
    qualified.sort(key=lambda r: (
        r["country"] == "ES",
        int(r.get("showcase_score", 0)),
        float(r.get("engagement_rate", 0)),
    ), reverse=True)

    top = qualified[:target]
    for i, row in enumerate(top, 1):
        row["rank"] = i

    out_fields = [
        "rank", "username", "country", "followers", "avg_views_10",
        "engagement_rate", "showcase_score", "showcase_hits", "ugc_hits",
        "email", "has_showcase", "profile_url", "bio",
    ]
    os.makedirs(os.path.dirname(output_csv) or ".", exist_ok=True)
    with open(output_csv, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=out_fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(top)

    # Country breakdown
    by_country = Counter(r["country"] for r in top)
    print(f"\n=== Top {len(top)} written to {output_csv} ===")
    print(f"By country: {dict(by_country)}")
    print(f"\nTop 20 preview:")
    for row in top[:20]:
        print(f"  #{row['rank']:3} @{row['username']:<25} {row['country']} "
              f"{int(row['followers']):>6,} followers  "
              f"shop={row['showcase_score']:2}  email={row['email'][:35]}")

    if len(top) < target:
        print(f"\nWARNING: Only {len(top)} qualified of {target} target. "
              f"Need more candidates — re-run batch discovery with more keywords.")


if __name__ == "__main__":
    main()
