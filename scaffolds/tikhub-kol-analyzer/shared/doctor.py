"""Read-only installation and runtime preflight for customer deployments."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.env_loader import load_env_file
from shared.feishu_bitable import BitableConfig


PROJECT_DIR = Path(__file__).resolve().parent.parent
REQUIRED_MODULES = ("anthropic", "requests", "openpyxl", "dns", "mcp", "playwright")


def main() -> int:
    load_env_file(PROJECT_DIR / ".env")
    missing = [name for name in REQUIRED_MODULES if importlib.util.find_spec(name) is None]
    status = {
        "python": sys.version.split()[0],
        "python_supported": sys.version_info >= (3, 10),
        "missing_python_modules": missing,
        "legacy_tikhub_key_configured": bool(
            (os.environ.get("TIKHUB_API_KEY") or os.environ.get("TIKHUB_KEY") or "").strip()
        ),
        "feishu_bitable_configured": BitableConfig.from_env(required=False) is not None,
    }
    status["installation_ready"] = bool(
        status["python_supported"]
        and not missing
    )
    print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0 if status["installation_ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
