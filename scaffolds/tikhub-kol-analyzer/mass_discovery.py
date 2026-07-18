"""FastMoss-only discovery for EU5 TikTok Shop creators.

TikTok Shop (TTS) commercial data is intentionally isolated from TikHub.
Instagram and YouTube use TikHub through ``social_fetcher.py`` instead.
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from contact_enrichment import enrich_contact
from discovery_runtime import CsvCheckpoint
from env_loader import load_env_file
from fastmoss_browser_provider import collect_fastmoss_browser
from fastmoss_provider import load_fastmoss_exports


load_env_file(Path(__file__).with_name(".env"))

SUPPORTED_COUNTRIES = {"ES", "FR", "DE", "IT", "GB"}
SHOP_PROOF_VERIFIED = "shop_showcase_verified"
SHOP_PROOF_NOT_VERIFIED = "not_verified"
LEGACY_PROOF_METHODS = {
    "video_product_anchor": "legacy_tikhub_recent_video_product_anchor",
    "showcase_product_list": "legacy_tikhub_showcase_product_list",
    "fastmoss_showcase_open": "fastmoss_creator_showcase_open",
    "fastmoss_filtered_web_page": "fastmoss_filtered_web_page",
}
RESULT_FIELDS = [
    "username", "status", "reason", "source", "country", "followers",
    "avg_views_10", "engagement_rate", "shop_signals", "shop_valid",
    "shop_proof", "shop_proof_method", "email", "email_source",
    "email_verified", "bio_url", "bio", "profile_url", "source_url",
    "fastmoss_units_sold", "fastmoss_gmv", "fastmoss_seller_id",
]


def normalize_shop_proof(row: dict) -> dict:
    """Use one public proof value while retaining FastMoss evidence details."""
    valid = str(row.get("shop_valid", "")).strip().lower() in {"1", "true", "yes"}
    previous = str(row.get("shop_proof") or "").strip()
    method = str(row.get("shop_proof_method") or "").strip()
    if not method:
        method = LEGACY_PROOF_METHODS.get(previous, previous)
    row["shop_proof"] = SHOP_PROOF_VERIFIED if valid else (
        SHOP_PROOF_NOT_VERIFIED if method else ""
    )
    row["shop_proof_method"] = method
    return row


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def collect_fastmoss_seeds(
    export_paths: list[str],
    output_dir: Path,
    countries: set[str],
    max_followers: int,
    desired: int,
    browser_enabled: bool,
    headed: bool,
) -> list[dict]:
    rows = load_fastmoss_exports(
        export_paths, countries, max_followers
    ) if export_paths else []
    merged = {row["username"]: normalize_shop_proof(row) for row in rows}
    if len(merged) < desired and browser_enabled:
        try:
            browser_rows = collect_fastmoss_browser(
                output_dir, countries, max_followers, desired - len(merged), headed
            )
            merged.update({
                row["username"]: normalize_shop_proof(row) for row in browser_rows
            })
        except Exception as exc:
            print(f"[fastmoss-browser] unavailable: {exc}")
    return list(merged.values())


def qualify_fastmoss_seed(
    seed: dict,
    countries: set[str],
    max_followers: int,
    verify_dns: bool,
) -> dict:
    """Strictly qualify one FastMoss creator without any TikHub request."""
    row = normalize_shop_proof(dict(seed))
    row.setdefault("profile_url", f"https://www.tiktok.com/@{row.get('username', '')}")
    row.update({"status": "rejected", "reason": "unknown"})
    if str(row.get("country", "")).upper() not in countries:
        row["reason"] = "country"
        return row
    try:
        followers = int(float(row.get("followers") or 0))
    except (TypeError, ValueError):
        followers = 0
    if not 0 < followers < max_followers:
        row["reason"] = "followers"
        return row
    if str(row.get("shop_valid", "")).lower() != "true":
        row["reason"] = "shop_not_verified"
        return row
    row.update(enrich_contact(row, verify_dns=verify_dns, scrape_link=False))
    if not row.get("email"):
        row["reason"] = "no_public_email"
        return row
    if not row.get("email_verified"):
        row["reason"] = "email_dns"
        return row
    row["status"] = "qualified"
    row["reason"] = ""
    return row


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--countries", nargs="+", default=["ES", "FR", "DE", "IT", "GB"])
    parser.add_argument("--target", type=int, default=1000)
    parser.add_argument("--max-followers", type=int, default=10_000)
    parser.add_argument("--pool-multiplier", type=float, default=4.0)
    parser.add_argument("--inspect-workers", type=int, default=30)
    parser.add_argument("--fastmoss-export", action="append", default=[])
    parser.add_argument("--no-fastmoss-browser", action="store_true")
    parser.add_argument("--fastmoss-headed", action="store_true")
    parser.add_argument("--output-dir", default="output/tts_fastmoss")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--skip-email-dns", action="store_true")
    parser.add_argument("--no-early-stop", action="store_true")
    args = parser.parse_args()

    if args.target < 1 or args.max_followers < 1 or args.pool_multiplier < 1:
        parser.error("target, max-followers and pool-multiplier must be positive")
    countries = {country.upper() for country in args.countries}
    unknown = countries - SUPPORTED_COUNTRIES
    if unknown:
        parser.error(f"unsupported countries: {', '.join(sorted(unknown))}")

    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    desired_pool = max(args.target, round(args.target * args.pool_multiplier))
    seeds = collect_fastmoss_seeds(
        args.fastmoss_export,
        out,
        countries,
        args.max_followers,
        desired_pool,
        not args.no_fastmoss_browser,
        args.fastmoss_headed,
    )
    if not seeds:
        request = {
            "reason": "no_fastmoss_candidates",
            "platform": "tts",
            "source": "fastmoss",
            "next_step": "run fastmoss_browser_setup.sh or pass --fastmoss-export",
        }
        (out / "source_required.json").write_text(
            json.dumps(request, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"[stopped-early] see {out / 'source_required.json'}")
        return 2

    write_csv(out / "raw_candidates.csv", seeds, RESULT_FIELDS)
    checkpoint = CsvCheckpoint(out / "inspection_checkpoint_fastmoss.csv", RESULT_FIELDS)
    completed = checkpoint.completed_keys() if args.resume else set()
    todo = [seed for seed in seeds if seed["username"] not in completed]
    print(f"[inspect] platform=tts source=fastmoss todo={len(todo)}")

    strict_found = sum(
        row.get("status") == "qualified"
        and str(row.get("email_verified")).lower() == "true"
        and str(row.get("shop_valid")).lower() == "true"
        for row in checkpoint.rows()
    ) if args.resume else 0
    with ThreadPoolExecutor(max_workers=args.inspect_workers) as executor:
        futures = {
            executor.submit(
                qualify_fastmoss_seed, seed, countries, args.max_followers,
                not args.skip_email_dns,
            ): seed["username"]
            for seed in todo
        }
        for index, future in enumerate(as_completed(futures), 1):
            username = futures[future]
            try:
                row = future.result()
            except Exception as exc:
                row = {"username": username, "status": "error", "reason": str(exc)[:200]}
            checkpoint.append(row)
            if (
                row.get("status") == "qualified"
                and str(row.get("email_verified")).lower() == "true"
                and str(row.get("shop_valid")).lower() == "true"
            ):
                strict_found += 1
            if index % 100 == 0 or row.get("status") == "qualified":
                print(f"[inspect {index}/{len(todo)}] @{username} {row.get('status')}")
            if not args.no_early_stop and strict_found >= args.target:
                cancelled = sum(item.cancel() for item in futures if not item.done())
                print(f"[inspect] target reached; cancelled {cancelled} pending")
                break

    rows = [normalize_shop_proof(row) for row in checkpoint.rows()]
    eligible = [
        row for row in rows
        if row.get("status") == "qualified"
        and row.get("email")
        and str(row.get("email_verified")).lower() == "true"
        and str(row.get("shop_valid")).lower() == "true"
    ]
    eligible.sort(key=lambda row: (
        row.get("country") == "ES",
        int(float(row.get("fastmoss_units_sold") or 0)),
        int(float(row.get("followers") or 0)),
    ), reverse=True)
    final = eligible[:args.target]
    for rank, row in enumerate(final, 1):
        row["rank"] = rank
    write_csv(out / "final.csv", final, ["rank"] + RESULT_FIELDS)
    write_csv(out / "final_top1000.csv", final, ["rank"] + RESULT_FIELDS)

    summary = {
        "platform": "tts",
        "source": "fastmoss",
        "raw_pool": len(seeds),
        "qualified_strict": len(eligible),
        "final": len(final),
        "status": dict(Counter(row.get("status") for row in rows)),
        "top_rejection_reasons": dict(Counter(
            row.get("reason") for row in rows if row.get("reason")
        ).most_common(15)),
        "tikhub_requests": 0,
    }
    (out / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if len(final) >= args.target else 3


if __name__ == "__main__":
    raise SystemExit(main())
