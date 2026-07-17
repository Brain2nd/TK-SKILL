#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

PYTHON_BIN=${PYTHON_BIN:-$(command -v python3 || true)}
NODE_BIN=${CODEX_NODE_BIN:-$(command -v node || true)}
NPM_BIN=$(command -v npm || true)

if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python 3.10+ was not found." >&2
  exit 1
fi
if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "Node.js 20+ and npm are required for FastMoss browser collection." >&2
  exit 1
fi
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "Python 3.10+ is required." >&2
  exit 1
fi
NODE_MAJOR=$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20+ is required." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv .venv
"$SCRIPT_DIR/.venv/bin/python" -m pip install --upgrade pip
"$SCRIPT_DIR/.venv/bin/python" -m pip install -r requirements-lock.txt
"$NPM_BIN" ci
"$SCRIPT_DIR/node_modules/.bin/playwright" install chromium

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env. Add your TIKHUB_API_KEY before using TikHub."
fi

chmod +x fastmoss_browser_setup.sh run_mcp.sh
"$SCRIPT_DIR/.venv/bin/python" doctor.py

echo
echo "Installation complete."
echo "1. Edit $SCRIPT_DIR/.env"
echo "2. Run $SCRIPT_DIR/fastmoss_browser_setup.sh for the first FastMoss login"
echo "3. Run $SCRIPT_DIR/.venv/bin/python print_mcp_config.py for MCP client JSON"
