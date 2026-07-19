"""Print a copy/paste MCP configuration with resolved local paths."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main() -> None:
    project = Path(__file__).resolve().parent.parent
    config = {
        "mcpServers": {
            "creator-search": {
                "command": str(project / "run_mcp.sh"),
                "args": [],
            },
        }
    }
    print(json.dumps(config, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
