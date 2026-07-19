#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${PYTHON_BIN:-"$SCRIPT_DIR/.venv/bin/python"}
MCP_SERVER_SCRIPT=${MCP_SERVER_SCRIPT:-tikhub_pipeline/kol_mcp_server.py}

if [[ ! -x "$PYTHON_BIN" ]] || ! "$PYTHON_BIN" -c 'import mcp, playwright, requests' >/dev/null 2>&1; then
  echo "Preparing the creator-search MCP runtime on first use..." >&2
  "$SCRIPT_DIR/setup.sh" >&2
fi

case "$MCP_SERVER_SCRIPT" in
  tikhub_pipeline/kol_mcp_server.py) ;;
  *)
    echo "Unsupported MCP server: $MCP_SERVER_SCRIPT" >&2
    exit 2
    ;;
esac

exec "$PYTHON_BIN" "$SCRIPT_DIR/$MCP_SERVER_SCRIPT"
