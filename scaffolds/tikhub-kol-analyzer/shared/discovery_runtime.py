"""Shared concurrency, rate limiting, HTTP metrics, and checkpoints."""
from __future__ import annotations

import csv
import random
import threading
import time
from collections import Counter, deque
from pathlib import Path

import requests

RETRY_STATUSES = {401, 408, 425, 429, 500, 502, 503, 504}


class RequestBudgetExceeded(RuntimeError):
    """Raised before an HTTP call would exceed the user-approved budget."""


class SlidingWindowRateLimiter:
    """Thread-safe hard cap of ``rate`` starts in every ``period`` window."""

    def __init__(self, rate: int, period: float = 1.0):
        if rate < 1:
            raise ValueError("rate must be >= 1")
        self.rate = rate
        self.period = period
        self._starts: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                while self._starts and now - self._starts[0] >= self.period:
                    self._starts.popleft()
                if len(self._starts) < self.rate:
                    self._starts.append(now)
                    return
                delay = self.period - (now - self._starts[0])
            time.sleep(max(delay, 0.001))


class RateLimitedJsonClient:
    """REST client with per-thread sessions and shared request accounting."""

    def __init__(
        self,
        base_url: str,
        token: str,
        rps: int,
        timeout: float = 15,
        max_retries: int = 3,
        trust_env: bool = True,
        max_requests: int | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_retries = max_retries
        self.trust_env = trust_env
        self.max_requests = max_requests
        self.limiter = SlidingWindowRateLimiter(rps)
        self.metrics = Counter()
        self._metrics_lock = threading.Lock()
        self._local = threading.local()

    def _session(self) -> requests.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.trust_env = self.trust_env
            session.headers.update({
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/json",
            })
            self._local.session = session
        return session

    def _count(self, key: str) -> None:
        with self._metrics_lock:
            self.metrics[key] += 1

    def _reserve_attempt(self) -> None:
        with self._metrics_lock:
            attempts = self.metrics["attempts"]
            if self.max_requests is not None and attempts >= self.max_requests:
                raise RequestBudgetExceeded(
                    f"request budget exhausted ({self.max_requests})"
                )
            self.metrics["attempts"] += 1

    def request(self, method: str, endpoint: str, **kwargs) -> dict:
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            self._reserve_attempt()
            self.limiter.acquire()
            started = time.monotonic()
            try:
                response = self._session().request(
                    method,
                    f"{self.base_url}{endpoint}",
                    timeout=self.timeout,
                    **kwargs,
                )
                self._count(f"http_{response.status_code}")
                if response.status_code in RETRY_STATUSES and attempt < self.max_retries - 1:
                    retry_after = response.headers.get("Retry-After")
                    delay = float(retry_after) if retry_after else (2 ** attempt) + random.random()
                    time.sleep(min(delay, 15))
                    continue
                response.raise_for_status()
                payload = response.json()
                self._count("ok")
                return payload
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                self._count(type(exc).__name__)
                if attempt < self.max_retries - 1:
                    time.sleep((2 ** attempt) + random.random())
            finally:
                elapsed = time.monotonic() - started
                with self._metrics_lock:
                    self.metrics["elapsed_ms"] += round(elapsed * 1000)
        raise RuntimeError(f"request failed after {self.max_retries} attempts: {last_error}")

    def get(self, endpoint: str, params: dict) -> dict:
        return self.request("GET", endpoint, params=params)

    def post(self, endpoint: str, body: dict) -> dict:
        return self.request("POST", endpoint, json=body)

    def metrics_summary(self) -> dict:
        with self._metrics_lock:
            result = dict(self.metrics)
        attempts = result.get("attempts", 0)
        result["avg_request_seconds"] = round(
            result.get("elapsed_ms", 0) / 1000 / attempts, 3
        ) if attempts else 0
        return result


class CsvCheckpoint:
    """Append-only, thread-safe checkpoint that records successes and rejects."""

    def __init__(self, path: str | Path, fields: list[str], key: str = "username"):
        self.path = Path(path)
        self.fields = fields
        self.key = key
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        with self.path.open(encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))

    def completed_keys(self) -> set[str]:
        return {row.get(self.key, "") for row in self.rows() if row.get(self.key)}

    def append(self, row: dict) -> None:
        with self._lock:
            new_file = not self.path.exists() or self.path.stat().st_size == 0
            with self.path.open("a", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=self.fields, extrasaction="ignore")
                if new_file:
                    writer.writeheader()
                writer.writerow(row)
                handle.flush()
