"""Keep a visible FastMoss browser open while the user completes verification."""
from __future__ import annotations

import time
from pathlib import Path

from fastmoss_pipeline.scraper import DEFAULT_PROFILE_DIR, FastMossScraper, SEARCH_URL


STOP_FILE = Path(DEFAULT_PROFILE_DIR) / "verification.stop"
READY_FILE = Path(DEFAULT_PROFILE_DIR) / "verification.ready"


def main() -> None:
    STOP_FILE.unlink(missing_ok=True)
    READY_FILE.unlink(missing_ok=True)
    scraper = FastMossScraper()
    try:
        with scraper._browser(headed=True) as (_, page):
            scraper._goto(page, SEARCH_URL)
            READY_FILE.write_text("ready", encoding="utf-8")
            while not STOP_FILE.exists():
                page.wait_for_timeout(500)
    finally:
        READY_FILE.unlink(missing_ok=True)
        STOP_FILE.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
