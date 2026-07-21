"""Print a copy/paste MCP configuration with resolved local paths."""
from __future__ import annotations

import json
from pathlib import Path


def main() -> None:
    launcher = Path(__file__).resolve().with_name("run_mcp.sh")
    config = {
        "mcpServers": {
            "tiktok-kol-analyzer": {
                "command": str(launcher),
                "args": [],
            }
        }
    }
    print(json.dumps(config, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
