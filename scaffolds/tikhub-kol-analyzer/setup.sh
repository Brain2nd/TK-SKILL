#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PYTHON_BIN=${PYTHON_BIN:-$(command -v python3 || true)}

if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python 3.10+ was not found." >&2
  exit 1
fi
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "Python 3.10+ is required." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv .venv
"$SCRIPT_DIR/.venv/bin/python" -m pip install --upgrade pip
"$SCRIPT_DIR/.venv/bin/python" -m pip install -r requirements.txt
"$SCRIPT_DIR/.venv/bin/python" -m playwright install chromium

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env. Add your TIKHUB_API_KEY before using TikHub."
fi

chmod +x run_mcp.sh
"$SCRIPT_DIR/.venv/bin/python" shared/doctor.py

echo
echo "Installation complete."
echo "1. Edit $SCRIPT_DIR/.env"
echo "2. Run $SCRIPT_DIR/.venv/bin/python shared/print_mcp_config.py for the MCP server"
