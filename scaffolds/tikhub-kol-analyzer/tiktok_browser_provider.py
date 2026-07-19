"""Python bridge for bounded TikTok public-page extraction."""
from __future__ import annotations

import csv
import os
import shutil
import subprocess
from pathlib import Path


def collect_tiktok_public_profiles(
    usernames: list[str],
    output_file: str | Path,
    *,
    headed: bool = False,
    resume: bool = True,
    min_delay_ms: int = 4000,
    max_delay_ms: int = 9000,
) -> list[dict[str, str]]:
    if not 1 <= len(usernames) <= 100:
        raise ValueError("usernames must contain 1..100 handles")
    if min_delay_ms < 1000 or max_delay_ms < min_delay_ms:
        raise ValueError("TikTok browser pacing must be at least 1000 ms")
    base = Path(__file__).resolve().parent
    output = Path(output_file).expanduser().resolve()
    node = os.environ.get("CODEX_NODE_BIN") or shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 20+ is required for TikTok public-page collection")
    command = [
        node, str(base / "tiktok_browser.mjs"),
        "--output", str(output),
        "--limit", str(len(usernames)),
        "--min-delay-ms", str(min_delay_ms),
        "--max-delay-ms", str(max_delay_ms),
    ]
    for username in usernames:
        command.extend(["--username", str(username)])
    if headed:
        command.append("--headed")
    if resume:
        command.append("--resume")
    env = dict(os.environ)
    modules = os.environ.get("CODEX_NODE_MODULES")
    if modules:
        env["NODE_PATH"] = modules + (
            os.pathsep + env["NODE_PATH"] if env.get("NODE_PATH") else ""
        )
    completed = subprocess.run(
        command,
        cwd=base,
        env=env,
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        timeout=max(180, len(usernames) * max_delay_ms // 1000 + 120),
    )
    if completed.returncode:
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        message = detail[-1] if detail else "TikTok browser collection failed"
        if completed.returncode == 3:
            raise RuntimeError(f"human_verification_required: {message}")
        raise RuntimeError(message)
    if not output.exists():
        return []
    with output.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))
