"""
Smoke test: 对已筛选的60个达人尝试提取联系方式
来源1: bio 正则提取 email
来源2: TikHub fetch_user_profile 获取 bio_url
来源3: 爬 linktr.ee / beacons.ai 提取 email 和 Instagram handle

用法: python smoke_test_contacts.py
"""
import csv
import re
import time
import requests
from config import TIKHUB_API_KEY

INPUT_CSV  = "output/candidates_final.csv"
OUTPUT_CSV = "output/contacts_smoke_test.csv"

BASE    = "https://api.tikhub.io"
HEADERS = {"Authorization": f"Bearer {TIKHUB_API_KEY}"}

EMAIL_RE    = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
INSTAGRAM_RE = re.compile(r"(?:instagram\.com/|ig[:\s@]+|insta[:\s@]+)([a-zA-Z0-9._]+)", re.I)
URL_RE      = re.compile(r"https?://[^\s\"'>]+")


def extract_email_from_text(text: str) -> str:
    m = EMAIL_RE.search(text or "")
    return m.group(0).lower() if m else ""


def extract_instagram_from_text(text: str) -> str:
    m = INSTAGRAM_RE.search(text or "")
    return m.group(1) if m else ""


def fetch_bio_url(username: str) -> str:
    """调 TikHub 拉用户 profile，返回 bio 外链（bio_url）"""
    try:
        r = requests.get(
            f"{BASE}/api/v1/tiktok/app/v3/fetch_user_profile_by_unique_id",
            headers=HEADERS,
            params={"unique_id": username},
            timeout=15,
        )
        data = r.json().get("data", {})
        user = data.get("user", {})
        return user.get("bio_url", {}).get("link_url", "") or ""
    except Exception as e:
        print(f"  [TikHub profile] @{username}: {e}")
        return ""


def fetch_page_text(url: str) -> str:
    """抓取外链页面文本，限时5s，截断到5000字符"""
    try:
        r = requests.get(url, timeout=5, headers={
            "User-Agent": "Mozilla/5.0 (compatible; smoke-test/1.0)"
        })
        return r.text[:5000]
    except Exception:
        return ""


def process_creator(username: str, bio: str) -> dict:
    result = {
        "username":  username,
        "email_from_bio":     "",
        "email_from_biolink": "",
        "instagram":          "",
        "bio_url":            "",
        "source":             "",
    }

    # 来源1: bio 直接提取
    result["email_from_bio"] = extract_email_from_text(bio)
    result["instagram"]      = extract_instagram_from_text(bio)

    # 来源2: TikHub profile bio_url
    bio_url = fetch_bio_url(username)
    result["bio_url"] = bio_url
    time.sleep(0.5)

    # 来源3: 爬 bio_url 页面
    if bio_url:
        page = fetch_page_text(bio_url)
        if not result["email_from_biolink"]:
            result["email_from_biolink"] = extract_email_from_text(page)
        if not result["instagram"]:
            result["instagram"] = extract_instagram_from_text(page)

    # 汇总 source 标注
    sources = []
    if result["email_from_bio"]:     sources.append("bio_email")
    if result["email_from_biolink"]: sources.append("biolink_email")
    if result["instagram"]:          sources.append("instagram")
    if result["bio_url"]:            sources.append("bio_url")
    result["source"] = ",".join(sources) if sources else "none"

    return result


def main():
    # 读取候选人
    with open(INPUT_CSV, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    print(f"共 {len(rows)} 位达人，开始 smoke test 联系方式提取...\n")

    results = []
    found_any = 0

    for i, row in enumerate(rows, 1):
        username = row.get("username", "")
        bio      = row.get("bio", "")
        print(f"[{i}/{len(rows)}] @{username}", end=" ... ")

        r = process_creator(username, bio)
        results.append(r)

        if r["source"] != "none":
            found_any += 1
            print(f"✅ {r['source']} | email={r['email_from_bio'] or r['email_from_biolink']} | ig={r['instagram']} | url={r['bio_url'][:50]}")
        else:
            print("❌ 无联系方式")

        time.sleep(0.3)

    # 写结果
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "username", "email_from_bio", "email_from_biolink",
            "instagram", "bio_url", "source"
        ])
        writer.writeheader()
        writer.writerows(results)

    print(f"\n{'='*50}")
    print(f"总计: {len(rows)} 人")
    print(f"有联系方式: {found_any} 人 ({found_any/len(rows)*100:.0f}%)")
    print(f"  - bio 有 email: {sum(1 for r in results if r['email_from_bio'])} 人")
    print(f"  - 外链有 email: {sum(1 for r in results if r['email_from_biolink'])} 人")
    print(f"  - 有 Instagram: {sum(1 for r in results if r['instagram'])} 人")
    print(f"  - 有 bio_url:   {sum(1 for r in results if r['bio_url'])} 人")
    print(f"\n结果写入: {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
