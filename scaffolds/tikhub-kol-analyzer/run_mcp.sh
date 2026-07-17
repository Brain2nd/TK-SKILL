#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${PYTHON_BIN:-"$SCRIPT_DIR/.venv/bin/python"}

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Python environment is missing. Run $SCRIPT_DIR/setup.sh first." >&2
  exit 1
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/kol_mcp_server.py"
