"""Shared process and CSV helpers for the local MCP servers."""
from __future__ import annotations

import csv
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


PROJECT_DIR = Path(__file__).resolve().parent.parent


def run_project_script(
    script: str,
    arguments: list[str],
    *,
    env_overrides: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Run one maintained CLI workflow and return bounded diagnostic output."""
    process_env = os.environ.copy()
    process_env.update(env_overrides or {})
    completed = subprocess.run(
        [sys.executable, script, *arguments],
        cwd=PROJECT_DIR,
        text=True,
        capture_output=True,
        timeout=60 * 60,
        env=process_env,
    )
    return {
        "ok": completed.returncode == 0,
        "exit_code": completed.returncode,
        "stdout": completed.stdout[-12_000:],
        "stderr": completed.stderr[-4_000:],
    }


def read_csv(path: Path, limit: int = 100) -> list[dict[str, str]]:
    """Read a UTF-8 CSV with a bounded number of rows."""
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))[:limit]
