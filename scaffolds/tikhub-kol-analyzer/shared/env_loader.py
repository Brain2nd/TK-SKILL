"""Dependency-free loader for simple project-local .env files."""
from __future__ import annotations

import os
from pathlib import Path


def load_env_file(path: str | Path = ".env") -> None:
    """Load ``KEY=value`` or ``export KEY=value`` without overriding the process."""
    env_path = Path(path)
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and value:
            os.environ.setdefault(key, value)
