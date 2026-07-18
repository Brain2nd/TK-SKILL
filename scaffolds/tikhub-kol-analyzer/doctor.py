"""Read-only installation and runtime preflight for customer deployments."""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path

from env_loader import load_env_file


PROJECT_DIR = Path(__file__).resolve().parent
REQUIRED_MODULES = ("anthropic", "requests", "openpyxl", "dns", "mcp")


def main() -> int:
    load_env_file(PROJECT_DIR / ".env")
    missing = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]
    node = os.environ.get("CODEX_NODE_BIN") or shutil.which("node")
    playwright = PROJECT_DIR / "node_modules" / "playwright"
    profile = Path(
        os.environ.get(
            "FASTMOSS_BROWSER_PROFILE",
            PROJECT_DIR / "output" / ".fastmoss-browser-profile",
        )
    )
    status = {
        "python": sys.version.split()[0],
        "python_supported": sys.version_info >= (3, 10),
        "missing_python_modules": missing,
        "node": node or "",
        "playwright_installed": playwright.is_dir(),
        "tikhub_key_configured": bool(
            (os.environ.get("TIKHUB_API_KEY") or os.environ.get("TIKHUB_KEY") or "").strip()
        ),
        "fastmoss_session_ready": (profile / "ready.json").is_file(),
    }
    status["installation_ready"] = bool(
        status["python_supported"]
        and not missing
        and node
        and status["playwright_installed"]
    )
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0 if status["installation_ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
