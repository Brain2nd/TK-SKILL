"""FastMoss contact API client authenticated from the Playwright session."""

from __future__ import annotations

import hashlib
import json
import random
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

SALT = "LAA6edGHBkcc3eTiOIRfg89bu9ODA6PB"
API_BASE = "https://www.fastmoss.com"
SEARCH_PATH = "/api/author/search"
DEFAULT_COOKIE_FILE = "cookies.json"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Pure helpers (no side effects)
# ---------------------------------------------------------------------------


def _cnonce() -> str:
    """8-digit random nonce matching ``Math.floor(1e7 + 9e7 * Math.random())``."""
    return str(int(1e7 + 9e7 * random.random()))


def _ts_sec() -> str:
    """10-digit seconds-precision timestamp."""
    return str(int(time.time()))


def _filter_params(params: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in params.items() if v is not None and v != ""}


def fm_sign(params: dict[str, Any], extra_data: str = "") -> str:
    """Reproduce the ``fm-sign`` header sent by the FastMoss web front-end.

    1. Sort keys, concatenate ``key + value + SALT`` for each.
    2. Append *extra_data* (JSON body for POST; empty for GET).
    3. MD5 the resulting string.
    4. XOR-transform: pair head/tail hex digits, append middle leftover.
    """
    filtered = _filter_params(params)
    raw = "".join(k + str(filtered[k]) + SALT for k in sorted(filtered))
    raw += extra_data
    digest = hashlib.md5(raw.encode()).hexdigest()
    chars = list(digest)
    result: list[str] = []
    i, j = 0, len(chars) - 1
    while i < j:
        result.append(format(int(chars[i], 16) ^ int(chars[j], 16), "x"))
        i += 1
        j -= 1
    result.append("".join(chars[i:]))
    return "".join(result)


# ---------------------------------------------------------------------------
# Cookie persistence
# ---------------------------------------------------------------------------


def _cookie_dict_to_header(cookies: list[dict[str, Any]]) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


class _CookieStore:
    """Thin JSON-file wrapper for a cookie jar plus a freshness timestamp."""

    def __init__(self, path: Path) -> None:
        self._path = path

    def read(self) -> str | None:
        if not self._path.exists():
            return None
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        header = data.get("cookie_header", "")
        if not header:
            return None
        return header

    def write(self, cookie_header: str) -> None:
        payload = {
            "cookie_header": cookie_header,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------


class FastMossApiClient:
    """FastMoss contact client backed by the managed Playwright profile."""

    def __init__(
        self,
        profile_dir: str | Path | None = None,
        cookie_file: str | Path | None = None,
    ) -> None:
        from fastmoss_pipeline.scraper import DEFAULT_PROFILE_DIR

        self._profile_dir = Path(profile_dir or DEFAULT_PROFILE_DIR)
        self._cookie_store = _CookieStore(
            self._profile_dir / (Path(cookie_file) if cookie_file else DEFAULT_COOKIE_FILE)
        )
        self._scraper: Any = None  # lazy – only when browser extraction is needed
        self._cookie_header: str | None = None
        self._session = requests.Session()

    # ------------------------------------------------------------------
    # Cookie lifecycle
    # ------------------------------------------------------------------

    @property
    def cookie_header(self) -> str:
        if self._cookie_header is None:
            self._cookie_header = self._load_cookie()
        return self._cookie_header

    @property
    def has_cookies(self) -> bool:
        """True if a cookie file exists on disk (no network check)."""
        return self._cookie_store._path.exists()

    def _load_cookie(self) -> str:
        stored = self._cookie_store.read()
        if stored is not None:
            self._cookie_header = stored
            return stored
        return ""

    def _get_scraper(self):
        if self._scraper is None:
            from fastmoss_pipeline.scraper import FastMossScraper
            self._scraper = FastMossScraper(str(self._profile_dir))
        return self._scraper

    def _probe_auth(self) -> bool:
        """Lightweight auth check: call page 1 with tiny pagesize."""
        try:
            resp = self._request(page=1, pagesize=1)
            if resp.status_code == 200:
                data = resp.json()
                return data.get("code") == 200 and data.get("ext", {}).get("is_login")
        except Exception:
            pass
        return False

    def refresh_cookies_from_browser(
        self,
        username: str = "",
        password: str = "",
        verification_timeout: int = 300,
    ) -> str:
        """Extract cookies from the Playwright browser and persist them.

        Blocks while the browser is open; returns the new ``Cookie`` header.
        Use the saved browser session when it is still authenticated.
        """
        raw_cookies = self._get_scraper().extract_cookies(
            username=username,
            password=password,
            verification_timeout=verification_timeout,
        )
        header = _cookie_dict_to_header(raw_cookies)
        self._cookie_header = header
        self._cookie_store.write(header)
        self._session.cookies.clear()
        return header

    # ------------------------------------------------------------------
    # Request helpers
    # ------------------------------------------------------------------

    def _request(
        self,
        page: int = 1,
        region: str = "US",
        pagesize: int = 10,
        order: str = "2,2",
        **extra_params: Any,
    ) -> requests.Response:
        params: dict[str, str] = {
            "page": str(page),
            "region": region,
            "order": order,
            "pagesize": str(pagesize),
            "_time": _ts_sec(),
            "cnonce": _cnonce(),
        }
        for k, v in extra_params.items():
            if v is not None and v != "":
                params[k] = str(v)

        headers = {
            "User-Agent": USER_AGENT,
            "fm-sign": fm_sign(params),
            "Cookie": self.cookie_header,
            "region": region,
            "lang": "zh-CN",
            "source": "pc",
        }
        url = f"{API_BASE}{SEARCH_PATH}"
        return self._session.get(url, params=params, headers=headers, timeout=30)

    def get_author_contact(self, uid: str) -> dict[str, Any]:
        """Fetch publicly listed contact info for a single creator.

        Calls the ``/api/author/v3/detail/authorContact`` endpoint with a
        valid ``fm-sign`` header.  Returns the email address (if present)
        along with the raw contact list.

        Args:
            uid: TikTok numeric user ID (e.g. ``\"7000802688678872069\"``).
        Returns:
            ``{"email": "foo@example.com", "has_email": true, "raw": {...}}``
            on success, or ``{"error": "MSG_SAFE_0001"}`` on rate-limit.
        """
        params: dict[str, str] = {
            "uid": str(uid),
            "_time": _ts_sec(),
            "cnonce": _cnonce(),
        }
        headers = {
            "User-Agent": USER_AGENT,
            "fm-sign": fm_sign(params),
            "Cookie": self.cookie_header,
            "region": "ES",
            "lang": "ZH_CN",
            "source": "pc",
            "accept": "application/json",
        }
        url = f"{API_BASE}/api/author/v3/detail/authorContact"
        try:
            resp = self._session.get(url, params=params, headers=headers, timeout=30)
        except requests.RequestException as exc:
            return {"error": f"request failed: {exc}"}

        if resp.status_code != 200:
            return {"error": f"HTTP {resp.status_code}"}

        try:
            data = resp.json()
        except json.JSONDecodeError:
            return {"error": "invalid JSON response"}

        if data.get("code") != 200:
            return {"error": data.get("msg", data.get("code", "unknown"))}

        contact_list = (data.get("data") or {}).get("list") or []
        email = ""
        for item in contact_list:
            if item.get("name") == "email" and item.get("has") and item.get("id"):
                email = item["id"]
                break

        return {
            "email": email,
            "has_email": bool(email),
            "raw": contact_list,
        }
