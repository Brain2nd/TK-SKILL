"""Public creator contact extraction and conservative email validation."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

import requests

try:
    import dns.resolver
except ImportError:  # DNS verification remains optional at runtime.
    dns = None


EMAIL_RE = re.compile(r"(?<![\w.+-])([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})(?![\w-])", re.I)
URL_RE = re.compile(r"https?://[^\s<>\"']+", re.I)
INVALID_EMAIL_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")


def extract_email(text: str) -> str:
    """Return the first plausible public email in text, normalized to lowercase."""
    for match in EMAIL_RE.finditer(text or ""):
        email = match.group(1).strip(".,;:()[]{}<>").lower()
        if not email.endswith(INVALID_EMAIL_SUFFIXES):
            return email
    return ""


def extract_url(value) -> str:
    """Find a public HTTP URL in common TikTok profile payload shapes."""
    if isinstance(value, str):
        match = URL_RE.search(value)
        return match.group(0).rstrip(".,;)") if match else ""
    if isinstance(value, dict):
        preferred = ("link_url", "bio_url", "url", "external_url", "web_url")
        for key in preferred:
            if key in value:
                found = extract_url(value[key])
                if found:
                    return found
        for child in value.values():
            found = extract_url(child)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = extract_url(child)
            if found:
                return found
    return ""


def _is_public_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    if parsed.hostname.lower() in {"localhost", "localhost.localdomain"}:
        return False
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    return True


def fetch_public_page(url: str, timeout: int = 8, max_redirects: int = 3) -> str:
    """Fetch a public profile link while rejecting private-network redirects."""
    current = url
    headers = {"User-Agent": "Mozilla/5.0 (compatible; KOLContactDiscovery/1.0)"}
    for _ in range(max_redirects + 1):
        if not _is_public_url(current):
            return ""
        try:
            response = requests.get(current, timeout=timeout, headers=headers, allow_redirects=False)
        except requests.RequestException:
            return ""
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("Location", "")
            if not location:
                return ""
            current = urljoin(current, location)
            continue
        if response.status_code >= 400:
            return ""
        content_type = response.headers.get("Content-Type", "").lower()
        if content_type and not any(kind in content_type for kind in ("text/", "application/xhtml", "application/json")):
            return ""
        return response.text[:500_000]
    return ""


def verify_email_domain(email: str, timeout: float = 3.0) -> bool:
    """Verify that the email domain publishes MX records; no SMTP probe is made."""
    if not extract_email(email) or dns is None:
        return False
    domain = email.rsplit("@", 1)[1]
    try:
        resolver = dns.resolver.Resolver()
        resolver.lifetime = timeout
        return bool(resolver.resolve(domain, "MX"))
    except Exception:
        return False


def enrich_contact(row: dict, profile_payload=None, verify_dns: bool = True, scrape_link: bool = True) -> dict:
    """Add email, bio_url, email_source, and email_verified to a candidate row."""
    enriched = dict(row)
    bio = enriched.get("bio", "") or ""
    email = extract_email(bio)
    source = "bio" if email else ""

    bio_url = enriched.get("bio_url", "") or extract_url(profile_payload)
    if not email and profile_payload:
        email = extract_email(str(profile_payload))
        source = "profile" if email else ""
    if not email and bio_url and scrape_link:
        email = extract_email(fetch_public_page(bio_url))
        source = "bio_url" if email else ""

    enriched["email"] = email
    enriched["bio_url"] = bio_url
    enriched["email_source"] = source
    enriched["email_verified"] = bool(email and (verify_email_domain(email) if verify_dns else True))
    return enriched
