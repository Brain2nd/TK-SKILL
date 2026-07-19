"""Persistent-browser FastMoss creator scraper.

The module deliberately has no FastMoss API client. It drives the customer-facing
Creator Search page with a user-owned account and collects only data rendered by
that account. Credentials live only for the duration of the call; the persistent
browser profile stores the resulting website session.
"""
from __future__ import annotations

import argparse
import csv
import fcntl
import getpass
import json
import math
import re
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlencode


PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_DIR = PROJECT_DIR / "output" / ".fastmoss-profile"
SEARCH_URL = "https://www.fastmoss.com/zh/influencer/search"
EMAIL_SCRIPT = Path(__file__).resolve().parent / "browser_email_enrichment.js"
API_PATH_HINTS = ("/api/author/search", "/api/influencer/search")


class FastMossError(RuntimeError):
    """Base error with a stable machine-readable code."""

    code = "fastmoss_error"


class FastMossAuthRequired(FastMossError):
    code = "fastmoss_auth_required"


class FastMossVerificationRequired(FastMossError):
    code = "fastmoss_verification_required"


class FastMossBlocked(FastMossError):
    code = "fastmoss_blocked"


class FastMossRateLimited(FastMossError):
    code = "fastmoss_rate_limited"


class FastMossBusy(FastMossError):
    code = "fastmoss_busy"


@dataclass(slots=True)
class SearchCriteria:
    """Supported creator characteristics.

    ``extra_filters`` keeps the scraper useful when FastMoss adds a filter before
    this module gets a named field. Keys are visible filter labels and values are
    a scalar, boolean, or ``[minimum, maximum]`` pair.
    """

    keyword: str = ""
    keywords: list[str] = field(default_factory=list)
    countries: list[str] = field(default_factory=list)
    min_followers: int | None = None
    max_followers: int | None = None
    min_avg_views: int | None = None
    max_avg_views: int | None = None
    min_engagement_rate: float | None = None
    min_units_sold: int | None = None
    max_units_sold: int | None = None
    min_gmv: float | None = None
    max_gmv: float | None = None
    creator_categories: list[str] = field(default_factory=list)
    product_categories: list[str] = field(default_factory=list)
    shop_affiliates_only: bool = False
    extra_filters: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> "SearchCriteria":
        raw = dict(raw or {})
        aliases = {
            "query": "keyword",
            "country": "countries",
            "regions": "countries",
            "follower_min": "min_followers",
            "follower_max": "max_followers",
            "followers_min": "min_followers",
            "followers_max": "max_followers",
            "avg_views_min": "min_avg_views",
            "avg_views_max": "max_avg_views",
            "sales_min": "min_units_sold",
            "sales_max": "max_units_sold",
        }
        for old, new in aliases.items():
            if old in raw and new not in raw:
                raw[new] = raw.pop(old)
        allowed = set(cls.__dataclass_fields__)
        unknown = sorted(set(raw) - allowed)
        if unknown:
            raise ValueError(f"unsupported FastMoss criteria: {', '.join(unknown)}")
        countries = raw.get("countries") or []
        if isinstance(countries, str):
            countries = [countries]
        raw["countries"] = [str(item).strip().upper() for item in countries if str(item).strip()]
        for name in ("creator_categories", "product_categories"):
            value = raw.get(name) or []
            raw[name] = [value] if isinstance(value, str) else list(value)
        keywords = raw.get("keywords") or []
        if isinstance(keywords, str):
            keywords = [keywords]
        raw["keywords"] = list(dict.fromkeys(
            str(item).strip() for item in keywords if str(item).strip()
        ))
        criteria = cls(**raw)
        criteria.validate()
        return criteria

    def validate(self) -> None:
        ranges = (
            ("followers", self.min_followers, self.max_followers),
            ("average views", self.min_avg_views, self.max_avg_views),
            ("units sold", self.min_units_sold, self.max_units_sold),
            ("GMV", self.min_gmv, self.max_gmv),
        )
        for label, minimum, maximum in ranges:
            if minimum is not None and minimum < 0:
                raise ValueError(f"minimum {label} cannot be negative")
            if maximum is not None and maximum < 0:
                raise ValueError(f"maximum {label} cannot be negative")
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError(f"minimum {label} cannot exceed maximum")
        if self.min_engagement_rate is not None and self.min_engagement_rate < 0:
            raise ValueError("minimum engagement rate cannot be negative")


def parse_number(value: Any) -> float:
    """Parse common FastMoss compact number formats."""
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip().lower().replace(",", "")
    if not text or text in {"--", "-", "n/a"}:
        return 0.0
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return 0.0
    number = float(match.group())
    suffix = text[match.end():].strip()
    if suffix.startswith("k") or suffix.startswith("千"):
        number *= 1_000
    elif suffix.startswith("m"):
        number *= 1_000_000
    elif suffix.startswith("b"):
        number *= 1_000_000_000
    elif suffix.startswith("万"):
        number *= 10_000
    elif suffix.startswith("亿"):
        number *= 100_000_000
    return number


def _key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


FIELD_ALIASES = {
    "uid": ("uid", "userid", "authorid", "id"),
    "username": ("uniqueid", "username", "handle", "authoruniqueid", "tiktokid"),
    "nickname": ("nickname", "authorname", "displayname"),
    "country": ("country", "region", "countrycode"),
    "followers": ("followers", "followercount", "fans", "fanscount"),
    "avg_views": ("avgviews", "averageviews", "playavg", "avgplaycount"),
    "engagement_rate": ("engagementrate", "interactrate", "interactionrate"),
    "units_sold": ("unitssold", "sales", "salescount", "soldcount", "totalunitsold"),
    "gmv": ("gmv", "totalgmv", "revenue", "salesamount"),
    "email": ("email", "contactemail", "businessemail"),
    "creator_category": ("creatorcategory", "authorcategory", "contentcategory"),
    "product_category": ("productcategory", "categoryname", "maincategory"),
    "profile_url": ("profileurl", "tiktokurl", "authorurl"),
    "source_url": ("detailurl", "fastmossurl", "sourceurl"),
    "bio": ("bio", "signature", "description", "desc"),
}


def _flatten_mapping(record: dict[str, Any]) -> dict[str, Any]:
    flat: dict[str, Any] = {}
    queue = [record]
    while queue and len(flat) < 300:
        current = queue.pop(0)
        for name, value in current.items():
            flat.setdefault(_key(name), value)
            if isinstance(value, dict):
                queue.append(value)
    return flat


def normalize_record(record: dict[str, Any], fallback_country: str = "") -> dict[str, Any] | None:
    flat = _flatten_mapping(record)

    def pick(field_name: str, default: Any = "") -> Any:
        for alias in FIELD_ALIASES[field_name]:
            value = flat.get(alias)
            if value not in (None, "", [], {}):
                return value
        return default

    username = str(pick("username")).strip().lstrip("@").lower()
    profile_url = str(pick("profile_url"))
    if not username:
        match = re.search(r"tiktok\.com/@([^/?#]+)", profile_url, re.I)
        username = match.group(1).lower() if match else ""
    if not username:
        return None
    rate_value = pick("engagement_rate")
    rate = parse_number(rate_value)
    if "%" in str(rate_value):
        rate /= 100
    result = {
        "uid": str(pick("uid")),
        "unique_id": username,
        "username": username,
        "nickname": str(pick("nickname")),
        "country": str(pick("country", fallback_country)).strip().upper(),
        "followers": int(parse_number(pick("followers"))),
        "avg_views": int(parse_number(pick("avg_views"))),
        "engagement_rate": rate,
        "units_sold": int(parse_number(pick("units_sold"))),
        "gmv": parse_number(pick("gmv")),
        "email": str(pick("email")).strip().lower(),
        "creator_category": str(pick("creator_category")),
        "product_category": str(pick("product_category")),
        "bio": str(pick("bio")),
        "profile_url": profile_url,
        "source_url": str(pick("source_url")),
        "source": "fastmoss_browser",
    }
    if not result["profile_url"]:
        result["profile_url"] = f"https://www.tiktok.com/@{username}"
    return result


def records_from_payload(payload: Any, fallback_country: str = "") -> list[dict[str, Any]]:
    """Find creator-shaped records without relying on one response envelope."""
    found: list[dict[str, Any]] = []
    stack: list[tuple[Any, int]] = [(payload, 0)]
    while stack and len(found) < 5_000:
        value, depth = stack.pop()
        if depth > 8:
            continue
        if isinstance(value, list):
            stack.extend((item, depth + 1) for item in value[:5_000])
        elif isinstance(value, dict):
            normalized_keys = {_key(name) for name in value}
            aliases = set().union(*FIELD_ALIASES.values())
            if len(normalized_keys & aliases) >= 2:
                row = normalize_record(value, fallback_country)
                if row:
                    found.append(row)
            stack.extend((item, depth + 1) for item in value.values() if isinstance(item, (dict, list)))
    return found


def matches_criteria(row: dict[str, Any], criteria: SearchCriteria) -> bool:
    numeric_checks = (
        ("followers", criteria.min_followers, criteria.max_followers),
        ("avg_views", criteria.min_avg_views, criteria.max_avg_views),
        ("units_sold", criteria.min_units_sold, criteria.max_units_sold),
        ("gmv", criteria.min_gmv, criteria.max_gmv),
    )
    for field_name, minimum, maximum in numeric_checks:
        value = parse_number(row.get(field_name))
        if minimum is not None and value < minimum:
            return False
        if maximum is not None and value > maximum:
            return False
    if criteria.countries and str(row.get("country") or "").upper() not in criteria.countries:
        return False
    if criteria.min_engagement_rate is not None:
        value = parse_number(row.get("engagement_rate"))
        if value < criteria.min_engagement_rate:
            return False
    haystack = " ".join(str(row.get(name) or "") for name in (
        "username", "nickname", "bio", "creator_category", "product_category"
    )).lower()
    if criteria.keyword and criteria.keyword.lower() not in haystack:
        return False
    if criteria.creator_categories and not any(item.lower() in haystack for item in criteria.creator_categories):
        return False
    if criteria.product_categories and not any(item.lower() in haystack for item in criteria.product_categories):
        return False
    return True


class FastMossScraper:
    """One focused login/search implementation backed by Playwright Chromium."""

    def __init__(self, profile_dir: str | Path = DEFAULT_PROFILE_DIR, timeout_ms: int = 60_000):
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        self.timeout_ms = timeout_ms
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.session_marker = self.profile_dir / "authenticated.json"

    @property
    def has_saved_session(self) -> bool:
        return self.session_marker.is_file()

    def _mark_authenticated(self) -> None:
        self.session_marker.write_text(
            json.dumps({"authenticated_at": datetime.now(UTC).isoformat()}),
            encoding="utf-8",
        )

    @contextmanager
    def _browser(self, *, headed: bool) -> Iterator[tuple[Any, Any]]:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise FastMossError("Playwright is not installed; run ./setup.sh") from exc
        lock_path = self.profile_dir / ".browser.lock"
        with lock_path.open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise FastMossBusy("another FastMoss browser job is already using this profile") from exc
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=str(self.profile_dir),
                    headless=not headed,
                    viewport={"width": 1440, "height": 960},
                    locale="en-US",
                    accept_downloads=False,
                    args=[
                        "--disable-save-password-bubble",
                        "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication",
                    ],
                )
                try:
                    yield context, context.pages[0] if context.pages else context.new_page()
                finally:
                    context.close()
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _goto(self, page: Any, url: str) -> None:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=self.timeout_ms)
        except Exception:
            # Some FastMoss requests keep long-lived connections open. If a DOM
            # exists, classify it below instead of turning a usable page into a
            # generic navigation timeout.
            if not page.url:
                raise
        page.wait_for_timeout(800)
        self._raise_if_blocked(page)

    @staticmethod
    def _visible(locator: Any) -> Any | None:
        for index in range(locator.count()):
            item = locator.nth(index)
            if item.is_visible():
                return item
        return None

    def _raise_if_blocked(self, page: Any) -> None:
        text = page.locator("body").inner_text(timeout=10_000)[:4_000].lower()
        markers = ("restricted access", "security policy", "请求已被", "安全策略", "access denied")
        if any(marker in text for marker in markers):
            raise FastMossBlocked(
                "FastMoss blocked this browser session; open the headed login flow and retry later"
            )

    def _authenticated(self, page: Any) -> bool:
        if self._visible(page.locator('input[type="password"]')):
            return False
        body = page.locator("body").inner_text(timeout=10_000)[:8_000].lower()
        # Guest pages also render the "Creator Search" heading, so a visible
        # login entry point must veto authentication before the heading check.
        if any(text in body for text in ("log in", "login/signup", "登录/注册", "登录 / 注册")):
            return False
        if "creator search" in body or "达人搜索" in body:
            return True
        return "/influencer/search" in page.url

    def _dismiss_overlays(self, page: Any) -> None:
        """Close cookie banners, announcements, and other modals that block clicks."""
        for selector in (
            '.ant-modal-close', '.ant-modal-wrap button:has-text("×")',
            '[class*="close"]', '[class*="Close"]',
            'button:has-text("Got it")', 'button:has-text("OK")',
            'button:has-text("了解")', 'button:has-text("确定")',
            'button:has-text("知道了")', 'button:has-text("接受")',
            'button:has-text("Accept")', 'button:has-text("Agree")',
        ):
            close_btn = self._visible(page.locator(selector).first)
            if close_btn:
                try:
                    close_btn.click(force=True)
                    page.wait_for_timeout(300)
                except Exception:
                    pass

    def _login_dialog(self, page: Any) -> Any:
        """Return the visible login dialog when FastMoss uses an overlay."""
        dialogs = page.locator(
            '[role="dialog"], .ant-modal, .el-dialog, '
            '[class*="login-modal"], [class*="loginModal"]'
        )
        return self._visible(dialogs) or page

    def _click_login_choice(self, scope: Any, labels: tuple[str, ...]) -> bool:
        """Click one exact visible login-mode choice without guessing position."""
        for label in labels:
            candidates = scope.get_by_text(label, exact=True)
            choice = self._visible(candidates)
            if not choice:
                continue
            try:
                choice.click(force=True)
            except Exception:
                choice.click()
            return True
        return False

    def _select_phone_password_login(self, page: Any) -> bool:
        """Switch the login modal from its default mode to phone/password."""
        if self._visible(page.locator('input[type="password"]')):
            return True
        scope = self._login_dialog(page)
        phone_selected = self._click_login_choice(scope, (
            "手机号登录/注册", "手机号登录 / 注册", "手机号登录",
            "手机登录/注册", "手机登录 / 注册", "手机登录",
        ))
        if phone_selected:
            page.wait_for_timeout(500)
        if self._visible(page.locator('input[type="password"]')):
            return True

        # Some accounts first land on SMS-code login and require one more tab
        # switch before the password field is rendered.
        scope = self._login_dialog(page)
        password_selected = self._click_login_choice(scope, (
            "密码登录", "账号密码登录", "手机号密码登录", "使用密码登录",
        ))
        if password_selected:
            page.wait_for_timeout(500)
        return self._visible(page.locator('input[type="password"]')) is not None

    def _open_login_form(self, page: Any) -> None:
        if self._visible(page.locator('input[type="password"]')):
            return
        self._dismiss_overlays(page)
        opened = self._click_login_choice(page, (
            "登录/注册", "登录 / 注册", "登录注册",
            "Log in", "Login", "Sign in",
        ))

        if not opened:
            # Stable link/button attributes are preferable to broad class-name
            # matches, which can accidentally click the entire modal container.
            for selector in (
                'a[href*="login"]', 'a[href*="signin"]',
                'button:has-text("登录/注册")', 'button:has-text("Log in")',
            ):
                trigger = self._visible(page.locator(selector))
                if not trigger:
                    continue
                try:
                    trigger.click(force=True)
                except Exception:
                    trigger.click()
                opened = True
                break

        if opened:
            page.wait_for_timeout(500)
        self._select_phone_password_login(page)

    def _login_in_context(
        self,
        page: Any,
        username: str,
        password: str,
        verification_timeout: int,
    ) -> None:
        self._goto(page, SEARCH_URL)
        if self.has_saved_session and self._authenticated(page):
            return
        if not username or not password:
            raise FastMossAuthRequired("FastMoss username and password are required")
        self._open_login_form(page)
        password_input = self._visible(page.locator('input[type="password"]'))
        if not password_input:
            raise FastMossAuthRequired(
                "FastMoss phone/password login form was not available"
            )
        form = password_input.locator("xpath=ancestor::form[1]")
        scope = form if form.count() == 1 else page
        account_input = self._visible(scope.locator(
            'input[type="email"], input[type="tel"], input[type="text"], input:not([type])'
        ))
        if not account_input:
            raise FastMossAuthRequired("FastMoss account field was not available")
        account_input.fill(username)
        password_input.fill(password)
        submit = None
        for label in ("Log in", "Login", "Sign in", "登录", "登录 / 注册", "登录/注册"):
            submit = self._visible(scope.get_by_role("button", name=label, exact=False))
            if submit:
                break
        if not submit:
            submit = self._visible(scope.locator('button[type="submit"]'))
        if not submit:
            raise FastMossAuthRequired("FastMoss login submit button was not available")
        submit.click()

        deadline = time.monotonic() + max(30, verification_timeout)
        verification_seen = False
        while time.monotonic() < deadline:
            page.wait_for_timeout(1_000)
            self._raise_if_blocked(page)
            text = page.locator("body").inner_text(timeout=10_000)[:6_000].lower()
            verification_seen = verification_seen or any(marker in text for marker in (
                "captcha", "verify you are human", "security verification", "验证码", "安全验证"
            ))
            if self._authenticated(page):
                self._goto(page, SEARCH_URL)
                self._mark_authenticated()
                return
        if verification_seen:
            raise FastMossVerificationRequired(
                "FastMoss still requires CAPTCHA, SMS, or another verification step"
            )
        raise FastMossAuthRequired("FastMoss login did not complete before the timeout")

    def login(self, username: str, password: str, verification_timeout: int = 300) -> dict[str, Any]:
        """Open a visible browser, sign in, and persist only the resulting session."""
        with self._browser(headed=True) as (_, page):
            self._login_in_context(page, username, password, verification_timeout)
            return {"ok": True, "status": "authenticated", "profile_dir": str(self.profile_dir)}

    def _fill_range(self, page: Any, terms: tuple[str, ...], minimum: Any, maximum: Any) -> bool:
        if minimum is None and maximum is None:
            return True
        pattern = re.compile("|".join(re.escape(term) for term in terms), re.I)
        labels = page.locator("label, [class*='label'], [class*='filter']").filter(has_text=pattern)
        for index in range(min(labels.count(), 80)):
            label = labels.nth(index)
            if not label.is_visible():
                continue
            container = label
            for _ in range(4):
                container = container.locator("xpath=..")
                inputs = container.locator("input")
                count = inputs.count()
                if 2 <= count <= 4:
                    if minimum is not None:
                        inputs.nth(0).fill(str(minimum))
                    if maximum is not None:
                        inputs.nth(1).fill(str(maximum))
                    return True
        return False

    def _apply_filters(self, page: Any, criteria: SearchCriteria) -> list[str]:
        warnings: list[str] = []
        advanced = self._visible(page.get_by_text("Advanced Filter", exact=True))
        if advanced:
            advanced.click()
            page.wait_for_timeout(300)

        if criteria.keyword:
            if self._fill_ant_select_keyword(page, criteria.keyword):
                keyword_input = True
            else:
                keyword_input = None
                for selector in (
                    'input[placeholder*="Username"]', 'input[placeholder*="Influencer"]',
                    'input[placeholder*="Creator"]', 'input[type="search"]',
                ):
                    keyword_input = self._visible(page.locator(selector))
                    if keyword_input:
                        break
                if keyword_input:
                    keyword_input.fill(criteria.keyword)
                    keyword_input.press("Enter")
            if not keyword_input:
                warnings.append("keyword control was not found in the current UI")

        ranges = (
            (("Followers", "Follower Count", "粉丝"), criteria.min_followers, criteria.max_followers, "followers"),
            (("Average Views", "Avg Views", "平均播放"), criteria.min_avg_views, criteria.max_avg_views, "average views"),
            (("Units Sold", "Sales", "销量"), criteria.min_units_sold, criteria.max_units_sold, "units sold"),
            (("GMV", "Revenue", "销售额"), criteria.min_gmv, criteria.max_gmv, "GMV"),
        )
        for terms, minimum, maximum, label in ranges:
            if (minimum is not None or maximum is not None) and not self._fill_range(
                page, terms, minimum, maximum
            ):
                warnings.append(f"{label} applied only to collected rows")

        if criteria.shop_affiliates_only:
            checkbox = self._visible(page.get_by_text("Check Shop Affiliates Only", exact=True))
            if checkbox:
                checkbox.click()
            else:
                warnings.append("shop-affiliate filter was not found in the current UI")

        for label, value in criteria.extra_filters.items():
            if isinstance(value, (list, tuple)) and len(value) == 2:
                if not self._fill_range(page, (label,), value[0], value[1]):
                    warnings.append(f"extra filter not found: {label}")
            elif isinstance(value, bool):
                control = self._visible(page.get_by_text(label, exact=True))
                if control and value:
                    control.click()
                elif value:
                    warnings.append(f"extra filter not found: {label}")
            else:
                labels = page.locator("label, [class*='label']").filter(has_text=re.compile(re.escape(label), re.I))
                applied = False
                for index in range(min(labels.count(), 30)):
                    container = labels.nth(index).locator("xpath=..").locator("input")
                    if container.count() == 1 and container.is_visible():
                        container.fill(str(value))
                        applied = True
                        break
                if not applied:
                    warnings.append(f"extra filter not found: {label}")

        for name in ("Search", "Apply", "查询", "搜索"):
            button = self._visible(page.get_by_role("button", name=name, exact=True))
            if button:
                button.click()
                page.wait_for_timeout(800)
                break
        return warnings

    def _fill_ant_select_keyword(self, page: Any, keyword: str) -> bool:
        """Fill the hidden combobox input used by the current Ant Design Select."""
        candidates = page.locator(
            '.ant-select input[role="combobox"], '
            '.ant-select .ant-select-selection-search-input'
        )
        for index in range(min(candidates.count(), 30)):
            control = candidates.nth(index)
            if not control.is_visible():
                continue
            select = control.locator("xpath=ancestor::*[contains(@class, 'ant-select')][1]")
            context = " ".join(filter(None, (
                control.get_attribute("placeholder") or "",
                control.get_attribute("aria-label") or "",
                select.locator("xpath=..").inner_text(timeout=2_000)[:300],
            )))
            if not re.search(
                r"username|influencer|creator|达人|用户名|账号|关键词|keyword|id",
                context,
                re.I,
            ):
                continue
            select.click(force=True)
            control.fill("")
            control.type(keyword, delay=20)
            page.wait_for_timeout(250)
            option = self._visible(page.locator(
                '.ant-select-dropdown:not(.ant-select-dropdown-hidden) '
                '.ant-select-item-option'
            ).filter(has_text=re.compile(rf"^{re.escape(keyword)}$", re.I)))
            if option:
                option.click()
            else:
                control.press("Enter")
            page.wait_for_timeout(150)
            return True
        return False

    @staticmethod
    def _dom_records(page: Any, country: str) -> list[dict[str, Any]]:
        raw_rows = page.locator("table tbody tr, [role='row'], .ant-table-row, .el-table__row")
        records: list[dict[str, Any]] = []
        for index in range(min(raw_rows.count(), 500)):
            row = raw_rows.nth(index)
            if not row.is_visible():
                continue
            record = row.evaluate("""element => {
                const table = element.closest('table');
                const headers = table ? [...table.querySelectorAll('thead th')].map(x => x.innerText.trim()) : [];
                const cells = [...element.querySelectorAll(':scope > td, :scope > [role=cell]')].map(x => x.innerText.trim());
                const data = {};
                headers.forEach((name, i) => { if (name) data[name] = cells[i] || ''; });
                data.bio = (element.innerText || '').replace(/\\s+/g, ' ').trim();
                const links = [...element.querySelectorAll('a[href]')].map(x => x.href);
                data.profile_url = links.find(x => /tiktok\\.com\\/@/i.test(x)) || '';
                data.source_url = links.find(x => /influencer\\/detail/i.test(x)) || '';
                const match = data.profile_url.match(/tiktok\\.com\\/@([^/?#]+)/i) || data.bio.match(/@([A-Za-z0-9._-]{2,})/);
                if (match) data.username = decodeURIComponent(match[1]);
                return data;
            }""")
            normalized = normalize_record(record, country)
            if normalized:
                records.append(normalized)
        return records

    def _next_page(self, page: Any) -> bool:
        selectors = (
            'button[aria-label="Next"]', 'button[aria-label="下一页"]',
            '.ant-pagination-next:not(.ant-pagination-disabled) button',
            '.el-pagination .btn-next:not([disabled])',
        )
        for selector in selectors:
            button = self._visible(page.locator(selector))
            if button and button.is_enabled():
                active = page.locator(".ant-pagination-item-active")
                previous = active.inner_text().strip() if active.count() else ""
                button.click()
                if previous:
                    try:
                        page.wait_for_function(
                            "previous => (document.querySelector('.ant-pagination-item-active')?.textContent || '').trim() !== previous",
                            arg=previous,
                            timeout=min(self.timeout_ms, 10_000),
                        )
                    except Exception:
                        return False
                page.wait_for_timeout(500)
                return True
        return False

    def _search_country(
        self,
        page: Any,
        criteria: SearchCriteria,
        country: str,
        limit: int,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        payloads: list[Any] = []
        auth_failures: list[int] = []
        rate_limits: list[int] = []

        def capture(response: Any) -> None:
            if not any(hint in response.url for hint in API_PATH_HINTS):
                return
            if response.status in {401, 403}:
                auth_failures.append(response.status)
            elif response.status == 429:
                rate_limits.append(response.status)
            elif response.status == 200:
                try:
                    payloads.append(response.json())
                except Exception:
                    pass

        page.on("response", capture)
        query = {"shop_window": "1"} if criteria.shop_affiliates_only else {}
        if country:
            query["region"] = country
        if criteria.min_followers is not None or criteria.max_followers is not None:
            query["follower"] = f"{criteria.min_followers or 0},{criteria.max_followers or ''}"
        if any(
            value and "contact" in str(label).lower()
            for label, value in criteria.extra_filters.items()
        ):
            query["contact"] = "3"
        url = SEARCH_URL + (f"?{urlencode(query)}" if query else "")
        self._goto(page, url)
        if not self._authenticated(page):
            raise FastMossAuthRequired("FastMoss session expired")
        warnings = self._apply_filters(page, criteria)
        page.wait_for_timeout(1_000)
        if auth_failures:
            self.session_marker.unlink(missing_ok=True)
            raise FastMossAuthRequired("FastMoss session expired")
        if rate_limits:
            raise FastMossRateLimited("FastMoss rate-limited the creator search; wait before retrying")

        rows: dict[str, dict[str, Any]] = {}
        max_pages = max(1, min(300, math.ceil(limit / 10) + 5))
        pages_visited = 0
        for _ in range(max_pages):
            pages_visited += 1
            for payload in payloads:
                for row in records_from_payload(payload, country):
                    rows[row["username"]] = row
            payloads.clear()
            for row in self._dom_records(page, country):
                rows[row["username"]] = row
            if len(rows) >= limit or not self._next_page(page):
                break
        try:
            page.remove_listener("response", capture)
        except Exception:
            pass
        warnings.append(f"pages_visited={pages_visited}; candidates_seen={len(rows)}")
        return list(rows.values()), warnings

    def search(
        self,
        criteria: SearchCriteria | dict[str, Any],
        *,
        limit: int = 50,
        username: str = "",
        password: str = "",
        headed: bool = False,
        verification_timeout: int = 300,
    ) -> dict[str, Any]:
        criteria = criteria if isinstance(criteria, SearchCriteria) else SearchCriteria.from_dict(criteria)
        if not 1 <= limit <= 5_000:
            raise ValueError("limit must be between 1 and 5000")
        if not self.has_saved_session and not (username and password):
            raise FastMossAuthRequired("FastMoss username and password are required for the first login")
        # A visible browser is mandatory when fresh credentials may trigger
        # CAPTCHA/SMS. Saved sessions can run headless.
        use_headed = headed or bool(username or password)
        with self._browser(headed=use_headed) as (_, page):
            self._login_in_context(page, username, password, verification_timeout)
            countries = criteria.countries or [""]
            keywords = criteria.keywords or ([criteria.keyword] if criteria.keyword else [""])
            collected: dict[str, dict[str, Any]] = {}
            warnings: list[str] = []
            per_search_limit = max(50, math.ceil(limit / max(1, len(countries) * len(keywords))))
            client_criteria = replace(criteria, keyword="", keywords=[])
            for keyword in keywords:
                search_criteria = replace(criteria, keyword=keyword, keywords=[])
                for country in countries:
                    rows, page_warnings = self._search_country(
                        page, search_criteria, country, per_search_limit
                    )
                    warnings.extend(page_warnings)
                    for row in rows:
                        if matches_criteria(row, client_criteria):
                            row.setdefault("discovery_keywords", [])
                            if keyword and keyword not in row["discovery_keywords"]:
                                row["discovery_keywords"].append(keyword)
                            existing = collected.get(row["username"])
                            if existing:
                                existing["discovery_keywords"] = list(dict.fromkeys(
                                    existing.get("discovery_keywords", []) + row["discovery_keywords"]
                                ))
                            else:
                                collected[row["username"]] = row
                    if len(collected) >= limit:
                        break
                if len(collected) >= limit:
                    break
        results = list(collected.values())[:limit]
        return {
            "ok": True,
            "status": "complete" if len(results) >= limit else "partial",
            "source": "fastmoss",
            "criteria": asdict(criteria),
            "count": len(results),
            "warnings": sorted(set(warnings)),
            "results": results,
        }

    def enrich_emails(
        self,
        rows: list[dict[str, Any]],
        *,
        target_emails: int = 0,
        username: str = "",
        password: str = "",
        headed: bool = False,
        verification_timeout: int = 300,
        region: str = "",
        min_delay_ms: int = 2_000,
        max_delay_ms: int = 3_000,
    ) -> dict[str, Any]:
        """Enrich candidates inside the authenticated browser network context."""
        if not EMAIL_SCRIPT.is_file():
            raise FastMossError(f"email injection is missing: {EMAIL_SCRIPT}")
        if target_emails < 0:
            raise ValueError("target_emails cannot be negative")
        if not 0 <= min_delay_ms <= max_delay_ms:
            raise ValueError("email delay range is invalid")
        if not self.has_saved_session and not (username and password):
            raise FastMossAuthRequired("FastMoss username and password are required for the first login")

        candidates = [dict(row) for row in rows if row.get("uid")]
        if not candidates:
            return {
                "ok": True,
                "status": "complete",
                "candidate_count": len(rows),
                "processed_count": 0,
                "email_count": sum(bool(row.get("email")) for row in rows),
                "results": rows,
            }

        source = EMAIL_SCRIPT.read_text(encoding="utf-8")
        use_headed = headed or bool(username or password)
        injection_log: list[str] = []
        with self._browser(headed=use_headed) as (_, page):
            page.on("console", lambda message: injection_log.append(message.text))
            self._login_in_context(page, username, password, verification_timeout)
            query = {"region": region} if region else {}
            self._goto(page, SEARCH_URL + (f"?{urlencode(query)}" if query else ""))
            page.evaluate(
                """payload => {
                    window.__candidates = payload.rows;
                    window.__fmEmailConfig = payload.config;
                    window.__emailResults = [];
                    window.__fmAbortEmail = false;
                    window.__fmRateLimited = false;
                }""",
                {
                    "rows": candidates,
                    "config": {
                        "region": region or "ES",
                        "minDelayMs": min_delay_ms,
                        "maxDelayMs": max_delay_ms,
                        "maxEmails": target_emails,
                        "download": False,
                    },
                },
            )
            page.evaluate("source => { window.eval(source); return true; }", source)
            page.evaluate("() => window.__emailPromise")

            email_results = page.evaluate("() => window.__emailResults || []")
            rate_limited = bool(page.evaluate("() => window.__fmRateLimited === true"))
            body = page.locator("body").inner_text(timeout=10_000)[:8_000].lower()
            verification_required = any(marker in body for marker in (
                "captcha", "verify you are human", "security verification",
                "验证码", "安全验证", "人机验证", "滑块",
            ))

        by_uid = {
            str(item.get("uid")): item
            for item in email_results
            if item.get("uid")
        }
        enriched: list[dict[str, Any]] = []
        for row in rows:
            updated = dict(row)
            item = by_uid.get(str(row.get("uid") or ""))
            email = str((item or {}).get("email") or "")
            if email and email != "NONE":
                updated["email"] = email
                updated["email_source"] = "fastmoss_browser"
            enriched.append(updated)

        if verification_required:
            status = "fastmoss_verification_required"
        elif rate_limited:
            status = "fastmoss_rate_limited"
        else:
            status = "complete"
        return {
            "ok": not (verification_required or rate_limited),
            "status": status,
            "candidate_count": len(rows),
            "processed_count": len(email_results),
            "email_count": sum(bool(row.get("email")) for row in enriched),
            "warnings": [
                message for message in injection_log
                if "ERR:" in message or "Verification required" in message
            ][-20:],
            "results": enriched,
        }

    def harvest(
        self,
        criteria: SearchCriteria | dict[str, Any],
        *,
        target_emails: int,
        candidate_limit: int = 5_000,
        username: str = "",
        password: str = "",
        headed: bool = False,
        verification_timeout: int = 300,
    ) -> dict[str, Any]:
        """Collect candidates first, then enrich them with email in the browser."""
        if not 1 <= target_emails <= 5_000:
            raise ValueError("target_emails must be between 1 and 5000")
        if not target_emails <= candidate_limit <= 5_000:
            raise ValueError("candidate_limit must be between target_emails and 5000")
        parsed = criteria if isinstance(criteria, SearchCriteria) else SearchCriteria.from_dict(criteria)
        candidate_result = self.search(
            parsed,
            limit=candidate_limit,
            username=username,
            password=password,
            headed=headed,
            verification_timeout=verification_timeout,
        )
        candidates = candidate_result["results"]
        region = parsed.countries[0] if len(parsed.countries) == 1 else ""
        email_result = self.enrich_emails(
            candidates,
            target_emails=target_emails,
            headed=headed,
            verification_timeout=verification_timeout,
            region=region,
        )
        candidate_results = email_result["results"]
        with_email = [row for row in candidate_results if row.get("email")]
        email_result.update({
            "source": "fastmoss_browser",
            "criteria": asdict(parsed),
            "target_emails": target_emails,
            "candidate_status": candidate_result["status"],
            "candidate_warnings": candidate_result.get("warnings", []),
            "candidate_results": candidate_results,
            "results": with_email[:target_emails],
            "count": min(len(with_email), target_emails),
        })
        if email_result["status"] == "complete":
            email_result["status"] = (
                "complete" if len(with_email) >= target_emails else "partial"
            )
            email_result["ok"] = True
        return email_result


def write_result_csv(result: dict[str, Any], output: str | Path) -> Path:
    destination = Path(output).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    rows = result.get("results") or []
    fields = list(dict.fromkeys(key for row in rows for key in row))
    with destination.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="FastMoss persistent-browser creator scraper")
    parser.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR))
    subparsers = parser.add_subparsers(dest="command", required=True)
    login_parser = subparsers.add_parser("login")
    login_parser.add_argument("--username", required=True)
    login_parser.add_argument("--verification-timeout", type=int, default=300)
    search_parser = subparsers.add_parser("search")
    search_parser.add_argument("--criteria", required=True, help="JSON object with creator filters")
    search_parser.add_argument("--limit", type=int, default=50)
    search_parser.add_argument("--headed", action="store_true")
    search_parser.add_argument("--output", default="")
    args = parser.parse_args()

    scraper = FastMossScraper(args.profile_dir)
    try:
        if args.command == "login":
            password = getpass.getpass("FastMoss password: ")
            result = scraper.login(args.username, password, args.verification_timeout)
        else:
            result = scraper.search(
                SearchCriteria.from_dict(json.loads(args.criteria)),
                limit=args.limit,
                headed=args.headed,
            )
            if args.output:
                result["output_file"] = str(write_result_csv(result, args.output))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except FastMossError as exc:
        print(json.dumps({"ok": False, "status": exc.code, "message": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
