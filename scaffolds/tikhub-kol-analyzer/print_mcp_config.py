"""Print a copy/paste MCP configuration with resolved local paths."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> None:
    server = Path(__file__).resolve().with_name("kol_mcp_server.py")
    config = {
        "mcpServers": {
            "tiktok-kol-analyzer": {
                "command": sys.executable,
                "args": [str(server)],
            }
        }
    }
    print(json.dumps(config, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
