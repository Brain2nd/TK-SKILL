"""Python bridge for the persistent FastMoss browser collector."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from fastmoss_provider import load_fastmoss_exports


def collect_fastmoss_browser(
    output_dir: str | Path,
    countries: set[str],
    max_followers: int,
    desired: int,
    headed: bool = False,
    resume: bool = True,
    min_delay_ms: int = 2500,
    max_delay_ms: int = 6500,
) -> list[dict]:
    base = Path(__file__).resolve().parent
    output = Path(output_dir) / "fastmoss_browser_candidates.csv"
    node = os.environ.get("CODEX_NODE_BIN") or shutil.which("node")
    if not node:
        raise RuntimeError(
            "Node.js was not found. Install Node.js 20+ and run ./setup.sh first"
        )
    env = dict(os.environ)
    modules = os.environ.get("CODEX_NODE_MODULES")
    if modules:
        env["NODE_PATH"] = modules + (
            os.pathsep + env["NODE_PATH"] if env.get("NODE_PATH") else ""
        )
    command = [
        node, str(base / "fastmoss_browser.mjs"),
        "--output", str(output), "--target", str(desired),
        "--max-followers", str(max_followers),
        "--min-delay-ms", str(min_delay_ms),
        "--max-delay-ms", str(max_delay_ms),
    ]
    if headed:
        command.append("--headed")
    if resume:
        command.append("--resume")
    completed = subprocess.run(
        command, env=env, stdin=subprocess.DEVNULL,
        text=True, capture_output=True, timeout=3600,
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "FastMoss browser collection failed")
    return load_fastmoss_exports([str(output)], countries, max_followers)
