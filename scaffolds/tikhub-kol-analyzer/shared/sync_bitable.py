"""CLI for importing an existing candidate CSV into Feishu Base."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.env_loader import load_env_file
from shared.feishu_bitable import sync_csv


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert a candidate CSV into Feishu Base")
    parser.add_argument("csv_file")
    args = parser.parse_args()
    project_dir = Path(__file__).resolve().parent.parent
    load_env_file(project_dir / ".env")
    result = sync_csv(args.csv_file, required=True)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
